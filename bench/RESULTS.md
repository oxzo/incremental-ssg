# Phase 0 gate — results

Run 2026-07-27. Reproduce with `npm run gate` (writes `.bench/`, gitignored).

**Machine:** 12-core, NVMe/btrfs, Node 22.22.3, 10 workers. Output written to real
disk, not tmpfs. Each figure is the faster of two consecutive runs.

> **Method caveat, added 2026-07-28.** Best-of-two is a weaker method than the
> interleaved runs used from the Phase 2 re-benchmark onward, and it flatters
> whichever run met the friendlier machine. The table is left as the record of
> what Phase 0 measured rather than rewritten; the figures to quote are the
> re-benchmarked ones below. Separately, `npm run gate` did not until today run
> the 20,000-post *heavy* row this section headlines — it swept every other row,
> so the command reproduced the table apart from its headline. Fixed in
> `bench/run.ts`; the reproduce instruction above is now true as written.

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

---

# Phase 2 — deploy diff, and the product measured against the harness

Run 2026-07-27, same machine. Reproduce with `node bench/run-2.ts` (build and
deploy figures) and `node bench/run-2-seam.ts` (the comparison below).

**Methodology changed, and the change was necessary.** Every figure in this
section comes from a **fresh process per measurement**, best of three. The first
attempt reused one process and reported that turning the determinism guard *off*
made builds 18% slower, and that `resolveSite` cost less than its own store
load. Both are impossible. Each 20k build allocates hundreds of megabytes, so
every run after the first is measured against a different GC state. Numbers from
that attempt were discarded rather than published. The Phase 0 table above used
best-of-two within one process; it is not directly comparable to what follows,
which is why the harness was re-run here rather than quoted.

## The deploy diff

23,441 routes, 320 MB of output, heavy tier, 10 workers.

| operation | time | moved |
|---|---:|---|
| hash the output tree | 0.68s | 23,441 files, 320 MB |
| cold deploy (nothing live) | 2.71s | 23,441 uploaded, 320 MB |
| no-op rebuild | 1.82s | **0 uploaded**, 23,441 unchanged |
| after one title edit | 1.79s | **7 uploaded**, 7 purged |

Seven files out of 23,441. Phase 0 predicted 8 for a title edit by diffing
per-route input signatures; this is the same claim measured on emitted bytes
through the real pipeline, and it lands in the same place. The diff costs ~1.8s
against a ~14s build — about 13%, for a 3,300× reduction in what gets uploaded.

Hashing runs at ~470 MB/s and is the dominant term. Listing a directory target
is free; a real paginating target will not be.

## Product pipeline vs Phase 0 harness

Both pipelines, this machine, this hour, same method. Normalised by **MB
written per second**, because the two corpora resolve to slightly different
route counts (23,441 vs 24,449) and pages/s would quietly reward whichever
produced smaller pages. Page sizes are in fact close — 11.05 vs 11.19 KB — so
the corpora are well matched.

| configuration | product | harness | product throughput |
|---|---:|---:|---:|
| plain / light, 1 thread | 12.91s | 11.48s | **−16%** |
| plain / light, 10 workers | 9.37s | 4.91s | **−50%** |
| highlight / heavy, 1 thread | 46.59s | 43.57s | **−11%** |
| highlight / heavy, 10 workers | 13.86s | 9.93s | **−31%** |

Pool speedup: product **1.38×** (light) and **3.36×** (heavy), against the
harness's **2.34×** and **4.39×**.

**The single-threaded cost of the engine/site seam is 11–16%.** Modest, and the
price of a site being a module rather than hardcoded.

**The parallel cost is the real one, and it is 31–50%.** The seam did not make
rendering much slower; it made the worker pool much worse.

### Where it goes

`resolveSite` — what every worker repeats — costs **0.60s**: store load 0.58s,
index 0.02s, route resolution 0.00s. A 10-worker build runs it eleven times
(once on the main thread purely to count routes for slicing, once per worker),
so **~6.4s of aggregate CPU is spent parsing the same 20,461 documents over and
over**.

`src/build.ts` justified that design with the claim that re-resolving per worker
is "cheap — milliseconds at 24k routes". It is 600ms. The comment was wrong by
roughly two orders of magnitude, which does not make the design wrong — a
24k-element structured clone per worker has its own cost, and nobody has
measured the alternative — but it does mean the decision is currently
unjustified rather than justified.

### What was ruled out

- **The determinism guard is not the cause.** Guard on measured 12.91–15.45s,
  guard off 14.89–15.08s, single-threaded. The ranges overlap, so at this
  precision there is **no measurable guard cost** in either direction. An
  earlier reading of "13% faster with the guard on" was best-of-three arithmetic
  over overlapping spreads and should not have been quoted.
- **Site indexing is not the cause.** 0.02s.
- **Route resolution is not the cause.** Under 5ms.
- **Environment drift does not explain it.** The harness ran 10% slower today
  than when Phase 0 recorded it (11.48s vs 10.48s light single-threaded), which
  is why it was re-run rather than quoted. A 10% box difference does not produce
  a 50% throughput gap.

### Not yet ruled out

Per-worker ESM module loading (each thread imports the site module, its
templates, and markdown-it or shiki), memory-bandwidth saturation from ten
concurrent 165 MB parses, and static slicing — `ceil(routes/workers)` contiguous
routes each, so an uneven cost distribution leaves the build waiting on the
slowest slice. The harness uses the same static slicing and scales better, so
slicing cannot be the whole story.

## Corrections to figures quoted elsewhere

**The 8.8s headline is not the product's number.** It was the harness at 24,449
routes with highlighting. The equivalent product figure is **13.86s**, and the
harness re-measured today is 9.93s. The conclusion Phase 0 drew is untouched —
a full rebuild remains far inside any webhook-to-live budget, and the crossover
to a painful build moves from ~150,000 routes to roughly ~100,000 — but the
specific number should be quoted as 13.86s from here on.

Sync was re-measured incidentally: 20,461 documents, 41 requests, 158 MB,
1.66s — **81 µs/doc** against Phase 2b's 67 µs/doc, the difference explained by
this corpus's larger bodies.

---

# Phase 2 addendum — the store-load fix, and a retraction

Run 2026-07-27, same machine, shortly after the section above. **That section's
product-vs-harness table was wrong and is retracted; the corrected figures are
below.**

## What was wrong

Product builds were charged for `rmSync` deleting the previous run's 23,441
output files — roughly 2.3s — because the product cleans *inside* `build()` while
the harness path cleaned outside its timer. Every product row paid it and no
harness row did. Best-of-N compounded it by systematically preferring whichever
run found the least to delete, which for the first configuration measured is an
empty directory.

The tell was the same one that caught the first methodology error, and it was
again not implausibility: **total wall time stopped equalling the sum of the
phases it reported** — 14.7s total against 0.30 load + 0.01 index + 12.05 render.
`bench/one-build.ts` now empties the output directory before the clock starts,
for both pipelines.

A second correction, of technique rather than code: **configurations measured in
separate batches are not comparable on this machine.** A first pass reported the
fixes making single-threaded builds 7% *slower*; interleaving the two variants
A/B/A/B showed the fixed build faster in all four pairs with no overlap. Sustained
load drifts the box more than the effect being measured, so every figure below
comes from interleaved runs.

## The fixes

**A composite `(type, id)` index on `documents`.** The only type-filtered query in
the engine reads `ORDER BY type, id`, and the index was on `(type)` alone, so
SQLite satisfied the filter and then built a temp B-tree, dragging all 158 MB of
JSON through the sorter. Measured at 20,461 documents before touching anything:

| | |
|---|---:|
| ordered read (temp B-tree) | 460ms |
| the same read, unordered | 158ms |
| `JSON.parse` of all of it | 129ms |
| ordered read with `(type, id)` | 170ms |

So ~300ms was pure sorting, and parsing — the thing that looked like the obvious
culprit — was never the problem. Row order was verified byte-identical across all
20,461 documents before the change was trusted. `resolveSite`: **0.60s → 0.33s**.

**The parent no longer resolves the site in parallel mode.** It was loading and
parsing every document purely to learn the route count for slicing, serially,
before any worker could start. Workers now derive their own slice from
`(index, count)`. This also made cross-worker agreement checkable, and it is now
checked — see the build source.

## Measured effect (interleaved, 4 pairs)

| configuration | before | after | |
|---|---:|---:|---:|
| light, 1 thread | 11.50–11.56s | 11.13–11.26s | −2.5% |
| light, 10 workers | 6.30–6.55s | 4.97–5.12s | **−22%** |

Single-threaded barely moves, which is right: one thread pays the fixed cost once.
The pool is where eleven redundant loads lived.

## Corrected product vs harness (interleaved, 3 pairs)

| configuration | product | harness | product throughput |
|---|---:|---:|---:|
| light, 1 thread | 11.24s / 259 MB | 10.32s / 274 MB | −13% |
| light, 10 workers | 5.07s | 4.49s | −16% |
| **heavy, 10 workers** | **9.62s** | **9.66s** | **−4%** |

Pool speedup: product **2.22×** light and **4.5×** heavy, against the harness's
**2.30×** and **4.45×**.

**The parallel scaling deficit is gone.** It was reported as 1.38× against 2.34×;
part of that gap was the clean-cost artefact and part was real, and the real part
is now fixed. On the heavy tier — the CPU-bound configuration Phase 0 headlined —
the product and the harness are indistinguishable in wall time, and the remaining
4% is that the product writes 259/320 MB where the harness writes 274/334.

The light tier keeps a genuine 13–16% deficit. It is write-I/O bound, so per-byte
throughput is the fair measure there and the product is behind on it. Unexplained,
and not chased further.

## Figures to quote from here on

**A 20,000-post site with syntax highlighting rebuilds in ~9.6s** on ten workers
(43.5s single-threaded). Not 8.8s (the harness, and a faster day), and not 13.9s
(the contaminated measurement above it). The Phase 0 verdict is untouched and was
never close to the line.

---

# Adapters — the two measurements that needed real services (2026-07-28)

Both had been open since Phase 2b/2d and were blocked on one thing: every sync
figure in this project came from a mock on localhost, where round-trip time is
meaningless. Reproduce with `stack/up.sh && stack/seed.ts 2000` then
`npm run bench:adapters`.

**Setup.** Directus 12.1.1 and MinIO in podman, 2,011 documents (2,000 posts +
11 others), 2,322 emitted objects in the bucket. RTT is *injected* by
`stack/proxy.ts` in front of each service. Three rounds, configurations
interleaved, spreads reported.

**What injected latency is and is not.** It is a constant; real RTT is a
distribution with a tail and load correlation. What it buys is a **swept**
variable instead of a single sample, so the Phase 2b cost model can be checked
across a range rather than anchored to whatever one host happened to do. Read
the model column, not the absolute milliseconds.

## 1. Page size against RTT — the Phase 2b model, checked

| RTT | page size | requests | wall (spread) | median | http | predicted | delta |
|---:|---:|---:|---|---:|---:|---:|---:|
| 0ms | 50 | 45 | 826ms–955ms | 935ms | 766ms | — | — |
| 0ms | 100 | 25 | 712ms–841ms | 777ms | 669ms | — | — |
| 0ms | 500 | 9 | 597ms–635ms | 610ms | 564ms | — | — |
| 0ms | 1000 | 7 | 589ms–631ms | 599ms | 562ms | — | — |
| 25ms | 50 | 45 | 2.01s–2.12s | 2.02s | 1.85s | 2.06s | −2% |
| 25ms | 100 | 25 | 1.39s–1.47s | 1.44s | 1.33s | 1.40s | +3% |
| 25ms | 500 | 9 | 861ms–890ms | 879ms | 828ms | 835ms | +5% |
| 25ms | 1000 | 7 | 800ms–820ms | 816ms | 778ms | 774ms | +5% |
| 100ms | 50 | 45 | 5.53s–5.57s | 5.54s | 5.35s | 5.43s | +2% |
| 100ms | 100 | 25 | 3.36s–3.42s | 3.37s | 3.26s | 3.28s | +3% |
| 100ms | 500 | 9 | 1.62s–1.63s | 1.63s | 1.57s | 1.51s | +8% |
| 100ms | 1000 | 7 | 1.40s–1.44s | 1.44s | 1.39s | 1.30s | +11% |

**The 0ms rows are the model's `local` term, not evidence.** The prediction is
`requests × RTT + local`, and `local` comes from the 0ms run at the same page
size — so a 0ms row predicts itself and would read `+0%` whatever the truth was.
They are shown as inputs, without a delta, on purpose.

**The model holds, and is optimistic in a way that has a shape.** Latency rows
land between −2% and +11% of prediction, and within each RTT the excess grows
monotonically with page size (25ms: −2, +3, +5, +5; 100ms: +2, +3, +8, +11).
That is the right shape for a fixed per-request cost the model omits — socket
setup, JSON parse, the SQLite upsert — becoming a larger share of the total as
the request count falls. Page size remains the dominant lever regardless: at
100ms RTT, 50-per-page costs 5.54s against 1.44s at 1000-per-page.

**Measured twice against two different proxy implementations.** An earlier run,
before the proxy was rewritten from `fetch` to `node:http`, gave the same shape
with a narrower band (+2% to +7%). Those numbers are not reported here because
they were produced by code that is not the code in this repository — a baseline
recorded against a different implementation is a different experiment. That the
two agree on direction and ordering is corroboration; that they disagree on the
band by a few points is the honest noise floor of a three-round run.

**Request counts reconcile exactly against the corpus**, which matters more than
the timings: post (2,000 rows) at page 50 is 40 full pages plus one empty probe,
plus one request each for the four small collections = 45. The same arithmetic
lands on 25, 9 and 7.

**The empty probe is a deliberate one-request-per-collection cost.** A full page
might be the last one, and finding out costs one more request. The alternative —
asking for `meta.total_count` on every page — trades one request per *collection*
for a count query per *page*. Only a collection whose row count is an exact
multiple of the page size pays it; here that is one request out of 7.

## 2. The deploy diff's remote listing cost

2,322 objects in a real bucket. Phase 2 could not measure this at all — a
directory target lists for free — so the figure quoted there (~25 requests,
~7.5s at 300ms RTT for a 24,449-object site) was a model resting on an assumed
1,000-objects-per-page cap.

| RTT | page size | objects | requests | wall (spread) | median | per request |
|---:|---:|---:|---:|---|---:|---:|
| 0ms | 100 | 2322 | 24 | 147ms–398ms | 364ms | 15ms |
| 0ms | 500 | 2322 | 5 | 109ms–132ms | 117ms | 23ms |
| 0ms | 1000 | 2322 | 3 | 86ms–97ms | 94ms | 31ms |
| 25ms | 100 | 2322 | 24 | 731ms–774ms | 766ms | 32ms |
| 25ms | 500 | 2322 | 5 | 233ms–268ms | 240ms | 48ms |
| 25ms | 1000 | 2322 | 3 | 157ms–167ms | 159ms | 53ms |
| 100ms | 100 | 2322 | 24 | 2.50s–2.51s | 2.50s | 104ms |
| 100ms | 500 | 2322 | 5 | 569ms–577ms | 569ms | 114ms |
| 100ms | 1000 | 2322 | 3 | 380ms–382ms | 381ms | 127ms |

**Same lever as sync, same shape.** Request count dominates: at 100ms RTT,
100-per-page costs 2.50s against 381ms at 1000-per-page. Nothing here is
surprising, which is the point — the assumption Phase 2 wrote down was right, and
it is now measured rather than assumed.

**Per-request cost rises with page size and per-object cost falls.** At 0ms RTT a
100-object page costs 15ms and a 1000-object page costs 31ms, so local work per
object drops from 0.15ms to 0.031ms. Bigger pages win twice: fewer round trips
*and* less parsing overhead per object. The one wide spread in the table
(147ms–398ms at 0ms/100) is the first-round cost of establishing connections,
visible only where there is no injected latency to swamp it.

**Extrapolated to Phase 0 scale, clearly labelled as extrapolation.** At
1,000-per-page a 24,449-object site is 25 requests. Taking the measured
127ms/request at 100ms RTT gives ~3.2s, and the ~27ms local component implies
~8.2s at 300ms RTT — against Phase 2's modelled ~7.5s. The model was sound. What
this does *not* measure is a provider that paginates differently, throttles
listings, or charges for them.

**Reconciliation: every configuration listed 2,322 objects.** Page size changes
the request count and nothing else. Had that column varied, the continuation-token
loop would be wrong and the timings would be describing a broken listing.

## What these two measurements do not settle

The stack is real software but it is local, unloaded, single-tenant and
unauthenticated in the ways that matter. Untouched by any of the above: a
provider's rate limiter under sustained load, replica lag between a write and the
read that follows it, a listing API that caps or charges differently, credential
rotation mid-sync, and the tail of a real network. Injected faults are the faults
that were anticipated, and anticipated faults are the ones already handled.

---

# Fan-out is a property of the template set (2026-07-28)

Found by running the service against the real stack for the first time: a single
title edit published **408 files of 2,322**. Every one of them genuinely
contained the edited title, so the deploy diff was correct — the expectation was
wrong. Phase 0's table predicts 8. Reproduce with
`npm run bench:fanout-templates`.

**Cause: the example site's related-posts sidebar.** `related` takes the first
`RELATED` entries from the post's *first tag's* list, which is sorted
newest-first. So the newest few posts in each tag appear on the page of every
post sharing that tag, and every other post appears on almost nothing. Fan-out is
**bimodal**, and which mode an edit lands in depends on which post is edited.

| | 500 posts (587 routes) | 2,000 posts (2,310 routes) |
|---|---:|---:|
| minimum | 6 | 6 |
| **median** | **8 (1.4%)** | **8 (0.3%)** |
| **maximum** | **223 (38.0%)** | **835 (36.1%)** |
| samples in the expensive mode | 8 of 24 | 8 of 24 |

**The cheap mode is constant and the expensive mode is proportional.** 8 routes
at both scales, exactly as Phase 0 found; 223 → 835 for a 4× corpus, holding at
roughly 36–38% of the site. The expensive mode is approximately "the number of
posts sharing a tag", which grows with the corpus by construction.

**The live run corroborates the benchmark.** The service published 408 of 2,322
for `post-7`; this benchmark measures `post-6` at 411 and `post-8` at 445, on a
corpus generated with different body settings. Two independent paths to the same
neighbourhood.

**The Phase 0 gate is untouched.** It rests on a full rebuild being fast enough,
and it is — 2,310 routes rebuilt and diffed in 1.6s through the live service.
What needs qualifying is the *fan-out table*: "content edits are constant-cost,
5–9 routes at any scale" is true of the harness templates, and true of the median
edit here, and false for the newest posts in each tag.

**The methodology note is the part worth keeping.** The first version of this
benchmark edited one post, reported 9 routes, and would have "refuted" the
observed 408. That is the same error Phase 0's notes already record about its own
first fan-out model — which appended text to the end of a body, left the excerpt
untouched, and reported the best case as if it were typical. **A bimodal quantity
has no meaningful single sample**, and nothing about editing one document tells
you it is bimodal. Sample the distribution, or measure the mechanism.

Transferable form: **fan-out is a property of the template set, not of the
content model.** A template that embeds one document into many pages creates a
hot minority that no average over documents will reveal.


## What the content-bound build seal costs (2026-07-28)

Reproduce with `npm run bench:seal -- <posts> <light|heavy>`; the table is
`20000 light` and `20000 heavy`. Same machine, three interleaved rounds per
configuration, median reported. Assets skipped, so this is the HTML tree only.

The seal used to record file count and total size — one stat per file, no reads.
Binding it to *contents* means reading back every byte the build just wrote, and
the question was whether that price is worth paying on the critical path.

| tier | files | bytes | build | seal | share | read throughput |
|---|---:|---:|---:|---:|---:|---:|
| light (plain markdown) | 23,027 | 106 MiB | 2.60s | 0.54s | **21.0%** | 194 MiB/s |
| heavy (syntax highlighting) | 23,027 | 164 MiB | 9.66s | 0.58s | **6.0%** | 283 MiB/s |

**The absolute cost is flat and the share is not.** ~0.55s either way — it is a
read over the same tree — against a build that is four times longer on the tier
this project headlines. So the honest single number is *6% of the configuration
the ~9.6s figure describes, and 21% of a light one*, and quoting either alone
picks the answer.

**The estimate this replaced was half right.** The plan for this change projected
~7% from the Phase 2 deploy-hash measurement (0.68s over 320 MB, ~470 MB/s). The
share was right for the heavy tier and wrong for the light one, and the
throughput was wrong for both: this tree averages ~7 KiB per file across 23,027
files, so per-file open and read dominate and 470 MB/s never appears. **A
bandwidth figure measured on a tree with large image derivatives does not
transfer to a tree of small HTML files** — same operation, different bottleneck.

**Accumulating digests during the write was rejected, and not on cost.** It would
be nearly free: both the render and the asset stage already hold each file's
bytes. It was refused because it changes what the seal *means*. Read from disk,
the seal says "this is what is in the tree". Accumulated while writing, it says
"this is what we meant to put there" — and the gap between those two is precisely
where the failures it exists to catch live: a truncated write, a file another
process replaced, a partial flush. A seal that cannot disagree with the writer
that produced it is not evidence about the tree.

**Method note.** The first run of this benchmark reported the two tiers as
costing the same, because the corpus was generated without `code: true` and the
heavy tier had nothing to highlight. `example/blog/fixture.ts` documents that
trap on the option itself; it still caught the person who had just read it.
