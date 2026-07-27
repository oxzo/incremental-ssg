// Synthetic corpus generator. Deterministic by seed so runs are comparable —
// the same determinism discipline the real renderer will need.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

export type Doc = { id: string; type: string; updated_at: number; hash: string; json: string }

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = `system content build cache render page route document query invalidate
dependency graph fingerprint hash pipeline template layout archive index deploy edge
static incremental publish revision webhook consistency latency throughput schema
migration transaction rollback snapshot manifest projection aggregate sitemap feed
tag author slug excerpt payload cursor delta reconcile orphan stale correctness oracle
worker parallel thread budget threshold measurement baseline regression instrument`
  .split(/\s+/)
  .filter(Boolean)

const CODE_SAMPLE = `export function fingerprint(deps: Dep[], code: string): string {
  const h = createHash('sha256')
  for (const d of deps.sort((a, b) => a.key < b.key ? -1 : 1)) {
    h.update(d.key); h.update('\\0'); h.update(d.hash); h.update('\\0')
  }
  h.update(code)
  return h.digest('hex').slice(0, 16)
}`

function words(rnd: () => number, n: number) {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)])
  return out.join(' ')
}

function sentence(rnd: () => number) {
  const s = words(rnd, 8 + Math.floor(rnd() * 14))
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function paragraph(rnd: () => number) {
  const n = 3 + Math.floor(rnd() * 4)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(sentence(rnd))
  return out.join(' ')
}

/** ~900-word markdown body with headings, a code block, a list, links, a quote. */
function body(rnd: () => number, i: number) {
  const parts: string[] = [paragraph(rnd), '']
  const sections = 3 + Math.floor(rnd() * 3)
  for (let s = 0; s < sections; s++) {
    parts.push(`## ${words(rnd, 3 + Math.floor(rnd() * 3))}`, '')
    parts.push(paragraph(rnd), '')
    if (s === 0) {
      parts.push('```ts', CODE_SAMPLE, '```', '')
    }
    if (s === 1) {
      parts.push(
        ...Array.from({ length: 4 }, () => `- ${sentence(rnd)}`),
        '',
        `> ${sentence(rnd)}`,
        '',
      )
    }
    parts.push(paragraph(rnd), '')
    parts.push(
      `See [${words(rnd, 2)}](/posts/post-${Math.floor(rnd() * Math.max(1, i))}/) for context.`,
      '',
    )
  }
  return parts.join('\n')
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export function generate(dbPath: string, nPosts: number, seed = 7) {
  const rnd = mulberry32(seed)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    DROP TABLE IF EXISTS documents;
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, updated_at INTEGER NOT NULL,
      hash TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX idx_documents_type ON documents(type);
  `)

  const ins = db.prepare('INSERT INTO documents (id,type,updated_at,hash,json) VALUES (?,?,?,?,?)')
  const nAuthors = Math.max(4, Math.floor(nPosts / 50))
  const nTags = 40
  const nPages = 20
  // Fixed epoch — no Date.now(), so corpora are byte-identical across runs.
  const EPOCH = 1_700_000_000_000

  const put = (id: string, type: string, obj: Record<string, unknown>, t: number) => {
    const json = JSON.stringify(obj)
    ins.run(id, type, t, sha(json), json)
  }

  for (let i = 0; i < nAuthors; i++) {
    put(`author-${i}`, 'author', {
      id: `author-${i}`, slug: `author-${i}`,
      name: `${words(rnd, 2)}`, bio: paragraph(rnd),
    }, EPOCH)
  }
  for (let i = 0; i < nTags; i++) {
    put(`tag-${i}`, 'tag', { id: `tag-${i}`, slug: `tag-${i}`, name: words(rnd, 1) }, EPOCH)
  }
  for (let i = 0; i < nPages; i++) {
    put(`page-${i}`, 'page', {
      id: `page-${i}`, slug: `page-${i}`, title: words(rnd, 3), body: body(rnd, i),
    }, EPOCH)
  }
  for (let i = 0; i < nPosts; i++) {
    const nt = 2 + Math.floor(rnd() * 3)
    const tags = new Set<string>()
    while (tags.size < nt) tags.add(`tag-${Math.floor(rnd() * nTags)}`)
    put(`post-${i}`, 'post', {
      id: `post-${i}`,
      slug: `post-${i}`,
      title: words(rnd, 4 + Math.floor(rnd() * 4)),
      author: `author-${Math.floor(rnd() * nAuthors)}`,
      tags: [...tags],
      // Descending date: post-0 is newest, so a new post inserts at the top of
      // every archive — the pagination-shift case the gate needs to measure.
      date: EPOCH - i * 3_600_000,
      body: body(rnd, i),
    }, EPOCH - i * 3_600_000)
  }

  put('settings', 'settings', {
    id: 'settings', siteName: 'Bench Site',
    nav: Array.from({ length: 8 }, (_, i) => ({ label: `nav-${i}`, href: `/pages/page-${i}/` })),
    footer: paragraph(rnd),
  }, EPOCH)

  // Checkpoint and drop out of WAL before readers touch it. A read-only
  // connection to a WAL database still needs to create the -shm file, so N
  // concurrent workers race and lose with SQLITE_BUSY; a plain rollback-journal
  // file is safely shareable by any number of readers.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;')
  db.close()
  return { nPosts, nAuthors, nTags, nPages }
}
