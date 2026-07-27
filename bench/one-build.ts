// One build, one process, JSON to stdout.
//
// Exists because measuring several 20,000-route builds inside a single Node
// process does not produce comparable numbers. The first attempt at the seam
// diagnostic did exactly that and reported that turning the determinism guard
// *off* made the build 18% slower and that resolveSite cost less than its own
// store load -- both impossible, and both explained by a shared heap: each build
// allocates hundreds of megabytes, so every run after the first is measured
// against a different GC state.
//
// The parent spawns this once per configuration. Slower to run, and the only
// version whose numbers mean anything.
import { parseArgs } from 'node:util'
import { build, resolveSite } from '../src/build.ts'
import { buildSingle, buildParallel, clean } from './build.ts'

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    db: { type: 'string' },
    out: { type: 'string' },
    workers: { type: 'string' },
    /** Measure resolveSite alone -- the fixed cost every worker repeats. */
    resolve: { type: 'boolean' },
    /**
     * Run the Phase 0 harness pipeline instead of the product one, so the two
     * can be compared on the same machine at the same moment. Comparing today's
     * product numbers against a figure recorded earlier confounds the seam with
     * whatever else changed about the box in between.
     */
    harness: { type: 'boolean' },
    tier: { type: 'string' },
  },
})

const site = values.site as string
const db = values.db as string

// Empty the output directory BEFORE the clock starts, for both pipelines.
//
// This was the second methodology bug in this benchmark, and it was worse than
// the first because it was a comparison error rather than a noise error. The
// harness path cleaned outside its own timer while the product path passed
// `clean: true` into build(), which cleans inside. So every product figure was
// charged ~2.3s for deleting the previous run's 23,441 files and every harness
// figure was not -- and best-of-N made it worse, systematically favouring
// whichever run happened to find the least to delete (the first run into a
// fresh directory finds nothing).
//
// The tell, again, was internal inconsistency rather than implausibility: total
// wall time did not equal the sum of the phases it reported.
const outDir = values.out as string
if (outDir) clean(outDir)

if (values.harness) {
  const out = outDir
  const tier = (values.tier ?? 'light') as 'light' | 'heavy'
  const workers = Number(values.workers ?? 1)
  const r = workers === 1
    ? await buildSingle(db, out, tier)
    : await buildParallel(db, out, tier, workers)
  process.stdout.write(JSON.stringify({
    total: r.ms.total, ms: r.ms, routes: r.routes, bytes: r.bytes, workers: r.workers,
  }))
} else if (values.resolve) {
  const t = performance.now()
  const r = await resolveSite(site, db)
  process.stdout.write(JSON.stringify({
    total: performance.now() - t, ms: r.ms, documents: r.documents, routes: r.routes.length,
  }))
} else {
  // clean: true is kept so the seal records a clean build (the deploy diff
  // refuses otherwise), but the directory is already empty, so it costs nothing
  // and neither pipeline is charged for it.
  const r = await build({
    site, dbPath: db, outDir,
    workers: Number(values.workers ?? 1), clean: true, skipAssets: true,
  })
  process.stdout.write(JSON.stringify({
    total: r.ms.total, ms: r.ms, routes: r.routes, bytes: r.bytes, workers: r.workers,
  }))
}
