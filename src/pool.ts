// Bounded-parallel map over async jobs.
//
// One implementation, because there were briefly two: the asset stage wrote one
// to cap sharp's concurrency, and the deploy diff copied its shape to cap
// uploads. That is the same drift hazard this codebase keeps meeting -- two
// copies of a primitive stay identical exactly until one of them is fixed.
//
// This is deliberately *not* a worker-thread pool. It bounds concurrent
// promises on one thread, which is what both callers need: sharp releases the
// event loop during encoding, and uploads are I/O. The worker pool in build.ts
// is a different mechanism for a different problem (CPU-bound rendering) and
// shares nothing with this -- except, as it turned out, the failure below.

/**
 * Run `jobs` with at most `width` in flight, preserving input order in the
 * result. Rejects with the first job that throws, having first stopped.
 *
 * "Having first stopped" is the whole of the change. This used to reject the
 * moment a job threw, which said nothing about the other runners: they kept
 * pulling from the queue and ran the entire remaining list in the background,
 * after the caller had been told the operation failed. Measured at 12 jobs and
 * width 3 with the first job throwing -- rejected having run 1, then completed
 * all 12. For the deploy that is uploads still landing in a live bucket after
 * deploy() threw and the build lock, released in a finally and therefore
 * immediately, reported no writer left.
 *
 * The old contract is worth quoting because it was not false: "rejects on the
 * first job that throws, like Promise.all". True about the returned promise,
 * and a false implication about the work. A comment can describe the value and
 * still mislead about the effects.
 *
 * A promise cannot be cancelled, so this is the weaker of the two drains
 * available: stop *pulling* new jobs, and await only those already in flight.
 * That bounds the wait by one job rather than by the rest of the list -- an
 * unbounded drain is a hang, and this project treats a hang as worse than a
 * failure. build.ts gets the stronger one, because a worker can be terminated.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let i = 0
  // A flag rather than a `failure !== undefined` test, because a job is allowed
  // to throw undefined and the decision to stop must not depend on what it threw.
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, width), jobs.length) }, async () => {
      for (;;) {
        if (failed) return
        const k = i++
        if (k >= jobs.length) return
        try {
          out[k] = await jobs[k]()
        } catch (e) {
          // First thrower wins. The ones that follow it are as likely to be
          // consequences as causes, and the first is the one worth reporting.
          if (!failed) {
            failed = true
            failure = e
          }
          return
        }
      }
    }),
  )
  if (failed) throw failure
  return out
}
