// A site whose template stamps the wall clock into the page -- the exact thing
// that turns a deploy diff into a full-site upload, and therefore the thing the
// determinism window exists to catch.
//
// The mode is baked into two thin sibling modules rather than read from an
// environment variable, because ESM caches a module after its first import: one
// module reading env at import time would silently reuse the first test's mode
// for the second test, and the second test would pass for the wrong reason.
import { defineSite } from '../../src/config.ts'
import type { DocsByType, RenderContext, Route, SiteConfig } from '../../src/config.ts'

export type StampedIndex = { title: string }

export function makeStampedSite(mode: 'enforce' | 'off'): SiteConfig<StampedIndex> {
  return defineSite<StampedIndex>({
    name: `nondeterministic-${mode}`,
    contentTypes: ['settings'],
    index(docs: DocsByType): StampedIndex {
      const s = (docs.get('settings') ?? [])[0] as { siteName?: string } | undefined
      return { title: s?.siteName ?? 'Untitled' }
    },
    routes(): Route[] {
      return [
        { kind: 'home', path: '/' },
        { kind: 'stamped', path: '/stamped/' },
      ]
    },
    templates: {
      home: (ctx: RenderContext<StampedIndex>) => `<h1>${ctx.esc(ctx.site.title)}</h1>`,
      stamped: (ctx: RenderContext<StampedIndex>) =>
        `<p>built at ${Date.now()} for ${ctx.esc(ctx.site.title)}</p>`,
    },
    determinism: mode,
  })
}
