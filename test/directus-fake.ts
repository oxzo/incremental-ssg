// A fake Directus that speaks the shapes measured against a real one.
//
// The point of this file is *not* convenience -- there is a real Directus in
// stack/, and test/live-stack.test.ts runs against it. This exists because the
// interesting failures are the ones a healthy Directus will not produce on
// demand: an empty doc_id, a row with both timestamps null, a listing that lies.
// Every response shape here was copied from an observed one (see
// stack/README.md), so when the two disagree the live test is what catches it.
import { createServer } from 'node:http'
import type { Server } from 'node:http'

export type FakeRow = Record<string, unknown> & { seq: number; doc_id?: unknown }

export type FakeDirectus = {
  url: string
  /** Requests served, by path prefix. */
  requests: () => { path: string; query: Record<string, string> }[]
  rows: Map<string, FakeRow[]>
  close: () => Promise<void>
}

const json = (res: any, code: number, body: unknown) => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Apply the subset of Directus's filter language the adapter actually emits.
 *
 * Deliberately narrow. A general filter evaluator would let a test pass with a
 * filter the real API would reject, which is the failure mode this whole file
 * is trying to avoid -- so anything unrecognised throws rather than being
 * ignored.
 */
function matches(row: FakeRow, filter: any): boolean {
  if (filter === null || filter === undefined) return true
  if (filter._and) return (filter._and as any[]).every((f) => matches(row, f))
  if (filter._or) return (filter._or as any[]).some((f) => matches(row, f))
  for (const [field, cond] of Object.entries(filter)) {
    const c = cond as Record<string, unknown>
    if ('_gt' in c) {
      const want = c._gt
      const have = row[field]
      if (have === null || have === undefined) return false
      if (typeof want === 'number') {
        if (!(Number(have) > want)) return false
      } else if (!(String(have) > String(want))) return false
    } else if ('_eq' in c) {
      if (row[field] !== c._eq) return false
    } else {
      throw new Error(`fake directus: unsupported filter operator in ${JSON.stringify(cond)}`)
    }
  }
  return true
}

export async function startFakeDirectus(
  rows: Map<string, FakeRow[]>,
  opts: {
    token?: string
    requireAuth?: boolean
    /**
     * Answer `meta=filter_count` with no `meta` at all -- an older Directus, a
     * proxy that strips it, or a permission that hides it. The adapter has to
     * report no total in that case rather than a wrong one, and nothing else in
     * the suite can produce a response shaped like this.
     */
    omitMeta?: boolean
    /**
     * Cap every listing at this many rows, the way Directus's QUERY_LIMIT_MAX
     * does -- including `limit=-1`, which is the whole point. The count in
     * `meta` still reports the true total, because that is what makes the
     * truncation detectable and what makes it silent without a check.
     */
    queryLimitMax?: number
  } = {},
): Promise<FakeDirectus> {
  const token = opts.token ?? 'fake-token'
  const seen: { path: string; query: Record<string, string> }[] = []

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const query = Object.fromEntries(url.searchParams.entries())
    seen.push({ path: url.pathname, query })

    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (body.password === 'wrong') return json(res, 401, { errors: [{ message: 'bad credentials' }] })
      return json(res, 200, { data: { access_token: token } })
    }

    if (opts.requireAuth !== false) {
      const auth = String(req.headers.authorization ?? '')
      if (auth !== `Bearer ${token}`) return json(res, 401, { errors: [{ message: 'unauthorized' }] })
    }

    const m = /^\/items\/([^/]+)$/.exec(url.pathname)
    if (m === null) return json(res, 404, { errors: [{ message: 'no route' }] })
    const list = rows.get(m[1])
    if (list === undefined) return json(res, 403, { errors: [{ message: 'no permission' }] })

    const filter = query.filter ? JSON.parse(query.filter) : null
    let out = list.filter((r) => matches(r, filter))
    // Counted after the filter and before the limit, which is what a real
    // Directus does -- verified against the live stack: a 2,000-row collection
    // answers `filter_count: 1995` under a `seq > 5` filter while returning the
    // 2 rows the limit asked for.
    const filterCount = out.length
    out.sort((a, b) => a.seq - b.seq)
    const limit = Number(query.limit ?? '100')
    if (limit >= 0) out = out.slice(0, limit)
    // Applied after the caller's own limit and to `-1` as well, which is the
    // case a cap makes dangerous: the request that asked for everything is the
    // one that silently gets less.
    if (opts.queryLimitMax !== undefined) out = out.slice(0, opts.queryLimitMax)
    // `fields` is honoured because the id-listing path depends on it being cheap;
    // a fake that returned whole bodies would hide a regression there.
    if (query.fields) {
      const want = query.fields.split(',')
      out = out.map((r) => Object.fromEntries(want.filter((f) => f in r).map((f) => [f, r[f]])) as FakeRow)
    }
    if (query.meta === 'filter_count' && opts.omitMeta !== true) {
      return json(res, 200, { meta: { filter_count: filterCount }, data: out })
    }
    return json(res, 200, { data: out })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => seen,
    rows,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

/** Rows in the shape the seeding convention produces. */
export function fakeRows(spec: Record<string, number>): Map<string, FakeRow[]> {
  const out = new Map<string, FakeRow[]>()
  for (const [collection, n] of Object.entries(spec)) {
    const list: FakeRow[] = []
    for (let i = 0; i < n; i++) {
      list.push({
        seq: i + 1,
        doc_id: `${collection}-${i}`,
        title: `${collection} ${i}`,
        // Created, never updated -- the state a real Directus leaves a new
        // document in, and the one that breaks a single-column delta filter.
        date_created: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        date_updated: null,
      })
    }
    out.set(collection, list)
  }
  return out
}
