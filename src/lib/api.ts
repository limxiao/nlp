import type { Session } from './types'

const sessionKey = 'nlp.session'
const oauthKey = 'nlp.oauth'
export const apiOrigin = document.querySelector<HTMLMetaElement>('meta[name="nlp-api"]')?.content
export const configured = Boolean(apiOrigin)
const text = new TextEncoder()

export function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function readSession(): Session | null {
  try {
    const saved = sessionStorage.getItem(sessionKey)
    if (!saved) return null
    const session: Session = JSON.parse(saved)
    if (!/^[A-Za-z0-9_-]{43}$/.test(session.token) || !['admin','viewer'].includes(session.role)) {
      sessionStorage.removeItem(sessionKey)
      return null
    }
    return session
  } catch {
    return null
  }
}

let session = readSession()

export function saveSession(next: Session | null) {
  session = next
  if (next) sessionStorage.setItem(sessionKey, JSON.stringify(next))
  else sessionStorage.removeItem(sessionKey)
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

const messages: Record<string, string> = {
  unauthenticated: 'セッションの有効期限が切れました。ログインしてください。',
  invalid_password: 'パスワードを確認してください。',
  invalid_password_format: '前後の空白なしで、16文字以上を指定してください。',
  not_admin: 'この GitHub アカウントには管理権限がありません。',
  admin_required: '管理者としてログインしてください。',
  invalid_oauth: '認証を完了できませんでした。GitHub ログインをやり直してください。',
  oauth_configuration: 'GitHub ログインの設定を管理者に確認してください。',
  auth_configuration: 'サーバーの認証設定を管理者に確認してください。',
  github_unavailable: 'GitHub に接続できませんでした。',
  rate_limited: '試行回数の上限に達しました。15分ほど待ってからお試しください。',
  invalid_input: '入力欄とページ範囲を確認してください。本文がある場合は校正状態を選択してください。',
  invalid_id: 'ID は半角英小文字・数字・ハイフン・アンダースコアで指定してください。',
  invalid_parent: '親の章節と種類を確認してください。',
  id_exists: '同じ ID が既に使われています。',
  conflict: '別の更新が先に保存されました。編集を控えてからページの最新版を開いてください。',
  deleted: 'この章節は削除済みです。編集履歴から復元してください。',
  invalid_restore: '公開していた版、または未削除の過去版を選択してください。',
  not_found: '指定された資料にアクセスできません。',
  unsupported_image: 'WebP、PNG、JPEG 画像を選択してください。',
  too_large: 'ファイルまたは入力が大きすぎます。',
  server_error: 'サーバーでエラーが発生しました。',
  configuration: '接続先 API を設定してください。',
  backup_changed: '途中で教科書が更新されました。バックアップを再実行してください。'
}

export function message(error: unknown): string {
  if (error instanceof ApiError) return messages[error.code] ?? ('処理に失敗しました（' + error.status + '）。')
  if (error instanceof Error && error.name === 'AbortError') return ''
  return '処理を完了できませんでした。接続とブラウザ設定を確認してください。'
}

export async function api(path: string, options: RequestInit = {}, publicRequest = false) {
  if (!apiOrigin) throw new ApiError(503, 'configuration')
  const headers = new Headers(options.headers)
  const used = session
  if (used && !publicRequest) headers.set('Authorization', 'Bearer ' + used.token)
  const response = await fetch(apiOrigin + '/v1' + path, {
    ...options, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
  })
  if (response.ok) return response
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (response.status === 401 && used && used === session && !publicRequest) {
    document.dispatchEvent(new Event('nlp:expired'))
  }
  throw new ApiError(response.status, payload.error ?? 'server_error')
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await api(path, { signal })).json()
}

export async function send<T>(path: string, method: string, body: unknown, publicRequest = false): Promise<T> {
  const response = await api(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }, publicRequest)
  return response.status === 204 ? undefined as T : response.json()
}

export async function beginOAuth() {
  const verifier = randomSecret()
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(verifier)))
  const challenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const { url, state } = await send<{ url: string; state: string }>('/auth/github/start', 'POST', { challenge }, true)
  const target = new URL(url)
  if (target.origin !== 'https://github.com' || target.pathname !== '/login/oauth/authorize') {
    throw new ApiError(400, 'invalid_oauth')
  }
  sessionStorage.setItem(oauthKey, JSON.stringify({ state, verifier, hash: location.hash }))
  location.assign(target)
}

export async function finishOAuth(): Promise<Session | null> {
  const params = new URLSearchParams(location.search)
  if (!params.has('code') && !params.has('error')) return null
  const oauth = sessionStorage.getItem(oauthKey)
  sessionStorage.removeItem(oauthKey)
  const pending = oauth ? JSON.parse(oauth) : null
  const hash = typeof pending?.hash === 'string' && /^#[a-z0-9][a-z0-9_./-]*$/.test(pending.hash) ? pending.hash : ''
  history.replaceState(null, '', location.pathname + hash)
  if (!pending || pending.state !== params.get('state') || !params.get('code') || params.has('error')) {
    throw new ApiError(400, 'invalid_oauth')
  }
  return send('/auth/github/exchange', 'POST', { code: params.get('code'), state: pending.state, verifier: pending.verifier }, true)
}
