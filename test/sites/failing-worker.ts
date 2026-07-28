// A site where exactly one worker fails immediately and the rest render slowly.
//
// The shape the drain test needs, and it has to be this way round: the *fast*
// path is the failure. A worker that fails after doing some work would let its
// siblings write before the rejection, and then "files appeared afterwards"
// could not distinguish a leak from a race. Here worker 0 throws on its first
// template call, before any sibling has finished its first page, so every byte
// in the output directory is a byte written after build() rejected.
//
// The slowness is a synchronous burn rather than a sleep. A template is
// synchronous, so there is nothing to await -- and a busy loop is also the case
// that matters, because it is the one a cooperative cancellation could not
// interrupt. It counts arithmetic rather than reading a clock, so the site is
// still legal under determinism: 'enforce'.
import { workerData } from 'node:worker_threads'
import { defineSite } from '../../src/config.ts'
import type { RenderContext, Route } from '../../src/config.ts'

export type FailIndex = { title: string }

// Routes are split across workers by (index, count), so this is how a template
// learns which slice it is rendering. The main thread has no workerData, which
// makes `workers: 1` the honest single-threaded control: index 0 fails there too.
const index: number = workerData?.index ?? 0

/** ~60ms per page: long enough that an undrained sibling writes within the test's
 *  settle window, short enough that the whole test stays under two seconds. */
function burn(): number {
  let x = 0
  for (let i = 0; i < 20_000_000; i++) x += Math.sqrt(i)
  return x
}

export const ROUTES = 40

export default defineSite<FailIndex>({
  name: 'test-failing-worker',
  contentTypes: ['settings'],
  index: () => ({ title: 'failing-worker' }),
  routes: (): Route[] =>
    Array.from({ length: ROUTES }, (_, i) => ({ kind: 'page', path: `/p/${i}/` })),
  templates: {
    page: (ctx: RenderContext<FailIndex>) => {
      if (index === 0) throw new Error('worker 0 fails on purpose')
      burn()
      return `<p>${ctx.esc(ctx.site.title)}</p>`
    },
  },
  determinism: 'enforce',
})
