// The full build: sync'd store -> index -> routes -> assets -> render -> write.
//
// No cache and no skipping, because the Phase 0 gate fired: a full rebuild of
// 24,449 routes takes 8.8s on a worker pool, the crossover to a painful build
// sits past ~150,000 routes, and a nav edit invalidates 100% of routes anyway.
// This is the product, not a baseline an incremental engine gets diffed against.
//
// The single-threaded and parallel paths deliberately share `prepare` and
// `renderRange` rather than each having their own loop. A "fast path" that
// diverges from the reference path is how a build tool ends up with two
// different notions of correct.
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { DocumentStore } from './store.ts'
import { loadSite } from './config.ts'
import { runAssetStage, emptyManifest } from './assets.ts'
import { createContextFactory, createRenderer, renderRoute, writeOut } from './render.ts'
import { beginDeterministicWindow } from './determinism.ts'
import { clearSeal, writeSeal, SEAL_SCHEMA } from './deploy.ts'
import { statTree } from './hash-tree.ts'
import type { Route, SiteConfig } from './config.ts'
import type { AssetManifest, AssetStageResult } from './assets.ts'
import type { Renderer } from './render.ts'
import type { BuildSeal } from './deploy.ts'

const now = () => performance.now()

export type BuildOptions = {
  /** Path to the site definition module. */
  site: string
  dbPath: string
  outDir: string
  /** 1 renders in-process. Default: cores - 2, matching the Phase 0 pool. */
  workers?: number
  /** Skip the asset stage even if the site configures one. */
  skipAssets?: boolean
  /** Where the worker asset-manifest handoff is written. Default: next to the db. */
  workDir?: string
  /** Remove outDir first. */
  clean?: boolean
}

export type BuildResult = {
  site: string
  documents: number
  routes: number
  bytes: number
  workers: number
  assets: AssetStageResult | null
  /** Proof this build finished, and the deploy diff's precondition. */
  seal: BuildSeal
  ms: { load: number; index: number; routes: number; assets: number; render: number; total: number }
}

export type Resolved = {
  cfg: SiteConfig<unknown>
  site: unknown
  routes: Route[]
  documents: number
  ms: { load: number; index: number; routes: number }
}

export type Prepared = Resolved & {
  renderer: Renderer
  manifest: AssetManifest
}

/**
 * Load the store, build the site's indexes, and resolve routes.
 *
 * Run identically on the main thread and inside each worker. Re-resolving per
 * worker is cheap -- milliseconds at 24k routes -- and means slices line up by
 * construction rather than by serialising a route array across the thread
 * boundary, where a 24k-element structured clone per worker would cost more
 * than the work it saved.
 */
export async function resolveSite(sitePath: string, dbPath: string): Promise<Resolved> {
  const t0 = now()
  const cfg = await loadSite(sitePath)
  const store = new DocumentStore(dbPath, { readOnly: true })
  let docs
  try {
    docs = store.byType(cfg.contentTypes)
  } finally {
    store.close()
  }
  let documents = 0
  for (const list of docs.values()) documents += list.length
  const t1 = now()

  const site = cfg.index(docs)
  const t2 = now()
  const routes = cfg.routes(site)
  const t3 = now()

  return { cfg, site, routes, documents, ms: { load: t1 - t0, index: t2 - t1, routes: t3 - t2 } }
}

/**
 * Everything a thread needs before it can render a route.
 *
 * Kept separate from resolveSite because the renderer is not free: at the
 * 'highlight' tier this builds a Shiki highlighter, and in parallel mode the
 * main thread only ever needs the route *count* for slicing. Building a
 * highlighter it will never call would add that cost to every build.
 */
export async function prepare(
  sitePath: string,
  dbPath: string,
  manifestPath: string | null,
): Promise<Prepared> {
  const resolved = await resolveSite(sitePath, dbPath)
  const renderer = await createRenderer(resolved.cfg.markdown ?? 'plain')
  const manifest: AssetManifest =
    manifestPath === null ? emptyManifest() : JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { ...resolved, renderer, manifest }
}

/**
 * Render routes [start, end) and write them.
 *
 * The determinism window is opened once around the whole range rather than per
 * route: installing the guards is a handful of property writes, and doing that
 * 24,000 times churns globalThis for nothing. The route label travels through
 * setLabel so a violation still names the page that caused it.
 */
export function renderRange(
  p: Prepared,
  outDir: string,
  start: number,
  end: number,
): { pages: number; bytes: number } {
  const contextFor = createContextFactory(p.site, p.renderer, p.manifest)
  const guard = beginDeterministicWindow(p.cfg.determinism ?? 'enforce')
  let bytes = 0
  let pages = 0
  try {
    for (let i = start; i < end; i++) {
      const route = p.routes[i]
      guard.setLabel(route.path)
      bytes += writeOut(outDir, route.path, renderRoute(p.cfg, contextFor(route), route))
      pages++
    }
  } finally {
    guard.end()
  }
  return { pages, bytes }
}

export function clean(outDir: string) {
  rmSync(outDir, { recursive: true, force: true })
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const t0 = now()
  const sitePath = resolve(opts.site)
  const dbPath = resolve(opts.dbPath)
  const outDir = resolve(opts.outDir)
  const workDir = resolve(opts.workDir ?? dirname(dbPath))
  if (opts.clean) clean(outDir)

  // Drop any previous seal before emitting a byte. A build that dies halfway
  // must leave no seal behind, or the next deploy reads the *last* build's
  // completion token as proof that this truncated tree is whole and starts
  // deleting live pages that this build simply never got to.
  clearSeal(workDir)

  // The asset stage runs on the main thread before any route renders, so
  // `ctx.image()` can be a synchronous lookup and every derivative exists
  // exactly once. See src/assets.ts for why it is a stage and not a callback.
  const cfgProbe = await loadSite(sitePath)
  let assets: AssetStageResult | null = null
  let manifestPath: string | null = null
  const ta = now()
  if (cfgProbe.assets && !opts.skipAssets) {
    // The site declares where derivatives are cached and what URL they are
    // served under; where they land inside *this* build's output follows from
    // outDir, which the site has no way to know.
    const publicPath = cfgProbe.assets.publicPath ?? '/assets/img'
    assets = await runAssetStage({
      ...cfgProbe.assets,
      publishTo: cfgProbe.assets.publishTo ?? join(outDir, publicPath),
    })
    mkdirSync(workDir, { recursive: true })
    manifestPath = join(workDir, 'asset-manifest.json')
    // Handed to workers as a file rather than through workerData: structured-
    // cloning a 20,000-entry manifest into every worker copies it N times for
    // no benefit, and a file on disk is also inspectable after a failed build.
    writeFileSync(manifestPath, JSON.stringify(assets.manifest))
  }
  const assetMs = now() - ta

  const workers = Math.max(1, opts.workers ?? Math.max(1, cpus().length - 2))
  // In parallel mode the main thread needs routes for slicing but never renders,
  // so it skips building a renderer it would not use.
  const p =
    workers === 1
      ? await prepare(sitePath, dbPath, manifestPath)
      : await resolveSite(sitePath, dbPath)

  const tr = now()
  let bytes = 0
  if (workers === 1) {
    bytes = renderRange(p as Prepared, outDir, 0, p.routes.length).bytes
  } else {
    const per = Math.ceil(p.routes.length / workers)
    const workerUrl = new URL('./render-worker.ts', import.meta.url)
    const jobs = Array.from({ length: workers }, (_, w) => {
      const start = w * per
      const end = Math.min(p.routes.length, start + per)
      return new Promise<{ pages: number; bytes: number }>((res, rej) => {
        if (start >= end) return res({ pages: 0, bytes: 0 })
        const wk = new Worker(fileURLToPath(workerUrl), {
          workerData: { sitePath, dbPath, outDir, manifestPath, start, end },
        })
        let out = { pages: 0, bytes: 0 }
        wk.on('message', (m) => {
          if (m && m.error) rej(new Error(`worker rendering [${start},${end}): ${m.error}`))
          else out = m
        })
        wk.on('error', rej)
        wk.on('exit', (c) => (c === 0 ? res(out) : rej(new Error(`worker exit ${c}`))))
      })
    })
    const done = await Promise.all(jobs)
    const rendered = done.reduce((a, b) => a + b.pages, 0)
    if (rendered !== p.routes.length) {
      // Slice arithmetic is the one place a silent gap produces a site that is
      // missing pages while every worker reports success.
      throw new Error(`rendered ${rendered} pages but resolved ${p.routes.length} routes`)
    }
    bytes = done.reduce((a, b) => a + b.bytes, 0)
  }
  const renderMs = now() - tr

  // Written last, and only here: every route has rendered and the count has
  // been checked. `files`/`bytes` come from a stat walk rather than the render
  // totals because assets are hardlinked into the output too, and the seal has
  // to describe the whole emitted tree -- that is what lets the deploy notice a
  // tree that lost files after the build rather than during it.
  const tree = statTree(outDir)
  const seal: BuildSeal = {
    schema: SEAL_SCHEMA,
    site: p.cfg.name,
    outDir,
    routes: p.routes.length,
    files: tree.files,
    bytes: tree.bytes,
    clean: opts.clean === true,
  }
  writeSeal(workDir, seal)

  return {
    site: p.cfg.name,
    documents: p.documents,
    routes: p.routes.length,
    bytes,
    workers,
    assets,
    seal,
    ms: {
      load: p.ms.load,
      index: p.ms.index,
      routes: p.ms.routes,
      assets: assetMs,
      render: renderMs,
      total: now() - t0,
    },
  }
}
