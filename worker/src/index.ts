import { authenticate, changePassword, cleanAuth, login, oauthExchange, oauthStart } from './auth'
import { createSection, getAsset, mutateSection, revisions, search, section, setAssetDeleted, stamp, toc, uploadAsset } from './content'
import { HttpError, fail, identifier, json, type Env } from './http'

const preflightHeaders = new Set(['authorization', 'content-type', 'x-asset-metadata'])
const allowedMethods = 'GET, POST, PUT, DELETE, OPTIONS'
const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

export function createApp(githubFetch: typeof fetch = fetch) {
  async function dispatch(request: Request, env: Env, url: URL): Promise<Response> {
    const path = url.pathname
    const method = request.method
    if (method === 'POST' && path === '/v1/auth/login') return login(request, env)
    if (method === 'POST' && path === '/v1/auth/github/start') return oauthStart(request, env)
    if (method === 'POST' && path === '/v1/auth/github/exchange') return oauthExchange(request, env, githubFetch)
    if (!path.startsWith('/v1/')) return fail(404, 'not_found')

    const session = await authenticate(request, env)
    const admin = session.role === 'admin'
    if (method === 'GET' && path === '/v1/auth/session') {
      return json({ role: session.role, expires: session.expires })
    }
    if (method === 'POST' && path === '/v1/auth/logout') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.hash).run()
      return new Response(null, { status: 204 })
    }
    if (method === 'GET') {
      if (path === '/v1/toc') return toc(env, admin)
      if (path === '/v1/symbols') return section(env, admin, 'symbols')
      if (path === '/v1/search') return search(env, url, admin)
      const content = path.match(/^\/v1\/sections\/([^/]+)$/)
      if (content) return section(env, admin, identifier(content[1]))
      const image = path.match(/^\/v1\/assets\/([^/]+)$/)
      if (image) return getAsset(env, identifier(image[1]), admin)
    }
    if (!path.startsWith('/v1/admin/')) return fail(404, 'not_found')
    if (!admin) return fail(403, 'admin_required')
    if (method === 'POST' && path === '/v1/admin/password') return changePassword(request, env)
    if (method === 'GET' && path === '/v1/admin/export') return stamp(env)
    if (method === 'POST' && path === '/v1/admin/sections') return createSection(env, request)
    if (method === 'POST' && path === '/v1/admin/assets') return uploadAsset(env, request, url)
    const content = path.match(/^\/v1\/admin\/sections\/([^/]+)(?:\/(history|restore))?$/)
    if (content) {
      const id = identifier(content[1])
      const action = content[2]
      if (method === 'GET' && action === 'history') return revisions(env, id, url)
      if (method === 'POST' && action === 'restore') return mutateSection(env, request, id, 'restore')
      if (method === 'PUT' && !action) return mutateSection(env, request, id, 'edit')
      if (method === 'DELETE' && !action) return mutateSection(env, request, id, 'delete')
    }
    const image = path.match(/^\/v1\/admin\/assets\/([^/]+)(\/restore)?$/)
    if (image) {
      if (method === 'DELETE' && !image[2]) return setAssetDeleted(env, identifier(image[1]), 1)
      if (method === 'POST' && image[2]) return setAssetDeleted(env, identifier(image[1]), 0)
    }
    return fail(404, 'not_found')
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url)
      const origin = request.headers.get('Origin')
      const cors = origin === env.SITE_ORIGIN
      let response: Response
      try {
        if (url.protocol !== 'https:' && !(loopback.test(url.origin) && loopback.test(env.SITE_ORIGIN))) {
          fail(400, 'https_required')
        }
        if (origin && !cors) fail(403, 'origin_denied')
        if (request.method === 'OPTIONS') {
          const method = request.headers.get('Access-Control-Request-Method') ?? ''
          const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
          if (!cors || !allowedMethods.split(', ').includes(method) || requestedHeaders.some(name => !preflightHeaders.has(name))) {
            fail(403, 'origin_denied')
          }
          response = new Response(null, { status: 204 })
        } else {
          response = await dispatch(request, env, url)
        }
      } catch (error) {
        if (error instanceof HttpError) {
          response = json({ error: error.code }, error.status)
          if (error.status === 429) response.headers.set('Retry-After', '900')
        } else {
          response = json({ error: 'server_error' }, 500)
        }
      }
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store, private')
      headers.set('Vary', 'Origin')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      if (cors) {
        headers.set('Access-Control-Allow-Origin', env.SITE_ORIGIN)
        headers.set('Access-Control-Allow-Methods', allowedMethods)
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Asset-Metadata')
        headers.set('Access-Control-Max-Age', '600')
      }
      return new Response(response.body, { status: response.status, headers })
    },
    scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
      ctx.waitUntil(cleanAuth(env))
    }
  }
}

export default createApp()
