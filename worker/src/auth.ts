import { fail, json, readJson, string, type Env } from './http'

const userId = 212172861
const utf8 = new TextEncoder()
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const now = () => Math.floor(Date.now() / 1000)

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))))
}

async function keyed(env: Env, value: string): Promise<string> {
  if (!env.AUTH_KEY || !/^[a-f0-9]{64}$/.test(env.AUTH_KEY)) return fail(503, 'auth_configuration')
  const key = await crypto.subtle.importKey('raw', utf8.encode(env.AUTH_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(value))))
}

function equal(a: string, b: string): boolean {
  return a.length === b.length && crypto.subtle.timingSafeEqual(utf8.encode(a), utf8.encode(b))
}

async function limit(request: Request, env: Env, category: string, perIp: number, global: number): Promise<void> {
  const timestamp = now()
  const interval = 900
  const window = Math.floor(timestamp / interval)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const key = await keyed(env, 'ip:' + ip)
  const bump = (bucket: string, maximum: number) => env.DB.prepare(`
    INSERT INTO auth_limits (bucket, count, expires) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count
  `).bind(bucket, (window + 1) * interval, maximum)
  const perAddress = await bump(category + ':' + window + ':' + key, perIp).first()
  if (!perAddress) fail(429, 'rate_limited')
  const acrossAddresses = await bump(category + ':' + window, global).first()
  if (!acrossAddresses) fail(429, 'rate_limited')
}

async function issue(env: Env, role: 'viewer' | 'admin', generation: number | null): Promise<Response> {
  const token = randomToken()
  const expires = now() + (role === 'viewer' ? 3600 : 1800)
  const issued = await env.DB.prepare(`
    INSERT INTO sessions (token_hash, role, generation, expires) SELECT ?, ?, ?, ?
    WHERE ? = 'admin' OR EXISTS (SELECT 1 FROM viewer_settings WHERE id = 1 AND generation = ?)
    RETURNING expires
  `).bind(await digest(token), role, generation, expires, role, generation).first()
  if (!issued) return fail(401, 'invalid_password')
  return json({ token, role, expires })
}

export async function authenticate(request: Request, env: Env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  if (!token) return fail(401, 'unauthenticated')
  const hash = await digest(token)
  const session = await env.DB.prepare(`
    SELECT role, expires FROM sessions
    WHERE token_hash = ? AND expires > ?
    AND (role = 'admin' OR generation = (SELECT generation FROM viewer_settings WHERE id = 1))
  `).bind(hash, now()).first<{ role: 'viewer' | 'admin'; expires: number }>()
  if (!session) return fail(401, 'unauthenticated')
  return { ...session, hash }
}

export async function login(request: Request, env: Env): Promise<Response> {
  const data = await readJson(request, 4096)
  const password = string(data.password, 256, 1)
  await limit(request, env, 'viewer', 10, 160)
  const settings = await env.DB.prepare('SELECT salt, verifier, generation FROM viewer_settings WHERE id = 1')
    .first<{ salt: string | null; verifier: string | null; generation: number }>()
  const calculated = await keyed(env, 'password:v1:' + (settings?.salt ?? 'unconfigured') + ':' + password)
  const valid = equal(calculated, settings?.verifier ?? '0'.repeat(43))
  if (!valid || !settings?.verifier) return fail(401, 'invalid_password')
  return issue(env, 'viewer', settings.generation)
}

export async function changePassword(request: Request, env: Env): Promise<Response> {
  const data = await readJson(request, 4096)
  const password = string(data.password, 256, 16)
  if (Array.from(password).length < 16 || password.trim() !== password) fail(400, 'invalid_password_format')
  const salt = randomToken()
  const verifier = await keyed(env, 'password:v1:' + salt + ':' + password)
  await env.DB.prepare(`
    UPDATE viewer_settings SET salt = ?, verifier = ?, generation = generation + 1, updated_at = unixepoch()
    WHERE id = 1
  `).bind(salt, verifier).run()
  return json({ ok: true })
}

export async function oauthStart(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return fail(503, 'oauth_configuration')
  const { challenge } = await readJson(request, 4096)
  if (typeof challenge !== 'string' || !tokenPattern.test(challenge)) return fail(400, 'invalid_oauth')
  await limit(request, env, 'oauth', 12, 120)
  const state = randomToken()
  await env.DB.prepare('INSERT INTO oauth_states (state_hash, challenge, expires) VALUES (?, ?, ?)')
    .bind(await digest(state), challenge, now() + 600).run()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: env.SITE_ORIGIN + '/nlp/',
    state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false'
  }).toString()
  return json({ url: url.toString(), state })
}

export async function oauthExchange(request: Request, env: Env, githubFetch: typeof fetch): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return fail(503, 'oauth_configuration')
  const data = await readJson(request, 4096)
  const code = string(data.code, 300, 1)
  const state = string(data.state, 43, 43)
  const verifier = string(data.verifier, 43, 43)
  if (!tokenPattern.test(state) || !tokenPattern.test(verifier)) return fail(400, 'invalid_oauth')
  const consumed = await env.DB.prepare(`
    DELETE FROM oauth_states WHERE state_hash = ? AND challenge = ? AND expires > ? RETURNING state_hash
  `).bind(await digest(state), await digest(verifier), now()).first()
  if (!consumed) return fail(400, 'invalid_oauth')
  const tokenResponse = await githubFetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
      redirect_uri: env.SITE_ORIGIN + '/nlp/', code_verifier: verifier
    })
  })
  if (!tokenResponse.ok) return fail(502, 'github_unavailable')
  const tokenData = await tokenResponse.json<{ access_token?: string }>()
  if (!tokenData.access_token) return fail(401, 'invalid_oauth')
  const profileResponse = await githubFetch('https://api.github.com/user', {
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tokenData.access_token,
      'User-Agent': 'nlp-textbook-worker', 'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!profileResponse.ok) return fail(502, 'github_unavailable')
  const profile = await profileResponse.json<{ id?: number }>()
  if (profile.id !== userId) return fail(403, 'not_admin')
  return issue(env, 'admin', null)
}

export async function cleanAuth(env: Env): Promise<void> {
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires <= ?').bind(timestamp),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires <= ?').bind(timestamp),
    env.DB.prepare('DELETE FROM auth_limits WHERE expires <= ?').bind(timestamp)
  ])
}
