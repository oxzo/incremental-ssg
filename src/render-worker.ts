// Render-pool worker. Loads the site module itself (a closure cannot cross a
// thread boundary), re-resolves routes, and renders its slice.
//
// The worker computes its *own* slice from (index, count) rather than being
// handed a [start, end). The parent used to resolve the whole site just to learn
// the route count for slicing -- a full load and parse of every document, on the
// critical path, before a single worker could start. Since each worker resolves
// anyway, the count is already in hand here.
//
// That also turns the agreement check into a real cross-thread one: every worker
// reports a digest of the route set it resolved, and the parent rejects the
// build if they disagree. Under the old shape a worker that somehow resolved a
// different route set was undetectable; under the shape after that, one that
// resolved a *same-length* different set still was.
//
// Errors are posted back as a message rather than left to the 'error' event so
// the parent can name the slice that failed; a worker that dies silently at
// scale is how Phase 0 briefly read a crash as a success.
import { workerData, parentPort } from 'node:worker_threads'
import { prepare, renderRange, sliceFor } from './build.ts'

const { sitePath, dbPath, outDir, manifestPath, index, count } = workerData as {
  sitePath: string
  dbPath: string
  outDir: string
  manifestPath: string | null
  index: number
  count: number
}

try {
  const p = await prepare(sitePath, dbPath, manifestPath)
  const { start, end } = sliceFor(p.routes.length, index, count)
  // renderRange returns the digest of the whole route set this worker resolved,
  // not of its slice. That is the value the parent makes every worker agree on.
  const out = renderRange(p, outDir, start, end)
  parentPort!.postMessage({
    ...out,
    routes: p.routes.length,
    documents: p.documents,
    ms: p.ms,
  })
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  process.exitCode = 1
}
