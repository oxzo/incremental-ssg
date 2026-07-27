// Phase 2b, part 2: what does the image pipeline actually cost?
//
// The Phase 0 gate measured HTML rendering only. Image processing is the cost
// most likely to dominate a real build, and unlike CMS latency it is fully
// measurable here.
import sharp from 'sharp'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const now = () => performance.now()
export const WIDTHS = [400, 800, 1200, 1600]
export type Fmt = 'jpeg' | 'webp' | 'avif'

/** Synthetic 6MP sources with real entropy — a flat colour would let encoders cheat. */
export async function makeSources(dir: string, n: number, seed = 11): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  const W = 3000, H = 2000
  for (let i = 0; i < n; i++) {
    const p = join(dir, `src-${i}.jpg`)
    paths.push(p)
    if (existsSync(p)) continue
    // Deterministic pseudo-random RGB, cheap to generate but incompressible.
    const buf = Buffer.allocUnsafe(W * H * 3)
    let a = (seed + i * 2654435761) >>> 0
    for (let j = 0; j < buf.length; j += 3) {
      a = (a * 1664525 + 1013904223) >>> 0
      const g = (j / buf.length) * 200
      buf[j] = (a >>> 16) & 0x3f | (g & 0xc0)
      buf[j + 1] = (a >>> 8) & 0x3f | (g & 0xc0)
      buf[j + 2] = a & 0x3f | (g & 0xc0)
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 85 }).toFile(p)
  }
  return paths
}

export type DerivStat = { fmt: Fmt; width: number; ms: number; bytes: number }

/** One source -> every derivative. Source is read once; each encode clones from that buffer. */
export async function deriveOne(src: string, outDir: string, fmts: Fmt[]): Promise<DerivStat[]> {
  const input = readFileSync(src)
  const out: DerivStat[] = []
  for (const fmt of fmts) {
    for (const width of WIDTHS) {
      const t = now()
      let pipe = sharp(input).resize({ width })
      if (fmt === 'jpeg') pipe = pipe.jpeg({ quality: 80 })
      else if (fmt === 'webp') pipe = pipe.webp({ quality: 80 })
      else pipe = pipe.avif({ quality: 50 })
      const buf = await pipe.toBuffer()
      const name = `${createHash('sha256').update(src).digest('hex').slice(0, 8)}-${width}.${fmt}`
      writeFileSync(join(outDir, name), buf)
      out.push({ fmt, width, ms: now() - t, bytes: buf.length })
    }
  }
  return out
}

/** The cache-hit path a content-addressed asset cache would take instead. */
export function cacheProbe(src: string, outDir: string): { ms: number; hit: boolean } {
  const t = now()
  const h = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 16)
  const hit = existsSync(join(outDir, `${h.slice(0, 8)}-400.webp`))
  return { ms: now() - t, hit }
}

async function pool<T>(items: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (true) {
      const k = i++
      if (k >= items.length) return
      out[k] = await items[k]()
    }
  }))
  return out
}

export type AssetRun = {
  sources: number; fmts: Fmt[]; concurrency: number
  totalMs: number; perSourceMs: number; derivatives: number
  bytesOut: number; byFmt: Record<string, { ms: number; bytes: number; n: number }>
}

export async function measure(
  srcs: string[], outDir: string, fmts: Fmt[], concurrency: number,
): Promise<AssetRun> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const t0 = now()
  const all = await pool(srcs.map((s) => () => deriveOne(s, outDir, fmts)), concurrency)
  const totalMs = now() - t0
  const flat = all.flat()
  const byFmt: AssetRun['byFmt'] = {}
  for (const d of flat) {
    const k = d.fmt
    byFmt[k] ??= { ms: 0, bytes: 0, n: 0 }
    byFmt[k].ms += d.ms; byFmt[k].bytes += d.bytes; byFmt[k].n++
  }
  return {
    sources: srcs.length, fmts, concurrency, totalMs,
    perSourceMs: totalMs / srcs.length,
    derivatives: flat.length,
    bytesOut: flat.reduce((a, b) => a + b.bytes, 0),
    byFmt,
  }
}
