// Route resolution + rendering for the naive full build.
// Shared by the main thread and the worker pool.
//
// Indexes are precomputed once per build. That is deliberate: the gate asks how
// fast a *reasonable* full rebuild is, so measuring an accidentally O(N^2) tag
// filter would argue for incremental on the strength of my own bad code.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import MarkdownIt from 'markdown-it'

export const PAGE_SIZE = 20
export const RELATED = 3
export type Tier = 'light' | 'heavy'

export type Post = {
  id: string; slug: string; title: string; author: string
  tags: string[]; date: number; body: string
}
export type Store = {
  posts: Post[]                       // sorted newest-first
  postById: Map<string, Post>
  authors: Map<string, any>
  tags: Map<string, any>
  pages: any[]
  settings: any
  byTag: Map<string, Post[]>
  byAuthor: Map<string, Post[]>
  indexOf: Map<string, number>        // post id -> position in sorted order
}

export function loadStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 15000;') // workers open this concurrently
  const rows = db.prepare('SELECT type, json FROM documents').all() as any[]
  db.close()
  return storeFromDocs(rows.map((r) => ({ type: r.type as string, doc: JSON.parse(r.json as string) })))
}

export function storeFromDocs(input: { type: string; doc: any }[]): Store {
  const posts: Post[] = []
  const authors = new Map<string, any>()
  const tags = new Map<string, any>()
  const pages: any[] = []
  let settings: any = null

  for (const r of input) {
    const d = r.doc
    if (r.type === 'post') posts.push(d)
    else if (r.type === 'author') authors.set(d.id, d)
    else if (r.type === 'tag') tags.set(d.id, d)
    else if (r.type === 'page') pages.push(d)
    else if (r.type === 'settings') settings = d
  }
  posts.sort((a, b) => b.date - a.date || (a.id < b.id ? -1 : 1))

  const byTag = new Map<string, Post[]>()
  const byAuthor = new Map<string, Post[]>()
  const postById = new Map<string, Post>()
  const indexOf = new Map<string, number>()
  posts.forEach((p, i) => {
    postById.set(p.id, p)
    indexOf.set(p.id, i)
    for (const t of p.tags) (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(p)
    ;(byAuthor.get(p.author) ?? byAuthor.set(p.author, []).get(p.author)!).push(p)
  })
  return { posts, postById, authors, tags, pages, settings, byTag, byAuthor, indexOf }
}

export type Route =
  | { kind: 'home'; path: string }
  | { kind: 'post'; path: string; id: string }
  | { kind: 'archive'; path: string; page: number }
  | { kind: 'tag'; path: string; tag: string; page: number }
  | { kind: 'author'; path: string; author: string }
  | { kind: 'page'; path: string; id: string }
  | { kind: 'sitemap'; path: string }
  | { kind: 'feed'; path: string }

export function resolveRoutes(s: Store): Route[] {
  const out: Route[] = [{ kind: 'home', path: '/' }]
  for (const p of s.posts) out.push({ kind: 'post', path: `/posts/${p.slug}/`, id: p.id })
  const archivePages = Math.max(1, Math.ceil(s.posts.length / PAGE_SIZE))
  for (let i = 1; i <= archivePages; i++) out.push({ kind: 'archive', path: `/posts/page/${i}/`, page: i })
  for (const [tid, list] of s.byTag) {
    const n = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    for (let i = 1; i <= n; i++) out.push({ kind: 'tag', path: `/tags/${tid}/page/${i}/`, tag: tid, page: i })
  }
  for (const aid of s.byAuthor.keys()) out.push({ kind: 'author', path: `/authors/${aid}/`, author: aid })
  for (const p of s.pages) out.push({ kind: 'page', path: `/pages/${p.slug}/`, id: p.id })
  out.push({ kind: 'sitemap', path: '/sitemap.xml' }, { kind: 'feed', path: '/feed.xml' })
  return out
}

export type Renderer = { md: MarkdownIt }

export async function createRenderer(tier: Tier): Promise<Renderer> {
  if (tier === 'light') {
    const md = new MarkdownIt({ html: true, linkify: true })
    return { md }
  }
  const { createHighlighter } = await import('shiki')
  const hl = await createHighlighter({ themes: ['github-dark'], langs: ['ts'] })
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, lang) => {
      if (lang === 'ts') return hl.codeToHtml(code, { lang: 'ts', theme: 'github-dark' })
      return ''
    },
  })
  return { md }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function layout(s: Store, title: string, main: string) {
  const nav = s.settings.nav.map((n: any) => `<a href="${n.href}">${esc(n.label)}</a>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(s.settings.siteName)}</title>
<link rel="stylesheet" href="/assets/site.css">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head><body>
<header><a class="brand" href="/">${esc(s.settings.siteName)}</a><nav>${nav}</nav></header>
<main>${main}</main>
<footer><p>${esc(s.settings.footer)}</p></footer>
</body></html>`
}

const excerpt = (p: Post) => esc(p.body.replace(/[#>`\-*\[\]()]/g, ' ').replace(/\s+/g, ' ').slice(0, 220))

function card(p: Post) {
  return `<article class="card"><h2><a href="/posts/${p.slug}/">${esc(p.title)}</a></h2>
<time datetime="${new Date(p.date).toISOString()}">${new Date(p.date).toISOString().slice(0, 10)}</time>
<p>${excerpt(p)}…</p>
<ul class="tags">${p.tags.map((t) => `<li><a href="/tags/${t}/page/1/">${esc(t)}</a></li>`).join('')}</ul>
</article>`
}

function list(s: Store, title: string, items: Post[], page: number, total: number, base: string) {
  const pager = total > 1
    ? `<nav class="pager">${page > 1 ? `<a href="${base}${page - 1}/">prev</a>` : ''}<span>${page}/${total}</span>${page < total ? `<a href="${base}${page + 1}/">next</a>` : ''}</nav>`
    : ''
  return layout(s, title, `<h1>${esc(title)}</h1>${items.map(card).join('')}${pager}`)
}

export function renderRoute(r: Route, s: Store, rd: Renderer): string {
  switch (r.kind) {
    case 'home':
      return list(s, s.settings.siteName, s.posts.slice(0, 10), 1, 1, '/posts/page/')
    case 'post': {
      const p = s.postById.get(r.id)!
      const author = s.authors.get(p.author)
      const i = s.indexOf.get(p.id)!
      const prev = s.posts[i - 1], next = s.posts[i + 1]
      // Related: same-tag neighbours, excluding self.
      const rel: Post[] = []
      for (const t of p.tags) {
        for (const c of s.byTag.get(t) ?? []) {
          if (c.id !== p.id && !rel.includes(c)) rel.push(c)
          if (rel.length >= RELATED) break
        }
        if (rel.length >= RELATED) break
      }
      const main = `<article><h1>${esc(p.title)}</h1>
<p class="byline">by <a href="/authors/${author.id}/">${esc(author.name)}</a> on
<time datetime="${new Date(p.date).toISOString()}">${new Date(p.date).toISOString().slice(0, 10)}</time></p>
<ul class="tags">${p.tags.map((t) => `<li><a href="/tags/${t}/page/1/">${esc(t)}</a></li>`).join('')}</ul>
${rd.md.render(p.body)}
<nav class="prevnext">${prev ? `<a href="/posts/${prev.slug}/">${esc(prev.title)}</a>` : ''}${next ? `<a href="/posts/${next.slug}/">${esc(next.title)}</a>` : ''}</nav>
<aside class="related"><h2>Related</h2>${rel.map(card).join('')}</aside>
</article>`
      return layout(s, p.title, main)
    }
    case 'archive': {
      const total = Math.max(1, Math.ceil(s.posts.length / PAGE_SIZE))
      const items = s.posts.slice((r.page - 1) * PAGE_SIZE, r.page * PAGE_SIZE)
      return list(s, `Archive — page ${r.page}`, items, r.page, total, '/posts/page/')
    }
    case 'tag': {
      const all = s.byTag.get(r.tag) ?? []
      const total = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
      const items = all.slice((r.page - 1) * PAGE_SIZE, r.page * PAGE_SIZE)
      return list(s, `Tag: ${r.tag}`, items, r.page, total, `/tags/${r.tag}/page/`)
    }
    case 'author': {
      const a = s.authors.get(r.author)
      const items = s.byAuthor.get(r.author) ?? []
      return layout(s, a.name, `<h1>${esc(a.name)}</h1><p>${esc(a.bio)}</p>${items.slice(0, 50).map(card).join('')}`)
    }
    case 'page': {
      const p = s.pages.find((x) => x.id === r.id)
      return layout(s, p.title, `<article><h1>${esc(p.title)}</h1>${rd.md.render(p.body)}</article>`)
    }
    case 'sitemap': {
      const urls = resolveRoutes(s)
        .map((x) => `<url><loc>https://example.com${x.path}</loc></url>`).join('')
      return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
    }
    case 'feed': {
      const items = s.posts.slice(0, 50).map((p) =>
        `<item><title>${esc(p.title)}</title><link>https://example.com/posts/${p.slug}/</link><description>${excerpt(p)}</description></item>`).join('')
      return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(s.settings.siteName)}</title>${items}</channel></rss>`
    }
  }
}

export function outputPath(outDir: string, route: string) {
  return route.endsWith('/') ? join(outDir, route, 'index.html') : join(outDir, route)
}

export function writeOut(outDir: string, route: string, html: string) {
  const p = outputPath(outDir, route)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, html)
  return Buffer.byteLength(html)
}
