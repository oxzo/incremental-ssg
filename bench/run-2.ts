// Phase 2 re-benchmark. Two questions the project has been quoting numbers for
// without having measured:
//
//   1. Does the *product* build as fast as the Phase 0 harness did? The 8.8s /
//      24,449-route figure came from bench/build.ts, before the engine/site
//      seam existed. Generalising added a per-worker site-module import and a
//      manifest read the harness never had, and nobody had checked the cost.
//
//   2. What does the deploy diff cost? It hashes every emitted byte, and at
//      scale that is the dominant term -- but until now the only figures came
//      from a 40-route demo.
//
// Corpus is matched to the Phase 0 one on the axes that drive per-page cost:
// ~900-word bodies (30 paragraphs), a fenced code block so the 'highlight' tier
// has real work to do, 40 tags, 20 pages, and authors scaled at posts/50.
//
// Output goes to real disk under .bench/, never /tmp -- tmpfs here would
// fabricate the I/O numbers that make the light tier interesting.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { build } from '../src/build.ts'
import { deploy } from '../src/deploy.ts'
import { directoryTarget } from '../src/deploy-mock.ts'
import { hashTree } from '../src/hash-tree.ts'
import { blogDocs, EPOCH } from '../example/blog/fixture.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.bench')
const smoke = process.argv.includes('--smoke')

const POSTS = smoke ? 500 : 20_000
const WORKERS = Math.max(2, availableParallelism() - 2)
const PLAIN = join(ROOT, 'bench/sites/blog-plain.ts')
const HIGHLIGHT = join(ROOT, 'bench/sites/blog-highlight.ts')

mkdirSync(WORK, { recursive: true })
const dbPath = join(WORK, `product-${POSTS}.db`)
const outDir = join(WORK, 'p2-dist')
const liveDir = join(WORK, 'p2-live')
rmSync(dbPath, { force: true })
rmSync(outDir, { recursive: true, force: true })
rmSync(liveDir, { recursive: true, force: true })

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`
const mb = (b: number) => `${(b / 1e6).toFixed(0)}MB`

const docs = blogDocs({ posts: POSTS, tags: 40, pages: 20, authors: Math.max(4, Math.floor(POSTS / 50)), paras: 30, code: true })
process.stdout.write(`corpus: ${fmt(POSTS)} posts, ${fmt(docs.length)} documents\n`)

// Through the real path -- mock CMS over HTTP, real adapter, real sync driver.
// Writing rows straight into SQLite would be faster and would skip the half of
// the pipeline this project actually ships.
const cms = await startMockCms(docs)
const adapter = httpCmsAdapter({ baseUrl: cms.url })
const store = new DocumentStore(dbPath)
const s = await sync(adapter, store, { pageSize: 500 })
store.close()
process.stdout.write(
  `sync:   ${s.strategy}, ${fmt(s.pulled)} pulled, ${s.requests} requests, ` +
  `${(s.bytes / 1e6).toFixed(0)}MB, ${secs(s.ms.total)} ` +
  `(${((s.ms.total * 1000) / s.pulled).toFixed(0)}us/doc)\n`)

type Row = { tier: string; mode: string; routes: number; ms: number; bytes: number; pagesPerSec: number }
const rows: Row[] = []

/**
 * Two runs, keep the faster. The first pays JIT warmup that a real build also
 * pays, but reporting the slower one would understate the product against a
 * Phase 0 harness that used the same rule -- and the comparison is the point.
 */
async function best(site: string, workers: number) {
  const a = await build({ site, dbPath, outDir, workers, clean: true, skipAssets: true })
  const b = await build({ site, dbPath, outDir, workers, clean: true, skipAssets: true })
  return a.ms.total <= b.ms.total ? a : b
}

process.stdout.write('\nfull build (product pipeline, assets skipped)\n')
for (const [tier, site] of [['plain', PLAIN], ['highlight', HIGHLIGHT]] as const) {
  for (const [mode, workers] of [['single', 1], ['parallel', WORKERS]] as const) {
    const r = await best(site, workers)
    const row: Row = {
      tier, mode, routes: r.routes, ms: r.ms.total, bytes: r.bytes,
      pagesPerSec: r.routes / (r.ms.total / 1000),
    }
    rows.push(row)
    process.stdout.write(
      `  ${tier.padEnd(9)} ${mode.padEnd(8)} ${fmt(r.routes).padStart(7)} routes  ` +
      `${secs(r.ms.total).padStart(8)}  ${fmt(row.pagesPerSec).padStart(6)} pages/s  ` +
      `${mb(r.bytes).padStart(6)}  (load ${secs(r.ms.load)} routes ${secs(r.ms.routes)} render ${secs(r.ms.render)})\n`)
  }
}

// The tree the deploy measurements run against is the heavy-tier parallel one,
// since that is the configuration Phase 0 headlined.
const built = await build({ site: HIGHLIGHT, dbPath, outDir, workers: WORKERS, clean: true, skipAssets: true })

process.stdout.write('\ndeploy diff\n')
const t0 = performance.now()
hashTree(outDir)
const hashOnly = performance.now() - t0
process.stdout.write(`  hash tree alone      ${secs(hashOnly).padStart(8)}  ${fmt(built.seal.files)} files, ${mb(built.seal.bytes)}\n`)

const target = directoryTarget({ dir: liveDir })
const cold = await deploy({ outDir, target, seal: built.seal })
process.stdout.write(
  `  cold (all new)       ${secs(cold.ms.total).padStart(8)}  ${fmt(cold.uploaded)} uploaded, ` +
  `${mb(cold.bytes)}  (hash ${secs(cold.ms.hash)} list ${secs(cold.ms.list)} upload ${secs(cold.ms.upload)})\n`)

const warm = await deploy({ outDir, target, seal: (await build({ site: HIGHLIGHT, dbPath, outDir, workers: WORKERS, clean: true, skipAssets: true })).seal })
process.stdout.write(
  `  no-op rebuild        ${secs(warm.ms.total).padStart(8)}  ${fmt(warm.uploaded)} uploaded, ` +
  `${fmt(warm.plan.unchanged)} unchanged  (hash ${secs(warm.ms.hash)} list ${secs(warm.ms.list)})\n`)

// One editor edits one post. The whole stage exists so this costs the size of
// the edit rather than the size of the site.
const post = docs.find((d) => d.doc.id === `post-${Math.floor(POSTS / 2)}`)
if (post) {
  post.doc.title = 'an edited title'
  post.doc.updated_at = EPOCH + 60_000
  post.doc.rev = 'r2-edit'
}
const cms2 = await startMockCms(docs)
const store2 = new DocumentStore(dbPath)
const s2 = await sync(httpCmsAdapter({ baseUrl: cms2.url }), store2, { pageSize: 500 })
store2.close()
await cms2.close()

const edited = await build({ site: HIGHLIGHT, dbPath, outDir, workers: WORKERS, clean: true, skipAssets: true })
const delta = await deploy({ outDir, target, seal: edited.seal })
process.stdout.write(
  `  after one edit       ${secs(delta.ms.total).padStart(8)}  ${fmt(delta.uploaded)} of ` +
  `${fmt(edited.seal.files)} uploaded (${mb(delta.bytes)}), ${fmt(delta.purged)} purged\n`)
process.stdout.write(
  `                       re-sync ${secs(s2.ms.total)} (${s2.strategy}, ${s2.changed} changed), ` +
  `rebuild ${secs(edited.ms.total)}\n`)

await cms.close()

writeFileSync(join(WORK, 'p2-results.json'), JSON.stringify({
  posts: POSTS, documents: docs.length, workers: WORKERS,
  sync: { ms: s.ms.total, requests: s.requests, bytes: s.bytes },
  builds: rows,
  deploy: {
    files: built.seal.files, bytes: built.seal.bytes, hashOnlyMs: hashOnly,
    cold: { ms: cold.ms, uploaded: cold.uploaded, bytes: cold.bytes },
    warm: { ms: warm.ms, uploaded: warm.uploaded, unchanged: warm.plan.unchanged },
    edit: { ms: delta.ms, uploaded: delta.uploaded, purged: delta.purged, plan: {
      added: delta.plan.added.length, modified: delta.plan.modified.length,
      deleted: delta.plan.deleted.length, unchanged: delta.plan.unchanged } },
  },
}, null, 2))
process.stdout.write(`\nwrote ${join(WORK, 'p2-results.json')}\n`)
