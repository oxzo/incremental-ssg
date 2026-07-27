// What does the engine/site seam cost?
//
// run-2.ts showed the product building slower than the Phase 0 harness on a
// matched corpus. This isolates the candidate causes rather than guessing:
//
//   1. per-worker store load, since every worker re-resolves the site
//      independently (the harness did this too, but its store load was smaller)
//   2. the determinism guard, which the harness did not have at all -- it swaps
//      globalThis.Date for a Proxy, and templates construct a Date per post card
//   3. per-worker module import, which the harness also did not have: the site
//      is loaded *by path*, so each thread imports the site module, its
//      templates, and markdown-it
//
// Every measurement runs in a fresh process. The first version of this file did
// not, and produced numbers that were not merely noisy but impossible -- see the
// header of one-build.ts. Repeat runs of a build that allocates hundreds of
// megabytes are not comparable inside one heap.
//
// Reuses the corpus run-2.ts synced. Run that first.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.bench')
const smoke = process.argv.includes('--smoke')
const POSTS = smoke ? 500 : 20_000
const dbPath = join(WORK, `product-${POSTS}.db`)
const outDir = join(WORK, 'p2-seam-dist')
const WORKERS = Math.max(2, availableParallelism() - 2)
const RUNS = smoke ? 2 : 3

if (!existsSync(dbPath)) {
  console.error(`missing ${dbPath} — run bench/run-2.ts${smoke ? ' --smoke' : ''} first`)
  process.exit(1)
}

const ONE = join(ROOT, 'bench/one-build.ts')
const SITES = {
  plain: join(ROOT, 'bench/sites/blog-plain.ts'),
  nodet: join(ROOT, 'bench/sites/blog-plain-nodet.ts'),
  highlight: join(ROOT, 'bench/sites/blog-highlight.ts'),
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`

function once(args: string[]): any {
  const out = execFileSync('node', ['--no-warnings', ONE, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 20,
  })
  return JSON.parse(out)
}

/** Best of N *processes*. The spread is printed too, since a tight one is the
 *  evidence that the per-process isolation actually fixed the contamination. */
function best(label: string, args: string[], runs = RUNS) {
  const rs = Array.from({ length: runs }, () => once(args))
  const times = rs.map((r) => r.total).sort((a, b) => a - b)
  const pick = rs.find((r) => r.total === times[0])
  process.stdout.write(
    `  ${label.padEnd(38)} ${secs(times[0]).padStart(8)}` +
    `   (spread ${secs(times[0])}–${secs(times[times.length - 1])})\n`)
  return pick
}

const results: Record<string, any> = {}

process.stdout.write(`\nfixed cost every thread repeats (${WORKERS} workers each pay it)\n`)
const res = best('resolveSite', ['--site', SITES.plain, '--db', dbPath, '--resolve'])
results.resolve = res
process.stdout.write(
  `    load ${secs(res.ms.load)}  index ${secs(res.ms.index)}  routes ${secs(res.ms.routes)}` +
  `   (${res.documents} docs → ${res.routes} routes)\n`)

process.stdout.write('\nfull build, one process each\n')
const grid: [string, keyof typeof SITES, number][] = [
  ['plain  w=1   guard on', 'plain', 1],
  ['plain  w=1   guard off', 'nodet', 1],
  [`plain  w=${WORKERS}  guard on`, 'plain', WORKERS],
  [`plain  w=${WORKERS}  guard off`, 'nodet', WORKERS],
  ['plain  w=4   guard on', 'plain', 4],
  ['highlight w=1', 'highlight', 1],
  [`highlight w=${WORKERS}`, 'highlight', WORKERS],
]
for (const [label, site, workers] of grid) {
  results[label] = best(label, [
    '--site', SITES[site], '--db', dbPath, '--out', outDir, '--workers', String(workers),
  ])
}

// The decisive comparison: the Phase 0 harness pipeline, on this machine, in
// this same minute, through the same one-process-per-measurement method. The
// recorded 8.8s was measured hours earlier on a box whose state has since
// changed, so quoting it as the baseline would confound the seam with the
// environment.
const harnessDb = join(WORK, `corpus-${POSTS}.db`)
if (existsSync(harnessDb)) {
  process.stdout.write('\nPhase 0 harness pipeline, same machine, same method\n')
  for (const [label, tier, workers] of [
    ['harness light w=1', 'light', 1],
    [`harness light w=${WORKERS}`, 'light', WORKERS],
    ['harness heavy w=1', 'heavy', 1],
    [`harness heavy w=${WORKERS}`, 'heavy', WORKERS],
  ] as [string, string, number][]) {
    results[label] = best(label, [
      '--harness', '--db', harnessDb, '--out', join(WORK, 'p2-seam-harness'),
      '--tier', tier, '--workers', String(workers),
    ])
  }
} else {
  process.stdout.write(`\n(no ${harnessDb} — skipping the harness comparison)\n`)
}

const t = (label: string) => results[label].total
const p1 = t('plain  w=1   guard on')
const pN = t(`plain  w=${WORKERS}  guard on`)
const o1 = t('plain  w=1   guard off')
const oN = t(`plain  w=${WORKERS}  guard off`)

process.stdout.write('\nreading\n')
process.stdout.write(
  `  determinism guard: ${(((p1 - o1) / o1) * 100).toFixed(0)}% of a single-threaded build ` +
  `(${secs(p1)} vs ${secs(o1)})\n`)
process.stdout.write(
  `  pool speedup: ${(p1 / pN).toFixed(2)}× at ${WORKERS} workers, ` +
  `${(p1 / t('plain  w=4   guard on')).toFixed(2)}× at 4, ` +
  `${(o1 / oN).toFixed(2)}× at ${WORKERS} with the guard off\n`)
process.stdout.write(
  `  per-thread fixed cost ${secs(res.total)}; with ${WORKERS} threads paying it concurrently ` +
  `a\n  perfectly parallel render still cannot finish before about ` +
  `${secs(res.total + (p1 - res.total) / WORKERS)}\n`)
process.stdout.write(
  `  highlight pool speedup: ` +
  `${(t('highlight w=1') / t(`highlight w=${WORKERS}`)).toFixed(2)}× ` +
  `(${secs(t('highlight w=1'))} → ${secs(t(`highlight w=${WORKERS}`))})\n`)

if (results['harness light w=1']) {
  // Normalised by bytes written, not by route count: the two corpora resolve to
  // slightly different route counts, and pages/s would silently reward whichever
  // produced smaller pages.
  process.stdout.write('\nproduct vs harness, normalised (MB written per second)\n')
  const pairs: [string, string][] = [
    ['plain  w=1   guard on', 'harness light w=1'],
    [`plain  w=${WORKERS}  guard on`, `harness light w=${WORKERS}`],
    ['highlight w=1', 'harness heavy w=1'],
    [`highlight w=${WORKERS}`, `harness heavy w=${WORKERS}`],
  ]
  for (const [p, h] of pairs) {
    const P = results[p]
    const H = results[h]
    const pRate = P.bytes / 1e6 / (P.total / 1000)
    const hRate = H.bytes / 1e6 / (H.total / 1000)
    process.stdout.write(
      `  ${p.padEnd(24)} ${secs(P.total).padStart(7)} ${pRate.toFixed(1).padStart(6)} MB/s   vs   ` +
      `${h.padEnd(22)} ${secs(H.total).padStart(7)} ${hRate.toFixed(1).padStart(6)} MB/s   ` +
      `product is ${(((pRate - hRate) / hRate) * 100).toFixed(0)}%\n`)
  }
}

writeFileSync(join(WORK, 'p2-seam.json'), JSON.stringify(results, null, 2))
process.stdout.write(`\nwrote ${join(WORK, 'p2-seam.json')}\n`)
