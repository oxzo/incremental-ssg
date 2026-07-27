# Phase 0 gate — results

Run 2026-07-27. Reproduce with `npm run gate` (writes `.bench/`, gitignored).

**Machine:** 12-core, NVMe/btrfs, Node 22.22.3, 10 workers. Output written to real
disk, not tmpfs. Each figure is the faster of two consecutive runs.

**Corpus:** synthetic, deterministic (seed 7). Posts carry ~900 words of markdown
with headings, a TypeScript code block, a list, a quote, and internal links.
Routes = post pages + paginated archive (20/page) + 40 tag archives + author
pages + static pages + sitemap + feed ≈ 1.22 × posts.

**Tiers:** `light` = markdown-it only. `heavy` = markdown-it + shiki syntax
highlighting. Heavy costs a consistent **4.0× per page** at every corpus size.

## Full-build wall time

| posts | routes | light 1-thread | light 10-worker | heavy 1-thread | heavy 10-worker |
|------:|-------:|---------------:|----------------:|---------------:|----------------:|
|   500 |    652 |          0.28s |           0.22s |          1.13s |           0.64s |
| 2,000 |  2,489 |          1.05s |           0.54s |          4.22s |           1.31s |
| 8,000 |  9,802 |          4.16s |           1.86s |         16.62s |           3.75s |
|20,000 | 24,449 |         10.48s |           4.43s |         40.51s |           8.80s |

Throughput is **flat in N** — 2,355 / 2,362 / 2,357 / 2,333 pages/s single-threaded
across a 40× range. No superlinear term; the harness is not measuring its own
accidental O(N²).

Store load is negligible (0.19s at 20k), so the modest parallel speedup is not
redundant per-worker loading. The light tier scales only 2.4× on 10 workers
because it is **write-I/O bound**; the heavy tier scales 4.5× because it is
CPU bound. For simple templates the full build is already near the disk floor.

## Edit fan-out

Routes whose *inputs* actually change, computed exactly by diffing per-route
input signatures (a scale model of the Phase 3 fingerprint) — not estimated.

| change | 500 | 2,000 | 8,000 | 20,000 | % of routes |
|---|---:|---:|---:|---:|---:|
| body edit, tail (excerpt unchanged) | 1 | 1 | 1 | 1 | ~0% |
| body edit, head (excerpt changes) | 6 | 5 | 7 | 6 | ~0.02% |
| title edit | 8 | 7 | 9 | 8 | ~0.03% |
| **new post** | 63 | 230 | 880 | 2,203 | **~9%** |
| delete post | 24 | 65 | 268 | 627 | ~2.6% |
| **settings / nav edit** | 652 | 2,489 | 9,802 | 24,449 | **100%** |

Three findings:

1. **Content edits are constant-cost, not proportional.** A title or body edit
   invalidates 5–9 routes whether the site has 500 pages or 20,000.
2. **Publishing is ~9% of the site at every scale** — the pagination-shift
   prediction, confirmed. A new post at the top of a date-sorted archive shifts
   every archive page's 20-item slice, and enters the related-post block of its
   tag-mates. This fraction is scale-invariant, so incremental buys ~11× here,
   not the ~3,000× the edit cases suggest.
3. **A nav or settings change invalidates everything.** No dependency graph helps;
   the full build is the floor. Same for any template edit.

## Verdict: gate closed against the incremental engine

The pre-registered exit condition was "if a full rebuild is already fast enough
for the actual edit cadence, stop, ship the deploy diff alone." At the largest
scale measured — 24,449 routes with real syntax highlighting — a parallel full
rebuild takes **8.8 seconds**. That is inside any webhook-to-live budget. On
these numbers the crossover to a painful (>60s) full build sits somewhere past
~150,000 routes.

**The fan-out data makes the deploy diff more valuable, not less.** A typical
edit changes 6 output files out of 24,449. Without an output diff you upload and
CDN-purge all 24,449; with one you upload 6. That win needs no dependency graph —
only hashing the emitted files.

## What Phase 0 did not measure — the honest caveats

Any of these could reopen the gate, roughly in order of likelihood:

1. **No image/asset pipeline.** Image processing routinely dominates real SSG
   builds and is absent here. Biggest omission.
2. **No CMS sync.** Fetching 20k documents over HTTP could exceed total render
   time. But the fix for that is delta *sync*, which is far cheaper to build than
   render invalidation.
3. **No search-index build.** Typically a whole-site pass.
4. **Plain template functions**, not MDX or component-framework SSR, which can be
   an order of magnitude slower per page. The 4.0× heavy tier brackets some of
   this but not all.
5. **Generous hardware.** A 2-core CI runner with slower disk would be several
   times worse than these figures.

---

# Phase 2b — sync and assets

Run 2026-07-27, same machine. Reproduce with `node bench/run-2b.ts`. Phase 0
measured only HTML rendering; these are the two costs it left out.

## CMS sync

Mock cursor-paginated JSON API over localhost, 20,461 documents, 129.4 MB of
JSON. Network latency is *modelled* rather than invented: localhost RTT is
unrealistic, so the table below combines measured request counts and measured
local processing with a swept RTT.

| page size | requests | measured total | http | parse | store |
|---:|---:|---:|---:|---:|---:|
| 50 | 410 | 2.58s | 529ms | 74ms | 1.97s |
| 100 | 205 | 1.76s | 377ms | 70ms | 1.30s |
| 500 | 41 | 1.22s | 285ms | 81ms | 850ms |

Local processing — JSON parse + hash + SQLite upsert — is **67 µs/doc**, and the
upsert dominates it (1.30s of the 1.76s total at page=100).

Modelled wall time (`requests × RTT + local processing`):

| RTT | page=50 | page=100 | page=500 |
|---:|---:|---:|---:|
| 20ms | 10.24s | 5.47s | 1.75s |
| 100ms | 43.04s | 21.87s | 5.03s |
| 300ms | 125.04s | 62.87s | 13.23s |

- **Delta pull, 1 document changed: 3ms**, 5.2 KB.
- **Full-ID reconcile scan: 9ms**, 0.47 MB for 20,461 ids.

Three conclusions. **Page size is the dominant lever, not delta sync** — at
300ms RTT it is the difference between 125s and 13s. **Delta sync is still worth
it** (3ms vs seconds) and is cheap. And **the deletion-detection scan the
architecture note recommends is essentially free**, so there is no excuse for
skipping it and leaving orphan pages live.

At a realistic 100ms RTT with large pages, a *full* sync is ~5s — the same order
as the 8.8s full render. Sync does not reopen the gate.

## Image pipeline

sharp 0.35.3 / libvips 8.18.3. Sources 3000×2000 JPEG, derivatives at
400/800/1200/1600px.

Per source, single-threaded, all four widths:

| format | time/source | output |
|---|---:|---:|
| jpeg | 98ms | 346 KB |
| webp | 292ms | 340 KB |
| **avif** | **4.52s** | 42 KB |

**AVIF `effort` is the single biggest tunable in the whole build** (@1600px):

| effort | time/image | size |
|---:|---:|---:|
| 0 | 87ms | 82 KB |
| 2 | 194ms | 83 KB |
| 4 (sharp default) | 2.53s | 29 KB |
| 6 | 9.55s | 31 KB |

Effort 4 costs **29× the time of effort 0** for 2.8× smaller files. Effort 6 cost
3.8× more than effort 4 and produced a *larger* file — see the caveats; treat the
size column as synthetic-content-specific and the timing column as robust.

Throughput at pool width 10 (measured, not extrapolated):

| config | time/source | 20,000 sources |
|---|---:|---:|
| webp + avif @ default effort | 1.42s | **7.9 hours** |
| webp only | 79ms | 26 min |
| avif effort 0 only | 53ms | 18 min |
| webp + avif effort 0 | ~132ms | ~44 min |

Concurrency saturates early: 4.66s → 1.59s → 1.42s per source at pool 1 → 4 → 10.
libvips is already threading internally despite reporting concurrency 1.

**Cache probe (hash source bytes + stat the derivative): 1.06ms** versus 1,420ms
of work — a ~1,300× saving on an unchanged image.

## Verdict: assets are the build; Phase 0's kill still stands

Rendering the whole 24,449-route site takes 8.8s. Processing its images at
sharp's default AVIF effort takes **7.9 hours** — roughly 3,200× the render cost.
The build is an image pipeline with some HTML generation attached.

This does **not** reopen the Phase 0 gate, and the distinction matters. An asset
cache is keyed on one source file's own content hash: hash the bytes, skip if the
derivative exists. It needs no dependency graph, no route invalidation, no query
fingerprints, and it cannot go stale in the way a page cache can, because the key
*is* the content. It is the simplest possible cache, and it sits on the one cost
that actually hurts.

Actions, in order of value:

1. **Content-addressed asset cache.** Highest-value component in the project.
2. **Tune AVIF effort explicitly.** Leaving sharp's default in place is a ~11×
   build-time decision made by accident.
3. **Request large sync pages** before bothering with delta sync.
4. **Delta sync + the free ID-reconcile scan** for the webhook path.

## What Phase 2b does not measure

1. **Synthetic images.** Sources are deterministic pseudo-random noise; downscaled
   noise is smoother than a real photograph. AVIF encode time is content-dependent,
   and the effort-6-produces-a-larger-file result is very likely an artifact of
   that. Timing *ratios* should hold; absolute output sizes should not be trusted.
2. **Mock CMS.** No auth overhead, no rate limiting, no server-side pagination cap,
   no read-replica lag. Hence RTT is modelled and labelled, not measured.
3. **One image per post.** Real sites carry inline images too, which scales the
   asset cost up further — in the direction that strengthens the conclusion.
4. **SQLite upsert** was measured with one transaction per page; batching larger
   would cut the 1.30s store cost.

---

# Phase 2c — the asset cache, built

Implementation in `src/asset-cache.ts`, tests in `test/asset-cache.test.ts`
(`npm test`, 15 tests). Benchmark `npm run bench:asset-cache`.

24 sources (3000×2000, ~2 MB each), WebP + AVIF at effort 0, four widths —
192 derivatives:

| build | wall time | hits | misses | speedup |
|---|---:|---:|---:|---:|
| cold (empty cache) | 4.23s | 0 | 192 | — |
| warm (no changes) | **33ms** | 192 | 0 | **130×** |
| warm (1 source edited) | 214ms | 184 | 8 | 19.8× |

Extrapolated to 20,000 sources: ~59 min cold, ~27s warm. Against the 8.8s full
render, a steady-state build of a 20,000-image site is roughly 36s — versus an
hour without the cache.

## What makes it safe

The derivative file's existence *is* the cache entry; there is no side table to
fall out of sync. Two properties carry the weight, and both are tested:

- **The spec hash covers every parameter that can change output bytes** — format,
  width, quality, effort, and the sharp/libvips versions. Without the encoder
  params in the key, flipping `effort` from 4 to 0 would silently reuse old
  derivatives and the build would serve output no current config can reproduce.
  Tests 3 and 4 assert a quality or effort change is a miss.
- **Writes are atomic** (temp file + rename). A cache keyed on "the file exists"
  must never observe a partial write, or one interrupted build poisons the cache
  with a truncated image that reads as a hit forever. Test 6 decodes every
  emitted derivative and asserts its actual width.

Width is deliberately *not* a global invalidator: it is per-derivative, so
narrowing `widths` from `[100,200]` to `[100,250]` reuses 100 and encodes only
250 (test 5).

## A hazard the benchmark surfaced

The first bench run reported `gc deleted 8 (expected 0)`. That was not a cache
bug — gc had been called on an instance that had processed the site *before* an
edit, so its keep-set was stale and the 8 newly-created derivatives looked like
orphans. Correct behaviour under a dangerous contract: **any partial or failed
build holds an incomplete keep-set, and collecting against it deletes live
files.** Two rails were added and tested:

1. `gc()` throws unless `seal()` was called, marking the build complete.
2. `gc()` refuses to delete more than 50% of the directory without `{force:true}`,
   guarding the "processed 3 sources, collected 20,000" failure.

## Limits

- **The warm path still reads every source file in full** to content-hash it —
  ~40 GB of reads for 20,000 sources at 2 MB each. The 27s warm extrapolation
  assumes page-cache-warm reads, as the 24-source sample certainly was, so a
  cold-filesystem warm build will be slower. The standard fix is an
  `(mtime, size)` fast path, which reintroduces exactly the side table and
  staleness risk this design otherwise avoids. Not taken yet; measure first.
- **Externally corrupted derivatives are still served.** Atomic writes mean *our*
  builds never create partials, but the existence check does not validate
  content, and validating would mean decoding every derivative — which is the
  1 ms probe that made the cache worth having.
- Derivative filenames embed the source basename for debuggability, so renaming a
  source re-encodes it (test 12). Deliberate; content is still the cache key.
