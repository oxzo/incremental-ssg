// A site whose route set differs per thread while its route *count* does not.
//
// The case sites/unstable-routes.ts cannot express, and the one the agreement
// check used to miss entirely: it compared counts, so two workers resolving
// different route lists of equal length agreed. Each then rendered its own slice
// of a different site, every worker reported success, and the seal vouched for
// the mixture.
//
// One route's path is stamped with the thread that resolved it, so the lists are
// the same length and differ by exactly one element -- the smallest disagreement
// the check has to catch, rather than an obvious one.
import { threadId } from 'node:worker_threads'
import { defineSite } from '../../src/config.ts'
import { index, routes } from '../../example/blog/site.ts'
import { templates } from '../../example/blog/templates.ts'
import type { BlogIndex } from '../../example/blog/types.ts'

export default defineSite<BlogIndex>({
  name: 'test-same-length-routes',
  contentTypes: ['post', 'author', 'tag', 'page', 'settings'],
  index,
  routes: (site) => {
    const all = routes(site)
    return all.map((r, i) => (i === 0 ? { ...r, path: `/thread-${threadId}/` } : r))
  },
  templates,
  markdown: 'plain',
  determinism: 'enforce',
})
