// Phase 2c: does the asset cache actually deliver, at scale, in the shape a real
// build hits it -- cold, then warm, then warm-with-one-edit?
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { AssetCache, defaultConfig } from '../src/asset-cache.ts'
import { makeSources } from './assets.ts'

const WORK = join(fileURLToPath(new URL('..', import.meta.url)), '.bench')
const OUT = join(WORK, 'asset-cache-out')
const SRC = join(WORK, 'src')
mkdirSync(WORK, { recursive: true })

const N = 24
const ms = (n: number) => (n < 1000 ? `${n.toFixed(0)}ms` : `${(n / 1000).toFixed(2)}s`)
const srcs = await makeSources(SRC, N)

// The config Phase 2b argued for: AVIF at effort 0 rather than sharp's default 4.
const cfg = {
  ...defaultConfig(OUT),
  formats: ['webp', 'avif'] as const as any,
  effort: { avif: 0, webp: 4 },
  concurrency: 4,
}

rmSync(OUT, { recursive: true, force: true })
console.log(`=== asset cache: ${N} sources, ${cfg.formats.join('+')}, ${cfg.widths.length} widths ===\n`)

const run = async (label: string, list: string[]) => {
  const c = new AssetCache(cfg)
  const t = performance.now()
  for (const s of list) await c.process(s)
  const el = performance.now() - t
  console.log(
    `  ${label.padEnd(22)} ${ms(el).padStart(9)}  ` +
    `${String(c.stats.hits).padStart(3)} hit ${String(c.stats.misses).padStart(3)} miss  ` +
    `probe ${ms(c.stats.msProbing).padStart(7)}  encode ${ms(c.stats.msEncoding).padStart(9)}`)
  return { el, c }
}

const cold = await run('cold (empty cache)', srcs)
const warm = await run('warm (no changes)', srcs)

// One source edited: the realistic steady-state build.
copyFileSync(srcs[N - 1], join(SRC, 'src-0.jpg'))
const edit = await run('warm (1 source edited)', srcs)

console.log(`\n  speedup, warm vs cold:        ${(cold.el / warm.el).toFixed(0)}x`)
console.log(`  speedup, 1-edit vs cold:      ${(cold.el / edit.el).toFixed(1)}x`)
const perSourceCold = cold.el / N
console.log(`\n  per source, cold: ${ms(perSourceCold)}   warm: ${ms(warm.el / N)}`)
console.log(`  extrapolated to 20,000 sources:`)
console.log(`    cold build   ${(perSourceCold * 20000 / 1000 / 60).toFixed(0)} min`)
console.log(`    warm rebuild ${((warm.el / N) * 20000 / 1000).toFixed(0)} s`)

// gc must run on the instance that processed every source, and only after it
// completed — the earlier `warm` instance never saw the edit, so collecting
// against it would delete the 8 derivatives the edit had just produced.
edit.c.seal()
const g = await edit.c.gc()
console.log(`\n  gc after the edited build: deleted ${g.deleted}, freed ${(g.bytes / 1024).toFixed(0)}KB`)
console.log(`  (the 8 derivatives orphaned by the edited source)`)
rmSync(OUT, { recursive: true, force: true })
