// What the content-bound seal costs the build.
//
// The seal used to record file count and total size, which is a stat per file
// and no reads. Binding it to contents means reading back every byte the build
// just wrote. That is a real price on the critical path, and the plan for this
// change said to measure it rather than assume the 0.68s figure from the Phase 2
// deploy-hash measurement carried over -- different walk, different moment, page
// cache in a different state.
//
// Reported against the build it is part of, because "0.7s" and "0.7s out of
// 10s" are different facts and only the second one decides anything.
//
//   node --no-warnings bench/run-seal.ts [posts]
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blogDocs } from '../example/blog/fixture.ts'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { build } from '../src/build.ts'
import { scanTree, foldDigests } from '../src/hash-tree.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.bench', 'seal')
// Both tiers, because the share is what decides and the share depends entirely
// on what it is a share *of*. Rendering with syntax highlighting is a measured
// ~4x per-page multiplier, so the same fixed read is a fifth of a light build
// and a twentieth of a heavy one. Reporting either alone would be picking the
// answer.
const TIER = process.argv[3] === 'heavy' ? 'heavy' : 'light'
const SITE = TIER === 'heavy'
  ? resolve(ROOT, 'test/sites/blog-highlight.ts')
  : resolve(ROOT, 'example/blog/site.ts')
const POSTS = Number(process.argv[2] ?? 8000)
const ROUNDS = 3

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// Seeded through the product's own sync driver rather than bench/corpus.ts.
// That generator writes the Phase 0 harness schema, which has no meta table --
// the product's store refuses it, correctly, and this benchmark has to measure
// the product.
const db = join(WORK, 'corpus.db')
process.stdout.write(`seeding ${POSTS.toLocaleString('en-US')} posts (${TIER} tier)...\n`)
{
  // `code: true` is not optional here, and the fixture says so: without a code
  // block the heavy tier has nothing to highlight and costs the same as the
  // light one. A first run of this benchmark omitted it and reported the two
  // tiers as identical, which is the fixture's documented trap working exactly
  // as advertised on someone who had just read past it.
  const cms = await startMockCms(blogDocs({ posts: POSTS, tags: 40, code: true }))
  const store = new DocumentStore(db)
  try {
    await sync(httpCmsAdapter({ baseUrl: cms.url }), store, { pageSize: 1000 })
  } finally {
    store.close()
    await cms.close()
  }
}

const secs = (ms: number) => (ms / 1000).toFixed(2) + 's'
const mib = (b: number) => (b / 1024 / 1024).toFixed(0) + ' MiB'

// Interleaved rounds rather than two batches. This project has already been
// burned by comparing batches taken minutes apart on a machine under load, and
// the effect here is small enough that the drift would swamp it.
const rows: { total: number; seal: number; files: number; bytes: number; standalone: number }[] = []
for (let i = 0; i < ROUNDS; i++) {
  const outDir = join(WORK, `dist-${i}`)
  const r = await build({ site: SITE, dbPath: db, outDir, workDir: WORK, clean: true, skipAssets: true })

  // The same walk again, alone, on a tree that is now certainly page-cache warm.
  // Reported next to the in-build figure so the difference between "cold" and
  // "warm" is visible rather than assumed away -- the build's own scan reads
  // files it wrote seconds ago, which is the friendliest case there is.
  const t = performance.now()
  const scan = scanTree(outDir, ['sha256'])
  foldDigests(scan.digests[0])
  const standalone = performance.now() - t

  rows.push({ total: r.ms.total, seal: r.ms.seal, files: r.seal.files, bytes: r.seal.bytes, standalone })
  process.stdout.write(
    `round ${i + 1}: build ${secs(r.ms.total)}  seal ${secs(r.ms.seal)}  ` +
    `(${((r.ms.seal / r.ms.total) * 100).toFixed(1)}% of build)  rescan ${secs(standalone)}\n`)
  rmSync(outDir, { recursive: true, force: true })
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const t = med(rows.map((r) => r.total))
const s = med(rows.map((r) => r.seal))
process.stdout.write(
  `\nmedian of ${ROUNDS} (${TIER} tier): ${rows[0].files.toLocaleString('en-US')} files, ${mib(rows[0].bytes)}\n` +
  `  build ${secs(t)}, seal ${secs(s)} = ${((s / t) * 100).toFixed(1)}% of the build\n` +
  `  throughput ${(rows[0].bytes / 1024 / 1024 / (s / 1000)).toFixed(0)} MiB/s\n`)
