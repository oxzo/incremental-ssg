// Render-pool worker. Loads the site module itself (a closure cannot cross a
// thread boundary), re-resolves routes, and renders its slice.
//
// Errors are posted back as a message rather than left to the 'error' event so
// the parent can name the slice that failed; a worker that dies silently at
// scale is how Phase 0 briefly read a crash as a success.
import { workerData, parentPort } from 'node:worker_threads'
import { prepare, renderRange } from './build.ts'

const { sitePath, dbPath, outDir, manifestPath, start, end } = workerData as {
  sitePath: string
  dbPath: string
  outDir: string
  manifestPath: string | null
  start: number
  end: number
}

try {
  const p = await prepare(sitePath, dbPath, manifestPath)
  parentPort!.postMessage(renderRange(p, outDir, start, end))
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  process.exitCode = 1
}
