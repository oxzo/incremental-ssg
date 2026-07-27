// The example blog, with its asset directories pointed at whatever the running
// test set up. Paths come from the environment because a site definition is
// loaded by path in every render worker -- there is no way to hand it a value --
// and worker threads inherit process.env.
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} must be set to use test/sites/blog-assets.ts`)
  return v
}

export default defineSite<BlogIndex>({
  name: 'test-blog-assets',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes,
  templates,
  markdown: 'plain',
  determinism: 'enforce',
  assets: {
    sources: need('TEST_ASSET_SRC'),
    outDir: need('TEST_ASSET_CACHE'),
    publicPath: '/assets/img',
    formats: ['avif', 'webp'],
    effort: { avif: 0, webp: 4 },
    widths: [400, 800, 1200, 1600],
  },
})
