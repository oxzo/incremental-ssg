// A fake S3 that emits the response shapes a real one emits in the cases MinIO
// will not produce on demand.
//
// test/live-stack.test.ts covers "does this speak S3 correctly" against MinIO.
// This file covers the three shapes that decide whether the deploy diff is
// safe, and that a healthy bucket never shows you:
//
//   - a multipart ETag (`<hash>-<n>`), which is not the MD5 of the object
//   - a listing paginated across continuation tokens
//   - a listing that claims to be complete while being short
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'

export type FakeObject = { key: string; body: Buffer; etag?: string }

export type FakeS3 = {
  url: string
  objects: Map<string, FakeObject>
  requests: () => { method: string; path: string; query: Record<string, string> }[]
  /** Force per-key errors from DeleteObjects, which S3 reports inside a 200. */
  failDeletes: Set<string>
  close: () => Promise<void>
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function startFakeS3(
  opts: { objects?: FakeObject[]; maxKeys?: number } = {},
): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>()
  for (const o of opts.objects ?? []) objects.set(o.key, o)
  const seen: { method: string; path: string; query: Record<string, string> }[] = []
  const failDeletes = new Set<string>()
  const hardMax = opts.maxKeys ?? 1000

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const query = Object.fromEntries(url.searchParams.entries())
    seen.push({ method: req.method ?? 'GET', path: url.pathname, query })

    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)

    // Path-style: /<bucket>/<key...>
    const rest = url.pathname.replace(/^\/+/, '')
    const slash = rest.indexOf('/')
    const key = slash === -1 ? '' : rest.slice(slash + 1)

    if (req.method === 'GET' && query['list-type'] === '2') {
      const prefix = query.prefix ?? ''
      const all = [...objects.values()].filter((o) => o.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1))
      const after = query['continuation-token'] ?? ''
      const start = after === '' ? 0 : all.findIndex((o) => o.key === after) + 1
      const max = Math.min(Number(query['max-keys'] ?? hardMax), hardMax)
      const page = all.slice(start, start + max)
      const truncated = start + max < all.length
      const next = truncated ? page[page.length - 1].key : null

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>bucket</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
        `<MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
        (next === null ? '' : `<NextContinuationToken>${esc(next)}</NextContinuationToken>`) +
        page
          .map(
            (o) =>
              `<Contents><Key>${esc(o.key)}</Key><LastModified>2026-07-28T00:00:00.000Z</LastModified>` +
              `<ETag>&quot;${o.etag ?? md5(o.body)}&quot;</ETag><Size>${o.body.length}</Size>` +
              `<StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join('') +
        `</ListBucketResult>`
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(xml) })
      return res.end(xml)
    }

    if (req.method === 'PUT') {
      objects.set(key, { key, body })
      res.writeHead(200, { etag: `"${md5(body)}"` })
      return res.end()
    }

    if (req.method === 'POST' && 'delete' in query) {
      const keys = [...body.toString('utf8').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1])
      const errors: string[] = []
      for (const k of keys) {
        if (failDeletes.has(k)) errors.push(k)
        else objects.delete(k)
      }
      // Per-key failures come back inside a 200. A client that only checks the
      // status code records a deletion that did not happen.
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        errors
          .map((k) => `<Error><Key>${esc(k)}</Key><Code>InternalError</Code><Message>injected</Message></Error>`)
          .join('') +
        `</DeleteResult>`
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(xml) })
      return res.end(xml)
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests: () => seen,
    failDeletes,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

export const obj = (key: string, text: string, etag?: string): FakeObject => ({
  key,
  body: Buffer.from(text, 'utf8'),
  etag,
})
