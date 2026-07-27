# incremental-ssg

A Node + TypeScript static site builder that pulls content from a headless CMS
and renders it to HTML. It was scoped as an *incremental* builder. The Phase 0
gate measured a full rebuild as fast enough and killed that half, so what
remains is a fast full build, a content-addressed asset cache, and (next) a
deploy diff.

No build step: Node's native type stripping runs the TypeScript directly.

```sh
npm test          # 86 tests
npm run demo      # mock CMS -> sync -> assets -> render -> write, end to end
npm run cli help
```

## Why there is no incremental engine

Phase 0 measured the thing the project was named after and found nothing to
save. Full details in `bench/RESULTS.md`; the three results that decided it:

- Full-build throughput is **flat** in corpus size — ~2,350 pages/s per thread
  across a 40× range. 24,449 routes with syntax highlighting rebuild in **8.8s**
  on a worker pool. The crossover to a painful (>60s) build sits past ~150,000
  routes.
- A content edit invalidates 5–9 routes whether the site has 500 pages or
  20,000 — constant, not proportional.
- A **new post invalidates ~9% of all routes at every scale** (pagination shift
  in the date-sorted archive), and a nav or settings edit invalidates **100%**.
  No dependency graph helps with either.

Phase 2b then found where the time actually goes: image processing costs roughly
**3,200× rendering** — 7.9 hours against 8.8 seconds at 20,000 sources. So the
expensive half got a cache and the cheap half did not. That asymmetry is the
whole design.

## Pipeline

```
sync ──> document store ──> index ──> routes ──> assets ──> render ──> write
(network)   (SQLite)              (site-defined)  (cached)  (workers)
```

Rendering never touches the network; all CMS I/O is confined to `sync`, so a
build runs offline against the last snapshot.

## The engine/site seam

`src/` never learns what a "post" is. A site is a module (`SiteConfig`) that
owns its schema, indexes, routes, and templates; the engine owns sync, storage,
the worker pool, assets, determinism, and writing. `example/blog/` is the blog
schema the Phase 0 benchmarks hardcoded, moved out of the engine — it exists to
prove the seam holds.

A site is loaded **by path** rather than by value because render workers cannot
be handed a closure; each thread imports the module itself.

## Properties that are tested, not asserted in prose

- **Two builds of one corpus are byte-identical.** Success criterion 1 stated as
  a test, with a negative control proving the check can detect a one-byte
  difference. Without it, the deploy diff in Phase 2 silently degrades to a
  full-site upload the first time a template reaches for the clock.
- **The worker pool and the single-threaded path produce the same bytes.** They
  share `prepare()` and `renderRange()` so they cannot drift.
- **Every resolved route produces exactly one file.** Catches slice-arithmetic
  gaps that would otherwise leave a hole in the site while every worker reports
  success.
- **Wall-clock and randomness throw inside the render window** (`Date.now()`,
  argless `new Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID`).
  `new Date(value)` is allowed — rendering a document's own timestamp is correct.
  Filesystem and network are *not* sandboxed; see `src/determinism.ts` for the
  honest list of what is and is not guarded.

## Asset cache

Keyed on one source file's own content hash plus the exact transform, so it
needs no dependency graph and cannot go stale the way a page cache can — the key
*is* the content. Measured: 4.23s cold, **33ms warm** (130×) on 192 derivatives.

Two rails, both learned by deleting live files during Phase 2c:

- `gc()` throws unless `seal()` marked the build complete, and refuses to sweep
  more than half the directory. A partial build holds an incomplete keep-set,
  and collecting against it deletes derivatives that are still live.
- The asset stage processes **every source in the directory**, not just
  referenced ones. That is what makes `seal()` honest rather than hopeful.

`DocumentStore.deleteMissing` carries the same rail for the same reason: a
reconcile scan that fails halfway returns a short list, and trusting it
unpublishes the site while the logs still say "sync complete".

Keep the cache directory **outside** the output directory, or every `clean`
build throws away work that costs ~59 minutes to regenerate at 20,000 sources.
Derivatives are hardlinked into the output at publish time.

## AVIF effort is the largest single tunable

At 1600px: effort 0 = 87ms, effort 2 = 194ms, effort 4 (**sharp's default**) =
2.53s, effort 6 = 9.55s. The default costs 29× effort 0 for 2.8× smaller files.
`src/asset-cache.ts` sets it explicitly so it is a decision rather than an
accident. Do not tidy it back to the default.

## CMS adapters

Only one CMS will ever be targeted, so the adapter interface is not about
portability. It exists because three capabilities differ sharply between CMSes
while document *shapes* barely differ at all:

1. cursor-based delta sync — absent, every sync is a full pull
2. cheap full-ID listing — absent, deletes are undetectable
3. revision identifiers in webhooks — absent, no read-after-write check

`capabilities` is data the sync driver branches on. No real CMS has been chosen
yet; `src/cms-mock.ts` is currently the only target.

**Page size is the dominant sync lever**, not delta sync: at 300ms round-trip,
50-per-page costs 125s where 500-per-page costs 13s.

## Layout

| path | what |
|---|---|
| `src/config.ts` | the `SiteConfig` seam and the site loader |
| `src/store.ts` | SQLite document mirror |
| `src/cms.ts`, `src/cms-mock.ts` | adapter interface, HTTP adapter, mock CMS |
| `src/sync.ts` | full/delta pull, hashing, delete reconciliation |
| `src/assets.ts`, `src/asset-cache.ts` | the asset stage and its cache |
| `src/determinism.ts` | the render-window guard |
| `src/render.ts` | markdown, render context, `ctx.image` / `ctx.picture` |
| `src/build.ts`, `src/render-worker.ts` | build driver and worker pool |
| `src/cli.ts` | `sync` and `build` commands |
| `example/blog/` | the example site, its sample corpus, and `demo.ts` |
| `bench/` | Phase 0 / 2b / 2c harnesses and `RESULTS.md` |

## Not built

Dependency recording, the fingerprint cache, the `dep_key` reverse index, and
projection-dependent aggregates are shelved by the gate. The fan-out harness
stays in `bench/` — it is the instrument that would say when scale finally
justifies revisiting.

Next: the deploy diff (Phase 2), sync tuning (Phase 2d), and the webhook service
(Phase 5).
