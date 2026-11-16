import { fail, identifier, integer, json, optional, readBytes, readJson, string, type Env } from './http'

const kinds = ['chapter', 'section', 'subsection', 'exercises', 'symbols', 'bibliography', 'frontmatter']
const statuses = ['missing', 'draft', 'review', 'verified']
const parentKinds: Record<string, Array<string | null>> = {
  chapter: [null], section: ['chapter'], subsection: ['section'], exercises: [null, 'chapter'],
  symbols: [null], bibliography: [null], frontmatter: [null]
}
const mutableColumns = [
  'parent_id', 'kind', 'number', 'title', 'position', 'body', 'print_from', 'print_to', 'print_label',
  'source_file', 'source_from', 'source_to', 'status', 'published', 'deleted'
]
const tocColumns = 's.id,s.parent_id,s.kind,s.number,s.title,s.position,s.status,s.published,s.deleted,s.revision'
const assetColumns = 'id,section_id,mime,caption,alt,source_file,source_page,print_page,byte_size,deleted,created_at'
const maxBytes = 1_500_000
const viewerAssetAccess = `AND a.deleted = 0 AND EXISTS (
  SELECT 1 FROM sections owner JOIN visible_sections v ON v.id = owner.id
  WHERE owner.id = a.section_id AND instr(owner.body, '(asset:' || a.id || ')') > 0
)`

const validListItem = (value: unknown, choices: string[]) => {
  const parsed = string(value, 40, 1)
  if (!choices.includes(parsed)) return fail(400, 'invalid_input')
  return parsed
}
const page = (value: unknown) => optional(value, value => integer(value, 1, 100_000))
const bool = (value: unknown) => {
  if (value === true || value === 1) return 1
  if (value === false || value === 0) return 0
  return fail(400, 'invalid_input')
}

async function fields(env: Env, data: Record<string, unknown>, id: string, allowDeletedParent = false) {
  const parent = optional(data.parent_id, identifier)
  const kind = validListItem(data.kind, kinds)
  const status = validListItem(data.status, statuses)
  const body = string(data.body ?? '', 120_000)
  const printFrom = page(data.print_from)
  const printTo = page(data.print_to)
  const sourceFrom = page(data.source_from)
  const sourceTo = page(data.source_to)
  const title = string(data.title, 200, 1).trim()
  if (!title || (status === 'missing' && body.trim()) || (status !== 'missing' && !body.trim())) fail(400, 'invalid_input')
  if ((printTo && (!printFrom || printTo < printFrom)) || (sourceTo && (!sourceFrom || sourceTo < sourceFrom))) fail(400, 'invalid_input')
  if (parent === id) fail(400, 'invalid_parent')
  const parentRow = parent ? await env.DB.prepare('SELECT kind, deleted FROM sections WHERE id = ?')
    .bind(parent).first<{ kind: string; deleted: number }>() : null
  if ((parent && (!parentRow || (parentRow.deleted && !allowDeletedParent))) ||
      !parentKinds[kind].includes(parentRow?.kind ?? null)) fail(400, 'invalid_parent')
  return [
    parent, kind, string(data.number ?? '', 32), title, integer(data.position, 0, 1_000_000),
    status === 'missing' ? '' : body, printFrom, printTo, optional(data.print_label, value => string(value, 48)),
    optional(data.source_file, value => string(value, 240)), sourceFrom, sourceTo, status, bool(data.published), bool(data.deleted ?? 0)
  ]
}

export async function toc(env: Env, admin: boolean): Promise<Response> {
  const [book, items] = await env.DB.batch([
    env.DB.prepare('SELECT title,language FROM book WHERE id = 1'),
    env.DB.prepare(`SELECT ${tocColumns} FROM sections s ${admin ? '' : 'JOIN visible_sections v ON v.id = s.id'} ORDER BY s.position,s.id`)
  ])
  return json({ book: book.results[0], sections: items.results })
}

export async function section(env: Env, admin: boolean, id: string): Promise<Response> {
  const visibility = admin ? '' : 'AND id IN (SELECT id FROM visible_sections)'
  const [content, assets] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM sections WHERE id = ? ${visibility}`).bind(id),
    env.DB.prepare(`SELECT ${assetColumns} FROM assets a WHERE section_id = ? ${admin ? '' : viewerAssetAccess} ORDER BY id`).bind(id)
  ])
  if (!content.results[0]) return fail(404, 'not_found')
  return json({ section: content.results[0], assets: assets.results })
}

export async function search(env: Env, url: URL, admin: boolean): Promise<Response> {
  const query = string((url.searchParams.get('q') ?? '').trim(), 80, 1)
  const cursor = url.searchParams.get('after') ?? ''
  if (cursor) identifier(cursor)
  const visibility = admin ? 'AND s.deleted = 0' : 'AND s.id IN (SELECT id FROM visible_sections)'
  const phrase = '"' + query.replaceAll('"', '""') + '"'
  const long = Array.from(query).length >= 3
  const matches = long
    ? env.DB.prepare(`
      SELECT s.id,s.title,s.number,
        substr(s.body, max(1,instr(lower(s.body),lower(?))-24), 100) AS snippet
      FROM search_index JOIN sections s ON s.rowid = search_index.rowid
      WHERE search_index MATCH ? AND s.id > ? ${visibility}
      ORDER BY s.id LIMIT 26
    `).bind(query, phrase, cursor)
    : env.DB.prepare(`
      SELECT s.id,s.title,s.number,
        substr(s.body, max(1,instr(lower(s.body),lower(?))-24), 100) AS snippet
      FROM sections s WHERE (instr(lower(s.title),lower(?)) > 0 OR instr(lower(s.body),lower(?)) > 0)
        AND s.id > ? ${visibility} ORDER BY s.id LIMIT 26
    `).bind(query, query, query, cursor)
  const { results } = await matches.all<{ id: string; title: string; number: string; snippet: string }>()
  return json({ hits: results.slice(0, 25), next: results.length > 25 ? results[24].id : null })
}

export async function createSection(env: Env, request: Request): Promise<Response> {
  const data = await readJson(request)
  const id = data.id == null ? 's-' + crypto.randomUUID() : identifier(data.id)
  const values = await fields(env, { ...data, deleted: 0 }, id)
  const created = await env.DB.prepare(`
    INSERT INTO sections (id,${mutableColumns.join(',')})
    VALUES (${Array(values.length + 1).fill('?').join(',')})
    ON CONFLICT(id) DO NOTHING RETURNING revision
  `).bind(id, ...values).first()
  if (!created) return fail(409, 'id_exists')
  return json({ id, ...created }, 201)
}

async function writeSection(env: Env, id: string, expected: number, data: Record<string, unknown>, action: string) {
  const values = await fields(env, data, id, action === 'delete')
  const saved = await env.DB.prepare(`
    UPDATE sections SET ${mutableColumns.map(column => column + ' = ?').join(',')},
      revision = revision + 1, action = ?, updated_at = unixepoch()
    WHERE id = ? AND revision = ? RETURNING revision
  `).bind(...values, action, id, expected).first()
  if (!saved) return fail(409, 'conflict')
  return json({ id, ...saved })
}

export async function mutateSection(env: Env, request: Request, id: string, action: 'edit' | 'delete' | 'restore'): Promise<Response> {
  const data = await readJson(request)
  const expected = integer(data.revision, 1, Number.MAX_SAFE_INTEGER)
  const current = await env.DB.prepare('SELECT * FROM sections WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!current) return fail(404, 'not_found')
  if (current.revision !== expected) return fail(409, 'conflict')
  if (action === 'delete') return writeSection(env, id, expected, { ...current, deleted: 1 }, action)
  if (action === 'edit') {
    if (current.deleted) return fail(409, 'deleted')
    // Node type and parent remain stable after creation so existing child links remain valid.
    return writeSection(env, id, expected, { ...data, kind: current.kind, parent_id: current.parent_id, deleted: 0 }, action)
  }
  const revision = integer(data.target, 1, expected)
  const old = await env.DB.prepare('SELECT snapshot FROM revisions WHERE section_id = ? AND revision = ?')
    .bind(id, revision).first<string>('snapshot')
  if (!old) return fail(404, 'not_found')
  const snapshot = JSON.parse(old)
  if (snapshot.deleted) return fail(400, 'invalid_restore')
  return writeSection(env, id, expected, snapshot, action)
}

export async function revisions(env: Env, id: string, url: URL): Promise<Response> {
  if (url.searchParams.has('revision')) {
    const revision = integer(Number(url.searchParams.get('revision')), 1, Number.MAX_SAFE_INTEGER)
    const result = await env.DB.prepare('SELECT snapshot FROM revisions WHERE section_id = ? AND revision = ?')
      .bind(id, revision).first<string>('snapshot')
    if (!result) return fail(404, 'not_found')
    return json({ snapshot: JSON.parse(result) })
  }
  const before = url.searchParams.has('before') ? integer(Number(url.searchParams.get('before')), 1, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const { results } = await env.DB.prepare('SELECT revision,action,updated_at FROM revisions WHERE section_id = ? AND revision < ? ORDER BY revision DESC LIMIT 31')
    .bind(id, before).all<{ revision: number; action: string; updated_at: number }>()
  return json({ revisions: results.slice(0, 30), next: results.length > 30 ? results[29].revision : null })
}

function imageMime(data: Uint8Array): string | null {
  if (data.length < 12) return null
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if ([137,80,78,71,13,10,26,10].every((byte, index) => data[index] === byte)) return 'image/png'
  const header = new TextDecoder().decode(data.subarray(0, 12))
  return header.startsWith('RIFF') && header.endsWith('WEBP') ? 'image/webp' : null
}

export async function uploadAsset(env: Env, request: Request, url: URL): Promise<Response> {
  const id = identifier(url.searchParams.get('id'))
  const sectionId = identifier(url.searchParams.get('section'))
  const metaHeader = request.headers.get('X-Asset-Metadata') ?? ''
  let data: Record<string, unknown>
  try {
    if (metaHeader.length > 8000) return fail(400, 'invalid_input')
    data = JSON.parse(decodeURIComponent(metaHeader))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'invalid_input')
  } catch {
    return fail(400, 'invalid_input')
  }
  const caption = string(data.caption ?? '', 500)
  const alt = string(data.alt, 250, 1).trim()
  if (!alt) return fail(400, 'invalid_input')
  const sourceFile = optional(data.source_file, value => string(value, 240))
  const sourcePage = page(data.source_page)
  const printPage = page(data.print_page)
  const sectionExists = await env.DB.prepare('SELECT 1 FROM sections WHERE id = ? AND deleted = 0').bind(sectionId).first()
  if (!sectionExists) return fail(404, 'not_found')
  const bytes = await readBytes(request, maxBytes)
  const mime = imageMime(bytes)
  if (!mime || mime !== request.headers.get('Content-Type')) return fail(415, 'unsupported_image')

  const statements = [env.DB.prepare(`
    INSERT INTO assets(id,section_id,mime,caption,alt,source_file,source_page,print_page,byte_size)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(id, sectionId, mime, caption, alt, sourceFile, sourcePage, printPage, bytes.length)]
  for (let start = 0, part = 0; start < bytes.length; start += 32_768, part++) {
    statements.push(env.DB.prepare('INSERT INTO asset_chunks VALUES (?,?,unhex(?))')
      .bind(id, part, bytes.subarray(start, start + 32_768).toHex()))
  }
  try {
    await env.DB.batch(statements)
  } catch (error) {
    const exists = await env.DB.prepare('SELECT 1 FROM assets WHERE id = ?').bind(id).first()
    if (exists) return fail(409, 'id_exists')
    throw error
  }
  return json({ id }, 201)
}

export async function getAsset(env: Env, id: string, admin: boolean): Promise<Response> {
  const access = admin ? '' : viewerAssetAccess
  const [metadata, payload] = await env.DB.batch([
    env.DB.prepare(`SELECT mime,byte_size FROM assets a WHERE id = ? ${access}`).bind(id),
    env.DB.prepare(`SELECT hex(bytes) AS hex_bytes FROM asset_chunks WHERE asset_id IN (SELECT id FROM assets a WHERE id = ? ${access}) ORDER BY part`).bind(id)
  ])
  const asset = metadata.results[0] as { mime: string; byte_size: number } | undefined
  if (!asset) return fail(404, 'not_found')
  const bytes = new Uint8Array(asset.byte_size)
  let offset = 0
  for (const item of payload.results as { hex_bytes: string }[]) {
    const chunk = Uint8Array.fromHex(item.hex_bytes)
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (offset !== bytes.length) return fail(500, 'asset_integrity')
  return new Response(bytes, { headers: { 'Content-Type': asset.mime, 'Content-Length': String(offset) } })
}

export async function setAssetDeleted(env: Env, id: string, deleted: number): Promise<Response> {
  const result = await env.DB.prepare('UPDATE assets SET deleted = ? WHERE id = ? RETURNING id').bind(deleted, id).first()
  if (!result) return fail(404, 'not_found')
  return json(result)
}

export async function stamp(env: Env): Promise<Response> {
  return json(await env.DB.prepare('SELECT version FROM content_stamp WHERE id = 1').first())
}
