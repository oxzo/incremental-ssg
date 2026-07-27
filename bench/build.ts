// Naive full build — no cache, no skipping. This is the Phase 0 measurement and
// (per the plan) the permanent correctness oracle later phases get diffed against.
import { Worker } from 'node:worker_threads'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadStore, resolveRoutes, createRenderer, renderRoute, writeOut, type Tier } from './render-core.ts'

export type BuildResult = {
  routes: number; bytes: number; workers: number; tier: Tier
  ms: { load: number; routes: number; rendererInit: number; render: number; total: number }
}

const now = () => performance.now()

export async function buildSingle(dbPath: string, outDir: string, tier: Tier): Promise<BuildResult> {
  const t0 = now()
  const store = loadStore(dbPath)
  const t1 = now()
  const routes = resolveRoutes(store)
  const t2 = now()
  const rd = await createRenderer(tier)
  const t3 = now()
  let bytes = 0
  for (const r of routes) bytes += writeOut(outDir, r.path, renderRoute(r, store, rd))
  const t4 = now()
  return {
    routes: routes.length, bytes, workers: 1, tier,
    ms: { load: t1 - t0, routes: t2 - t1, rendererInit: t3 - t2, render: t4 - t3, total: t4 - t0 },
  }
}

export async function buildParallel(
  dbPath: string, outDir: string, tier: Tier, workers: number,
): Promise<BuildResult> {
  const t0 = now()
  // Route resolution happens once on the main thread to get the count; each
  // worker re-resolves independently (cheap) so slices line up.
  const store = loadStore(dbPath)
  const routes = resolveRoutes(store)
  const t2 = now()

  const per = Math.ceil(routes.length / workers)
  const url = new URL('./worker.ts', import.meta.url)
  const jobs = Array.from({ length: workers }, (_, w) => {
    const start = w * per
    const end = Math.min(routes.length, start + per)
    return new Promise<{ pages: number; bytes: number }>((res, rej) => {
      if (start >= end) return res({ pages: 0, bytes: 0 })
      const wk = new Worker(fileURLToPath(url), {
        workerData: { dbPath, outDir, tier, start, end },
      })
      let out = { pages: 0, bytes: 0 }
      wk.on('message', (m) => { out = m })
      wk.on('error', rej)
      wk.on('exit', (c) => (c === 0 ? res(out) : rej(new Error(`worker exit ${c}`))))
    })
  })
  const done = await Promise.all(jobs)
  const t4 = now()
  return {
    routes: routes.length,
    bytes: done.reduce((a, b) => a + b.bytes, 0),
    workers, tier,
    // Worker mode folds load/init into the parallel section; report it as render.
    ms: { load: t2 - t0, routes: 0, rendererInit: 0, render: t4 - t2, total: t4 - t0 },
  }
}

export function clean(outDir: string) {
  rmSync(outDir, { recursive: true, force: true })
}
