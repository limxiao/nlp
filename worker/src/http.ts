export interface Env {
  DB: D1Database
  SITE_ORIGIN: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET?: string
  AUTH_KEY?: string
}

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export const fail = (status: number, code: string): never => { throw new HttpError(status, code) }

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export async function readBytes(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('Content-Length')
  if (length && Number(length) > max) fail(413, 'too_large')
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const bytes = new Uint8Array(max)
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return bytes.subarray(0, size)
      if (size + value.byteLength > max) {
        await reader.cancel()
        fail(413, 'too_large')
      }
      bytes.set(value, size)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}

export async function readJson(request: Request, max = 512_000): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    fail(415, 'unsupported_media')
  }
  const bytes = await readBytes(request, max)
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(400, 'invalid_input')
    return value
  } catch {
    return fail(400, 'invalid_input')
  }
}

export function string(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\u0000')) {
    return fail(400, 'invalid_input')
  }
  return value
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(400, 'invalid_input')
  }
  return value
}

export function identifier(value: unknown): string {
  const id = string(value, 72, 1)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail(400, 'invalid_id')
  return id
}

export function optional<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value == null || value === '' ? null : parse(value)
}
