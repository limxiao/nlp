import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, expect } from '@playwright/test'
import { root, startFrontend, startWorker } from './server.mjs'

const site = 'http://127.0.0.1:4321/nlp/'
const privateSql = process.env.NLP_PRIVATE_SQL
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOQLwsGIgYIBQAYngOhqIkM0AAAAABJRU5ErkJggg==', 'base64')
let worker, frontend

test.beforeAll(async () => {
  worker = await startWorker({ port: 8787 })
  frontend = await startFrontend()
})
test.afterAll(async () => {
  await frontend?.close()
  await worker?.close()
})

async function githubLogin(page, code = 'owner') {
  await page.route('https://github.com/login/oauth/authorize?**', route => {
    const url = new URL(route.request().url())
    const redirect = new URL(url.searchParams.get('redirect_uri'))
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', url.searchParams.get('state'))
    return route.fulfill({ status: 302, headers: { location: redirect.toString() } })
  })
  await page.getByRole('button', { name: '管理者は GitHub でログイン' }).click()
}

async function setPassword(page, value) {
  await page.getByRole('button', { name: '管理', exact: true }).click()
  await page.getByLabel('新しい閲覧パスワード').fill(value)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'パスワードを更新' }).click()
  await expect(page.locator('#admin-feedback')).toContainText('更新しました')
  await page.locator('#admin-dialog').getByRole('button', { name: '閉じる' }).click()
}

async function viewerLogin(page, value) {
  await page.locator('#viewer-password').fill(value)
  await page.getByRole('button', { name: '教科書を開く' }).click()
}

test('admin editing, mobile reader, password rotation, assets, history and restorable backup', async ({ browser, page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()) })
  const first = randomBytes(32).toString('base64url')
  const rotated = randomBytes(32).toString('base64url')
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const reader = await mobile.newPage()
  const external = []
  reader.on('request', request => { if (request.url().includes('example.invalid')) external.push(request.url()) })
  try {
    await reader.goto(site + '#s-test/eq-1.1')
    await expect(reader.getByRole('heading', { name: '閲覧ログイン' })).toBeVisible()
    await expect(reader.locator('#toc')).toBeEmpty()
    await expect(reader.locator('#prose')).toBeEmpty()

    await page.goto(site + '#s-test')
    await githubLogin(page)
    await expect(page.locator('#content-title')).toContainText('数式と検索')
    expect(new URL(page.url()).search).toBe('')
    expect(page.url()).toContain('#s-test')
    await setPassword(page, first)
    await viewerLogin(reader, 'incorrect-password')
    await expect(reader.locator('#login-error')).toContainText('パスワードを確認')
    await viewerLogin(reader, first)
    await expect(reader.locator('#eq-1\\.1 .katex')).toBeVisible()
    await expect(reader.locator('.footnote-ref a')).toHaveText('*7')
    await expect(reader.locator('.footnotes-list li')).toContainText('*7')
    await expect(reader.locator('#prose table')).toHaveCount(1)
    await expect(reader.locator('html')).not.toHaveAttribute('data-injected', 'yes')
    expect(external).toHaveLength(0)
    expect(await reader.locator('#eq-1\\.1').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await reader.locator('#eq-1\\.1 .math-numbered').evaluate(node => {
      const expression = node.querySelector('.math-expression').getBoundingClientRect()
      const number = node.querySelector('.katex-tag').getBoundingClientRect()
      return expression.right <= number.left
    })).toBe(true)
    await reader.getByRole('button', { name: '配色を切り替え' }).click()
    await expect(reader.locator('html')).toHaveAttribute('data-theme', 'dark')
    await reader.getByRole('button', { name: '本文の文字を大きくする' }).click()
    expect(await reader.locator('html').evaluate(node => node.style.getPropertyValue('--text-size'))).toBe('19px')

    await reader.getByRole('button', { name: '検索', exact: true }).click()
    await reader.getByRole('searchbox').fill('検索対象語')
    await reader.locator('#search-dialog').getByRole('button', { name: '検索', exact: true }).click()
    await reader.locator('#search-results').getByRole('link', { name: /数式と検索/ }).click()
    await expect(reader.locator('#content-title')).toContainText('数式と検索')
    await reader.getByRole('link', { name: '1.1', exact: true }).click()
    await expect(reader).toHaveURL(/#s-test\/eq-1\.1$/)
    await reader.getByRole('button', { name: '記号表', exact: true }).click()
    await expect(reader.locator('#prose')).toContainText('記号')
    await reader.goto(site + '#s-empty')
    await expect(reader.locator('#content-notice')).toContainText('未収録')

    await page.getByRole('button', { name: '編集', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown / LaTeX 本文' })
    const formula = '更新後の本文です。\n\n$$\n\\frac{x}{2}\\tag{1.2}\n$$'
    await editor.fill('$$\n\\unknowncommand\n$$')
    await expect(page.locator('#math-feedback')).toContainText('数式エラー')
    await editor.fill(formula)
    await expect(page.locator('#preview .katex')).toBeVisible()
    await page.getByRole('button', { name: '図版の管理' }).click()
    await page.locator('input[type="file"]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png })
    await page.getByLabel('代替テキスト').fill('追加した図版')
    await page.getByLabel('キャプション').fill('試験用キャプション')
    await page.getByRole('button', { name: '図版を追加して参照を挿入' }).click()
    await expect(page.locator('#asset-feedback')).toContainText('参照を挿入')
    await page.locator('#asset-dialog').getByRole('button', { name: '閉じる' }).click()
    await editor.press('ControlOrMeta+s')
    await expect(page.locator('#editor-dialog')).not.toBeVisible()
    await expect(page.locator('#prose')).toContainText('更新後の本文')
    await reader.goto(site + '#s-test')
    await expect(reader.locator('#prose')).toContainText('更新後の本文')
    const figure = reader.getByAltText('追加した図版')
    await figure.scrollIntoViewIfNeeded()
    await expect(figure).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => figure.evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
    await reader.reload()
    await expect(reader.locator('#eq-1\\.2 .katex')).toBeVisible()

    await page.getByRole('button', { name: '編集', exact: true }).click()
    await page.getByRole('button', { name: '編集履歴' }).click()
    await page.getByRole('button', { name: /^版 1\b/ }).click()
    await expect(page.locator('#history-diff')).toContainText('更新後の本文')
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'この版に復元' }).click()
    await expect(page.locator('#prose')).toContainText('検索対象語')
    await expect(page.locator('#page-info')).toContainText('版 3')

    await page.getByRole('button', { name: '管理', exact: true }).click()
    await page.getByRole('button', { name: '章節を追加' }).click()
    await page.getByLabel('タイトル', { exact: true }).fill('ブラウザで新しい節')
    await page.getByLabel('種類', { exact: true }).selectOption('section')
    await page.getByLabel('親の章節').selectOption('ch-test')
    await page.getByLabel('校正状態').selectOption('verified')
    await page.getByRole('textbox', { name: 'Markdown / LaTeX 本文' }).fill('節を追加できました。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('#content-title')).toContainText('ブラウザで新しい節')
    const created = page.url()
    await reader.goto(created)
    await expect(reader.locator('#prose')).toContainText('節を追加できました')

    await setPassword(page, rotated)
    await reader.reload()
    await expect(reader.getByRole('heading', { name: '閲覧ログイン' })).toBeVisible()
    await viewerLogin(reader, first)
    await expect(reader.locator('#login-error')).toContainText('パスワードを確認')
    await viewerLogin(reader, rotated)
    await expect(reader.locator('#prose')).toContainText('節を追加できました')

    await page.getByRole('button', { name: '管理', exact: true }).click()
    const downloaded = page.waitForEvent('download', { timeout: 12_000 })
    await page.getByRole('button', { name: 'バックアップを取得' }).click()
    const download = await downloaded
    const data = JSON.parse(readFileSync(await download.path(), 'utf8'))
    expect(data.format).toBe('nlp-textbook-backup/v1')
    expect(data.entries.find(item => item.section.id === 's-test').history).toHaveLength(3)
    expect(JSON.stringify(data)).not.toContain(rotated)
    const tmp = mkdtempSync(resolve(root, '.wrangler/backup-test-'))
    try {
      const file = resolve(tmp, 'from-browser.backup.json')
      const sql = resolve(tmp, 'restore.sql')
      await download.saveAs(file)
      execFileSync('python3', [resolve(root, 'scripts/import_content.py'), '--backup', file, '--output', sql])
      const db = new DatabaseSync(':memory:')
      db.exec(readFileSync(resolve(root, 'worker/migrations/0001_initial.sql'), 'utf8'))
      db.exec(readFileSync(sql, 'utf8'))
      expect(db.prepare('SELECT count(*) AS n FROM revisions WHERE section_id = ?').get('s-test').n).toBe(3)
      expect(db.prepare('SELECT count(*) AS n FROM asset_chunks').get().n).toBeGreaterThan(0)
      expect(db.prepare('SELECT count(*) AS n FROM sessions').get().n).toBe(0)
      db.close()
    } finally { rmSync(tmp, { recursive: true, force: true }) }
    expect(errors).toEqual([])
  } finally { await mobile.close() }
})

test('GitHub login rejects a different numeric identity', async ({ page }) => {
  await page.goto(site)
  await githubLogin(page, 'visitor')
  await expect(page.locator('#login-error')).toContainText('管理権限がありません')
  await expect(page.locator('#toc')).toBeEmpty()
})

test('private initial manifest renders symbols and all recorded sections', async ({ page }) => {
  test.skip(!privateSql, 'Set NLP_PRIVATE_SQL to a local, compiled private import.')
  await worker.close()
  worker = await startWorker({ port: 8787, privateSql: resolve(privateSql) })
  await page.goto(site + '#s-2-5-1/eq-2.12')
  await githubLogin(page)
  await expect(page.locator('#prose .katex')).not.toHaveCount(0)
  const password = randomBytes(32).toString('base64url')
  await setPassword(page, password)
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click()
  await viewerLogin(page, password)
  await expect(page.locator('#eq-2\\.12')).toBeVisible()
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('nlp.session')).token)
  const toc = await fetch(worker.base + '/toc', { headers: { Authorization: 'Bearer ' + token } }).then(response => response.json())
  expect(toc.sections).toHaveLength(161)
  let figures = 0
  let formulas = 0
  for (const row of toc.sections.filter(item => item.status !== 'missing')) {
    await page.goto(site + '#' + row.id)
    await expect(page.locator('#content-title')).toContainText(row.title)
    await expect(page.locator('#prose > *').first()).toBeVisible()
    await expect(page.locator('#prose .math-error')).toHaveCount(0)
    formulas += await page.locator('#prose .katex').count()
    const images = await page.locator('#prose img').all()
    for (const image of images) {
      await image.scrollIntoViewIfNeeded()
      await expect(image).toHaveAttribute('src', /^blob:/)
      await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0)
      figures++
    }
  }
  expect(figures).toBe(8)
  expect(formulas).toBe(317)
  await page.goto(site + '#symbols')
  await expect(page.locator('#prose table')).toHaveCount(8)
  await expect(page.locator('.footnote-ref a')).toHaveText('*3')
  await page.goto(site + '#ch-11')
  await expect(page.locator('#content-notice')).toContainText('未収録')
})
