// A real CmsAdapter, against a real Directus.
//
// Six phases ran against `cms-mock.ts`, which fails only in the ways somebody
// remembered to write. Everything in this file that is not a straight
// translation of the interface exists because the live API does something the
// mock does not, and each of those is noted at the point it matters rather than
// collected in a list nobody reads. The measured behaviour behind them is in
// stack/README.md.
//
// The three capabilities are all available and none of them are free:
//
//   deltaSync        needs an _or across two timestamp columns, because
//                    date_updated is null until a document is *updated* and a
//                    filter on it alone silently misses every new document.
//   idListing        cheap: fields=doc_id with no bodies.
//   webhookRevisions needs a two-operation flow provisioned in Directus, and
//                    only creates and updates can carry a revision at all.
import { RailError } from './rails.ts'
import type { CmsAdapter, CmsDocument, CmsPage, ListOptions } from './cms.ts'

export type DirectusCollection = {
  /** The Directus collection name. */
  collection: string
  /** The engine's content type. Defaults to the collection name. */
  type?: string
}

export type DirectusOptions = {
  baseUrl: string
  /** A static access token. Preferred: no login round-trip, no expiry mid-sync. */
  token?: string
  /** Or credentials, which are exchanged for a token lazily and again on a 401. */
  email?: string
  password?: string
  /** Collections to sync, in a fixed order. Pagination walks them in this order. */
  collections: (string | DirectusCollection)[]
  name?: string
  /** Per-request timeout. A hung socket is the failure a retry loop cannot see. */
  timeoutMs?: number
  /** Attempts per request, including the first. */
  attempts?: number
  /** First backoff step; doubles per attempt. */
  backoffMs?: number
  /** Cap on a server-supplied Retry-After, so a hostile header cannot wedge sync. */
  maxRetryAfterMs?: number
  /**
   * Budget for total time spent waiting between attempts of one request. Caps by
   * accumulation what maxRetryAfterMs caps per attempt.
   */
  maxTotalWaitMs?: number
}

/**
 * Envelope fields, stripped from the document body before it is stored.
 *
 * `seq` is a pagination detail the site must never see. The two timestamps are
 * stripped for a subtler reason: leaving them in would fold "when was this
 * touched" into the content hash, so re-saving a document with no edits would
 * report as changed and trigger a full rebuild and a deploy. Stripping them
 * makes the hash mean what the pipeline assumes it means -- the content.
 */
const ENVELOPE = new Set(['seq', 'doc_id', 'date_created', 'date_updated'])

const iso = (ms: number): string => new Date(ms).toISOString()

const epoch = (value: unknown): number => {
  if (typeof value !== 'string' || value === '') return 0
  const t = Date.parse(value)
  return Number.isNaN(t) ? 0 : t
}

type Row = Record<string, unknown>

/** `${collectionIndex}:${lastSeq}` -- opaque to the engine, by interface contract. */
function parseCursor(cursor: string | null): { index: number; seq: number } {
  if (cursor === null) return { index: 0, seq: 0 }
  const m = /^(\d+):(\d+)$/.exec(cursor)
  if (m === null) {
    throw new RailError('cms.cursor', true, `unparseable cursor ${JSON.stringify(cursor)}`)
  }
  return { index: Number(m[1]), seq: Number(m[2]) }
}

export function directusCmsAdapter(opts: DirectusOptions): CmsAdapter {
  const base = opts.baseUrl.replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 15_000
  const attempts = Math.max(1, opts.attempts ?? 4)
  const backoffMs = opts.backoffMs ?? 250
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000
  const cols: DirectusCollection[] = opts.collections.map((c) =>
    typeof c === 'string' ? { collection: c, type: c } : { collection: c.collection, type: c.type ?? c.collection },
  )
  if (cols.length === 0) throw new RailError('cms.config', true, 'no collections configured')
  if (!opts.token && !(opts.email && opts.password)) {
    throw new RailError('cms.config', true, 'directus adapter needs either a token or email+password')
  }

  let bytes = 0
  let token = opts.token ?? ''

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function login(): Promise<void> {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      // Wrong credentials do not improve with retrying, and a service that keeps
      // trying them looks busy while publishing nothing.
      throw new RailError('cms.auth', true, `login failed: ${res.status} ${res.statusText}`)
    }
    const body = await res.json()
    token = body?.data?.access_token ?? ''
    if (token === '') throw new RailError('cms.auth', true, 'login returned no access token')
  }

  /**
   * One request, with the retry policy the mock never needed.
   *
   * The classification is the load-bearing part, not the backoff. A 429 or a 5xx
   * is a fact about right now and retrying is the correct response; a 403 or a
   * 404 is a fact about the request and retrying it is a loop. Anything
   * unrecognised is treated as transient, matching `isTerminal`'s default -- an
   * unclassified failure is usually a blip, and the service's consecutive-failure
   * count is what stops a genuinely broken sync from retrying forever.
   */
  async function request(path: string): Promise<any> {
    if (token === '') await login()
    let reauthed = false
    let lastError: unknown = null

    /**
     * A budget for time spent *waiting*, separate from the per-request timeout.
     *
     * The per-attempt cap on Retry-After stops one hostile header from stalling
     * publishing; this stops the same thing happening by accumulation, which no
     * per-attempt cap can see. Both matter, and the failure they prevent is the
     * one this project keeps naming as the worst available: a service that is
     * busy forever and publishes nothing, with nobody watching.
     *
     * It also makes the waits *bounded* rather than merely capped, which is what
     * lets a test observe the behaviour instead of waiting out the header.
     */
    const waitDeadline = performance.now() + (opts.maxTotalWaitMs ?? 60_000)
    const waitFor = async (ms: number) => {
      const left = waitDeadline - performance.now()
      if (ms > left) {
        throw new RailError(
          'cms.request',
          false,
          `${path}: retry budget exhausted — next wait of ${Math.round(ms)}ms exceeds the ${Math.round(Math.max(left, 0))}ms left`,
        )
      }
      await sleep(ms)
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await waitFor(backoffMs * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await fetch(`${base}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        // Includes the abort. A timeout is retryable by construction: the point
        // of the deadline is that a hung socket never returns a status at all.
        lastError = e
        continue
      }

      if (res.ok) {
        const text = await res.text()
        bytes += Buffer.byteLength(text)
        return JSON.parse(text)
      }

      // An expired token is not an authorisation failure, it is a stale one, and
      // the difference is that exactly one re-login can fix it. Re-logging in on
      // every 401 would turn genuinely bad credentials into an infinite loop.
      if (res.status === 401 && !reauthed) {
        reauthed = true
        await login()
        continue
      }

      if (res.status === 429) {
        // Honoured, but capped: an upstream that says "come back in an hour" must
        // not be able to stall publishing for an hour on its own say-so.
        const header = res.headers.get('retry-after')
        const wait = header === null ? null : Number(header) * 1000
        const delay = wait !== null && Number.isFinite(wait)
          ? Math.min(Math.max(wait, 0), maxRetryAfterMs)
          : backoffMs * 2 ** attempt
        lastError = new Error(`429 rate limited on ${path}`)
        await waitFor(delay)
        continue
      }

      if (res.status >= 500) {
        lastError = new Error(`${res.status} ${res.statusText} on ${path}`)
        continue
      }

      const detail = (await res.text()).slice(0, 300)
      throw new RailError('cms.request', true, `${res.status} ${res.statusText} on ${path}: ${detail}`)
    }

    throw new RailError(
      'cms.request',
      false,
      `${path} failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /**
   * The delta filter, and the reason it names two columns.
   *
   * `date_updated` is null until a document is updated, so `date_updated > w`
   * matches nothing for a newly created document -- and a missed create is
   * indistinguishable from no change, so it is silent. Anything that edits this
   * expression down to one column reintroduces that.
   */
  function deltaFilter(since: number | undefined): object | null {
    if (since === undefined) return null
    const at = iso(since)
    return { _or: [{ date_created: { _gt: at } }, { date_updated: { _gt: at } }] }
  }

  function toDocument(row: Row, type: string, collection: string): CmsDocument {
    const id = row.doc_id
    if (typeof id !== 'string' || id === '') {
      // The one shape the rest of the pipeline cannot survive: the store is keyed
      // by id and a blank one would collide every such document onto one row.
      throw new RailError(
        'cms.schema',
        true,
        `${collection} row seq=${String(row.seq)} has no usable doc_id (got ${JSON.stringify(id)})`,
      )
    }
    const updated = epoch(row.date_updated)
    const created = epoch(row.date_created)
    const doc: Row = {}
    for (const [k, v] of Object.entries(row)) if (!ENVELOPE.has(k)) doc[k] = v
    doc.id = id
    return {
      id,
      type,
      // Compared for equality only, so the newer of the two timestamps is a valid
      // revision. Empty when neither is set, which makes sync fall back to the
      // content hash rather than treat every document as unchanged.
      revision: (row.date_updated as string) ?? (row.date_created as string) ?? '',
      updatedAt: Math.max(updated, created),
      doc,
    }
  }

  return {
    name: opts.name ?? 'directus',
    capabilities: { deltaSync: true, idListing: true, webhookRevisions: true },

    /**
     * One HTTP request per call, walking collections in configured order.
     *
     * Pagination is keyset on the integer primary key, never offset. Directus
     * rejects `_gt` on a string field, so offset is the obvious alternative and
     * it is unsafe here specifically: the sync driver feeds the ids it pulled
     * straight into DocumentStore.deleteMissing after a full pull, so a page
     * that drifts because a document was inserted mid-pull does not merely skip
     * that document -- it unpublishes it.
     */
    async list(o: ListOptions): Promise<CmsPage> {
      const { index, seq } = parseCursor(o.cursor)
      if (index >= cols.length) return { items: [], cursor: null }
      const { collection, type } = cols[index]

      const delta = deltaFilter(o.since)
      const keyset = { seq: { _gt: seq } }
      const filter = delta === null ? keyset : { _and: [keyset, delta] }

      const qs = new URLSearchParams({
        limit: String(o.limit),
        sort: 'seq',
        filter: JSON.stringify(filter),
      })
      const body = await request(`/items/${collection}?${qs}`)
      const rows: Row[] = Array.isArray(body?.data) ? body.data : []
      const items = rows.map((r) => toDocument(r, type ?? collection, collection))

      // A short page means this collection is exhausted, so the cursor moves to
      // the next one. A full page might be the last -- that costs one empty
      // request to discover, which is cheaper than the alternative of asking for
      // a count on every page.
      let cursor: string | null
      if (rows.length < o.limit) {
        cursor = index + 1 >= cols.length ? null : `${index + 1}:0`
      } else {
        cursor = `${index}:${Number(rows[rows.length - 1].seq)}`
      }

      // A cursor that does not advance is an infinite sync, and an infinite sync
      // presents as a service that is busy forever and publishes nothing -- the
      // failure this project already names as the worst available. Cheaper to
      // refuse here than to discover it as a flat CPU graph. Terminal, because
      // re-running reproduces it exactly.
      if (cursor !== null && cursor === o.cursor) {
        throw new RailError(
          'cms.cursor',
          true,
          `cursor did not advance past ${cursor} in ${collection} — ${rows.length} rows returned`,
        )
      }
      return { items, cursor }
    },

    /**
     * Every id, no bodies. This is the only thing that catches deletes, and after
     * a delta pull it is also the only check on whether the delta was complete.
     */
    async listIds() {
      const out: { id: string; revision: string }[] = []
      for (const { collection } of cols) {
        const qs = new URLSearchParams({ limit: '-1', fields: 'doc_id,date_updated,date_created', sort: 'seq' })
        const body = await request(`/items/${collection}?${qs}`)
        for (const row of (body?.data ?? []) as Row[]) {
          const id = row.doc_id
          if (typeof id !== 'string' || id === '') continue
          out.push({ id, revision: (row.date_updated as string) ?? (row.date_created as string) ?? '' })
        }
      }
      return out
    },

    /**
     * Pull the changed document out of a Directus flow delivery.
     *
     * The shapes are the provisioning's, not Directus's defaults -- a bare event
     * trigger carries the internal row key and the changed fields only, with no
     * revision and no document id, so `stack/seed.ts` chains a read operation
     * ahead of the request. Three facts that each break a naive parser:
     *
     *   - a single-key update delivers `docs` as an object, a multi-key update
     *     delivers an array
     *   - deletes carry no `docs` at all, because there is nothing left to read;
     *     they return null, which the service reads as "no expectation" rather
     *     than as an error
     *   - only one expectation is representable by this interface, so a batch
     *     edit registers its first document and the rest ride on the rebuild
     */
    revisionOf(payload: unknown) {
      const p = payload as any
      if (!p || typeof p !== 'object') return null
      const docs = p.docs
      const first = Array.isArray(docs) ? docs[0] : docs
      if (!first || typeof first !== 'object') return null
      const id = first.doc_id
      const revision = first.date_updated ?? first.date_created
      if (typeof id !== 'string' || id === '' || revision === undefined || revision === null) return null
      return { id, revision: String(revision) }
    },

    bytesRead: () => bytes,
  }
}
