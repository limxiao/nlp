import { createApp } from '../worker/src/index'

export default createApp(async (input, init) => {
  const url = String(input)
  if (url === 'https://github.com/login/oauth/access_token') {
    const values = new URLSearchParams(String(init?.body))
    if (values.get('code_verifier')?.length !== 43 || values.get('client_secret') !== 'local-github-fixture') {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const code = values.get('code')
    if (!['owner', 'visitor'].includes(code ?? '')) return Response.json({ error: 'invalid_code' })
    return Response.json({ access_token: code })
  }
  if (url === 'https://api.github.com/user') {
    const auth = new Headers(init?.headers).get('Authorization')
    // Using the same login for both accounts makes the numeric ID check observable.
    return Response.json({ login: 'limxiao', id: auth === 'Bearer owner' ? 212172861 : 20 })
  }
  return new Response(null, { status: 404 })
})
