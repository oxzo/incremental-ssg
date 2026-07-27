// The synced document mirror.
//
// Post-gate this table carries no build cache -- no routes, no deps, no
// dep_key reverse index. It exists so rendering runs offline against a local
// snapshot, not so builds can skip work. That is why there is nothing here that
// can be *stale*: the only failure mode left is "the mirror is out of date with
// the CMS", which a re-sync fixes, rather than "the cache disagrees with the
// content", which nothing fixes.
import { DatabaseSync } from 'node:sqlite'
import type { Doc, DocsByType } from './config.ts'

/** Bumped when a change here makes an existing database file unreadable. */
export const STORE_SCHEMA = 1

export type StoredDoc = {
  id: string
  type: string
  revision: string
  updated_at: number
  hash: string
  json: string
}

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
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        revision TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        hash TEXT NOT NULL,
        json TEXT NOT NULL
      );
      -- (type, id) rather than (type). byType() is the only type-filtered query
      -- in the engine and it reads ORDER BY type, id -- with an index on type
      -- alone SQLite satisfied the filter and then built a temp B-tree for the
      -- sort, dragging all 158 MB of JSON through the sorter. Measured at 20,461
      -- documents: 460ms ordered against 158ms unordered, so roughly 300ms was
      -- pure sorting. The composite index removes the temp B-tree entirely and
      -- the same read costs 170ms. It is paid once per worker plus once on the
      -- main thread, so at ten workers this is the difference between ~6.4s and
      -- ~3s of aggregate CPU.
      CREATE INDEX IF NOT EXISTS idx_documents_type_id ON documents(type, id);
      -- Strictly redundant now: any query that could use (type) can use the
      -- leftmost prefix of (type, id). Kept as a DROP rather than left in place
      -- so sync does not maintain a second index that nothing reads.
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

  /** Existing content hashes, for deciding what a full pull actually changed. */
  hashes(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, hash FROM documents').all() as
      { id: string; hash: string }[]
    const out = new Map<string, string>()
    for (const r of rows) out.set(r.id, r.hash)
    return out
  }

  ids(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM documents').all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
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
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, revision=excluded.revision,
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
    const { maxDeleteRatio = 0.5, force = false } = opts
    const local = this.ids()
    const doomed = [...local].filter((id) => !live.has(id))
    if (doomed.length === 0) return 0
    if (local.size > 0 && doomed.length / local.size > maxDeleteRatio && !force) {
      throw new Error(
        `deleteMissing() would drop ${doomed.length} of ${local.size} documents ` +
        `(${((doomed.length / local.size) * 100).toFixed(0)}%), over the ` +
        `${maxDeleteRatio * 100}% limit. This usually means the reconcile scan ` +
        `returned a partial listing. Pass {force:true} if the sweep is intended.`)
    }
    const del = this.db.prepare('DELETE FROM documents WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const id of doomed) del.run(id)
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
