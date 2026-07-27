// Phase 2b, part 1: what does a CMS pull actually cost?
//
// Sync time splits into a part that depends on someone else's API (round-trips
// and bandwidth) and a part that is ours (JSON parse, hash, SQLite upsert).
// Only the second is measurable without picking a CMS, so this measures that
// exactly and models the first, rather than inventing a latency number and
// reporting the sum as though it were data.
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const now = () => performance.now()

/** Mock headless CMS: cursor-paginated JSON, optional per-request latency. */
export function startMockCms(docs: any[], latencyMs = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const respond = () => {
      if (url.pathname === '/ids') {
        // Full-ID reconciliation: the cheap scan that catches deletes and
        // unpublishes, which an `updatedAt >` query can never return.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ids: docs.map((d) => [d.doc.id, d.doc.rev]) }))
        return
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const since = Number(url.searchParams.get('since') ?? -1)
      const pool = since >= 0 ? docs.filter((d) => d.doc.updated_at > since) : docs
      const slice = pool.slice(cursor, cursor + limit)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        items: slice,
        next: cursor + limit < pool.length ? cursor + limit : null,
        total: pool.length,
      }))
    }
    if (latencyMs > 0) setTimeout(respond, latencyMs)
    else respond()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

export type SyncResult = {
  docs: number; requests: number; bytes: number
  ms: { http: number; parse: number; store: number; total: number }
}

/** Full or delta pull into the local store, with the stages timed separately. */
export async function pull(
  port: number, dbPath: string, pageSize: number, since?: number,
): Promise<SyncResult> {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, updated_at INTEGER NOT NULL,
      hash TEXT NOT NULL, json TEXT NOT NULL);
  `)
  const up = db.prepare(`INSERT INTO documents (id,type,updated_at,hash,json)
    VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    type=excluded.type, updated_at=excluded.updated_at,
    hash=excluded.hash, json=excluded.json`)

  const t0 = now()
  let httpMs = 0, parseMs = 0, storeMs = 0, bytes = 0, requests = 0, docs = 0
  let cursor: number | null = 0

  while (cursor !== null) {
    const qs = new URLSearchParams({ cursor: String(cursor), limit: String(pageSize) })
    if (since !== undefined) qs.set('since', String(since))
    const a = now()
    const res = await fetch(`http://127.0.0.1:${port}/documents?${qs}`)
    const text = await res.text()
    const b = now()
    const page = JSON.parse(text)
    const c = now()

    db.exec('BEGIN')
    for (const it of page.items) {
      const json = JSON.stringify(it.doc)
      up.run(it.doc.id, it.type, it.doc.updated_at, sha(json), json)
      docs++
    }
    db.exec('COMMIT')
    const d = now()

    httpMs += b - a; parseMs += c - b; storeMs += d - c
    bytes += Buffer.byteLength(text); requests++
    cursor = page.next
  }
  db.close()
  return { docs, requests, bytes, ms: { http: httpMs, parse: parseMs, store: storeMs, total: now() - t0 } }
}

/** Cost of the ID-only reconciliation scan that catches deletes. */
export async function reconcile(port: number): Promise<{ ms: number; bytes: number; ids: number }> {
  const t0 = now()
  const res = await fetch(`http://127.0.0.1:${port}/ids`)
  const text = await res.text()
  const { ids } = JSON.parse(text)
  return { ms: now() - t0, bytes: Buffer.byteLength(text), ids: ids.length }
}
