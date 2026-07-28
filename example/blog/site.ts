// The example site: the blog schema the Phase 0/2b benchmarks hardcoded, moved
// out of the engine and into a SiteConfig.
//
// It exists to prove the seam holds. If anything in `src/` still needed to know
// what a post is, this file could not have been written without changing it.
import { join, resolve } from 'node:path'
import { defineSite } from '../../src/config.ts'
import type { DocsByType, Route } from '../../src/config.ts'
import { templates } from './templates.ts'
import { PAGE_SIZE } from './types.ts'
import type { Author, BlogIndex, Page, Post, Settings, Tag } from './types.ts'

const here = import.meta.dirname

/**
 * Build every index the templates need, once.
 *
 * Deliberately eager and deliberately here rather than in the engine: the
 * benchmark comment that survived into Phase 1 is that measuring an accidentally
 * O(N^2) tag filter would argue for an incremental engine on the strength of bad
 * template code. Sorting and grouping once keeps the render loop linear.
 */
export function index(docs: DocsByType): BlogIndex {
  const posts = (docs.get('post') ?? []) as unknown as Post[]
  const settings = ((docs.get('settings') ?? [])[0] ?? {
    id: 'settings', siteName: 'Untitled', nav: [], footer: '',
  }) as unknown as Settings

  // Newest first, ties broken by id: a total order, so two builds of the same
  // corpus produce the same pagination and therefore the same bytes.
  const sorted = posts.slice().sort((a, b) => b.date - a.date || (a.id < b.id ? -1 : 1))

  const authors = new Map<string, Author>()
  for (const a of (docs.get('author') ?? []) as unknown as Author[]) authors.set(a.id, a)
  const tags = new Map<string, Tag>()
  for (const t of (docs.get('tag') ?? []) as unknown as Tag[]) tags.set(t.id, t)

  const byTag = new Map<string, Post[]>()
  const byAuthor = new Map<string, Post[]>()
  const postById = new Map<string, Post>()
  const indexOf = new Map<string, number>()

  sorted.forEach((p, i) => {
    postById.set(p.id, p)
    indexOf.set(p.id, i)
    for (const t of p.tags) {
      const list = byTag.get(t)
      if (list) list.push(p)
      else byTag.set(t, [p])
    }
    const own = byAuthor.get(p.author)
    if (own) own.push(p)
    else byAuthor.set(p.author, [p])
  })

  return {
    posts: sorted,
    postById,
    authors,
    tags,
    pages: (docs.get('page') ?? []) as unknown as Page[],
    settings,
    byTag,
    byAuthor,
    indexOf,
  }
}

/**
 * One route per output file.
 *
 * Phase 0 measured routes at ~1.22x posts on this shape, and found that a new
 * post shifts every archive page's slice -- ~9% of all routes at every scale.
 * That fan-out is a property of paginating a date-sorted archive, visible right
 * here in the archive and tag loops, and it is why no dependency graph would
 * have saved the publish case.
 */
export function routes(site: BlogIndex): Route[] {
  const out: Route[] = [{ kind: 'home', path: '/' }, { kind: 'about', path: '/about/' }]

  for (const p of site.posts) out.push({ kind: 'post', path: `/posts/${p.slug}/`, id: p.id })

  const archivePages = Math.max(1, Math.ceil(site.posts.length / PAGE_SIZE))
  for (let i = 1; i <= archivePages; i++) {
    out.push({ kind: 'archive', path: `/posts/page/${i}/`, page: i })
  }

  // Sorted so route order does not depend on Map insertion order, which depends
  // on document arrival order. Stable route order keeps worker slices, and
  // therefore any per-slice reporting, reproducible between runs.
  for (const tid of [...site.byTag.keys()].sort()) {
    const n = Math.max(1, Math.ceil((site.byTag.get(tid) ?? []).length / PAGE_SIZE))
    for (let i = 1; i <= n; i++) {
      out.push({ kind: 'tag', path: `/tags/${tid}/page/${i}/`, tag: tid, page: i })
    }
  }

  for (const aid of [...site.byAuthor.keys()].sort()) {
    out.push({ kind: 'author', path: `/authors/${aid}/`, author: aid })
  }

  for (const p of site.pages) out.push({ kind: 'page', path: `/pages/${p.slug}/`, id: p.id })

  // The sitemap lists the HTML routes above; it carries them on the route so the
  // template never re-resolves anything.
  const paths = out.map((r) => r.path)
  out.push({ kind: 'sitemap', path: '/sitemap.xml', paths })
  out.push({ kind: 'feed', path: '/feed.xml' })
  return out
}

export default defineSite<BlogIndex>({
  name: 'example-blog',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes,
  templates,
  markdown: 'plain',
  determinism: 'enforce',
  assets: {
    sources: join(here, 'images'),
    // Outside any build output directory on purpose: a `clean` build must not
    // throw away derivatives that cost ~59 minutes to regenerate at scale.
    outDir: resolve(here, '../../.cache/assets'),
    publicPath: '/assets/img',
    // Best-first; the last format is the <img> fallback. AVIF effort 0 is a
    // deliberate choice, not sharp's default of 4, which Phase 2b measured as an
    // ~11x build-time decision for 2.8x smaller files.
    formats: ['avif', 'webp'],
    effort: { avif: 0, webp: 4 },
    widths: [400, 800, 1200, 1600],
  },
})
