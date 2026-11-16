import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { api } from './api'
import type { Asset } from './types'

const md = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(footnote)
const escape = md.utils.escapeHtml
const assetLink = /^asset:([a-z0-9][a-z0-9_-]{0,71})$/
let heading = 0

interface RenderEnvironment { errors: string[]; prefix: string; docId: string }

md.renderer.rules.footnote_caption = (tokens, i) => {
  const label = String(tokens[i].meta.label ?? (tokens[i].meta.id + 1))
  return '*' + escape(label)
}
const openFootnote = md.renderer.rules.footnote_open!
md.renderer.rules.footnote_open = (tokens, i, options, env, self) => {
  const original = openFootnote(tokens, i, options, env, self)
  const label = env.footnotes?.list?.[tokens[i].meta.id]?.label
  return label != null ? original + '<span class="printed-note">*' + escape(String(label)) + '　</span>' : original
}

md.validateLink = (url) => /^(#|https:\/\/)/i.test(url) || assetLink.test(url)
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  const href = tokens[i].attrGet('href') ?? ''
  if (assetLink.test(href)) tokens[i].attrSet('href', '#' + href.slice(6))
  if (href.startsWith('https:')) {
    tokens[i].attrSet('rel', 'noopener noreferrer')
    tokens[i].attrSet('target', '_blank')
  }
  return self.renderToken(tokens, i, options)
}

md.renderer.rules.image = (tokens, i, options, _env, self) => {
  const token = tokens[i]
  const alt = self.renderInlineAsText(token.children ?? [], options, _env)
  const match = token.attrGet('src')?.match(assetLink)
  if (!match) return '<span class="asset-unavailable">' + escape(alt || '画像') + '</span>'
  return '<span class="figure" data-asset="' + match[1] + '" id="' + match[1] + '"><img alt="' + escape(alt) + '"><span class="caption"></span></span>'
}

function math(source: string, displayMode: boolean, env: RenderEnvironment) {
  const tag = displayMode ? source.match(/\\tag\{([a-zA-Z0-9.\-]+)\}/)?.[1] : undefined
  const id = tag ? ' id="eq-' + tag + '"' : ''
  try {
    const html = katex.renderToString(source, { displayMode, trust: false, throwOnError: true, strict: 'ignore', maxExpand: 300, maxSize: 16 })
    return displayMode ? '<div class="math-block" tabindex="0"' + id + '>' + html + '</div>' : html
  } catch {
    env.errors.push(source.trim().slice(0, 100))
    const fallback = '<code class="math-error">' + escape(source) + '</code>'
    return displayMode ? '<div class="math-block" tabindex="0"' + id + '>' + fallback + '</div>' : fallback
  }
}

md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const start = state.pos
  if (state.src[start] !== '$' || state.src[start + 1] === '$' || /\s/.test(state.src[start + 1] ?? ' ')) return false
  let end = start + 1
  for (; end < state.posMax; end++) {
    if (state.src[end] === '\\') { end++; continue }
    if (state.src[end] === '\n') return false
    if (state.src[end] === '$') break
  }
  if (end >= state.posMax || /\s/.test(state.src[end - 1])) return false
  if (!silent) state.push('math_inline', '', 0).content = state.src.slice(start + 1, end)
  state.pos = end + 1
  return true
})
md.renderer.rules.math_inline = (tokens, i, _options, env) => math(tokens[i].content, false, env)

md.block.ruler.before('fence', 'math_block', (state, start, stop, silent) => {
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).trim()
  if (!first.startsWith('$$') || state.sCount[start] - state.blkIndent >= 4) return false
  const rest = first.slice(2)
  let limit = start
  const lines: string[] = []
  if (rest.endsWith('$$')) lines.push(rest.slice(0, -2))
  else {
    lines.push(rest)
    for (limit = start + 1; limit < stop; limit++) {
      const line = state.src.slice(state.bMarks[limit], state.eMarks[limit])
      if (line.trimEnd().endsWith('$$')) {
        lines.push(line.trimEnd().slice(0, -2))
        break
      }
      lines.push(line)
    }
  }
  const unclosed = limit >= stop
  if (silent) return true
  const token = state.push(unclosed ? 'math_unclosed' : 'math_block', '', 0)
  token.block = true
  token.content = lines.join('\n').trim()
  state.line = unclosed ? stop : limit + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote'] })
md.renderer.rules.math_block = (tokens, i, _options, env) => math(tokens[i].content, true, env)
md.renderer.rules.math_unclosed = (tokens, i, _options, env: RenderEnvironment) => {
  env.errors.push('$$ の閉じ記号がありません。')
  return '<pre class="math-error">' + escape(tokens[i].content) + '</pre>'
}

md.block.ruler.before('paragraph', 'page_marker', (state, start, _stop, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).trim()
  const marker = line.match(/^\[\[page:([0-9]{1,5}|[ivxlcdm]{1,12})\]\]$/i)
  if (!marker) return false
  if (silent) return true
  state.push('page_marker', '', 0).content = marker[1]
  state.line = start + 1
  return true
}, { alt: ['paragraph'] })
md.renderer.rules.page_marker = (tokens, i) =>
  '<div class="page-marker">p. ' + escape(tokens[i].content) + '</div>'

md.renderer.rules.heading_open = (tokens, i, options, env: RenderEnvironment, self) => {
  const next = tokens[i + 1]
  const explicit = next.content.match(/\s+\{#([a-z0-9][a-z0-9_.-]*)\}$/)
  if (explicit) {
    next.content = next.content.slice(0, -explicit[0].length)
    const last = next.children?.at(-1)
    if (last?.type === 'text') last.content = last.content.replace(/\s*\{#[a-z0-9_.-]+\}$/, '')
  }
  tokens[i].attrSet('id', explicit?.[1] ?? env.prefix + '-h' + (++heading))
  return self.renderToken(tokens, i, options)
}
md.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0"><table>'
md.renderer.rules.table_close = () => '</table></div>'

export function renderMarkdown(target: HTMLElement, source: string, prefix: string): string[] {
  heading = 0
  const env: RenderEnvironment = { errors: [], prefix, docId: prefix }
  target.innerHTML = md.render(source, env)
  // KaTeX positions equation numbers absolutely by default. Keep the number
  // and expression in separate columns inside the reader's scroll container.
  for (const tag of target.querySelectorAll('.katex-display > .katex > .katex-html > .katex-tag')) {
    const math = tag.parentElement!
    const expression = document.createElement('span')
    expression.className = 'math-expression'
    expression.append(...[...math.childNodes].filter(node => node !== tag))
    math.replaceChildren(expression, tag)
    math.classList.add('math-numbered')
  }
  return env.errors
}

export class Figures {
  private objects = new Map<string, Promise<string>>()
  private controller = new AbortController()

  clear() {
    this.controller.abort()
    for (const promise of this.objects.values()) promise.then(URL.revokeObjectURL).catch(() => {})
    this.objects.clear()
    this.controller = new AbortController()
  }

  paint(target: HTMLElement, metadata: Asset[], preview = false) {
    const signal = this.controller.signal
    for (const figure of target.querySelectorAll<HTMLElement>('[data-asset]')) {
      const asset = metadata.find(item => item.id === figure.dataset.asset && (!item.deleted || preview))
      const image = figure.querySelector('img')!
      const caption = figure.querySelector<HTMLElement>('.caption')!
      if (!asset) {
        image.remove()
        caption.textContent = '図版を表示できません。'
        continue
      }
      image.alt = asset.alt || image.alt
      caption.textContent = [asset.caption, asset.print_page ? 'p. ' + asset.print_page : ''].filter(Boolean).join('　')
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        observer.disconnect()
        if (signal.aborted || !figure.isConnected) return
        let result = this.objects.get(asset.id)
        if (!result) {
          result = api('/assets/' + asset.id, { signal }).then(r => r.blob()).then(URL.createObjectURL)
          this.objects.set(asset.id, result)
        }
        result.then(url => { if (!signal.aborted) image.src = url }).catch(() => {
          if (!signal.aborted) {
            this.objects.delete(asset.id)
            image.remove()
            caption.textContent = '図版の取得に失敗しました。'
          }
        })
      }, { rootMargin: '240px' })
      observer.observe(figure)
      signal.addEventListener('abort', () => observer.disconnect(), { once: true })
    }
  }
}
