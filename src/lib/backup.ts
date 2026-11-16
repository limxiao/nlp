import { ApiError, api, get } from './api'
import type { Content, HistoryItem, Section, Toc } from './types'

async function encodedImage(id: string) {
  const blob = await (await api('/assets/' + id)).blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
    reader.readAsDataURL(blob)
  })
}

export async function downloadBackup(progress: (text: string) => void) {
  const { version } = await get<{ version: number }>('/admin/export')
  const toc = await get<Toc>('/toc')
  const parts: BlobPart[] = [
    '{"format":"nlp-textbook-backup/v1","book":' + JSON.stringify(toc.book) +
    ',"exported_at":' + JSON.stringify(new Date().toISOString()) + ',"entries":['
  ]
  let index = 0
  for (const item of toc.sections) {
    progress('バックアップを取得しています　' + (++index) + ' / ' + toc.sections.length)
    const { section, assets } = await get<Content>('/sections/' + item.id)
    if (index > 1) parts.push(',')
    parts.push('{"section":' + JSON.stringify(section) + ',"assets":[')
    for (const [assetIndex, asset] of assets.entries()) {
      const data_base64 = await encodedImage(asset.id)
      parts.push((assetIndex ? ',' : '') + JSON.stringify({ ...asset, data_base64 }))
    }
    parts.push('],"history":[')
    let before: number | null = null
    let first = true
    do {
      const path = '/admin/sections/' + item.id + '/history'
      const page: { revisions: HistoryItem[]; next: number | null } = await get(path + (before === null ? '' : '?before=' + before))
      for (const history of page.revisions) {
        const { snapshot } = await get<{ snapshot: Section }>(path + '?revision=' + history.revision)
        parts.push((first ? '' : ',') + JSON.stringify({ ...history, snapshot }))
        first = false
      }
      before = page.next
    } while (before !== null)
    parts.push(']}')
  }
  parts.push(']}')
  if ((await get<{ version: number }>('/admin/export')).version !== version) {
    throw new ApiError(409, 'backup_changed')
  }
  const blob = new Blob(parts, { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'nlp-' + new Date().toISOString().slice(0, 10) + '.backup.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
