// A site whose *route set* is nondeterministic, rather than its page bodies.
//
// The case the determinism window used to miss entirely. It opened inside
// renderRange, so index() and routes() -- the two hooks that decide what the
// site *is* -- ran outside it. That is the worst place for the gap: a clock read
// in a template changes one page, while a clock read here changes which pages
// exist, so the seal describes a different tree on every build and the deploy
// diff reports the entire site as modified.
//
// The parallel path had a partial backstop, which is why this fixture is built
// for a single worker: workers must agree on a digest of the resolved route
// list, so a clock here makes them disagree and the build refuses for a
// different reason. With one worker there is nobody to disagree with.
import { defineSite } from '../../src/config.ts'
import type { DocsByType, RenderContext, Route } from '../../src/config.ts'

export type StampedRoutesIndex = { title: string }

export default defineSite<StampedRoutesIndex>({
  name: 'test-stamped-routes',
  contentTypes: ['settings'],
  index(docs: DocsByType): StampedRoutesIndex {
    const s = (docs.get('settings') ?? [])[0] as { siteName?: string } | undefined
    return { title: s?.siteName ?? 'Untitled' }
  },
  routes(): Route[] {
    // The whole point: the route set depends on the wall clock.
    return [
      { kind: 'home', path: '/' },
      { kind: 'home', path: `/build-${Date.now()}/` },
    ]
  },
  templates: {
    home: (ctx: RenderContext<StampedRoutesIndex>) => `<h1>${ctx.esc(ctx.site.title)}</h1>`,
  },
  determinism: 'enforce',
})
