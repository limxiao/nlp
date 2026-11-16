export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}

export function link(hash: string, text: string) {
  const anchor = element('a', text)
  anchor.href = '#' + hash
  return anchor
}

export function field<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(form: HTMLFormElement, name: string) {
  return form.elements.namedItem(name) as T
}

export async function busy(button: HTMLButtonElement, work: () => Promise<void>) {
  if (button.disabled) return
  button.disabled = true
  try { await work() } finally { button.disabled = false }
}
