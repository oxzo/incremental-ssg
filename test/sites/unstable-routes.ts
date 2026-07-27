// A site whose route set depends on which thread resolved it.
//
// Exists to prove the cross-worker agreement check can actually fire. Every
// worker resolves the site independently, so "they all resolve the same site"
// is an assumption the build rests on rather than something it used to verify:
// under the previous shape the parent resolved once and handed out ranges, and
// a worker that resolved a different route set would have rendered the wrong
// slice of a different site and reported success.
//
// `threadId` is 0 on the main thread and 1..N in workers, so each worker drops a
// different number of routes and they disagree by construction.
import { threadId } from 'node:worker_threads'
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'test-unstable-routes',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes: (site) => {
    const all = routes(site)
    return all.slice(0, Math.max(1, all.length - threadId))
  },
  templates,
  markdown: 'plain',
  determinism: 'enforce',
})
