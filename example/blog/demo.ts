// End-to-end demo: mock CMS -> sync -> store -> assets -> render -> write.
//
// The whole Phase 1 pipeline in one runnable file. `npm run demo`.
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startMockCms } from '../../src/cms-mock.ts'
import { httpCmsAdapter } from '../../src/cms.ts'
import { DocumentStore } from '../../src/store.ts'
import { sync } from '../../src/sync.ts'
import { build } from '../../src/build.ts'
import { blogDocs, makeImages } from './fixture.ts'

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

console.log(`\noutput:   ${outDir}`)
