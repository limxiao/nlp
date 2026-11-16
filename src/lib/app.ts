import { api, beginOAuth, configured, finishOAuth, get, message, randomSecret, readSession, saveSession, send } from './api'
import { $, busy, element, link } from './dom'
import { Figures, renderMarkdown } from './render'
import { sectionLabel, type Content, type SearchHit, type Session, type Toc, type TocItem } from './types'

const loginScreen = $('login')
const loginForm = $<HTMLFormElement>('login-form')
const prose = $('prose')
const tocNav = $('toc')
const tocPanel = $<HTMLDetailsElement>('toc-panel')
const searchDialog = $<HTMLDialogElement>('search-dialog')
const adminDialog = $<HTMLDialogElement>('admin-dialog')
const passwordForm = $<HTMLFormElement>('password-form')
const figures = new Figures()
let session: Session | null = null
let outline: Toc = { book: { title: '', language: 'ja' }, sections: [] }
let current: Content | null = null
let controller = new AbortController()
let searchController = new AbortController()
let expiry: ReturnType<typeof setTimeout>
let toastTimer: ReturnType<typeof setTimeout>
let searchCursor: string | null = null
let searchQuery = ''
let editor: import('./editor').Editor | undefined

const mobile = matchMedia('(max-width: 700px)')
function toast(value: string) {
  const notice = $('toast')
  notice.textContent = value
  notice.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { notice.hidden = true }, 4000)
}

function route() {
  const [id, anchor] = location.hash.slice(1).split('/', 2)
  return { id: /^[a-z0-9][a-z0-9_-]{0,71}$/.test(id) ? id : '', anchor }
}

function showLogin(reason = '') {
  clearTimeout(expiry)
  controller.abort()
  searchController.abort()
  figures.clear()
  editor?.reset()
  session = null
  saveSession(null)
  current = null
  outline.sections = []
  prose.replaceChildren()
  tocNav.replaceChildren()
  for (const id of ['breadcrumbs','content-title','page-info','content-notice','outline','neighbors','search-results','search-input','search-feedback','editor-feedback','history-list','history-diff','asset-list']) {
    $(id).replaceChildren()
  }
  $<HTMLInputElement>('search-input').value = ''
  $<HTMLInputElement>('viewer-password').value = ''
  passwordForm.reset()
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close()
  $('reader').hidden = true
  $('reader-tools').hidden = true
  loginScreen.hidden = false
  $('login-error').textContent = reason
}

async function activate(next: Session) {
  session = next
  saveSession(next)
  $('reader').hidden = false
  $('reader-tools').hidden = false
  $('copy-link').hidden = true
  $('admin-open').hidden = next.role !== 'admin'
  $('edit-open').hidden = true
  loginScreen.hidden = true
  tocPanel.open = !mobile.matches
  clearTimeout(expiry)
  expiry = setTimeout(() => showLogin('セッションの有効期限が切れました。ログインしてください。'), Math.max(0, next.expires * 1000 - Date.now()))
  await refresh()
}

let navItems: TocItem[] = []
function drawToc(selected = '') {
  const children = new Map<string | null, TocItem[]>()
  for (const row of outline.sections) {
    const siblings = children.get(row.parent_id) ?? []
    siblings.push(row)
    children.set(row.parent_id, siblings)
  }
  navItems = []
  function branch(parent: string | null): HTMLUListElement {
    const list = element('ul')
    for (const row of children.get(parent) ?? []) {
      navItems.push(row)
      const item = element('li')
      const label = sectionLabel(row) + (row.deleted ? '（削除済み）' : row.published ? '' : '（非公開）')
      const anchor = link(row.id, label)
      if (row.id === selected) anchor.setAttribute('aria-current', 'page')
      if (row.status === 'missing' || row.deleted) anchor.dataset.muted = 'true'
      item.append(anchor)
      if (children.has(row.id)) item.append(branch(row.id))
      list.append(item)
    }
    return list
  }
  const previousScroll = tocPanel.scrollTop
  tocNav.replaceChildren(branch(null))
  tocPanel.scrollTop = previousScroll
  $('symbol-link').hidden = !outline.sections.some(row => row.id === 'symbols' && !row.deleted)
}

function pages(from: number | null, to: number | null): string {
  if (from == null) return ''
  return from + (to && to !== from ? '–' + to : '')
}

function showSection(data: Content) {
  const { section, assets } = data
  $('content-title').textContent = sectionLabel(section)
  $('edit-open').hidden = session?.role !== 'admin'
  $('copy-link').hidden = false

  const parents: TocItem[] = []
  let parent = outline.sections.find(item => item.id === section.parent_id)
  while (parent) {
    parents.unshift(parent)
    parent = outline.sections.find(item => item.id === parent!.parent_id)
  }
  $('breadcrumbs').replaceChildren(...parents.flatMap(item => [link(item.id, sectionLabel(item)), '　/　']), sectionLabel(section))
  const print = section.print_label || pages(section.print_from, section.print_to)
  $('page-info').textContent = [
    print && '印刷ページ ' + print,
    session?.role === 'admin' && section.source_file && section.source_file + '  p. ' + pages(section.source_from, section.source_to),
    session?.role === 'admin' && '版 ' + section.revision
  ].filter(Boolean).join('　·　')

  const children = navItems.filter(row => row.parent_id === section.id)
  const hasRecordedChildren = children.some(row => row.status !== 'missing' || navItems.some(child => child.parent_id === row.id && child.status !== 'missing'))
  const notice = $('content-notice')
  notice.textContent = section.deleted ? '削除済みの章節です。'
    : section.status === 'missing' ? (hasRecordedChildren ? '' : 'この章節の本文は未収録です。')
    : section.status === 'review' ? 'この章節には校正待ちの内容があります。'
    : section.status === 'draft' ? '下書きの本文を表示しています。'
    : ''
  if (!section.published && !section.deleted) notice.textContent = ['非公開の章節です。', notice.textContent].filter(Boolean).join(' ')
  notice.hidden = !notice.textContent

  if (section.body) {
    renderMarkdown(prose, section.body, section.id)
    figures.paint(prose, assets, session?.role === 'admin')
  }
  if (children.length) {
    const heading = element('h2', 'この章節の内容')
    heading.id = section.id + '-contents'
    const list = element('ul')
    for (const child of children) {
      const item = element('li')
      item.append(link(child.id, sectionLabel(child)))
      list.append(item)
    }
    prose.append(heading, list)
  }
  const top = link(section.id, sectionLabel(section))
  top.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    go(section.id)
  })
  $('outline').replaceChildren(top, ...[...prose.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
    .filter(heading => heading.id)
    .map(heading => link(section.id + '/' + heading.id, heading.textContent ?? '')))
  const index = navItems.findIndex(row => row.id === section.id)
  const neighboring = $('neighbors')
  neighboring.replaceChildren()
  if (navItems[index - 1]) {
    const previous = navItems[index - 1]
    neighboring.append(link(previous.id, '← ' + sectionLabel(previous)))
  }
  if (index >= 0 && navItems[index + 1]) {
    const next = navItems[index + 1]
    neighboring.append(link(next.id, sectionLabel(next) + ' →'))
  }
}

async function openCurrent(moveFocus = false) {
  if (!session) return
  const { id, anchor } = route()
  const chosen = id || outline.sections.find(row => row.kind === 'chapter' && !row.deleted)?.id || outline.sections[0]?.id
  if (current && current.section.id === chosen) {
    if (anchor) scrollAnchor(anchor)
    else if (moveFocus) focusArticle()
    return
  }
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  figures.clear()
  current = null
  prose.replaceChildren()
  $('outline').replaceChildren()
  $('neighbors').replaceChildren()
  $('breadcrumbs').replaceChildren()
  $('page-info').textContent = ''
  $('content-notice').hidden = true
  $('copy-link').hidden = true
  $('edit-open').hidden = true
  if (!chosen) {
    $('content-title').textContent = '目次はまだ登録されていません'
    return
  }
  if (!id) history.replaceState(null, '', '#' + chosen)
  drawToc(chosen)
  $('content-title').textContent = '読み込み中…'
  try {
    const data = await get<Content>(chosen === 'symbols' ? '/symbols' : '/sections/' + chosen, signal)
    if (signal.aborted || !session) return
    current = data
    showSection(data)
    if (anchor) scrollAnchor(anchor)
    else if (moveFocus) focusArticle()
  } catch (error) {
    if (signal.aborted || !session) return
    $('content-title').textContent = message(error)
  }
}

function focusArticle() {
  $('reading-content').focus({ preventScroll: true })
  window.scrollTo(0, 0)
}

function scrollAnchor(id: string) {
  const target = Array.from(prose.querySelectorAll<HTMLElement>('[id]')).find(node => node.id === id)
  target?.scrollIntoView({ block: 'start' })
}

function go(id: string) {
  if (location.hash === '#' + id) void openCurrent(true)
  else location.hash = id
}

async function refresh(id?: string) {
  const before = session
  const next = await get<Toc>('/toc')
  if (!before || before !== session) return
  outline = next
  drawToc()
  current = null
  if (id) history.replaceState(null, '', '#' + id)
  await openCurrent()
}

async function getEditor() {
  if (!editor) {
    const { Editor } = await import('./editor')
    editor ??= new Editor(() => outline.sections, refresh, toast)
  }
  return editor
}

document.querySelector('.skip')?.addEventListener('click', event => {
  event.preventDefault()
  if (session) focusArticle()
  else $('viewer-password').focus()
})
window.addEventListener('hashchange', () => {
  if (location.hash === '#reading-content') return
  if (mobile.matches) tocPanel.open = false
  void openCurrent(true)
})
window.addEventListener('pageshow', event => {
  if (event.persisted && session) {
    void get('/auth/session').then(() => refresh()).catch(error => showLogin(message(error)))
  }
})
document.addEventListener('nlp:expired', () => showLogin('セッションの有効期限が切れました。ログインしてください。'))
prose.addEventListener('click', event => {
  const anchor = (event.target as HTMLElement).closest('a[href^="#"]')
  if (!current || !anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const hash = anchor.getAttribute('href')!.slice(1)
  if (hash.includes('/') || !hash) return
  if (!Array.from(prose.querySelectorAll('[id]')).some(node => node.id === hash)) return
  event.preventDefault()
  go(current.section.id + '/' + hash)
})

loginForm.addEventListener('submit', event => {
  event.preventDefault()
  const submit = loginForm.querySelector('button')!
  void busy(submit, async () => {
    $('login-error').textContent = ''
    try {
      const input = $<HTMLInputElement>('viewer-password')
      const next = await send<Session>('/auth/login', 'POST', { password: input.value }, true)
      input.value = ''
      await activate(next)
    } catch (error) { showLogin(message(error)) }
  })
})
$('github').addEventListener('click', () => void busy($<HTMLButtonElement>('github'), async () => {
  $('login-error').textContent = ''
  try { await beginOAuth() } catch (error) { $('login-error').textContent = message(error) }
}))
$('logout').addEventListener('click', () => void busy($<HTMLButtonElement>('logout'), async () => {
  try { await send('/auth/logout', 'POST', {}) }
  catch (error) { if (session) toast(message(error)) }
  finally { showLogin() }
}))
$('symbol-link').addEventListener('click', () => go('symbols'))
$('copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('閲覧リンクをコピーしました。') }
  catch { toast('アドレスバーから閲覧リンクをコピーできます。') }
})

function appearance() {
  const theme = $('theme')
  let dark = (localStorage.getItem('nlp.theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'
  let size = Math.min(26, Math.max(14, Number(localStorage.getItem('nlp.font-size')) || 18))
  const draw = () => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    theme.setAttribute('aria-pressed', String(dark))
    document.documentElement.style.setProperty('--text-size', size + 'px')
    $<HTMLButtonElement>('font-smaller').disabled = size <= 14
    $<HTMLButtonElement>('font-larger').disabled = size >= 26
  }
  theme.addEventListener('click', () => {
    dark = !dark
    localStorage.setItem('nlp.theme', dark ? 'dark' : 'light')
    draw()
  })
  for (const [id, delta] of [['font-smaller', -1], ['font-larger', 1]] as const) {
    $(id).addEventListener('click', () => {
      size = Math.min(26, Math.max(14, size + delta))
      localStorage.setItem('nlp.font-size', String(size))
      draw()
    })
  }
  draw()
}

async function searchMore(reset: boolean) {
  const feedback = $('search-feedback')
  if (reset) {
    searchQuery = $<HTMLInputElement>('search-input').value.trim()
    searchCursor = null
    $('search-results').replaceChildren()
  }
  searchController.abort()
  searchController = new AbortController()
  const { signal } = searchController
  if (!searchQuery) return
  feedback.textContent = '検索中…'
  $('search-more').hidden = true
  try {
    const params = new URLSearchParams({ q: searchQuery })
    if (searchCursor) params.set('after', searchCursor)
    const { hits, next } = await get<{ hits: SearchHit[]; next: string | null }>('/search?' + params, signal)
    if (signal.aborted) return
    feedback.textContent = hits.length ? '' : '該当する章節がありません。'
    for (const result of hits) {
      const row = element('div', undefined, 'result')
      const anchor = link(result.id, [result.number, result.title].filter(Boolean).join('　'))
      anchor.addEventListener('click', () => searchDialog.close())
      row.append(anchor, element('p', result.snippet))
      $('search-results').append(row)
    }
    searchCursor = next
    $('search-more').hidden = !next
  } catch (error) {
    if (!signal.aborted) feedback.textContent = message(error)
  }
}

$('search-open').addEventListener('click', () => { searchDialog.showModal(); $('search-input').focus() })
$('search-form').addEventListener('submit', event => { event.preventDefault(); void searchMore(true) })
$('search-more').addEventListener('click', () => void searchMore(false))
for (const close of document.querySelectorAll<HTMLButtonElement>('[data-close]')) {
  close.addEventListener('click', () => close.closest('dialog')?.close())
}
$('admin-open').addEventListener('click', () => {
  $('admin-feedback').textContent = ''
  adminDialog.showModal()
})
$('create-open').addEventListener('click', async () => {
  try {
    const editor = await getEditor()
    if (session?.role !== 'admin') return
    adminDialog.close()
    editor.open()
  } catch (error) { toast(message(error)) }
})
$('edit-open').addEventListener('click', async () => {
  try {
    const editor = await getEditor()
    if (session?.role === 'admin' && current) editor.open(current)
  } catch (error) { toast(message(error)) }
})

const newPassword = $<HTMLInputElement>('new-password')
const showPassword = $<HTMLButtonElement>('show-password')
function passwordVisibility(visible: boolean) {
  newPassword.type = visible ? 'text' : 'password'
  showPassword.setAttribute('aria-pressed', String(visible))
  showPassword.textContent = visible ? '隠す' : '表示'
}
adminDialog.addEventListener('close', () => {
  passwordForm.reset()
  passwordVisibility(false)
})
$('random-password').addEventListener('click', () => {
  newPassword.value = randomSecret()
  passwordVisibility(true)
  newPassword.focus()
  newPassword.select()
})
showPassword.addEventListener('click', () => passwordVisibility(newPassword.type === 'password'))
passwordForm.addEventListener('submit', event => {
  event.preventDefault()
  if (!confirm('閲覧パスワードを変更し、現在の閲覧者セッションを失効させますか？')) return
  void busy(passwordForm.querySelector('button[type="submit"]')!, async () => {
    try {
      await send('/admin/password', 'POST', { password: newPassword.value })
      $('admin-feedback').textContent = '更新しました。共有する新しいパスワードをこの欄からコピーできます。'
    } catch (error) { $('admin-feedback').textContent = message(error) }
  })
})
$('backup').addEventListener('click', () => void busy($<HTMLButtonElement>('backup'), async () => {
  const feedback = $('admin-feedback')
  try {
    const { downloadBackup } = await import('./backup')
    await downloadBackup(value => { feedback.textContent = value })
    feedback.textContent = 'バックアップを作成しました。'
  } catch (error) { feedback.textContent = message(error) }
}))

async function start() {
  try {
    appearance()
    if (!configured) {
      $('login-error').textContent = '接続先 API の設定を管理者に確認してください。'
      loginForm.querySelector('button')!.disabled = true
      $<HTMLButtonElement>('github').disabled = true
      return
    }
    const authenticated = await finishOAuth()
    if (authenticated) return await activate(authenticated)
    const previous = readSession()
    if (previous) {
      const valid = await get<Omit<Session, 'token'>>('/auth/session')
      await activate({ ...valid, token: previous.token })
    }
  } catch (error) {
    showLogin(message(error))
  }
}
void start()
