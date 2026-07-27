// Phase 2b: measure the two costs the Phase 0 gate did not cover —
// CMS sync and the image pipeline.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import sharp from 'sharp'
import { startMockCms, pull, reconcile } from './sync.ts'
import { makeSources, measure, deriveOne, cacheProbe, WIDTHS, type Fmt } from './assets.ts'
import { generate } from './corpus.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.bench')
mkdirSync(WORK, { recursive: true })
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const ms = (n: number) => (n < 1000 ? `${n.toFixed(0)}ms` : `${(n / 1000).toFixed(2)}s`)

// ---------------------------------------------------------------- sync
console.log('=== CMS sync ===')
const N = 20_000
const corpusDb = join(WORK, `corpus-${N}.db`)
if (!existsSync(corpusDb)) generate(corpusDb, N)
const cdb = new DatabaseSync(corpusDb, { readOnly: true })
const rows = cdb.prepare('SELECT type, json FROM documents').all() as any[]
cdb.close()
const docs = rows.map((r, i) => {
  const d = JSON.parse(r.json as string)
  return { type: r.type as string, doc: { ...d, updated_at: d.date ?? 0, rev: `r${i}` } }
})
const payloadBytes = Buffer.byteLength(JSON.stringify(docs))
console.log(`  corpus ${fmt(docs.length)} docs, ${(payloadBytes / 1e6).toFixed(1)}MB of JSON`)

const { server, port } = await startMockCms(docs, 0)
const syncDb = join(WORK, 'sync.db')

const pageResults: { pageSize: number; r: Awaited<ReturnType<typeof pull>> }[] = []
for (const pageSize of [50, 100, 500]) {
  rmSync(syncDb, { force: true })
  const r = await pull(port, syncDb, pageSize)
  pageResults.push({ pageSize, r })
  console.log(
    `  full pull page=${String(pageSize).padStart(3)}  ${fmt(r.requests).padStart(4)} req  ` +
    `${ms(r.ms.total).padStart(8)} total   http ${ms(r.ms.http).padStart(8)}  ` +
    `parse ${ms(r.ms.parse).padStart(7)}  store ${ms(r.ms.store).padStart(8)}`)
}
const base = pageResults[1].r
const localPerDoc = (base.ms.parse + base.ms.store) / base.docs
console.log(`  local processing (parse+hash+upsert): ${(localPerDoc * 1000).toFixed(0)}µs/doc`)

// Delta pull — one document changed.
const newest = Math.max(...docs.map((d) => d.doc.updated_at))
const d1 = await pull(port, syncDb, 100, newest - 1)
console.log(`  delta pull (1 doc changed):  ${d1.requests} req  ${ms(d1.ms.total)}  ${fmt(d1.bytes)}B`)

const rec = await reconcile(port)
console.log(`  full-ID reconcile scan:      1 req  ${ms(rec.ms)}  ${(rec.bytes / 1e6).toFixed(2)}MB for ${fmt(rec.ids)} ids`)
server.close()

console.log('\n  modelled wall time = requests x RTT + local processing:')
console.log('    RTT     page=50    page=100   page=500')
for (const rtt of [20, 100, 300]) {
  const cells = pageResults.map(({ r }) => {
    const local = r.ms.parse + r.ms.store
    return ms(r.requests * rtt + local).padStart(9)
  })
  console.log(`    ${String(rtt + 'ms').padStart(5)}  ${cells.join('  ')}`)
}

// ---------------------------------------------------------------- assets
console.log('\n=== Image pipeline ===')
console.log(`  sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}, ` +
  `internal concurrency ${sharp.concurrency()}`)
const SRC = join(WORK, 'src')
const OUT = join(WORK, 'img-out')
mkdirSync(OUT, { recursive: true })

console.log(`  sources: 3000x2000 JPEG, derivatives at ${WIDTHS.join('/')}px`)
const srcs = await makeSources(SRC, 12)

console.log('\n  per-source cost, single-threaded (4 widths):')
for (const f of ['jpeg', 'webp', 'avif'] as Fmt[]) {
  const n = f === 'avif' ? 3 : 8
  const t = performance.now()
  let bytes = 0
  for (const s of srcs.slice(0, n)) bytes += (await deriveOne(s, OUT, [f])).reduce((a, b) => a + b.bytes, 0)
  const per = (performance.now() - t) / n
  console.log(`    ${f.padEnd(5)} ${ms(per).padStart(8)}/source   ${(bytes / n / 1024).toFixed(0)}KB out   (n=${n})`)
}

console.log('\n  AVIF effort sweep @1600px (the main tunable):')
for (const effort of [0, 2, 4, 6]) {
  const t = performance.now()
  let bytes = 0
  for (const s of srcs.slice(0, 3)) {
    const b = await sharp(s).resize({ width: 1600 }).avif({ quality: 50, effort }).toBuffer()
    bytes += b.length
  }
  console.log(`    effort ${effort}  ${ms((performance.now() - t) / 3).padStart(8)}/image   ${(bytes / 3 / 1024).toFixed(0)}KB`)
}

console.log('\n  concurrency scaling (webp+avif, 4 widths each):')
for (const c of [1, 4, 10]) {
  const r = await measure(srcs.slice(0, 6), OUT, ['webp', 'avif'], c)
  console.log(`    pool=${String(c).padStart(2)}  ${ms(r.totalMs).padStart(8)} for ${r.sources} sources  ` +
    `= ${ms(r.perSourceMs).padStart(8)}/source  (${fmt(r.sources / (r.totalMs / 1000) * 3600)} sources/hour)`)
}

const probe = cacheProbe(srcs[0], OUT)
console.log(`\n  cache probe (hash source + stat derivative): ${probe.ms.toFixed(2)}ms`)

rmSync(OUT, { recursive: true, force: true })
console.log('\ndone')
