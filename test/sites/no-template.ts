// A site that resolves a route it has no template for. A build tool that
// silently skipped it would produce a site with a hole in it and exit 0.
import { defineSite } from '../../src/config.ts'
import type { RenderContext, Route } from '../../src/config.ts'

type Index = Record<string, never>

export default defineSite<Index>({
  name: 'no-template',
  contentTypes: ['settings'],
  index: () => ({}) as Index,
  routes: (): Route[] => [
    { kind: 'home', path: '/' },
    { kind: 'orphan', path: '/orphan/' },
  ],
  templates: {
    home: (ctx: RenderContext<Index>) => `<h1>${ctx.esc('home')}</h1>`,
  },
})
