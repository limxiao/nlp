import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { createServer } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))
const wrangler = resolve(root, 'node_modules/.bin/wrangler')
const stateRoot = resolve(root, '.wrangler')
const tls = { origin: 'http://127.0.0.1:4321' }

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  for (const channel of [child.stdout, child.stderr]) {
    channel.on('data', value => { log = (log + value).slice(-16000) })
  }
  return {
    child, log: () => log,
    close: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve()
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    })
  }
}

async function ready(url, app, expected) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (app.child.exitCode !== null || app.child.signalCode) break
    const status = await fetch(url, { signal: AbortSignal.timeout(250) }).then(result => result.status).catch(() => 0)
    if (status === expected) return
    await sleep(100)
  }
  throw new Error('Local server did not start: ' + app.log())
}

export async function startWorker({ port, origin = tls.origin, privateSql } = {}) {
  port ??= await unusedPort()
  mkdirSync(stateRoot, { recursive: true })
  const dir = mkdtempSync(resolve(stateRoot, 'test-'))
  const config = resolve(dir, 'wrangler.json')
  const state = resolve(dir, 'state')
  writeFileSync(config, JSON.stringify({
    name: 'nlp-local-test',
    main: resolve(root, 'tests/mock-worker.ts'),
    compatibility_date: '2026-11-13',
    vars: {
      SITE_ORIGIN: origin, AUTH_KEY: randomBytes(32).toString('hex'),
      GITHUB_CLIENT_ID: 'test-only', GITHUB_CLIENT_SECRET: 'local-github-fixture'
    },
    d1_databases: [{
      binding: 'DB', database_name: 'nlp-test', database_id: '00000000-0000-0000-0000-000000000001',
      migrations_dir: resolve(root, 'worker/migrations')
    }]
  }), { mode: 0o600 })
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log') }
  const args = ['--config', config]
  let app
  try {
    execFileSync(wrangler, ['d1', 'migrations', 'apply', 'nlp-test', '--local', '--persist-to', state, ...args], { cwd: root, env })
    execFileSync(wrangler, ['d1', 'execute', 'nlp-test', '--local', '--persist-to', state,
      '--file', privateSql ?? resolve(root, 'tests/fixtures.sql'), ...args], { cwd: root, env })
    app = run(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, ...args], env)
    const base = 'http://127.0.0.1:' + port + '/v1'
    await ready(base + '/toc', app, 401)
    return {
      base, origin, log: app.log,
      async close() { await app.close(); rmSync(dir, { force: true, recursive: true }) }
    }
  } catch (error) {
    await app?.close()
    rmSync(dir, { force: true, recursive: true })
    throw error
  }
}

export async function startFrontend(port = 4321) {
  const directory = resolve(root, 'dist')
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
  }
  const server = httpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (!url.pathname.startsWith('/nlp/')) {
        response.writeHead(404).end()
        return
      }
      const name = decodeURIComponent(url.pathname.slice('/nlp/'.length)) || 'index.html'
      const file = resolve(directory, name)
      if (!file.startsWith(directory + sep)) {
        response.writeHead(404).end()
        return
      }
      const contents = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(contents)
    } catch { response.writeHead(404).end() }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
