// Sync driver: CMS -> local document mirror.
//
// This is the only stage that touches the network. Rendering never does, which
// is what makes a build reproducible from a local snapshot.
//
// Phase 2b measured the local half of this at 67 microseconds per document, and
// found the remote half is dominated by request *count* rather than payload
// size or delta filtering. So the shape here is: pull in the largest pages the
// adapter will serve, hash everything, and let the store decide what actually
// changed.
import { createHash } from 'node:crypto'
import type { CmsAdapter, CmsDocument } from './cms.ts'
import type { DocumentStore, UpsertInput } from './store.ts'

const WATERMARK = 'sync:watermark'

/**
 * Set while committed writes exist that the watermark does not yet cover.
 *
 * The mirror is updated page by page (see the upsert in the pull loop), and the
 * watermark is written once at the end. Between the first commit and that write
 * the store is ahead of the cursor describing it, and a crash in that window is
 * silent and permanent: the restart re-pulls from the *old* watermark, the hash
 * comparison finds those documents already stored and reports `changed: 0`, the
 * watermark then advances over them, and the publish that content was going to
 * trigger never happens. Nothing errors, because from the second run's point of
 * view nothing changed -- which is true, and is the problem.
 *
 * `service:dirty` cannot cover this. It is set by the stage *after* sync, so the
 * run that would set it has not reached that code yet. Hence a second marker,
 * owned by the subsystem whose invariant it is: the service reads it on entry
 * and treats it as an outstanding publish, because a sync that died mid-write
 * may have committed anything.
 *
 * Set lazily -- only immediately before an operation that actually commits -- so
 * an idle delta poll that pulls nothing and deletes nothing never writes it.
 * Cleared unconditionally on a completed sync, including one that never set it,
 * because a marker left by an *earlier* crash must not survive a sync that has
 * since reconciled the store with its watermark. Leaving it sticky there would
 * trade a lost publish for a rebuild on every poll, forever.
 *
 * Scope, so the guarantee is not read as larger than it is: this survives a
 * process crash, which is the failure the service is exposed to. Surviving loss
 * of power additionally depends on SQLite's `synchronous` pragma, which this
 * project has not set and has not measured.
 */
export const SYNC_MUTATING = 'sync:mutating'

export type SyncOptions = {
  /** Documents per request. The dominant lever on sync wall time (Phase 2b). */
  pageSize?: number
  /** Ignore the stored watermark and pull everything. */
  full?: boolean
  /** Only store these types. Defaults to storing everything the CMS returns. */
  contentTypes?: string[]
  /** Run the full-ID reconcile scan that catches deletes. */
  reconcile?: boolean
  /** Passed through to DocumentStore.deleteMissing. */
  maxDeleteRatio?: number
}

export type SyncResult = {
  strategy: 'full' | 'delta'
  /** Documents received from the CMS. */
  pulled: number
  /** Of those, how many differed from what was already stored. */
  changed: number
  deleted: number
  requests: number
  bytes: number
  watermark: number | null
  ms: { http: number; hash: number; store: number; reconcile: number; total: number }
}

const now = () => performance.now()

/**
 * JSON with object keys sorted, recursively.
 *
 * Two reasons this is worth the cycles. Change detection: a CMS that reorders
 * keys between responses would otherwise report every document as changed on
 * every sync. And determinism: the stored bytes are what the renderer parses
 * back, so canonicalising here means the store -- and therefore the build -- does
 * not depend on the order a document happened to arrive in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k]
    if (v === undefined) return null
    return `${JSON.stringify(k)}:${canonicalJson(v)}`
  })
  return `{${parts.filter((p) => p !== null).join(',')}}`
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export async function sync(
  adapter: CmsAdapter,
  store: DocumentStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 500
  const wantTypes = opts.contentTypes ? new Set(opts.contentTypes) : null
  const t0 = now()

  const stored = store.getMeta(WATERMARK)
  const watermark = stored === null ? null : Number(stored)
  const canDelta = adapter.capabilities.deltaSync && watermark !== null && !opts.full
  const strategy: 'full' | 'delta' = canDelta ? 'delta' : 'full'

  // The boundary re-pull. `since` is exclusive, so querying at exactly the
  // watermark drops any document sharing that timestamp with the newest one we
  // already have -- a real risk whenever the CMS stamps at second granularity.
  // Re-pulling one timestamp's worth is cheap, and the hash comparison below
  // makes the redundant documents cost nothing downstream.
  const since = canDelta ? Math.max(0, (watermark as number) - 1) : undefined

  const known = store.hashes()
  let cursor: string | null = null
  let pulled = 0
  let changed = 0
  let requests = 0
  let maxUpdatedAt = watermark ?? 0
  let httpMs = 0
  let hashMs = 0
  let storeMs = 0
  const seen = new Set<string>()

  // Idempotent, and deliberately not hoisted to the top of the function: the
  // marker claims writes are committed that the watermark does not cover, and
  // that claim is false until the first one lands. Marking on entry would be
  // simpler and would make every failed *network* request -- the likeliest place
  // for a long full sync to die, and the one that has written nothing -- look
  // like an interrupted write.
  let marked = false
  const markMutating = () => {
    if (marked) return
    store.setMeta(SYNC_MUTATING, '1')
    marked = true
  }

  for (;;) {
    const a = now()
    const page = await adapter.list({ cursor, limit: pageSize, since })
    const b = now()
    httpMs += b - a
    requests++

    const batch: UpsertInput[] = []
    for (const item of page.items as CmsDocument[]) {
      pulled++
      seen.add(item.id)
      if (item.updatedAt > maxUpdatedAt) maxUpdatedAt = item.updatedAt
      if (wantTypes && !wantTypes.has(item.type)) continue
      const json = canonicalJson(item.doc)
      const hash = sha(json)
      if (known.get(item.id) !== hash) changed++
      batch.push({
        id: item.id,
        type: item.type,
        // Fall back to the content hash when the CMS has no revision concept --
        // it is compared for equality only, so a hash is a valid revision id.
        revision: item.revision === '' ? hash : item.revision,
        updatedAt: item.updatedAt,
        hash,
        json,
      })
    }
    const c = now()
    hashMs += c - b

    if (batch.length > 0) markMutating()
    store.upsertMany(batch)
    storeMs += now() - c

    cursor = page.cursor
    if (cursor === null) break
  }

  // Deletes. A delta pull cannot return a document that no longer exists, so
  // without the reconcile scan a deleted post leaves its page live forever --
  // the failure mode where the build is "correct" and the site is wrong.
  let deleted = 0
  const r0 = now()
  const wantReconcile = opts.reconcile ?? true
  if (wantReconcile && adapter.capabilities.idListing) {
    // Marked immediately before the delete, not before the listing request that
    // precedes it in the delta branch: a listing that fails has committed
    // nothing, and the marker costs a rebuild it would not have earned.
    if (strategy === 'full') {
      // A full pull already enumerated everything; the second request would be
      // asking the CMS a question we just answered.
      markMutating()
      deleted = store.deleteMissing(seen, { maxDeleteRatio: opts.maxDeleteRatio })
    } else {
      const live = await adapter.listIds()
      requests++
      markMutating()
      deleted = store.deleteMissing(new Set(live.map((l) => l.id)), {
        maxDeleteRatio: opts.maxDeleteRatio,
      })
    }
  }
  const reconcileMs = now() - r0

  const nextWatermark = pulled > 0 || watermark !== null ? maxUpdatedAt : null
  if (nextWatermark !== null) store.setMeta(WATERMARK, String(nextWatermark))

  // After the watermark write, never before. Clearing first and dying in the gap
  // reinstates the exact loss this marker exists to prevent, one statement later.
  //
  // Justified by construction, and not by a test -- said plainly because the
  // alternative is a comment implying coverage that does not exist. The window
  // is two adjacent statements wide, and a kill-point test aimed at it would be
  // sampling microseconds across process-scheduling jitter, which is how this
  // project previously came within one run of certifying a build-lock fix its
  // race test had no power to check. tools/mutate.py mutates whether the marker
  // is written and read at all; the ordering it cannot reach.
  store.setMeta(SYNC_MUTATING, '0')

  // Hand the file over to the read-only workers in a shareable journal mode.
  store.prepareForReaders()

  return {
    strategy,
    pulled,
    changed,
    deleted,
    requests,
    bytes: adapter.bytesRead(),
    watermark: nextWatermark,
    ms: { http: httpMs, hash: hashMs, store: storeMs, reconcile: reconcileMs, total: now() - t0 },
  }
}
