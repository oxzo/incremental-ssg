// Second gate condition: incremental only pays if a typical edit touches a small
// fraction of pages. Rather than hand-reason about fan-out, this computes the
// exact per-route *input signature* — the projected fields each route actually
// reads — mutates the corpus, and diffs. It is a scale model of the Phase 3
// fingerprint, used here only to answer "does incremental pay at all".
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { storeFromDocs, resolveRoutes, PAGE_SIZE, RELATED, type Store, type Post } from './render-core.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** What a listing card displays — a body edit changes the excerpt, a title edit the title. */
const cardProj = (p: Post) => [p.id, p.title, p.date, p.tags.join(','), p.body.slice(0, 220)].join('|')
/** Prev/next links show title + slug only, so a body edit must NOT invalidate neighbours. */
const linkProj = (p?: Post) => (p ? `${p.slug}|${p.title}` : '-')

function relatedOf(s: Store, p: Post): Post[] {
  const rel: Post[] = []
  for (const t of p.tags) {
    for (const c of s.byTag.get(t) ?? []) {
      if (c.id !== p.id && !rel.includes(c)) rel.push(c)
      if (rel.length >= RELATED) break
    }
    if (rel.length >= RELATED) break
  }
  return rel
}

/** Exact input signature per route: hash of precisely the fields that route reads. */
export function signatures(s: Store): Map<string, string> {
  const sig = new Map<string, string>()
  const settingsSig = sha(JSON.stringify(s.settings))
  for (const r of resolveRoutes(s)) {
    let body: string
    switch (r.kind) {
      case 'home':
        body = s.posts.slice(0, 10).map(cardProj).join('\n'); break
      case 'post': {
        const p = s.postById.get(r.id)!
        const i = s.indexOf.get(p.id)!
        body = [
          JSON.stringify(p),
          s.authors.get(p.author).name,
          p.tags.map((t) => s.tags.get(t)?.name ?? '').join(','),
          relatedOf(s, p).map(cardProj).join(';'),
          linkProj(s.posts[i - 1]), linkProj(s.posts[i + 1]),
        ].join('\n')
        break
      }
      case 'archive':
        body = s.posts.slice((r.page - 1) * PAGE_SIZE, r.page * PAGE_SIZE).map(cardProj).join('\n')
          + `\npage:${r.page}/${Math.max(1, Math.ceil(s.posts.length / PAGE_SIZE))}`
        break
      case 'tag': {
        const all = s.byTag.get(r.tag) ?? []
        body = all.slice((r.page - 1) * PAGE_SIZE, r.page * PAGE_SIZE).map(cardProj).join('\n')
          + `\npage:${r.page}/${Math.max(1, Math.ceil(all.length / PAGE_SIZE))}`
        break
      }
      case 'author':
        body = JSON.stringify(s.authors.get(r.author))
          + (s.byAuthor.get(r.author) ?? []).slice(0, 50).map(cardProj).join('\n')
        break
      case 'page':
        body = JSON.stringify(s.pages.find((x) => x.id === r.id)); break
      case 'sitemap':
        body = resolveRoutes(s).map((x) => x.path).join('\n'); break
      case 'feed':
        body = s.posts.slice(0, 50).map((p) => `${p.title}|${p.slug}|${p.body.slice(0, 220)}`).join('\n'); break
    }
    sig.set(r.path, sha(body + '\n' + settingsSig))
  }
  return sig
}

export type Docs = { type: string; doc: any }[]

export function loadDocs(dbPath: string): Docs {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT type, json FROM documents').all() as any[]
  db.close()
  return rows.map((r) => ({ type: r.type as string, doc: JSON.parse(r.json as string) }))
}

export type Fanout = { changed: number; added: number; removed: number; total: number; pct: number }

function diff(before: Map<string, string>, after: Map<string, string>): Fanout {
  let changed = 0, added = 0, removed = 0
  for (const [k, v] of after) {
    if (!before.has(k)) added++
    else if (before.get(k) !== v) changed++
  }
  for (const k of before.keys()) if (!after.has(k)) removed++
  const total = after.size
  return { changed, added, removed, total, pct: ((changed + added + removed) / total) * 100 }
}

const clone = (d: Docs): Docs => d.map((r) => ({ type: r.type, doc: structuredClone(r.doc) }))

export function measureFanout(dbPath: string) {
  const docs = loadDocs(dbPath)
  const base = storeFromDocs(docs)
  const before = signatures(base)
  const n = base.posts.length
  // "Typical" edit target: a mid-corpus post, not the newest — editing the newest
  // is the best case for archives and would flatter the result.
  const midId = base.posts[Math.floor(n / 2)].id

  const run = (mutate: (d: Docs) => void) => {
    const d = clone(docs)
    mutate(d)
    return diff(before, signatures(storeFromDocs(d)))
  }
  const findPost = (d: Docs, id: string) => d.find((r) => r.type === 'post' && r.doc.id === id)!.doc

  return {
    // Two body edits, because where in the body you edit decides the fan-out:
    // a tail edit leaves the leading excerpt untouched (best case), a head edit
    // changes every listing card that shows it (typical case).
    bodyEditTail: run((d) => { findPost(d, midId).body += '\n\nAppended paragraph for the edit test.' }),
    bodyEditHead: run((d) => {
      const p = findPost(d, midId)
      p.body = 'Rewritten opening paragraph for the edit test. ' + p.body
    }),
    titleEdit: run((d) => { findPost(d, midId).title = 'Retitled for the edit test' }),
    newPost: run((d) => {
      const newest = base.posts[0]
      d.push({ type: 'post', doc: {
        id: 'post-new', slug: 'post-new', title: 'Brand new post',
        author: newest.author, tags: newest.tags.slice(0, 2),
        date: newest.date + 3_600_000, body: '# New\n\nBody of the new post.',
      } })
    }),
    deletePost: run((d) => {
      const i = d.findIndex((r) => r.type === 'post' && r.doc.id === midId)
      d.splice(i, 1)
    }),
    settingsEdit: run((d) => { d.find((r) => r.type === 'settings')!.doc.footer = 'New footer' }),
  }
}
