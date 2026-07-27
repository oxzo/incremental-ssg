// Blog templates. Plain functions from (context, route) to a string.
//
// Every template is synchronous and touches nothing but its arguments -- no
// clock, no randomness, no I/O. That is not a style preference: the determinism
// window in src/determinism.ts makes a `Date.now()` in here throw, because a
// timestamp in a footer would make every page differ on every build and turn the
// Phase 2 deploy diff into a full-site upload.
import type { RenderContext, Route } from '../../src/config.ts'
import type { BlogIndex, Post } from './types.ts'
import { PAGE_SIZE, RELATED } from './types.ts'

type Ctx = RenderContext<BlogIndex>

/** Content timestamps only. `new Date(value)` is deterministic; `new Date()` is not. */
const iso = (ms: number) => new Date(ms).toISOString()
const day = (ms: number) => iso(ms).slice(0, 10)

export function layout(ctx: Ctx, title: string, main: string): string {
  const s = ctx.site.settings
  const nav = s.nav.map((n) => `<a href="${n.href}">${ctx.esc(n.label)}</a>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ctx.esc(title)} — ${ctx.esc(s.siteName)}</title>
<link rel="stylesheet" href="/assets/site.css">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head><body>
<header><a class="brand" href="/">${ctx.esc(s.siteName)}</a><nav>${nav}</nav></header>
<main>${main}</main>
<footer><p>${ctx.esc(s.footer)}</p></footer>
</body></html>`
}

export const excerpt = (p: Post) =>
  p.body.replace(/[#>`\-*\[\]()]/g, ' ').replace(/\s+/g, ' ').slice(0, 220)

function card(ctx: Ctx, p: Post): string {
  return `<article class="card"><h2><a href="/posts/${p.slug}/">${ctx.esc(p.title)}</a></h2>
<time datetime="${iso(p.date)}">${day(p.date)}</time>
<p>${ctx.esc(excerpt(p))}…</p>
<ul class="tags">${p.tags.map((t) => `<li><a href="/tags/${t}/page/1/">${ctx.esc(t)}</a></li>`).join('')}</ul>
</article>`
}

function listPage(
  ctx: Ctx, title: string, items: Post[], page: number, total: number, base: string,
): string {
  const pager = total > 1
    ? `<nav class="pager">${page > 1 ? `<a href="${base}${page - 1}/">prev</a>` : ''}` +
      `<span>${page}/${total}</span>` +
      `${page < total ? `<a href="${base}${page + 1}/">next</a>` : ''}</nav>`
    : ''
  return layout(ctx, title, `<h1>${ctx.esc(title)}</h1>${items.map((p) => card(ctx, p)).join('')}${pager}`)
}

export const templates = {
  home(ctx: Ctx): string {
    return listPage(ctx, ctx.site.settings.siteName, ctx.site.posts.slice(0, 10), 1, 1, '/posts/page/')
  },

  post(ctx: Ctx, route: Route): string {
    const s = ctx.site
    const p = s.postById.get(route.id as string)
    if (!p) throw new Error(`route ${route.path} references unknown post ${route.id}`)
    const author = s.authors.get(p.author)
    const i = s.indexOf.get(p.id) ?? 0
    const prev = s.posts[i - 1]
    const next = s.posts[i + 1]

    const rel: Post[] = []
    for (const t of p.tags) {
      for (const c of s.byTag.get(t) ?? []) {
        if (c.id !== p.id && !rel.includes(c)) rel.push(c)
        if (rel.length >= RELATED) break
      }
      if (rel.length >= RELATED) break
    }

    // The asset-cache integration. `ctx.picture` is a synchronous manifest
    // lookup carrying srcset plus intrinsic width/height, so the browser
    // reserves the box before the bytes land. A hero naming a source that was
    // not processed throws rather than emitting a broken <img>.
    const hero = p.hero
      ? ctx.picture(p.hero, {
          alt: p.title,
          sizes: '(min-width: 60rem) 60rem, 100vw',
          loading: 'eager',
          className: 'hero',
        })
      : ''

    const main = `<article>${hero}<h1>${ctx.esc(p.title)}</h1>
<p class="byline">by <a href="/authors/${p.author}/">${ctx.esc(author ? author.name : p.author)}</a> on
<time datetime="${iso(p.date)}">${day(p.date)}</time></p>
<ul class="tags">${p.tags.map((t) => `<li><a href="/tags/${t}/page/1/">${ctx.esc(t)}</a></li>`).join('')}</ul>
${ctx.md(p.body)}
<nav class="prevnext">${prev ? `<a href="/posts/${prev.slug}/">${ctx.esc(prev.title)}</a>` : ''}${next ? `<a href="/posts/${next.slug}/">${ctx.esc(next.title)}</a>` : ''}</nav>
<aside class="related"><h2>Related</h2>${rel.map((r) => card(ctx, r)).join('')}</aside>
</article>`
    return layout(ctx, p.title, main)
  },

  archive(ctx: Ctx, route: Route): string {
    const page = route.page as number
    const total = Math.max(1, Math.ceil(ctx.site.posts.length / PAGE_SIZE))
    const items = ctx.site.posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    return listPage(ctx, `Archive — page ${page}`, items, page, total, '/posts/page/')
  },

  tag(ctx: Ctx, route: Route): string {
    const tag = route.tag as string
    const page = route.page as number
    const all = ctx.site.byTag.get(tag) ?? []
    const total = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
    const items = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    return listPage(ctx, `Tag: ${tag}`, items, page, total, `/tags/${tag}/page/`)
  },

  author(ctx: Ctx, route: Route): string {
    const id = route.author as string
    const a = ctx.site.authors.get(id)
    const items = ctx.site.byAuthor.get(id) ?? []
    const name = a ? a.name : id
    const bio = a ? a.bio : ''
    return layout(
      ctx, name,
      `<h1>${ctx.esc(name)}</h1><p>${ctx.esc(bio)}</p>${items.slice(0, 50).map((p) => card(ctx, p)).join('')}`,
    )
  },

  page(ctx: Ctx, route: Route): string {
    const p = ctx.site.pages.find((x) => x.id === route.id)
    if (!p) throw new Error(`route ${route.path} references unknown page ${route.id}`)
    return layout(ctx, p.title, `<article><h1>${ctx.esc(p.title)}</h1>${ctx.md(p.body)}</article>`)
  },

  sitemap(ctx: Ctx, route: Route): string {
    // Route paths were resolved once for the build and handed to this template
    // on the route itself, rather than re-resolved here. Re-resolving inside a
    // template is how an accidentally quadratic build gets blamed on the engine.
    const paths = route.paths as string[]
    const urls = paths.map((p) => `<url><loc>https://example.com${p}</loc></url>`).join('')
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
  },

  feed(ctx: Ctx): string {
    const items = ctx.site.posts.slice(0, 50).map((p) =>
      `<item><title>${ctx.esc(p.title)}</title>` +
      `<link>https://example.com/posts/${p.slug}/</link>` +
      `<pubDate>${iso(p.date)}</pubDate>` +
      `<description>${ctx.esc(excerpt(p))}</description></item>`).join('')
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
      `<title>${ctx.esc(ctx.site.settings.siteName)}</title>${items}</channel></rss>`
  },
}
