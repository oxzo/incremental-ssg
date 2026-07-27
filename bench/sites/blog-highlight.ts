// The example blog with no asset stage, at the 'highlight' markdown tier.
//
// Exists so the Phase 2 re-benchmark measures the *product* pipeline against
// the Phase 0 harness numbers rather than against itself. Assets are left out
// because the harness never had them and Phase 2c measured them separately.
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'bench-blog-highlight',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes,
  templates,
  markdown: 'highlight',
  determinism: 'enforce',
})
