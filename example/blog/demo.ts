// End-to-end demo: mock CMS -> sync -> store -> assets -> render -> write -> deploy.
//
// The whole pipeline in one runnable file. `npm run demo`.
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startMockCms } from '../../src/cms-mock.ts'
import { httpCmsAdapter } from '../../src/cms.ts'
import { DocumentStore } from '../../src/store.ts'
import { sync } from '../../src/sync.ts'
import { build } from '../../src/build.ts'
import { deploy } from '../../src/deploy.ts'
import { directoryTarget } from '../../src/deploy-mock.ts'
import { blogDocs, makeImages, EPOCH } from './fixture.ts'

const root = resolve(import.meta.dirname, '../..')
mkdirSync(join(root, '.tmp'), { recursive: true })
const work = mkdtempSync(join(root, '.tmp', 'demo-'))
const dbPath = join(work, 'content.db')
const outDir = join(work, 'dist')
const sitePath = join(import.meta.dirname, 'site.ts')

const ms = (n: number) => `${n.toFixed(1)}ms`

// Sources live beside the site module; the site config points the asset stage at
// this directory and every file in it gets processed.
const heroes = await makeImages(join(import.meta.dirname, 'images'), [
  'hero-a.jpg', 'hero-b.jpg', 'hero-c.jpg',
])
console.log(`images:   ${heroes.length} sources in example/blog/images`)

const docs = blogDocs({ posts: 25, heroes })
const cms = await startMockCms(docs)
const store = new DocumentStore(dbPath)
const adapter = httpCmsAdapter({ baseUrl: cms.url })

const first = await sync(adapter, store, { pageSize: 500 })
console.log(
  `sync:     ${first.strategy} — ${first.pulled} pulled, ${first.changed} changed, ` +
  `${first.deleted} deleted, ${first.requests} requests, ${ms(first.ms.total)}`)

// A second sync with nothing changed: delta strategy, and the point is that it
// reports zero changes rather than re-storing the whole corpus.
const second = await sync(adapter, store, { pageSize: 500 })
console.log(
  `re-sync:  ${second.strategy} — ${second.pulled} pulled, ${second.changed} changed, ` +
  `${second.requests} requests, ${ms(second.ms.total)}`)
store.close()
await cms.close()

const cold = await build({ site: sitePath, dbPath, outDir, clean: true })
console.log(
  `build:    ${cold.routes} routes, ${cold.documents} docs, ${(cold.bytes / 1024).toFixed(0)} KiB, ` +
  `${cold.workers} workers, ${ms(cold.ms.total)} ` +
  `(assets ${ms(cold.ms.assets)}, render ${ms(cold.ms.render)})`)
if (cold.assets) {
  console.log(
    `assets:   ${cold.assets.sources} sources, ${cold.assets.stats.hits} hits, ` +
    `${cold.assets.stats.misses} misses, ${cold.assets.published} published`)
}

// The asset cache is content-addressed and lives outside the output dir, so a
// clean rebuild pays nothing to re-encode. Phase 2c measured 130x on this.
const warm = await build({ site: sitePath, dbPath, outDir, clean: true })
console.log(
  `rebuild:  ${ms(warm.ms.total)} (assets ${ms(warm.ms.assets)}, render ${ms(warm.ms.render)}) — ` +
  `${warm.assets ? warm.assets.stats.hits : 0} asset hits, ` +
  `${warm.assets ? warm.assets.stats.misses : 0} misses`)

// The deploy diff. The target is a directory standing in for the live site --
// no real host is wired up yet, deliberately, the same way the CMS is still a
// mock behind its adapter.
const liveDir = join(work, 'live')
const target = directoryTarget({ dir: liveDir })

const full = await deploy({ outDir, target, seal: warm.seal })
console.log(
  `\ndeploy:   ${full.plan.added.length} added, ${full.plan.modified.length} modified, ` +
  `${full.plan.deleted.length} deleted, ${full.plan.unchanged} unchanged, ` +
  `${(full.bytes / 1024).toFixed(0)} KiB, ${ms(full.ms.total)}`)

// Nothing changed, so nothing moves. This is the byte-identity property paying
// out: if a template reached for the clock, every file would be "modified" here.
const noop = await deploy({ outDir, target, seal: (await build({ site: sitePath, dbPath, outDir, clean: true })).seal })
console.log(
  `re-deploy: ${noop.uploaded} uploaded, ${noop.deleted} deleted, ` +
  `${noop.plan.unchanged} unchanged, ${ms(noop.ms.total)}`)

// One editor edits one post. Phase 0 measured a title edit at 8 changed routes
// whether the site had 500 posts or 20,000 -- constant, not proportional. On a
// 25-post demo that constant is a large *share* of a tiny site, so read the
// count below, not the percentage; the percentage is the thing that shrinks as
// the site grows.
const post = docs.find((d) => d.doc.id === 'post-7')
if (post) {
  post.doc.title = 'an edited title'
  post.doc.updated_at = EPOCH + 60_000
  post.doc.rev = 'r2-post-7'
}
const cms2 = await startMockCms(docs)
const store2 = new DocumentStore(dbPath)
const third = await sync(httpCmsAdapter({ baseUrl: cms2.url }), store2, { pageSize: 500 })
store2.close()
await cms2.close()
console.log(
  `\nedit:     ${third.strategy} — ${third.changed} document changed, ${ms(third.ms.total)}`)

const edited = await build({ site: sitePath, dbPath, outDir, clean: true })
const delta = await deploy({ outDir, target, seal: edited.seal })
console.log(
  `deploy:   ${delta.uploaded} of ${edited.seal.files} files uploaded ` +
  `(${delta.plan.added.length} added, ${delta.plan.modified.length} modified, ` +
  `${delta.plan.deleted.length} deleted), ${delta.purged} purged, ${ms(delta.ms.total)}`)
for (const path of delta.plan.modified) console.log(`          ~ ${path}`)

console.log(`\noutput:   ${outDir}`)
console.log(`live:     ${liveDir}`)
