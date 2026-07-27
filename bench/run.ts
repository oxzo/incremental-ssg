// Phase 0 gate. Sweeps corpus size, measures naive full-build wall time
// (single-threaded and worker-pool), and computes exact edit fan-out.
// Output goes to real disk, not tmpfs — tmpfs would flatter the write cost.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './corpus.ts'
import { buildSingle, buildParallel, clean, type BuildResult } from './build.ts'
import { measureFanout } from './fanout.ts'
import { availableParallelism } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.bench')
const OUT = join(WORK, 'dist')
const smoke = process.argv.includes('--smoke')

const SIZES = smoke ? [200] : [500, 2000, 8000, 20000]
// Heavy tier (shiki syntax highlighting) is sampled, not swept — its per-page
// cost multiplier is what matters and that is size-independent.
const HEAVY_SIZES = smoke ? [200] : [500, 2000, 8000]
const WORKERS = Math.max(2, availableParallelism() - 2)

mkdirSync(WORK, { recursive: true })

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const secs = (ms: number) => (ms / 1000).toFixed(2) + 's'

type Row = BuildResult & { posts: number; mode: string; pagesPerSec: number }
const rows: Row[] = []

async function best(fn: () => Promise<BuildResult>): Promise<BuildResult> {
  // Two runs, keep the faster: the first pays JIT warmup a real build would
  // also pay, but reporting the slower of the two would overstate the case
  // for incremental — and this gate should be biased against building it.
  clean(OUT); const a = await fn()
  clean(OUT); const b = await fn()
  return a.ms.total <= b.ms.total ? a : b
}

for (const posts of SIZES) {
  const db = join(WORK, `corpus-${posts}.db`)
  process.stdout.write(`\n=== corpus ${fmt(posts)} posts ===\n`)
  const meta = generate(db, posts)
  process.stdout.write(`  authors=${meta.nAuthors} tags=${meta.nTags} pages=${meta.nPages}\n`)

  const tiers: ('light' | 'heavy')[] = HEAVY_SIZES.includes(posts) ? ['light', 'heavy'] : ['light']
  for (const tier of tiers) {
    for (const mode of ['single', 'parallel'] as const) {
      const r = await best(() =>
        mode === 'single' ? buildSingle(db, OUT, tier) : buildParallel(db, OUT, tier, WORKERS))
      const row: Row = { ...r, posts, mode, pagesPerSec: r.routes / (r.ms.total / 1000) }
      rows.push(row)
      process.stdout.write(
        `  ${tier.padEnd(5)} ${mode.padEnd(8)} ${String(fmt(r.routes)).padStart(7)} routes  ` +
        `${secs(r.ms.total).padStart(8)}  ${fmt(row.pagesPerSec).padStart(6)} pages/s  ` +
        `${(r.bytes / 1e6).toFixed(0)}MB\n`)
    }
  }

  process.stdout.write('  fan-out (routes invalidated by one change):\n')
  const fo = measureFanout(db)
  for (const [k, v] of Object.entries(fo)) {
    process.stdout.write(
      `    ${k.padEnd(13)} ${String(fmt(v.changed + v.added + v.removed)).padStart(7)} / ${fmt(v.total).padStart(7)}` +
      `  = ${v.pct.toFixed(2).padStart(6)}%   (changed ${fmt(v.changed)}, +${v.added}, -${v.removed})\n`)
  }
  rows.push(...[])
  writeFileSync(join(WORK, `fanout-${posts}.json`), JSON.stringify(fo, null, 2))
}

clean(OUT)
writeFileSync(join(WORK, 'results.json'), JSON.stringify({ workers: WORKERS, rows }, null, 2))
process.stdout.write(`\nworkers=${WORKERS}  results -> .bench/results.json\n`)
