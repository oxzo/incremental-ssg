import { workerData, parentPort } from 'node:worker_threads'
import { loadStore, resolveRoutes, createRenderer, renderRoute, writeOut, type Tier } from './render-core.ts'

const { dbPath, outDir, tier, start, end } = workerData as {
  dbPath: string; outDir: string; tier: Tier; start: number; end: number
}

const store = loadStore(dbPath)
const routes = resolveRoutes(store)
const rd = await createRenderer(tier)

let bytes = 0
for (let i = start; i < end; i++) {
  const r = routes[i]
  bytes += writeOut(outDir, r.path, renderRoute(r, store, rd))
}
parentPort!.postMessage({ pages: end - start, bytes })
