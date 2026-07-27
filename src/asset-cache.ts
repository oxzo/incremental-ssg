// Content-addressed asset cache.
//
// Phase 2b measured image processing at ~3,200x the cost of rendering every page
// of the site, so this is the highest-value component in the build. It is also
// the simplest kind of cache there is: the key is the source file's own content
// hash plus the exact transform, and the derivative file's existence IS the cache
// entry. There is no side table to fall out of sync, and no dependency graph.
//
// Two properties are load-bearing and both are tested:
//
//   1. The spec hash covers EVERY parameter that can change output bytes --
//      including quality and effort and the encoder version. If it did not,
//      changing `effort` from 4 to 0 would silently reuse the old derivatives
//      and the build would serve output no current setting can reproduce.
//   2. Writes are atomic (temp file + rename). A cache whose entry is "the file
//      exists" must never observe a half-written file, or an interrupted build
//      poisons the cache with a truncated image that looks like a hit forever.
import sharp from 'sharp'
import { threadId } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { pool } from './pool.ts'

export type Fmt = 'jpeg' | 'webp' | 'avif' | 'png'

export type AssetConfig = {
  outDir: string
  widths: number[]
  formats: Fmt[]
  /** Per-format encoder quality. */
  quality: Partial<Record<Fmt, number>>
  /** AVIF/WebP CPU-vs-size tradeoff. Phase 2b: effort 4 costs 29x effort 0. */
  effort: Partial<Record<Fmt, number>>
  concurrency: number
}

export const defaultConfig = (outDir: string): AssetConfig => ({
  outDir,
  widths: [400, 800, 1200, 1600],
  formats: ['webp'],
  quality: { jpeg: 80, webp: 80, avif: 50, png: 90 },
  // Deliberately not sharp's default of 4. Phase 2b measured that default as an
  // ~11x build-time decision; making it explicit here means it is a choice.
  effort: { avif: 0, webp: 4 },
  concurrency: 4, // measured saturation point; 10 bought ~10% over 4
})

/** Bumped when a change to this file alters output bytes for an unchanged input. */
const CACHE_SCHEMA = 1

/**
 * Temp-file sequence, module-scoped rather than per-instance.
 *
 * Per-instance was a bug: two AssetCache instances in one process share a pid
 * and both start their counter at zero, so they build the *same* temp filename
 * for the same derivative. One renames it into place and the other's rename
 * fails with ENOENT -- an intermittent build failure in the one code path whose
 * whole job is to never be observed half-done. Module scope plus threadId makes
 * the name unique per writer instead of per process.
 */
let tmpSeq = 0

const sha = (b: Buffer | string, n = 16) => createHash('sha256').update(b).digest('hex').slice(0, n)
const ext = (f: Fmt) => (f === 'jpeg' ? 'jpg' : f)

export type Derivative = { url: string; file: string; width: number; format: Fmt; bytes: number }
export type AssetEntry = {
  src: string
  hash: string
  width: number
  height: number
  derivatives: Derivative[]
  /** Grouped for <picture>/srcset emission; format order follows config. */
  srcset: Record<string, string>
  fallback: Derivative
}

export type CacheStats = {
  sources: number; hits: number; misses: number
  bytesWritten: number; msEncoding: number; msProbing: number
}

export class AssetCache {
  readonly stats: CacheStats = {
    sources: 0, hits: 0, misses: 0, bytesWritten: 0, msEncoding: 0, msProbing: 0,
  }
  /** Every derivative filename this build referenced — the GC keep-set. */
  private referenced = new Set<string>()
  private cfg: AssetConfig
  private publicPath: string
  private sealed = false

  constructor(cfg: AssetConfig, publicPath = '/assets/img') {
    this.cfg = cfg
    this.publicPath = publicPath
  }

  /**
   * Identity of one derivative. Everything that can change the output bytes goes
   * in, so a config change is a miss rather than a stale hit.
   */
  private specHash(fmt: Fmt, width: number) {
    return sha([
      `v${CACHE_SCHEMA}`,
      `sharp:${sharp.versions.sharp}`,
      `vips:${sharp.versions.vips}`,
      `fmt:${fmt}`,
      `w:${width}`,
      `q:${this.cfg.quality[fmt] ?? 'default'}`,
      `e:${this.cfg.effort[fmt] ?? 'default'}`,
    ].join('|'), 8)
  }

  private encode(input: Buffer, fmt: Fmt, width: number) {
    let p = sharp(input).resize({ width, withoutEnlargement: true })
    const q = this.cfg.quality[fmt]
    const e = this.cfg.effort[fmt]
    if (fmt === 'jpeg') p = p.jpeg({ quality: q })
    else if (fmt === 'webp') p = p.webp({ quality: q, effort: e })
    else if (fmt === 'avif') p = p.avif({ quality: q, effort: e })
    else p = p.png({ quality: q, effort: e })
    return p.toBuffer()
  }

  /** Atomic publish: a reader must never see a partially written derivative. */
  private async writeAtomic(file: string, buf: Buffer) {
    const tmp = `${file}.tmp-${process.pid}-${threadId}-${tmpSeq++}`
    await writeFile(tmp, buf)
    await rename(tmp, file)
  }

  async process(srcPath: string): Promise<AssetEntry> {
    await mkdir(this.cfg.outDir, { recursive: true })
    const input = await readFile(srcPath)
    const hash = sha(input)
    const meta = await sharp(input).metadata()
    const intrinsic = meta.width ?? 0
    this.stats.sources++

    // Never upscale. If the source is smaller than every configured width, emit
    // it at its own size rather than nothing.
    let widths = this.cfg.widths.filter((w) => w <= intrinsic)
    if (widths.length === 0) widths = [intrinsic]

    const jobs: (() => Promise<Derivative>)[] = []
    for (const fmt of this.cfg.formats) {
      for (const width of widths) {
        jobs.push(async () => {
          const name = `${basename(srcPath, extname(srcPath))}.${hash.slice(0, 12)}-${this.specHash(fmt, width)}.${ext(fmt)}`
          const file = join(this.cfg.outDir, name)
          this.referenced.add(name)

          const t0 = performance.now()
          const hit = existsSync(file)
          this.stats.msProbing += performance.now() - t0

          if (hit) {
            this.stats.hits++
            return { url: `${this.publicPath}/${name}`, file, width, format: fmt, bytes: (await stat(file)).size }
          }
          const t1 = performance.now()
          const buf = await this.encode(input, fmt, width)
          await this.writeAtomic(file, buf)
          this.stats.msEncoding += performance.now() - t1
          this.stats.misses++
          this.stats.bytesWritten += buf.length
          return { url: `${this.publicPath}/${name}`, file, width, format: fmt, bytes: buf.length }
        })
      }
    }

    const derivatives = await pool(jobs, this.cfg.concurrency)
    const srcset: Record<string, string> = {}
    for (const fmt of this.cfg.formats) {
      srcset[fmt] = derivatives
        .filter((d) => d.format === fmt)
        .sort((a, b) => a.width - b.width)
        .map((d) => `${d.url} ${d.width}w`)
        .join(', ')
    }
    const last = this.cfg.formats[this.cfg.formats.length - 1]
    const fallback = derivatives.filter((d) => d.format === last).sort((a, b) => b.width - a.width)[0]

    return {
      src: srcPath, hash, width: intrinsic, height: meta.height ?? 0,
      derivatives, srcset, fallback,
    }
  }

  /**
   * Mark this instance as having processed the whole site. Required before gc:
   * the keep-set is only trustworthy if the build that built it finished.
   */
  seal() { this.sealed = true }

  /**
   * Delete derivatives no longer referenced. Content-addressed names mean a
   * changed source produces a new filename and orphans the old one, so without
   * this the cache directory grows without bound.
   *
   * Two rails, both learned from deleting live files during Phase 2c benching:
   * gc is only safe on the instance that processed the *entire* site, and only
   * if that build completed. A partial or failed build has an incomplete
   * keep-set, and gc against it deletes derivatives that are still live.
   */
  async gc(opts: { maxDeleteRatio?: number; force?: boolean } = {}): Promise<{ deleted: number; bytes: number }> {
    const { maxDeleteRatio = 0.5, force = false } = opts
    if (!this.sealed && !force) {
      throw new Error(
        'AssetCache.gc() requires seal() first — an unsealed instance may hold an ' +
        'incomplete keep-set from a partial or failed build, and collecting against ' +
        'it deletes live derivatives. Pass {force:true} only if you mean it.')
    }
    const files = (await readdir(this.cfg.outDir))
      .filter((f) => !f.includes('.tmp-')) // another build may be mid-write
    const doomed = files.filter((f) => !this.referenced.has(f))

    // Guards against the "processed 3 files, collected 20,000" failure.
    if (files.length > 0 && doomed.length / files.length > maxDeleteRatio && !force) {
      throw new Error(
        `AssetCache.gc() would delete ${doomed.length} of ${files.length} derivatives ` +
        `(${((doomed.length / files.length) * 100).toFixed(0)}%), over the ${maxDeleteRatio * 100}% ` +
        `limit. This usually means the build did not process every source. ` +
        `Pass {force:true} or raise maxDeleteRatio if the sweep is intended.`)
    }

    let deleted = 0, bytes = 0
    for (const f of doomed) {
      const p = join(this.cfg.outDir, f)
      bytes += (await stat(p)).size
      await unlink(p)
      deleted++
    }
    return { deleted, bytes }
  }
}

