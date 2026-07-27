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
// shares nothing with this.

/**
 * Run `jobs` with at most `width` in flight, preserving input order in the
 * result. Rejects on the first job that throws, like Promise.all -- neither
 * caller has a partial-success story, and inventing one here would hide
 * failures from both.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, width), jobs.length) }, async () => {
      for (;;) {
        const k = i++
        if (k >= jobs.length) return
        out[k] = await jobs[k]()
      }
    }),
  )
  return out
}
