// A site with one route that writes outside the output directory.
//
// Not a contrived shape. example/blog/site.ts interpolates CMS-derived slugs and
// tag and author ids straight into route paths, so this is what a single
// document whose slug contains ".." produces -- which makes it a filesystem
// write primitive available to anyone who can edit a document. Nothing
// downstream notices: the file lands outside the tree, the build seal never
// describes it, and the deploy diff never hears about it.
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'test-escaping-route',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes: (site) => {
    const all = routes(site)
    return all.map((r, i) => (i === 0 ? { ...r, path: '/../escaped-by-route.html' } : r))
  },
  templates,
  markdown: 'plain',
  determinism: 'enforce',
})
