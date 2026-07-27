// The asset stage: everything image-shaped happens here, before the first route
// renders.
//
// Phase 2b measured image processing at roughly 3,200x the cost of rendering
// every page of the site -- 7.9 hours against 8.8 seconds at 20,000 sources. The
// build is an image pipeline with some HTML generation attached, and the asset
// cache from Phase 2c is what makes the steady-state build ~36 seconds instead
// of an hour. Until now it was wired into nothing.
//
// Two structural decisions, both load-bearing:
//
// 1. Assets are a STAGE, not a render-time side effect. `ctx.image()` is a
//    synchronous manifest lookup because every derivative already exists by the
//    time a template runs. If images were encoded on demand, templates would be
//    async, the worker pool would be contending with sharp's own pool, and the
//    same source referenced from twelve pages would race twelve ways.
//
// 2. The stage processes EVERY source in the directory, not just referenced
//    ones. That is what makes `seal()` honest: AssetCache.gc deletes anything
//    the build did not reference, so a keep-set built from "images some route
//    happened to link" would delete live derivatives the moment a route failed
//    to render. Scanning the directory makes the keep-set complete by
//    construction rather than by hoping the render pass finished.
import { readdir, stat, link, copyFile, mkdir } from 'node:fs/promises'
import { basename, join, relative, extname, sep } from 'node:path'
import { AssetCache, defaultConfig } from './asset-cache.ts'
import type { AssetEntry, AssetConfig, CacheStats } from './asset-cache.ts'
import type { SiteAssets } from './config.ts'

/** Formats sharp can decode that are worth treating as site imagery. */
const SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif'])

export type ManifestEntry = AssetEntry & {
  /** Path relative to the source dir, forward-slashed. The `ctx.image()` key. */
  key: string
}

export type AssetManifest = Record<string, ManifestEntry>

export type AssetStageResult = {
  manifest: AssetManifest
  stats: CacheStats
  sources: number
  gc: { deleted: number; bytes: number }
  published: number
  ms: number
}

export function resolveAssetConfig(assets: SiteAssets): AssetConfig {
  const base = defaultConfig(assets.outDir)
  return {
    outDir: assets.outDir,
    widths: assets.widths ?? base.widths,
    formats: assets.formats ?? base.formats,
    quality: assets.quality ?? base.quality,
    // Not spread-merged with the default on purpose. Phase 2b found sharp's
    // default AVIF effort of 4 is an ~11x build-time decision; a partial
    // override that silently inherits it would reintroduce exactly the accident
    // the explicit config was written to prevent.
    effort: assets.effort ?? base.effort,
    concurrency: assets.concurrency ?? base.concurrency,
  }
}

/** Recursive scan, sorted, so processing order is identical between runs. */
export async function findSources(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    let entries: string[]
    try {
      entries = await readdir(d)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return
      throw e
    }
    for (const name of entries.sort()) {
      const p = join(d, name)
      const s = await stat(p)
      if (s.isDirectory()) await walk(p)
      else if (SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) out.push(p)
    }
  }
  await walk(dir)
  return out
}

export async function runAssetStage(assets: SiteAssets): Promise<AssetStageResult> {
  const t0 = performance.now()
  const cfg = resolveAssetConfig(assets)
  const cache = new AssetCache(cfg, assets.publicPath ?? '/assets/img')
  const sources = await findSources(assets.sources)

  const manifest: AssetManifest = {}
  for (const src of sources) {
    const entry = await cache.process(src)
    const key = relative(assets.sources, src).split(sep).join('/')
    manifest[key] = { ...entry, key }
  }

  // Only now is the keep-set complete: every source in the directory has been
  // processed, so anything left over in the output dir really is an orphan.
  cache.seal()
  const gc = assets.gc ? await cache.gc() : { deleted: 0, bytes: 0 }
  const published = assets.publishTo ? await publish(manifest, assets.publishTo) : 0

  return {
    manifest,
    stats: cache.stats,
    sources: sources.length,
    gc,
    published,
    ms: performance.now() - t0,
  }
}

/**
 * Hardlink every referenced derivative from the persistent cache into the site
 * output, so a `clean` build can throw away the output without throwing away an
 * hour of AVIF encoding.
 *
 * Only referenced derivatives are linked, so a *cleaned* output dir contains
 * exactly this build's assets. An output dir that was NOT cleaned keeps stale
 * links from previous builds -- harmless (they are content-addressed, so nothing
 * points at them) but they accumulate, which is what `clean` is for.
 */
async function publish(manifest: AssetManifest, dir: string): Promise<number> {
  await mkdir(dir, { recursive: true })
  let n = 0
  for (const entry of Object.values(manifest)) {
    for (const d of entry.derivatives) {
      const dest = join(dir, basename(d.file))
      try {
        await link(d.file, dest)
        n++
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue // already published, and content-addressed
        // EXDEV: cache and output on different filesystems. EPERM: some
        // container and network mounts refuse hardlinks outright.
        if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOSYS') {
          await copyFile(d.file, dest)
          n++
          continue
        }
        throw e
      }
    }
  }
  return n
}

/** MIME type for a `<source type="...">`. */
export function mimeOf(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

export const emptyManifest = (): AssetManifest => ({})
