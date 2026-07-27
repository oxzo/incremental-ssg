// The example blog at the 'highlight' markdown tier.
//
// Exists so the suite covers the syntax-highlighting path, which is where the
// only determinism exemption in the codebase lives: the tokenizer reads a wall
// clock, and the exemption's whole justification is that the reading cannot
// reach the output. The byte-identity test against this site is what checks
// that claim rather than trusting it.
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'test-blog-highlight',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes,
  templates,
  markdown: 'highlight',
  determinism: 'enforce',
})
