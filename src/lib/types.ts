export interface TocItem {
  id: string
  parent_id: string | null
  kind: 'chapter' | 'section' | 'subsection' | 'exercises' | 'symbols' | 'bibliography' | 'frontmatter'
  number: string
  title: string
  position: number
  status: 'missing' | 'draft' | 'review' | 'verified'
  published: number
  deleted: number
  revision: number
}

export interface Section extends TocItem {
  body: string
  print_from: number | null
  print_to: number | null
  print_label: string | null
  source_file: string | null
  source_from: number | null
  source_to: number | null
  created_at: number
  updated_at: number
}

export interface Asset {
  id: string
  section_id: string
  mime: string
  caption: string
  alt: string
  source_file: string | null
  source_page: number | null
  print_page: number | null
  byte_size: number
  deleted: number
  created_at: number
}

export interface Toc {
  book: { title: string; language: string }
  sections: TocItem[]
}
export interface Content { section: Section; assets: Asset[] }
export interface Session { token: string; role: 'viewer' | 'admin'; expires: number }
export interface HistoryItem { revision: number; updated_at: number; action: string }
export type SearchHit = Pick<TocItem, 'id' | 'title' | 'number'> & { snippet: string }

export function sectionLabel(item: TocItem) {
  return [item.number, item.title].filter(Boolean).join('　')
}
