// A site where two routes write the same file.
//
// The failure is quiet in a way the others are not: both routes render, both
// count toward the reported total, one silently overwrites the other, and the
// seal describes the tree that actually exists -- so tree and seal agree and the
// only evidence is a route count higher than the file count. Two slugs
// colliding after normalisation is all it takes.
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'test-duplicate-routes',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes: (site) => {
    const all = routes(site)
    return all.map((r, i) => (i === 1 ? { ...r, path: all[0].path } : r))
  },
  templates,
  markdown: 'plain',
  determinism: 'enforce',
})
