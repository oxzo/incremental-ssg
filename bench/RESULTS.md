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

## What this does not measure — the honest caveats

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
