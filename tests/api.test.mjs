import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { startWorker } from './server.mjs'

const token = () => randomBytes(32).toString('base64url')

test('D1 and Workers API protects and persists textbook content', { timeout: 120_000 }, async t => {
  const worker = await startWorker()
  t.after(() => worker.close())
  let admin, reader
  const one = token()
  const two = token()
  const image = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOQLwsGIgYIBQAYngOhqIkM0AAAAABJRU5ErkJggg==', 'base64'),
    randomBytes(70_000)
  ])

  async function request(path, { status = 200, bearer, data, method = 'GET', headers = {}, raw, origin = worker.origin } = {}) {
    const response = await fetch(worker.base + path, {
      method, headers: {
        Origin: origin, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers
      }, body: data ? JSON.stringify(data) : raw
    })
    assert.equal(response.status, status, method + ' ' + path + ' ' + (response.status === status ? '' : await response.clone().text()))
    assert.match(response.headers.get('Cache-Control'), /no-store/)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin === worker.origin ? worker.origin : null)
    return response
  }

  await t.test('denies unauthenticated content, origins and preflight misuse', async () => {
    for (const path of ['/toc', '/sections/s-test', '/symbols', '/search?q=検', '/assets/fig-test', '/admin/export']) {
      await request(path, { status: 401 })
    }
    await request('/toc', { status: 403, origin: 'https://attacker.example' })
    await request('/toc', { method: 'OPTIONS', status: 204, headers: {
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'
    } })
    await request('/toc', { method: 'OPTIONS', status: 403, headers: {
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-hostile'
    } })
  })

  const start = async verifier => {
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const result = await request('/auth/github/start', { method: 'POST', data: { challenge } }).then(r => r.json())
    const authorize = new URL(result.url)
    assert.equal(authorize.origin, 'https://github.com')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorize.searchParams.get('redirect_uri'), worker.origin + '/nlp/')
    assert.equal(authorize.searchParams.get('code_challenge'), challenge)
    return result.state
  }
  const exchange = (state, verifier, code, status = 200) => request('/auth/github/exchange',
    { method: 'POST', status, data: { state, verifier, code } })

  await t.test('validates state, PKCE, single use and numeric GitHub ID', async () => {
    const verifier = token()
    const state = await start(verifier)
    await exchange(token(), verifier, 'owner', 400)
    await exchange(state, token(), 'owner', 400)
    await exchange(state, verifier, 'visitor', 403)
    await exchange(state, verifier, 'owner', 400)
    const ownerState = await start(verifier)
    const success = await exchange(ownerState, verifier, 'owner').then(r => r.json())
    assert.equal(success.role, 'admin')
    assert.match(success.token, /^[\w-]{43}$/)
    assert.ok(success.expires - Date.now() / 1000 <= 1800)
    admin = success.token
  })

  const change = password => request('/admin/password', { method: 'POST', bearer: admin, data: { password } })
  const login = (password, status = 200) => request('/auth/login', { method: 'POST', status, data: { password } })

  await t.test('verifies shared secret and isolates roles', async () => {
    await login(one, 401)
    await change(one)
    await login(two, 401)
    const result = await login(one).then(r => r.json())
    assert.equal(result.role, 'viewer')
    assert.ok(result.expires - Date.now() / 1000 <= 3600)
    reader = result.token
    await request('/admin/password', { method: 'POST', bearer: reader, status: 403, data: { password: two } })
    await request('/admin/sections/s-test', { method: 'PUT', bearer: reader, status: 403, data: {} })
    await request('/admin/export', { bearer: reader, status: 403 })
    await request('/symbols', { bearer: reader })
    const { hits } = await request('/search?q=検索対象語', { bearer: reader }).then(r => r.json())
    assert.equal(hits[0].id, 's-test')
    const short = await request('/search?q=語', { bearer: reader }).then(r => r.json())
    assert.ok(short.hits.some(row => row.id === 's-test'))
  })

  await t.test('stores chunked private figures, validates formats, supports soft removal and restore', async () => {
    const path = '/admin/assets?id=fig-test&section=s-test'
    const headers = { 'Content-Type': 'image/png', 'X-Asset-Metadata': encodeURIComponent(JSON.stringify({
      alt: '試験用図', caption: '試験用図の説明', print_page: 2
    })) }
    await request(path, { method: 'POST', bearer: admin, status: 415, raw: Buffer.from('<svg/>'), headers })
    await request(path, { method: 'POST', bearer: admin, status: 201, raw: image, headers })
    const response = await request('/assets/fig-test', { bearer: reader })
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
    await request('/assets/fig-test', { status: 401 })
    await request('/admin/assets/fig-test', { method: 'DELETE', bearer: admin })
    await request('/assets/fig-test', { status: 404, bearer: reader })
    await request('/admin/assets/fig-test/restore', { method: 'POST', bearer: admin })
    await request('/assets/fig-test', { bearer: reader })
  })

  await t.test('persists revisions and rejects concurrent changes, hides descendants, restores history', async () => {
    const { section: original } = await request('/sections/s-test', { bearer: admin }).then(r => r.json())
    const put = (data, status = 200) => request('/admin/sections/s-test', { method: 'PUT', bearer: admin, status, data })
    await put({ ...original, body: '競合 A $x^2$' })
    await put({ ...original, body: '競合 B' }, 409)
    const saved = await request('/sections/s-test', { bearer: reader }).then(r => r.json())
    assert.equal(saved.section.body, '競合 A $x^2$')
    assert.equal(saved.section.revision, 2)
    const history = await request('/admin/sections/s-test/history', { bearer: admin }).then(r => r.json())
    assert.deepEqual(history.revisions.map(row => row.revision), [2, 1])
    await request('/admin/sections/s-test/restore', { method: 'POST', bearer: admin, data: { target: 1, revision: 2 } })
    const restored = await request('/sections/s-test', { bearer: reader }).then(r => r.json())
    assert.equal(restored.section.body, original.body)
    assert.equal(restored.section.revision, 3)

    await request('/admin/sections', { method: 'POST', bearer: admin, status: 201, data: {
      id: 's-added', kind: 'subsection', parent_id: 's-test', position: 1,
      number: '1.1.1', title: '動的な小節', body: 'テスト検索新規', status: 'verified', published: 1
    } })
    assert.ok((await request('/toc', { bearer: reader }).then(r => r.json())).sections.some(row => row.id === 's-added'))
    await put({ ...restored.section, published: 0 })
    await request('/sections/s-added', { status: 404, bearer: reader })
    await request('/assets/fig-test', { status: 404, bearer: reader })
    assert.equal((await request('/search?q=テスト検索新規', { bearer: reader }).then(r => r.json())).hits.length, 0)
    await request('/admin/sections/s-test', { method: 'DELETE', bearer: admin, data: { revision: 4 } })
    await request('/admin/sections/s-test/restore', { method: 'POST', bearer: admin, data: { target: 3, revision: 5 } })
    await request('/sections/s-added', { bearer: reader })
  })

  await t.test('password rotation revokes viewers, leaves admin and textbook available, rate limits guesses', async () => {
    await change(two)
    await request('/toc', { bearer: reader, status: 401 })
    await login(one, 401)
    await request('/auth/session', { bearer: admin })
    const user = await login(two).then(r => r.json())
    await request('/sections/s-added', { bearer: user.token })
    await request('/auth/logout', { method: 'POST', status: 204, bearer: user.token })
    await request('/toc', { bearer: user.token, status: 401 })
    for (let index = 0; index < 5; index++) await login(token(), 401)
    await login(two, 429)
    for (const secret of [one, two, reader, admin, user.token]) assert.ok(!worker.log().includes(secret))
  })
})
