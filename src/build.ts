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
import { dirname, join, resolve, sep } from 'node:path'
import { DocumentStore } from './store.ts'
import { loadSite } from './config.ts'
import { runAssetStage, emptyManifest } from './assets.ts'
import { createContextFactory, createRenderer, renderRoute, writeFile, planOutputs } from './render.ts'
import { beginDeterministicWindow } from './determinism.ts'
import { clearSeal, writeSeal, SEAL_SCHEMA, SEAL_ALGORITHM } from './deploy.ts'
import { scanTree, foldDigests } from './hash-tree.ts'
import { checkNumber, RailError } from './rails.ts'
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
  ms: {
    load: number; index: number; routes: number; assets: number; render: number
    /** Reading the emitted tree back to bind the seal to its contents. */
    seal: number
    total: number
  }
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
 * Run identically on the main thread and inside each worker, so slices line up
 * by construction rather than by serialising a route array across the thread
 * boundary.
 *
 * This comment used to claim re-resolving per worker was "cheap -- milliseconds
 * at 24k routes". Measured in the Phase 2 re-benchmark: **0.60s**, of which
 * 0.58s is the store load (index 0.02s, route resolution 0.00s). A 10-worker
 * build pays it eleven times, so ~6.4s of aggregate CPU goes on parsing the
 * same 20,461 documents over and over -- and that is the largest identified
 * component of the product's parallel scaling deficit against the Phase 0
 * harness (1.38x on 10 workers where the harness gets 2.34x).
 *
 * The design is not therefore wrong: a 24k-element structured clone per worker
 * has its own cost, and nobody has measured that alternative. But the number
 * this rationale rested on was off by roughly two orders of magnitude, so the
 * decision is now unjustified rather than justified. See bench/RESULTS.md.
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
): { pages: number; bytes: number; digest: string } {
  // The whole route set is planned, not just this slice. Two reasons, and both
  // are about a caller that only owns part of the list. Every worker validates
  // every route, so a traversal path in slice 5 is refused by worker 0 as well
  // -- before any of them has written a byte. And the digest is the identity of
  // the set the parent makes them agree on, which a per-slice plan could not
  // produce.
  const plan = planOutputs(outDir, p.routes)
  const contextFor = createContextFactory(p.site, p.renderer, p.manifest)
  const guard = beginDeterministicWindow(p.cfg.determinism ?? 'enforce')
  let bytes = 0
  let pages = 0
  try {
    for (let i = start; i < end; i++) {
      const route = p.routes[i]
      guard.setLabel(route.path)
      // The planned path, not a second derivation from route.path. Validating
      // one string and writing another is how a check and its subject drift.
      bytes += writeFile(plan.paths[i], renderRoute(p.cfg, contextFor(route), route))
      pages++
    }
  } finally {
    guard.end()
  }
  return { pages, bytes, digest: plan.digest }
}

/**
 * The contiguous route range worker `index` of `count` is responsible for.
 *
 * Exported so the worker and the single-threaded path derive slices from one
 * definition. When the parent computed ranges and the worker trusted them, this
 * arithmetic existed once; now that both sides reason about it, two copies would
 * be a gap or an overlap waiting to happen.
 */
export function sliceFor(total: number, index: number, count: number): { start: number; end: number } {
  const per = Math.ceil(total / count)
  const start = Math.min(total, index * per)
  return { start, end: Math.min(total, start + per) }
}

/** What each render worker reports back. */
export type WorkerReport = {
  pages: number
  bytes: number
  /** Routes this worker resolved. Reported so a disagreement can be described. */
  routes: number
  /**
   * Identity of the route set this worker resolved -- what the parent actually
   * compares. The count alone cannot distinguish two different route sets of
   * equal length, which is a build assembled from slices of two sites.
   */
  digest: string
  documents: number
  ms: Resolved['ms']
}

/** Something a `--clean` build must not delete, and a name to refuse it by. */
export type ProtectedPath = { label: string; path: string }

/**
 * Whether `--clean` would take something with it, decided without deleting
 * anything.
 *
 * Separated from `clean` for two reasons, and the second is the important one.
 * It is a pure check, so it is directly testable -- and a test of the *dangerous*
 * cases must never be one rmSync away from being right. Asserting that this
 * refuses `--out /` costs nothing; asserting it by calling `clean('/')` and
 * hoping is a test whose failure mode is the filesystem.
 *
 * The comparison is between resolved paths, not real paths. A symlink routing
 * one of these inside the output directory is not detected here, and saying so
 * beats implying a coverage that does not exist: the tree walk in hash-tree.ts
 * refuses links it finds *inside* the tree, which is a different question from
 * where the tree's own neighbours live.
 */
export function checkCleanScope(outDir: string, protect: ProtectedPath[]) {
  const root = resolve(outDir)
  // `/` is already its own separator, and `'/' + sep` matches nothing -- which
  // would make the single most destructive argument the one case that passed.
  const prefix = root.endsWith(sep) ? root : root + sep
  for (const { label, path } of protect) {
    const p = resolve(path)
    if (p !== root && !p.startsWith(prefix)) continue
    throw new RailError(
      'build.clean-scope',
      true,
      `--clean would delete ${label} (${p}), which is inside the output directory (${root}). ` +
      `Refused: the output directory is the one thing this build is allowed to throw away, and ` +
      `everything else here either costs an hour to regenerate or cannot be regenerated at all. ` +
      `Move it outside ${root}, or build without --clean.`,
    )
  }
}

/**
 * Empty the output directory, having established that it holds nothing else.
 *
 * The protected set is a parameter rather than a lookup so that cleaning without
 * naming what must survive is not something a caller can do by omission. The
 * README asked for one of these in prose -- keep the asset cache outside the
 * output directory or every clean build throws away an hour of encoding -- which
 * is the shape this whole arc keeps finding: the capability to state a rule,
 * spent on stating it somewhere the code cannot read.
 */
export function clean(outDir: string, protect: ProtectedPath[]) {
  checkCleanScope(outDir, protect)
  rmSync(outDir, { recursive: true, force: true })
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const t0 = now()
  const sitePath = resolve(opts.site)
  const dbPath = resolve(opts.dbPath)
  const outDir = resolve(opts.outDir)
  const workDir = resolve(opts.workDir ?? dirname(dbPath))

  // The site is loaded before anything is deleted, which is a change of order
  // rather than of steps. Two things follow from it: the clean can be checked
  // against the asset paths the site declares, which are only knowable from
  // here; and a build that cannot start -- a site module that fails to import,
  // or declares no routes -- no longer takes the last good output with it on the
  // way out.
  const cfgProbe = await loadSite(sitePath)

  if (opts.clean) {
    clean(outDir, [
      { label: 'the site module', path: sitePath },
      { label: 'the document store', path: dbPath },
      { label: "the build's work directory", path: workDir },
      ...(cfgProbe.assets
        ? [
            { label: 'the asset derivative cache', path: cfgProbe.assets.outDir },
            { label: 'the asset source directory', path: cfgProbe.assets.sources },
          ]
        : []),
    ])
  }

  // Drop any previous seal before emitting a byte. A build that dies halfway
  // must leave no seal behind, or the next deploy reads the *last* build's
  // completion token as proof that this truncated tree is whole and starts
  // deleting live pages that this build simply never got to.
  clearSeal(workDir)

  // The asset stage runs on the main thread before any route renders, so
  // `ctx.image()` can be a synchronous lookup and every derivative exists
  // exactly once. See src/assets.ts for why it is a stage and not a callback.
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

  // Not Math.max(1, …): that clamp is transparent to NaN, and a NaN worker count
  // builds a pool of zero workers, collects zero reports, agrees with itself that
  // the site has zero routes, passes the rendered-equals-resolved check because
  // 0 === 0, and seals an empty tree as a complete build. Every step reports
  // success. The deploy's delete-ratio rail is the only thing standing between
  // that seal and an unpublished site, and against an empty target there is
  // nothing for it to refuse.
  const workers = checkNumber(opts.workers, Math.max(1, cpus().length - 2), {
    name: 'workers', min: 1, integer: true,
  })

  const tr = now()
  let bytes = 0
  let routes: number
  let documents: number
  let resolveMs: Resolved['ms']

  if (workers === 1) {
    const p = await prepare(sitePath, dbPath, manifestPath)
    bytes = renderRange(p, outDir, 0, p.routes.length).bytes
    routes = p.routes.length
    documents = p.documents
    resolveMs = p.ms
  } else {
    // The main thread deliberately does not resolve the site. It used to, purely
    // to learn the route count for slicing -- a full load and parse of every
    // document (0.34s at 20,461 documents, and 0.60s before the store gained its
    // (type, id) index) sitting on the critical path before a single worker could
    // start. Every worker resolves anyway, so the count is already there; the
    // parent just tells each one which of N it is.
    //
    // The cost of not knowing the count: a pool wider than the route list spawns
    // workers whose slice is empty, and each still resolves the site before
    // discovering it has nothing to do. The old shape skipped those. Bounded in
    // practice -- `workers` defaults to cores-2 and any real site has far more
    // routes than cores -- so this trades a pathological case nobody runs for
    // ~340ms off the critical path of every real build.
    const workerUrl = new URL('./render-worker.ts', import.meta.url)
    // Handles kept, not just promises. A promise that has rejected says nothing
    // about the thread behind it, and what has to be waited on here is the
    // thread.
    const threads: Worker[] = []
    const jobs = Array.from({ length: workers }, (_, index) =>
      new Promise<WorkerReport>((res, rej) => {
        const wk = new Worker(fileURLToPath(workerUrl), {
          workerData: { sitePath, dbPath, outDir, manifestPath, index, count: workers },
        })
        threads.push(wk)
        let out: WorkerReport | null = null
        wk.on('message', (m) => {
          if (m && m.error) rej(new Error(`worker ${index} of ${workers}: ${m.error}`))
          else out = m as WorkerReport
        })
        wk.on('error', rej)
        wk.on('exit', (c) => {
          if (c !== 0) return rej(new Error(`worker ${index} exited ${c}`))
          if (out === null) return rej(new Error(`worker ${index} exited without reporting`))
          res(out)
        })
      }))

    // Promise.all rejects on the first worker to fail, and the others go on
    // rendering: they hold no lock and answer to nobody. Measured before this
    // existed, with worker 0 failing fast and three siblings rendering slowly --
    // build() rejected 91ms in having written nothing, the next writer took the
    // build lock immediately, and all 120 of the survivors' output entries
    // appeared afterwards. Not a tail past the release. All of it, after.
    //
    // The lock is not the place to fix that. A lock that promised "held until
    // the writers are quiet" would have to be told what to wait for, so a caller
    // that forgot to register still leaks and the lock carries a guarantee it
    // cannot keep -- which is the defect this codebase keeps finding, one layer
    // down. Draining here means build() cannot return while a thread of its own
    // is alive, so withLock's release-in-a-finally already releases into
    // quiescence and claims nothing new to do it.
    let done: WorkerReport[]
    try {
      done = await Promise.all(jobs)
    } catch (e) {
      // terminate() rather than awaiting a natural exit, because a natural exit
      // is not bounded: a worker wedged in a render would turn a failed build
      // into a hang, which this project treats as the worse result. It stops a
      // thread inside a tight synchronous loop -- nothing polite to interrupt --
      // in 4ms measured, and an idle-blocked one in 0ms.
      //
      // Rethrow the original. The terminated siblings exit non-zero and reject
      // their own promises on the way out, but Promise.all has already settled
      // on the first failure, so those are ignored rather than unhandled. The
      // first failure is the diagnosis; an exit code this line caused is not.
      await Promise.all(threads.map((wk) => wk.terminate()))
      throw e
    }
    // No drain on the success path: every job promise resolves from its own
    // 'exit' event, so arriving here already means every thread is gone.

    // Every worker resolved the site independently, so they must agree on what
    // the site *is*. Under the previous shape the parent resolved once and
    // handed out ranges, which made a worker resolving a different route set
    // impossible to notice -- it would simply render the wrong slice of a
    // different site and report success.
    // Compared on the route set's identity rather than its size. The count check
    // this replaces passed whenever two workers resolved different route lists
    // that happened to be the same length -- each rendering its slice of a
    // different site, both reporting success, and the seal vouching for the
    // mixture. Equal digests imply equal counts, so nothing is lost; the count
    // is still reported because "142 vs 138" describes the failure and two hex
    // strings do not.
    const digests = [...new Set(done.map((d) => d.digest))]
    if (digests.length > 1) {
      const shape = [...new Set(done.map((d) => `${d.routes} routes (${d.digest})`))]
      throw new Error(
        `workers disagree on the route set: ${shape.join(' vs ')}. ` +
        `Site resolution must be a pure function of the store, and something here ` +
        `is not -- a build assembled from these slices would have gaps, overlaps, ` +
        `or both.`)
    }
    routes = done[0]?.routes ?? 0
    documents = done[0]?.documents ?? 0
    // The slowest worker's, because that is what the wall clock actually waited
    // on. Reporting the fastest would understate the fixed cost this stage pays.
    resolveMs = {
      load: Math.max(...done.map((d) => d.ms.load)),
      index: Math.max(...done.map((d) => d.ms.index)),
      routes: Math.max(...done.map((d) => d.ms.routes)),
    }

    const rendered = done.reduce((a, b) => a + b.pages, 0)
    if (rendered !== routes) {
      // Slice arithmetic is the one place a silent gap produces a site that is
      // missing pages while every worker reports success.
      throw new Error(`rendered ${rendered} pages but resolved ${routes} routes`)
    }
    bytes = done.reduce((a, b) => a + b.bytes, 0)
  }
  const renderMs = now() - tr

  // Written last, and only here: every route has rendered and the count has
  // been checked. `files`/`bytes` come from a stat walk rather than the render
  // totals because assets are hardlinked into the output too, and the seal has
  // to describe the whole emitted tree -- that is what lets the deploy notice a
  // tree that lost files after the build rather than during it.
  // Reads every emitted byte, which the old stat-only walk did not. That is the
  // price of a seal that describes contents instead of dimensions, and it is
  // reported as its own timing (ms.seal) rather than folded into the total --
  // a cost nobody can see is a cost nobody can decide about.
  const ts = now()
  const scan = scanTree(outDir, [SEAL_ALGORITHM])
  const seal: BuildSeal = {
    schema: SEAL_SCHEMA,
    site: cfgProbe.name,
    outDir,
    routes,
    files: scan.files,
    bytes: scan.bytes,
    digest: foldDigests(scan.digests[0]),
    clean: opts.clean === true,
  }
  const sealMs = now() - ts
  writeSeal(workDir, seal)

  return {
    site: cfgProbe.name,
    documents,
    routes,
    bytes,
    workers,
    assets,
    seal,
    ms: {
      load: resolveMs.load,
      index: resolveMs.index,
      routes: resolveMs.routes,
      assets: assetMs,
      render: renderMs,
      seal: sealMs,
      total: now() - t0,
    },
  }
}
