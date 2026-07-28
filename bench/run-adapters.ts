// The two measurements that were blocked on having a real adapter, and only on
// that. Both have been open since Phase 2b/2d.
//
//   1. The page-size lever. Every sync figure in this project came from a mock
//      on localhost, where round-trip time is meaningless, so page size -- the
//      largest identified lever on sync wall time -- had never been exercised
//      against anything. Phase 2b published a *model*, requests x RTT + local,
//      and modelled numbers from it. This measures the model.
//
//   2. The deploy diff's listing cost. A directory target lists for free, so the
//      cost of comparing against a paginating remote was a guess with a stated
//      assumption (1000 objects per page) and no measurement behind it.
//
// Method, per the rules this project earned the hard way:
//   - configurations are INTERLEAVED, never batched: a loaded box drifts more
//     than the effect being measured, and batching turns run order into a
//     confound
//   - spreads are reported, never best-of-N, which selects for the friendliest
//     conditions rather than the truth
//   - every total is reconciled against its parts, because both retractions in
//     this project announced themselves as internal inconsistency rather than
//     as implausibility
//
// Injected latency is a constant and real RTT is a distribution. What this buys
// is a swept variable instead of a single sample; what it does not buy is a
// tail. Read the model check, not the absolute milliseconds.
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { directusCmsAdapter } from '../src/cms-directus.ts'
import { s3DeployTarget } from '../src/deploy-s3.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { startProxy } from '../stack/proxy.ts'

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k} -- source stack/env.sh first`)
  return v
}

const root = resolve(import.meta.dirname, '..')
const ROUNDS = Number(process.env.ISSG_BENCH_ROUNDS ?? 3)
const PAGE_SIZES = (process.env.ISSG_BENCH_PAGES ?? '50,100,500,1000').split(',').map(Number)
const LATENCIES = (process.env.ISSG_BENCH_RTT ?? '0,25,100').split(',').map(Number)

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`)
const spread = (xs: number[]) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// --- measurement 1: page size against injected RTT ---------------------------

type SyncPoint = { pageSize: number; latency: number; ms: number[]; requests: number; pulled: number; httpMs: number[] }

async function measureSync(): Promise<SyncPoint[]> {
  const proxy = await startProxy({ origin: env('ISSG_DIRECTUS_URL'), latencyMs: 0 })
  const points = new Map<string, SyncPoint>()
  const key = (p: number, l: number) => `${p}:${l}`

  for (const latency of LATENCIES) {
    for (const p of PAGE_SIZES) points.set(key(p, latency), { pageSize: p, latency, ms: [], requests: 0, pulled: 0, httpMs: [] })
  }

  for (let round = 0; round < ROUNDS; round++) {
    for (const latency of LATENCIES) {
      // Interleaved: every page size is visited once per round, so drift in the
      // box spreads across configurations instead of landing on one of them.
      for (const pageSize of PAGE_SIZES) {
        proxy.configure({ latencyMs: latency })
        const dir = mkdtempSync(join(root, '.tmp', 'bench-sync-'))
        const store = new DocumentStore(join(dir, 'content.db'))
        const adapter = directusCmsAdapter({
          baseUrl: proxy.url,
          email: env('ISSG_DIRECTUS_EMAIL'),
          password: env('ISSG_DIRECTUS_PASSWORD'),
          collections: ['post', 'author', 'tag', 'page', 'settings'],
          timeoutMs: 120_000,
        })
        const t0 = performance.now()
        const res = await sync(adapter, store, { pageSize, full: true, reconcile: false })
        const wall = performance.now() - t0
        store.close()
        rmSync(dir, { recursive: true, force: true })

        const pt = points.get(key(pageSize, latency))!
        pt.ms.push(wall)
        pt.httpMs.push(res.ms.http)
        pt.requests = res.requests
        pt.pulled = res.pulled
      }
    }
  }
  await proxy.close()
  return [...points.values()]
}

// --- measurement 2: the deploy diff's listing cost ---------------------------

type ListPoint = { pageSize: number; latency: number; ms: number[]; objects: number; requests: number }

async function measureListing(): Promise<ListPoint[]> {
  const proxy = await startProxy({ origin: env('ISSG_S3_ENDPOINT'), latencyMs: 0 })
  const points: ListPoint[] = []
  const configs: { pageSize: number; latency: number }[] = []
  for (const latency of LATENCIES) for (const pageSize of [100, 500, 1000]) configs.push({ pageSize, latency })
  for (const c of configs) points.push({ ...c, ms: [], objects: 0, requests: 0 })

  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < configs.length; i++) {
      const { pageSize, latency } = configs[i]
      proxy.configure({ latencyMs: latency })
      const target = s3DeployTarget({
        bucket: env('ISSG_S3_BUCKET'),
        endpoint: proxy.url,
        region: env('ISSG_S3_REGION', 'us-east-1'),
        accessKeyId: env('ISSG_S3_ACCESS_KEY'),
        secretAccessKey: env('ISSG_S3_SECRET_KEY'),
        pageSize,
      })
      const before = proxy.stats().requests
      const t0 = performance.now()
      const listed = await target.list()
      const wall = performance.now() - t0
      points[i].ms.push(wall)
      points[i].objects = listed.length
      points[i].requests = proxy.stats().requests - before
    }
  }
  await proxy.close()
  return points
}

// --- report ------------------------------------------------------------------

console.log('# Adapter measurements\n')
console.log(`rounds: ${ROUNDS}, interleaved; spreads reported, not best-of-N\n`)

console.log('## 1. Sync: page size against injected RTT\n')
const syncPoints = await measureSync()
console.log('| RTT | page size | requests | wall (spread) | median | http | predicted (req x RTT + local) | delta |')
console.log('|---:|---:|---:|---|---:|---:|---:|---:|')

// The local term is taken from the zero-latency runs at the same page size, so
// the prediction is built from this session's own numbers rather than from a
// figure recorded on another day on a differently-loaded box.
const localAt = new Map<number, number>()
for (const p of syncPoints) if (p.latency === 0) localAt.set(p.pageSize, median(p.ms))

for (const p of syncPoints.sort((a, b) => a.latency - b.latency || a.pageSize - b.pageSize)) {
  const local = localAt.get(p.pageSize) ?? 0
  const predicted = p.requests * p.latency + local
  const actual = median(p.ms)
  const delta = predicted === 0 ? 0 : ((actual - predicted) / predicted) * 100
  console.log(
    `| ${p.latency}ms | ${p.pageSize} | ${p.requests} | ${spread(p.ms)} | ${fmt(actual)} | ` +
    `${fmt(median(p.httpMs))} | ${fmt(predicted)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% |`,
  )
}

const pulled = new Set(syncPoints.map((p) => p.pulled))
console.log(
  `\nreconciliation: every configuration pulled ${[...pulled].join('/')} documents` +
  `${pulled.size === 1 ? ' — page size changes the request count, not the result' : ' — MISMATCH, do not trust this table'}`,
)

console.log('\n## 2. Deploy diff: remote listing cost\n')
const listPoints = await measureListing()
console.log('| RTT | page size | objects | requests | wall (spread) | median | per request |')
console.log('|---:|---:|---:|---:|---|---:|---:|')
for (const p of listPoints.sort((a, b) => a.latency - b.latency || a.pageSize - b.pageSize)) {
  console.log(
    `| ${p.latency}ms | ${p.pageSize} | ${p.objects} | ${p.requests} | ${spread(p.ms)} | ` +
    `${fmt(median(p.ms))} | ${fmt(median(p.ms) / p.requests)} |`,
  )
}
const counts = new Set(listPoints.map((p) => p.objects))
console.log(
  `\nreconciliation: every configuration listed ${[...counts].join('/')} objects` +
  `${counts.size === 1 ? ' — pagination changes the request count, not the result' : ' — MISMATCH, do not trust this table'}`,
)
