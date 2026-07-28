// The synced document mirror.
//
// Post-gate this table carries no build cache -- no routes, no deps, no
// dep_key reverse index. It exists so rendering runs offline against a local
// snapshot, not so builds can skip work. That is why there is nothing here that
// can be *stale*: the only failure mode left is "the mirror is out of date with
// the CMS", which a re-sync fixes, rather than "the cache disagrees with the
// content", which nothing fixes.
import { DatabaseSync } from 'node:sqlite'
import { RailError, checkNumber } from './rails.ts'
import type { Doc, DocsByType } from './config.ts'

/**
 * Bumped when a change here makes an existing database file unreadable.
 *
 * 2: the primary key became (type, id). A v1 mirror is not migrated in place --
 * it is refused with instructions to delete and re-sync, which costs one full
 * pull and is the remedy this file is designed around. See the header: the
 * mirror holds nothing that can be stale, so it is always reproducible.
 */
export const STORE_SCHEMA = 2

export type StoredDoc = {
  id: string
  type: string
  revision: string
  updated_at: number
  hash: string
  json: string
}

/**
 * The identity a pulled document is compared against: its type and its content.
 *
 * One definition, exported, because the store builds these from rows and sync
 * builds them from CMS responses. Two spellings of "what makes a document the
 * same document" would agree until one of them was fixed.
 *
 * The separator is NUL because it is the one byte a CMS type name cannot
 * contain, so two different (type, hash) pairs cannot fold into one string --
 * the same ambiguity A4 found in the seal's digest fold, where `path hash` lines
 * joined by newlines let two trees produce one value. Written `\x00` rather than
 * as a literal NUL: the two are identical at runtime, but a raw control byte
 * makes this file `data` rather than text, and `grep` then reports no matches
 * for anything in it rather than reporting an error. A file that answers every
 * search with silence is worse than one that is hard to read.
 */
export const documentIdentity = (type: string, hash: string) => `${type}\x00${hash}`

/**
 * What makes a document *that* document: its type and its id, together.
 *
 * `id` alone was the primary key until this, and a multi-collection CMS makes
 * that a collision rather than a key. Directus puts no constraint across
 * collections, so two of them carrying a slug-shaped `doc_id` -- an ordinary
 * schema -- had one document overwrite the other on arrival. The measured
 * result was not a one-time loss but a mirror that never converges: the two
 * overwrite each other on every sync, `changed` never reaches zero, and the
 * service rebuilds and redeploys the whole site on every poll forever.
 *
 * Same NUL separator and the same reason as documentIdentity above: a type name
 * cannot contain it, so two different pairs cannot fold into one string.
 *
 * One definition, exported, because the store builds these from rows and sync
 * builds them from CMS responses -- two spellings of "the same document" would
 * agree until one of them was fixed.
 */
export const documentKey = (type: string, id: string) => `${type}\x00${id}`

/** A document's identity as a pair, for the calls that have to name one. */
export type DocRef = { type: string; id: string }

export type UpsertInput = {
  id: string
  type: string
  revision: string
  updatedAt: number
  hash: string
  json: string
}

export class DocumentStore {
  private db: DatabaseSync
  readonly path: string
  readonly readOnly: boolean

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.path = path
    this.readOnly = opts.readOnly ?? false
    this.db = new DatabaseSync(path, { readOnly: this.readOnly })
    // Workers open this file concurrently; without a busy timeout the losers of
    // a lock race fail the build rather than waiting a few milliseconds.
    this.db.exec('PRAGMA busy_timeout = 15000;')
    if (!this.readOnly) this.migrate()
    else this.checkSchema()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        revision TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        hash TEXT NOT NULL,
        json TEXT NOT NULL,
        -- (type, id) rather than id. A multi-collection CMS puts no constraint
        -- across collections, so id alone is not a key: two collections
        -- carrying a slug-shaped doc_id had one document overwrite the other on
        -- arrival, and kept doing it on every sync. Ordered (type, id) rather
        -- than (id, type) so it also serves byType()'s read -- see below.
        PRIMARY KEY (type, id)
      );
      -- Formerly a separate index, now the primary key's own B-tree, which is
      -- why there is nothing to create here any more. The reasoning is kept
      -- because it is what makes the *order* of the key columns load-bearing
      -- rather than arbitrary:
      -- (type, id) rather than (type). byType() is the only type-filtered query
      -- in the engine and it reads ORDER BY type, id -- with an index on type
      -- alone SQLite satisfied the filter and then built a temp B-tree for the
      -- sort, dragging all 158 MB of JSON through the sorter. Measured at 20,461
      -- documents: 460ms ordered against 158ms unordered, so roughly 300ms was
      -- pure sorting. The composite index removes the temp B-tree entirely and
      -- the same read costs 170ms. It is paid once per worker plus once on the
      -- main thread, so at ten workers this is the difference between ~6.4s and
      -- ~3s of aggregate CPU.
      -- Both dropped rather than left in place, for the same reason the second
      -- one was dropped when the first arrived: sync should not maintain an
      -- index nothing reads. idx_documents_type_id is now exactly the primary
      -- key, so keeping it would double every write to buy nothing.
      DROP INDEX IF EXISTS idx_documents_type_id;
      DROP INDEX IF EXISTS idx_documents_type;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const found = this.getMeta('schema')
    if (found === null) this.setMeta('schema', String(STORE_SCHEMA))
    else if (Number(found) !== STORE_SCHEMA) {
      throw new Error(
        `store schema ${found} != ${STORE_SCHEMA} at ${this.path}. Delete the ` +
        `database and re-sync; the mirror is reproducible from the CMS.`)
    }
  }

  private checkSchema() {
    const found = this.getMeta('schema')
    if (found !== null && Number(found) !== STORE_SCHEMA) {
      throw new Error(`store schema ${found} != ${STORE_SCHEMA} at ${this.path}`)
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  /**
   * The stored revision for one document, or null if it is not in the mirror.
   *
   * The read-after-write check in the webhook service is the only caller: a
   * webhook says "document X is now at revision R", and this answers whether the
   * mirror has caught up. Only meaningful when the CMS's list payload and its
   * webhook payload carry the *same* revision identifier -- sync falls back to
   * the content hash for a CMS with no revision concept, and a hash will never
   * equal a webhook's revision string. That is what `webhookRevisions` declares,
   * and why an unsatisfied check is reported rather than fatal.
   */
  revisionOf(type: string, id: string): string | null {
    const row = this.db
      .prepare('SELECT revision FROM documents WHERE type = ? AND id = ?')
      .get(type, id) as
      | { revision: string }
      | undefined
    return row ? row.revision : null
  }

  /**
   * What a stored document *is*, for deciding whether a pulled one differs.
   *
   * Type and content hash, because change detection on the hash alone misses a
   * document that moved between two rendered types without its body changing.
   * The store would take the new type, `changed` would stay 0, and the service
   * would skip the build -- while route membership had changed underneath it,
   * since routes are resolved per type.
   */
  identities(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, type, hash FROM documents').all() as
      { id: string; type: string; hash: string }[]
    const out = new Map<string, string>()
    for (const r of rows) out.set(documentKey(r.type, r.id), documentIdentity(r.type, r.hash))
    return out
  }

  /**
   * Remove specific documents by id, with no ratio ceiling.
   *
   * Deliberately not `deleteMissing`. That rail guards against *absence*: an id
   * missing from a listing might mean the listing came back short, so a large
   * sweep is refused rather than trusted. Here the CMS positively stated each
   * document's type, per document, in a response already parsed -- there is no
   * completeness question to get wrong, so there is nothing for a ratio to
   * protect. Routing these through deleteMissing would refuse a correct,
   * evidenced removal for a reason that does not apply to it.
   */
  deleteIds(refs: DocRef[]): number {
    if (refs.length === 0) return 0
    const del = this.db.prepare('DELETE FROM documents WHERE type = ? AND id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of refs) n += del.run(r.type, r.id).changes > 0 ? 1 : 0
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return n
  }

  /** Every stored document as (type, id), which is what identifies one. */
  refs(): DocRef[] {
    return this.db.prepare('SELECT type, id FROM documents').all() as DocRef[]
  }

  /** The same set, spelled as composite keys for membership tests. */
  keys(): Set<string> {
    return new Set(this.refs().map((r) => documentKey(r.type, r.id)))
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
    return Number(row.n)
  }

  /** One transaction for the whole batch; per-row commits dominated Phase 2b. */
  upsertMany(docs: UpsertInput[]): number {
    if (docs.length === 0) return 0
    const up = this.db.prepare(
      `INSERT INTO documents (id,type,revision,updated_at,hash,json) VALUES (?,?,?,?,?,?)
       ON CONFLICT(type,id) DO UPDATE SET
         revision=excluded.revision,
         updated_at=excluded.updated_at, hash=excluded.hash, json=excluded.json`)
    this.db.exec('BEGIN')
    try {
      for (const d of docs) up.run(d.id, d.type, d.revision, d.updatedAt, d.hash, d.json)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return docs.length
  }

  /**
   * Drop documents the CMS no longer lists.
   *
   * Same shape of hazard as AssetCache.gc, and the same rail: this is only safe
   * if `live` is a *complete* listing. A reconcile scan that failed halfway
   * returns a short list, and deleting against it silently unpublishes the site
   * -- so refuse an implausibly large sweep instead of trusting the caller.
   */
  deleteMissing(live: Set<string>, opts: { maxDeleteRatio?: number; force?: boolean } = {}): number {
    const { force = false } = opts
    // Validated rather than defaulted-in-place. The ceiling below is a `>`
    // comparison, and every comparison against NaN is false, so an unparsed
    // ratio arriving here does not fail -- it removes the ceiling and lets the
    // sweep through. Checked before ids() so a bad value costs no scan.
    const maxDeleteRatio = checkNumber(opts.maxDeleteRatio, 0.5, {
      name: 'maxDeleteRatio', min: 0, max: 1,
    })
    const local = this.refs()
    const doomed = local.filter((r) => !live.has(documentKey(r.type, r.id)))
    if (doomed.length === 0) return 0
    if (local.length > 0 && doomed.length / local.length > maxDeleteRatio && !force) {
      // Transient, which looks wrong for a mass-delete refusal and is not. The
      // refusal itself deletes nothing, so retrying is safe by construction --
      // and the likeliest cause, a listing that came back short, is exactly the
      // kind of thing that succeeds on the next attempt. If the CMS really did
      // lose half its documents the rail refuses again every time, and the
      // service's consecutive-failure count is what surfaces that.
      throw new RailError(
        'store-delete-ratio',
        false,
        `deleteMissing() would drop ${doomed.length} of ${local.length} documents ` +
        `(${((doomed.length / local.length) * 100).toFixed(0)}%), over the ` +
        `${maxDeleteRatio * 100}% limit. This usually means the reconcile scan ` +
        `returned a partial listing. Pass {force:true} if the sweep is intended.`)
    }
    const del = this.db.prepare('DELETE FROM documents WHERE type = ? AND id = ?')
    this.db.exec('BEGIN')
    try {
      for (const r of doomed) del.run(r.type, r.id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return doomed.length
  }

  /**
   * Load documents of the given types, grouped and ordered deterministically.
   *
   * Ordering by id rather than insertion order matters more than it looks: the
   * site's index hook and every downstream route list inherit this order, so a
   * stable sort here is part of why two builds of one corpus are byte-identical.
   */
  byType(types: string[]): DocsByType {
    const out: DocsByType = new Map()
    if (types.length === 0) return out
    for (const t of types) out.set(t, [])
    const holes = types.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT type, json FROM documents WHERE type IN (${holes}) ORDER BY type, id`)
      .all(...types) as { type: string; json: string }[]
    for (const r of rows) {
      const list = out.get(r.type)
      if (list) list.push(JSON.parse(r.json) as Doc)
    }
    return out
  }

  /**
   * Make the file safe for N concurrent read-only workers.
   *
   * A read-only connection to a WAL database still has to create the -shm file,
   * so ten workers opening at once race and lose with SQLITE_BUSY -- which in
   * Phase 0 only showed up at the largest corpus, i.e. exactly where a crash is
   * most expensive. A plain rollback-journal file is shareable by any number of
   * readers, so the writer checkpoints out of WAL before the readers arrive.
   */
  prepareForReaders() {
    if (this.readOnly) return
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;')
  }

  close() {
    this.db.close()
  }
}
