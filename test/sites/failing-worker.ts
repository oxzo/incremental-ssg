// A site where exactly one worker fails and the rest cannot write until it has.
//
// The drain test wants to say "every byte in the output directory arrived after
// build() rejected". Getting there by making worker 0 merely *fast* is a race,
// and it is one this fixture lost on CI: on a slower runner three sibling pages
// landed before worker 0 threw, and a test that had been passing locally for the
// wrong reason failed for the right one.
//
// So the ordering is enforced rather than sampled. Worker 0 drops a marker file
// and throws; every other worker blocks until it sees that marker, and only then
// starts the burn that precedes its first write. A sibling's first byte
// therefore cannot precede worker 0's failure -- it is separated from it by a
// full burn, which is the margin the parent has to reject and terminate. Same
// move as A1's kill point: when a window is too narrow to sample, make it
// structural.
//
// The slowness is a synchronous burn rather than a sleep. A template is
// synchronous, so there is nothing to await -- and a busy loop is also the case
// that matters, because it is the one a cooperative cancellation could not
// interrupt. It counts arithmetic rather than reading a clock, so the site stays
// legal under determinism: 'enforce'.
import { workerData } from 'node:worker_threads'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineSite } from '../../src/config.ts'
import type { RenderContext, Route } from '../../src/config.ts'

export type FailIndex = { title: string }

// Routes are split across workers by (index, count), so this is how a template
// learns which slice it is rendering. The main thread has no workerData, which
// makes `workers: 1` the honest single-threaded control: index 0 fails there too.
const index: number = workerData?.index ?? 0
const outDir: string | undefined = workerData?.outDir

/** Beside the output directory, not inside it -- the test counts what is inside. */
const marker = outDir === undefined ? undefined : join(outDir, '..', 'worker-0-failed')

function spin(iterations: number): number {
  let x = 0
  for (let i = 0; i < iterations; i++) x += Math.sqrt(i)
  return x
}

/**
 * The margin before a sibling's first write, ~150ms.
 *
 * Sized from both directions, and the second one is easy to forget. Large
 * enough that the parent has room to reject and terminate after worker 0's
 * failure. Small enough that when the drain is *removed* -- which is what
 * tools/mutate.py does to this rail -- the leaked work still finishes quickly,
 * because a mutation whose test cannot finish is reported as a hang rather than
 * as a kill. An earlier version of this file used 100M here across 40 routes;
 * the leaked render then outlived the harness's 90s timeout on CI and turned a
 * caught mutation into no result at all. That is M2's lesson pointed the other
 * way: a test for a bound has to be able to fail by completing, and a test for a
 * drain has to be able to fail *quickly*.
 */
const pageBurn = () => spin(50_000_000)

/**
 * Block until worker 0 has failed.
 *
 * Polled with a much smaller burn than a page costs, so the wait is responsive
 * and its own bound stays tight: ~800 x 6ms is a five-second ceiling, not the
 * seventy-five a page-sized poll would have given. Bounded and giving up rather
 * than hanging, because a fixture that wedges turns a detected defect into no
 * result, which the harness cannot tell from a pass.
 */
function awaitFailure() {
  if (marker === undefined) return
  for (let spins = 0; spins < 800; spins++) {
    if (existsSync(marker)) return
    spin(2_000_000)
  }
}

/** 12 routes over 4 workers: 3 per sibling, so an undrained pool leaks about a
 *  second of work rather than a minute of it. */
export const ROUTES = 12

export default defineSite<FailIndex>({
  name: 'test-failing-worker',
  contentTypes: ['settings'],
  index: () => ({ title: 'failing-worker' }),
  routes: (): Route[] =>
    Array.from({ length: ROUTES }, (_, i) => ({ kind: 'page', path: `/p/${i}/` })),
  templates: {
    page: (ctx: RenderContext<FailIndex>) => {
      if (index === 0) {
        if (marker !== undefined) writeFileSync(marker, 'failed')
        throw new Error('worker 0 fails on purpose')
      }
      awaitFailure()
      pageBurn()
      return `<p>${ctx.esc(ctx.site.title)}</p>`
    },
  },
  determinism: 'enforce',
})
