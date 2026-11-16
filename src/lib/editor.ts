import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { diffLines } from 'diff'
import { api, get, message, send } from './api'
import { $, busy, element, field } from './dom'
import { Figures, renderMarkdown } from './render'
import { sectionLabel, type Content, type HistoryItem, type Section, type TocItem } from './types'

const form = $<HTMLFormElement>('section-form')
const dialog = $<HTMLDialogElement>('editor-dialog')
const historyDialog = $<HTMLDialogElement>('history-dialog')
const assetDialog = $<HTMLDialogElement>('asset-dialog')
const assetForm = $<HTMLFormElement>('asset-form')
const preview = $('preview')
const date = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
const kindParents: Record<string, string[]> = {
  section: ['chapter'], subsection: ['section'], exercises: ['chapter']
}
const numericFields = ['print_from', 'print_to', 'source_from', 'source_to']
const textFields = ['title', 'number', 'print_label', 'source_file', 'status', 'kind', 'parent_id']

function texMarks(view: EditorView): DecorationSet {
  const source = view.state.doc.toString()
  const marks = []
  const math = /(?<!\\)(\$\$)([\s\S]*?)(?<!\\)\$\$|(?<![\\$])(\$)([^\n$]+?)(?<!\\)\$/g
  for (const match of source.matchAll(math)) {
    const begin = match.index!
    const end = begin + match[0].length
    marks.push(Decoration.mark({ class: 'cm-tex' }).range(begin, end))
    for (const command of match[0].matchAll(/\\[A-Za-z]+/g)) {
      const start = begin + command.index!
      marks.push(Decoration.mark({ class: 'cm-tex-command' }).range(start, start + command[0].length))
    }
  }
  return Decoration.set(marks, true)
}

const texHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = texMarks(view) }
  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = texMarks(update.view)
  }
}, { decorations: plugin => plugin.decorations })

async function imageForUpload(file: File) {
  if (!['image/webp', 'image/png', 'image/jpeg'].includes(file.type)) throw new Error('image type')
  if (file.size > 25_000_000) throw new Error('image size')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    let ratio = Math.min(1, 2400 / Math.max(image.width, image.height))
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .9))
      if (blob && blob.size <= 1_500_000 && blob.type === 'image/webp') {
        return file.size < blob.size && ratio === 1 ? file : blob
      }
      ratio *= .75
    }
    if (file.size <= 1_500_000) return file
    throw new Error('image size')
  } finally { image.close() }
}

export class Editor {
  private view?: EditorView
  private data?: Content
  private source = ''
  private timer?: ReturnType<typeof setTimeout>
  private saving = false
  private selectedRevision?: Section
  private nextRevision: number | null = null
  private figures = new Figures()

  constructor(
    private readonly toc: () => TocItem[],
    private readonly saved: (id?: string) => Promise<void>,
    private readonly notify: (message: string) => void
  ) {
    form.addEventListener('input', event => {
      if (event.target === field(form, 'kind') && !this.data) this.parents()
    })
    field(form, 'parent_id').addEventListener('change', () => {
      if (!this.data) field(form, 'position').value = String(this.nextPosition(field(form, 'parent_id').value || null))
    })
    form.addEventListener('submit', event => { event.preventDefault(); void this.save() })
    dialog.addEventListener('keydown', event => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!this.data?.section.deleted) form.requestSubmit()
      }
    })
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    $('editor-close').addEventListener('click', () => this.close())
    $('editor-discard').addEventListener('click', () => this.close())
    $('delete-section').addEventListener('click', () => void this.remove())
    $('history-open').addEventListener('click', () => void this.showHistory(true))
    $('history-more').addEventListener('click', () => void this.showHistory(false))
    $('restore').addEventListener('click', () => void this.restore())
    $('asset-open').addEventListener('click', () => {
      assetDialog.showModal()
      $('asset-feedback').textContent = ''
      assetForm.reset()
      this.paintAssets()
    })
    assetForm.addEventListener('submit', event => { event.preventDefault(); void this.upload() })
    window.addEventListener('beforeunload', event => {
      if (dialog.open && this.dirty()) {
        event.preventDefault()
        event.returnValue = ''
      }
    })
  }

  private nextPosition(parent: string | null) {
    return Math.min(1_000_000, Math.max(0, ...this.toc().filter(row => row.parent_id === parent).map(row => row.position)) + 10)
  }

  private parents() {
    const kind = field(form, 'kind').value
    const parentSelect = field<HTMLSelectElement>(form, 'parent_id')
    const old = parentSelect.value
    const kinds = kindParents[kind] ?? []
    const choices = this.toc().filter(row => kinds.includes(row.kind) && !row.deleted)
    parentSelect.replaceChildren(new Option(kind === 'section' || kind === 'subsection' ? '親を選択' : 'なし', ''))
    for (const row of choices) parentSelect.append(new Option(sectionLabel(row), row.id))
    if (choices.some(row => row.id === old)) parentSelect.value = old
    parentSelect.required = !this.data && (kind === 'section' || kind === 'subsection')
    $('parent-field').hidden = Boolean(this.data) || kinds.length === 0
    if (!this.data) field(form, 'position').value = String(this.nextPosition(parentSelect.value || null))
  }

  open(data?: Content) {
    this.reset()
    this.data = data
    const section = data?.section
    form.reset()
    field(form, 'kind').value = section?.kind ?? 'chapter'
    this.parents()
    const disabled = Boolean(section?.deleted)
    for (const key of [...textFields, ...numericFields, 'published', 'position']) {
      const input = field(form, key)
      input.disabled = disabled
      if (section) input.value = String(section[key as keyof Section] ?? '')
    }
    $('kind-field').hidden = Boolean(data)
    $('editor-title').textContent = section ? '章節を編集' : '章節を追加'
    $('editor-feedback').textContent = disabled ? '削除済みです。編集履歴から復元できます。' : ''
    $('history-open').hidden = !section
    $('asset-open').hidden = !section || disabled
    $('delete-section').hidden = !section || disabled
    $('save-section').hidden = disabled
    this.view = new EditorView({
      parent: $('code-editor'),
      state: EditorState.create({
        doc: section?.body ?? '',
        extensions: [
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown / LaTeX 本文' }),
          EditorState.readOnly.of(disabled), EditorView.lineWrapping, lineNumbers(), history(), markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }), texHighlight,
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { if (!disabled) form.requestSubmit(); return true } },
            ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return
            clearTimeout(this.timer)
            this.timer = setTimeout(() => this.paintPreview(), 150)
          })
        ]
      })
    })
    this.source = JSON.stringify(this.payload())
    dialog.showModal()
    this.paintPreview()
  }

  reset() {
    clearTimeout(this.timer)
    this.view?.destroy()
    this.view = undefined
    this.data = undefined
    this.selectedRevision = undefined
    this.figures.clear()
    form.reset()
    preview.replaceChildren()
    $('math-feedback').textContent = ''
    $('history-diff').replaceChildren()
    $('history-list').replaceChildren()
    $('asset-list').replaceChildren()
    assetForm.reset()
    for (const modal of [historyDialog, assetDialog, dialog]) if (modal.open) modal.close()
  }

  private payload() {
    const data: Record<string, unknown> = {
      body: this.view?.state.doc.toString() ?? '',
      revision: this.data?.section.revision,
      position: field(form, 'position').valueAsNumber,
      published: Number(field(form, 'published').value)
    }
    for (const key of textFields) data[key] = field(form, key).value
    for (const key of numericFields) data[key] = field(form, key).value ? field(form, key).valueAsNumber : null
    return data
  }

  private dirty() { return this.source !== JSON.stringify(this.payload()) }

  private close() {
    if (this.saving) return
    if (this.dirty() && !confirm('保存していない変更を破棄しますか？')) return
    this.reset()
  }

  private paintPreview() {
    if (!this.view) return
    const errors = renderMarkdown(preview, this.view.state.doc.toString(), 'preview')
    this.figures.paint(preview, this.data?.assets ?? [], true)
    $('math-feedback').textContent = errors.length ? '数式エラーを確認してください。\n' + errors.slice(0, 5).join('\n') : ''
  }

  private async save() {
    if (this.saving || !this.view) return
    const data = this.payload()
    const errors = renderMarkdown(preview, String(data.body), 'preview')
    this.figures.paint(preview, this.data?.assets ?? [], true)
    if (errors.length) {
      $('math-feedback').textContent = '数式エラーを確認してください。\n' + errors.slice(0, 5).join('\n')
      return
    }
    this.saving = true
    const button = $<HTMLButtonElement>('save-section')
    button.disabled = true
    try {
      const id = this.data?.section.id
      const response = await send<{ id: string }>('/admin/sections' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data)
      this.reset()
      this.notify('保存しました。')
      await this.saved(response.id)
    } catch (error) {
      if (dialog.open) $('editor-feedback').textContent = message(error)
      else this.notify(message(error))
    } finally {
      button.disabled = false
      this.saving = false
    }
  }

  private async remove() {
    const section = this.data?.section
    if (this.saving || !section || !confirm('この章節を削除しますか？ 配下の節は閲覧者の目次からも非表示になります。')) return
    this.saving = true
    try {
      await send('/admin/sections/' + section.id, 'DELETE', { revision: section.revision })
      this.reset()
      await this.saved(section.id)
      this.notify('削除しました。')
    } catch (error) { $('editor-feedback').textContent = message(error) }
    finally { this.saving = false }
  }

  private async showHistory(reset: boolean) {
    const section = this.data?.section
    if (!section) return
    if (reset) {
      this.selectedRevision = undefined
      this.nextRevision = null
      $('history-diff').hidden = true
      $('restore').hidden = true
      $('history-list').replaceChildren()
      historyDialog.showModal()
    }
    $('history-more').hidden = true
    $('history-feedback').textContent = ''
    const path = '/admin/sections/' + section.id + '/history'
    try {
      const { revisions, next } = await get<{ revisions: HistoryItem[]; next: number | null }>(path + (this.nextRevision ? '?before=' + this.nextRevision : ''))
      if (section !== this.data?.section || !historyDialog.open) return
      for (const revision of revisions) {
        const actions: Record<string, string> = { create: '登録', import: '取り込み', edit: '編集', delete: '削除', restore: '復元' }
        const row = element('div', undefined, 'history-row')
        const select = element('button', '版 ' + revision.revision + '　' + date.format(revision.updated_at * 1000) + '　' + (actions[revision.action] ?? revision.action), 'quiet')
        select.type = 'button'
        select.addEventListener('click', async () => {
          try {
            const { snapshot } = await get<{ snapshot: Section }>(path + '?revision=' + revision.revision)
            if (section !== this.data?.section || !historyDialog.open) return
            this.selectedRevision = snapshot
            const diff = $('history-diff')
            diff.hidden = false
            const metadata = (row: Section) => [
              row.title, row.number, row.position, row.status, row.published, row.deleted,
              row.print_label, row.print_from, row.print_to, row.source_file, row.source_from, row.source_to, '', row.body
            ].join('\n')
            const changes = diffLines(metadata(snapshot), metadata(section), { timeout: 500 })
            diff.replaceChildren(...(changes?.map(part => element(part.added ? 'ins' : part.removed ? 'del' : 'span', part.value)) ??
              [element('span', '差分の計算に時間がかかりました。\n' + snapshot.body)]))
            $('restore').hidden = Boolean(snapshot.deleted) || snapshot.revision === section.revision
          } catch (error) { $('history-feedback').textContent = message(error) }
        })
        row.append(select)
        $('history-list').append(row)
      }
      this.nextRevision = next
      $('history-more').hidden = !next
    } catch (error) { $('history-feedback').textContent = message(error) }
  }

  private async restore() {
    const current = this.data?.section
    const target = this.selectedRevision
    if (!current || !target || !confirm('版 ' + target.revision + ' を新しい版として復元しますか？')) return
    await busy($<HTMLButtonElement>('restore'), async () => {
      try {
        await send('/admin/sections/' + current.id + '/restore', 'POST', { target: target.revision, revision: current.revision })
        this.reset()
        await this.saved(current.id)
        this.notify('復元しました。')
      } catch (error) { $('history-feedback').textContent = message(error) }
    })
  }

  private paintAssets() {
    const assets = this.data?.assets ?? []
    const list = $('asset-list')
    list.replaceChildren()
    const replacement = field<HTMLSelectElement>(assetForm, 'replacement')
    replacement.replaceChildren(new Option('新規追加', ''))
    for (const asset of assets) {
      const row = element('div', undefined, 'asset-row')
      const caption = asset.caption || asset.alt
      row.append(element('p', caption + (asset.deleted ? '（削除済み）' : '')))
      if (!asset.deleted) replacement.append(new Option(caption, asset.id))
      const action = element('button', asset.deleted ? '復元' : '削除', asset.deleted ? 'quiet' : 'danger')
      action.type = 'button'
      action.addEventListener('click', () => {
        if (!asset.deleted && !confirm('この図版を削除しますか？')) return
        void busy(action, async () => {
          try {
            await send('/admin/assets/' + asset.id + (asset.deleted ? '/restore' : ''), asset.deleted ? 'POST' : 'DELETE', {})
            await this.reloadAssets()
          } catch (error) { $('asset-feedback').textContent = message(error) }
        })
      })
      row.append(action)
      list.append(row)
    }
  }

  private async reloadAssets() {
    const data = this.data
    if (!data) return
    const updated = await get<Content>('/sections/' + data.section.id)
    if (data !== this.data) return
    data.assets = updated.assets
    this.figures.clear()
    this.paintAssets()
    this.paintPreview()
  }

  private async upload() {
    const section = this.data?.section
    const file = field(assetForm, 'file').files?.[0]
    if (!section || !file) return
    await busy(assetForm.querySelector('button[type="submit"]')!, async () => {
      $('asset-feedback').textContent = '図版を処理しています…'
      const alt = field(assetForm, 'alt').value
      const old = field(assetForm, 'replacement').value
      const meta = {
        alt, caption: field(assetForm, 'caption').value,
        source_file: field(assetForm, 'source_file').value,
        source_page: field(assetForm, 'source_page').valueAsNumber || null,
        print_page: field(assetForm, 'print_page').valueAsNumber || null
      }
      const id = 'fig-' + crypto.randomUUID()
      let blob: Blob
      try { blob = await imageForUpload(file) }
      catch { $('asset-feedback').textContent = '画像を開けませんでした。形式と画像サイズを確認してください。'; return }
      try {
        await api('/admin/assets?' + new URLSearchParams({ section: section.id, id }), {
          method: 'POST', body: blob, headers: {
            'Content-Type': blob.type, 'X-Asset-Metadata': encodeURIComponent(JSON.stringify(meta))
          }
        })
        if (!this.view || section !== this.data?.section) return
        const doc = this.view.state.doc.toString()
        const reference = old ? '(asset:' + old + ')' : ''
        if (reference && doc.includes(reference)) {
          this.view.dispatch({ changes: { from: 0, to: doc.length, insert: doc.replaceAll(reference, '(asset:' + id + ')') } })
        } else {
          const markdown = '\n\n![' + alt.replace(/[\[\]\\]/g, '') + '](asset:' + id + ')\n\n'
          this.view.dispatch({ changes: { from: this.view.state.selection.main.head, insert: markdown } })
        }
        assetForm.reset()
        await this.reloadAssets()
        $('asset-feedback').textContent = '参照を挿入しました。本文を保存すると反映されます。'
      } catch (error) { $('asset-feedback').textContent = message(error) }
    })
  }
}
