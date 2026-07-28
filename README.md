# incremental-ssg

A Node + TypeScript static site builder that pulls content from a headless CMS
and renders it to HTML. It was scoped as an *incremental* builder. The Phase 0
gate measured a full rebuild as fast enough and killed that half, so what
remains is a fast full build, a content-addressed asset cache, and a deploy
diff that uploads only the files an edit actually changed.

No build step: Node's native type stripping runs the TypeScript directly.

```sh
npm test          # the suite; counts and the rest of the gate live under Checks
npm run demo      # mock CMS -> sync -> assets -> render -> write -> deploy
npm run cli help
```

## Demo

A public site that a CMS edit visibly rebuilds: Directus and the publish service
run locally, the built site lives in Cloudflare R2, and a small Worker serves it.
An editor saves, a webhook fires, the site is rebuilt, and only the changed files
are uploaded — usually single digits out of a few thousand.

Setup and the runbook are in `demo/README.md`. Nothing in the pipeline is
demo-specific: R2 speaks the S3 API, so `--to s3://<bucket>` reaches it through
the same target that reaches MinIO in `stack/`.

## Why there is no incremental engine

Phase 0 measured the thing the project was named after and found nothing to
save. Full details in `bench/RESULTS.md`; the three results that decided it:

- Full-build throughput is **flat** in corpus size — ~2,350 pages/s per thread
  across a 40× range. ~23,400 routes with syntax highlighting rebuild in
  **~9.6s** on a worker pool. The crossover to a painful (>60s) build sits
  somewhere past ~100,000 routes.

  (Two other numbers are in circulation and both are wrong. **8.8s** was the
  Phase 0 *harness* on a faster day. **13.9s** came from a benchmark that charged
  the product for deleting its previous output while the harness was not charged
  — retracted in `bench/RESULTS.md`. Measured properly and interleaved, the
  product and the harness are indistinguishable on this tier.)
- A content edit invalidates 5–9 routes whether the site has 500 pages or
  20,000 — constant, not proportional.
- A **new post invalidates ~9% of all routes at every scale** (pagination shift
  in the date-sorted archive), and a nav or settings edit invalidates **100%**.
  No dependency graph helps with either.

Phase 2b then found where the time actually goes: image processing costs three
orders of magnitude more than rendering — **7.9 hours against ~10 seconds** at
20,000 sources. So the expensive half got a cache and the cheap half did not.
That asymmetry is the whole design, and it is wide enough that the seam
regression above does not dent it.

## Pipeline

```
sync ──> document store ──> index ──> routes ──> assets ──> render ──> write ──> deploy
(network)   (SQLite)              (site-defined)  (cached)  (workers)          (diff)
```

Rendering never touches the network; all CMS I/O is confined to `sync`, so a
build runs offline against the last snapshot. `deploy` is the only stage that
can damage a live site, which is why it carries three refusals rather than one.

## The engine/site seam

`src/` never learns what a "post" is. A site is a module (`SiteConfig`) that
owns its schema, indexes, routes, and templates; the engine owns sync, storage,
the worker pool, assets, determinism, and writing. `example/blog/` is the blog
schema the Phase 0 benchmarks hardcoded, moved out of the engine — it exists to
prove the seam holds.

A site is loaded **by path** rather than by value because render workers cannot
be handed a closure; each thread imports the module itself.

## The content trust model

**CMS content is trusted, and templates are not escaped for you.** Two specific
consequences, written down because both are reasonable defaults and neither is
guessable from the code:

- `ctx.md()` runs markdown-it with `html: true`, so raw HTML in a document body
  reaches the page verbatim. That is correct for an editor you already trust with
  the site's templates, and it is stored XSS the moment a contributor you do not
  is allowed to publish.
- Templates are string functions. `ctx.esc()` exists and is not applied for you,
  so interpolating a document field without it is the same hazard by a different
  route.

The assumption behind both is a single-editor CMS whose authors could change the
templates anyway, which is the setup this project was built against. If that is
not your setup, the change is small — construct the renderer with `html: false`
in `src/render.ts`, or sanitize in `ctx.md()` — and the decision is yours to make
deliberately rather than to inherit.

Route paths are *not* trusted, and are validated: a slug containing `..` cannot
write outside the output directory, and two routes cannot silently write one
file. See `planOutputs` in `src/render.ts`.

The output tree is not trusted to stay inside itself either. **A tree this build
seals and deploys is regular files and directories** — a symlink anywhere under
it is refused by name rather than followed, because following a directory link
would publish an arbitrary subtree of the filesystem under a path in the site,
and following a file link would put bytes in the seal that the tree does not own.
Asset derivatives are *hardlinked*, which is a regular file and is unaffected.
See `walk` in `src/hash-tree.ts`.

## Properties that are tested, not asserted in prose

- **Two builds of one corpus are byte-identical.** Success criterion 1 stated as
  a test, with a negative control proving the check can detect a one-byte
  difference. Without it the deploy diff silently degrades to a full-site upload
  the first time a template reaches for the clock — so if a diff ever reports
  "everything changed", suspect a determinism regression before suspecting the
  diff.
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

## Deploy diff

Hash the built tree, compare it against **the remote listing** — what is
actually live — and upload, delete, and purge only the difference. A typical
content edit moves single-digit files where a naive deploy moves all 24,449.

It keeps no cross-build state, and that is the point rather than an oversight.
A local record of "what did I upload last time" is exactly the class of thing
that can be wrong, and a restored-but-stale CI cache would make a correct tool
skip a real upload. Don't reintroduce one for speed.

Three refusals, because this is the only stage that acts on production:

1. **No build seal, no deploy.** A build writes its seal only after every route
   has rendered and been counted, and clears any previous seal before it starts.
   A diff taken from a half-finished tree issues deletes for pages that are
   still live.
2. **No sweep past `maxDeleteRatio`** (default half the live site). Same rail as
   `AssetCache.gc` and `DocumentStore.deleteMissing` — a partial listing and a
   mass deletion are indistinguishable from inside the function.
3. **No deploy from a non-clean build.** This one fails *silently* rather than
   destructively, which is why it is easy to miss: nothing in the build removes
   output an earlier build left behind, so a deleted post's page and an edited
   image's old derivatives are still in the tree, still byte-identical to what
   is live, and therefore reported *unchanged*. The page never comes down and no
   error is ever raised. Cleaning costs only the cheap half of the build — the
   asset cache lives outside `outDir` precisely so this is affordable.

Uploads always land before deletes: the reverse order opens a window where a
page that merely moved is missing from the live site.

Two behaviours that look wrong and aren't. A changed image is an **add plus a
delete, never a modify**, because derivative filenames are content-addressed —
good for cache purging, alarming in a summary if nobody warned you. And added
paths are **not purged** by default: nothing is cached at a URL that did not
exist, so the only reason to purge one is a CDN that negatively caches 404s
(`purgeAdded` turns it on).

A target that cannot report content digests degrades to re-uploading every
existing path and **says so** (`digestsUnavailable`) rather than reporting them
unchanged — same principle as the sync driver refusing to pretend it can detect
deletes without an id listing.

Two targets exist: `src/deploy-s3.ts` speaks the S3 API and reaches MinIO
locally and Cloudflare R2 in the public demo, and `src/deploy-mock.ts` is a
directory standing in for the live site — which is not a lesser option kept for
tests, but how a deploy is rehearsed against something that cannot damage
anything.

**Measured at scale** (23,441 routes, 320 MB; full table in `bench/RESULTS.md`):
hashing the output tree costs **0.68s** at ~470 MB/s and is the dominant term; a
no-op rebuild deploys in **1.82s** moving nothing; a one-post title edit uploads
**7 files of 23,441**. So the diff costs ~13% of a build to avoid uploading
3,300× more than necessary.

**Known limits.** Hashing reads every byte, image derivatives included — at
20,000 sources that is far more I/O than the HTML. A shortcut exists and is
deliberately not taken: derivative filenames already contain their content hash,
so those paths could be digested from their names, at the price of coupling the
deploy stage to the asset naming scheme. Listing cost is still unmeasured — a
directory target is free, but a real target paginates, so a 24,449-object site
is ~25 requests and Phase 2b's finding was that request *count* dominates.

## AVIF effort is the largest single tunable

At 1600px: effort 0 = 87ms, effort 2 = 194ms, effort 4 (**sharp's default**) =
2.53s, effort 6 = 9.55s. The default costs 29× effort 0 for 2.8× smaller files.
`src/asset-cache.ts` sets it explicitly so it is a decision rather than an
accident. Do not tidy it back to the default.

## The publish service

`npm run cli serve` is the only unattended command, and that changes what a
safety rail means. Every rail in this codebase was designed against a human who
typed a command and could read a refusal; unattended, the same throw becomes a
site that silently stops updating — which is the worst failure available here.

So a refusal now carries one extra bit (`src/rails.ts`): can re-running change
the answer?

- **Self-clearing** — no build seal (the build died; the next one writes one),
  output drifted from its seal. Retried with doubling backoff. The persisted
  dirty flag keeps the pending publish alive across every retry and restart.
- **Terminal** — the delete-ratio ceiling (the build genuinely emitted fewer
  pages than the site has, so a rebuild refuses again), a seal describing a
  different directory, a held build lock. Publishing halts, the last good site
  keeps serving, `/health` goes 503. `POST <path>/build` is the way back.

After 3 consecutive transient failures the service reports unhealthy while still
retrying, because "busy forever and never publishing" has to be visible to
something.

### What is persisted, and what is not

There is no durable event queue, and that is a design decision rather than a
shortcut. Every build is a full build — the Phase 0 gate killed per-document
invalidation — so the pipeline can never act on *which* documents changed, only
on whether anything did. A queue of webhook payloads would persist per-document
detail nothing downstream can read, while carrying all the completeness hazards
this codebase keeps meeting.

What must survive a crash is one bit: is a publish outstanding? It lives in the
store's meta table as `service:dirty`, **set before the build starts and cleared
only after the deploy succeeds**. That ordering is the whole guarantee.
Set-after-build loses a publish to a crash mid-build; clear-before-deploy loses
one to a crash mid-deploy. Either way sync has already advanced its watermark, so
the next run finds nothing changed, never rebuilds, and raises no error.

### Coalescing

Editors save in bursts, so triggers are debounced (2s) but never delayed past a
cap (15s) — a plain reset-on-every-event debounce starves under a steady stream
and never builds at all. A trigger arriving *during* a run sets pending and the
finishing run re-arms; dropping it would be silent, since the dirty flag would be
clear and the next sync would report nothing changed. Only webhook and manual
triggers reset the quiet period: a poll is the net, not an editor.

Polling (60s) exists because webhook delivery is not reliable. The skip rule —
sync found nothing changed and nothing was outstanding, so don't build — is safe
for content and a real gap for **code**: a template edit changes the output while
sync sees nothing. `POST <path>/build` forces past it, and so does a restart.

### The endpoint

`POST <path>` queues, `POST <path>/build` forces, `GET /health` is
unauthenticated and coarse (up or down), `GET /status` is authenticated and
detailed.

It answers **before** it builds. A CMS webhook sender times out in seconds and
retries on timeout, so holding the connection open for a ~10s build turns one
publish into a retry storm. It also refuses to start without a secret: an open
endpoint that triggers a full build is a denial of service needing no payload,
and that belongs in the code rather than a deployment checklist. Bodies are
capped while streaming, not after.

### The build lock

`build`, `deploy` and `serve` all take a lock file in the work directory. A lock
only the service respected would not be a lock — the collision worth preventing
is an operator running `build` by hand during a scheduled publish, which an
in-process mutex cannot see. Two builds sharing one store, output tree and seal
corrupt all three at once.

A lock whose holder is *provably* gone is reclaimed automatically, because one
crash must not wedge publishing forever. A holder that might be alive is never
stolen: two concurrent builds are a correctness failure where a stalled service
is only a liveness one. The honest limit is pid reuse, which looks alive and
needs `--force-unlock`.

The lock file is written to a temp name and **linked** into place rather than
created with `wx` and filled afterwards. `wx` is atomic about creating a file but
not about filling it, which leaves a window where the lock exists and is empty —
and a racer reading it there finds unparseable JSON, judges the lock corrupt,
deletes it, and takes a lock someone else holds. Worth knowing: the
six-process race test passes against the broken version too (checked, not
assumed — the window is microseconds wide against tens of milliseconds of process
startup), so this one is justified by construction rather than by the test.

## CMS adapters

Only one CMS will ever be targeted, so the adapter interface is not about
portability. It exists because three capabilities differ sharply between CMSes
while document *shapes* barely differ at all:

1. cursor-based delta sync — absent, every sync is a full pull
2. cheap full-ID listing — absent, deletes are undetectable
3. revision identifiers in webhooks — absent, no read-after-write check (the
   service says so rather than running a check that cannot mean anything)

`capabilities` is data the sync driver branches on.

**Page size is the dominant sync lever**, not delta sync: at 300ms round-trip,
50-per-page costs 125s where 500-per-page costs 13s.

### Real adapters, and the local stack behind them

Both ends now have a real implementation as well as a mock. `stack/` stands up
**Directus** and **MinIO** in podman containers, with a fault-injecting proxy in
front of both so the adapters meet rate limits, truncated listings, aborted
responses and swept round-trip time without needing a hosted service or a bad
day. Full account, including what a local stack does *not* buy, in
`stack/README.md`.

Three things the real Directus does that the mock never did, each of which
silently breaks the obvious implementation:

- `date_updated` is **null until a document is updated**, so a delta filter on
  it alone misses every newly created document. The filter names both timestamp
  columns.
- `_gt` is **rejected on string fields**, so keyset pagination needs an integer
  key. Offset pagination is not a safe fallback here: after a full pull the sync
  driver feeds the ids it saw into `DocumentStore.deleteMissing`, so a page that
  drifts mid-pull does not merely skip a document, it unpublishes it.
- Webhooks were **removed in Directus 12**; Flows replace them and deliver three
  different payload shapes across create, update and delete. A flow written the
  obvious way works for updates and sends nothing at all for creates.

The CLI selects both by scheme — `--cms directus+http://host`, `--to s3://bucket`
— with credentials read from the environment only, never a flag.

On the deploy side the S3 target uses `@aws-sdk/client-s3`, so the same code
points at S3 or R2 by changing an endpoint and a credential pair. The one
non-obvious rule: a **multipart ETag is not the MD5 of the object**, so it is
reported as no-digest rather than compared — otherwise every multipart-uploaded
object reads as modified on every deploy, forever.

## Layout

| path | what |
|---|---|
| `src/config.ts` | the `SiteConfig` seam and the site loader |
| `src/store.ts` | SQLite document mirror (see the `(type, id)` index comment) |
| `src/cms.ts`, `src/cms-mock.ts` | adapter interface, HTTP adapter, mock CMS |
| `src/cms-directus.ts` | the real CMS adapter, and its retry and wait budgets |
| `src/deploy-s3.ts` | the real deploy target, over the S3 API |
| `src/sync.ts` | full/delta pull, hashing, delete reconciliation |
| `src/assets.ts`, `src/asset-cache.ts` | the asset stage and its cache |
| `src/determinism.ts` | the render-window guard |
| `src/render.ts` | markdown, render context, `ctx.image` / `ctx.picture` |
| `src/build.ts`, `src/render-worker.ts` | build driver, worker pool, build seal |
| `src/hash-tree.ts`, `src/pool.ts` | tree digests, and the one bounded-parallel map |
| `src/deploy.ts`, `src/deploy-mock.ts` | the deploy diff, its rails, and a directory target |
| `src/rails.ts` | `RailError`, and whether re-running can clear a refusal |
| `src/build-lock.ts` | the single-writer lock every writer takes |
| `src/service.ts` | the publish pipeline and the trigger coalescer |
| `src/webhook.ts` | the HTTP endpoint, its auth, and its body cap |
| `src/cli.ts` | `sync`, `build`, `deploy`, and `serve` commands |
| `example/blog/` | the example site, its sample corpus, and `demo.ts` |
| `stack/` | the local Directus + MinIO stack, its seeding, and the fault proxy |
| `tools/mutate.py` | breaks each rail in turn and checks that a test notices |
| `bench/` | Phase 0 / 2b / 2c / adapter / fan-out harnesses and `RESULTS.md` |
| `.github/workflows/ci.yml` | the checks below, enforced on push |

## Checks

```sh
npm test           # 276 tests
npm run typecheck  # tsc, strict, no emit — Node strips types and checks nothing
npm run test:mutate  # break each rail in turn; every one must fail a test
npm audit --omit=dev
```

`demo/worker` is a separate npm package and is checked separately, against the
Cloudflare runtime whose globals are not Node's:

```sh
npm ci --prefix demo/worker && npm run typecheck:worker
```

CI runs all four on the Node version `engines` declares as the floor and on
current. The mutation harness is a separate job because it takes minutes rather
than seconds, and it now runs every mutation. It excluded
`s3-truncated-listing-accepted` by name for a while — under that mutation the S3
listing loop never terminated, outlived the test that timed out on it, and hung
the run about one time in six. Bounding the listing loop at a request count
fixed the mutation as well as the code: a check that decides whether to
*continue* cannot be broken safely unless something outside it stops the loop.

## License

MIT. See `LICENSE`.

## Not built

Dependency recording, the fingerprint cache, the `dep_key` reverse index, and
projection-dependent aggregates are shelved by the gate. The fan-out harness
stays in `bench/` — it is the instrument that would say when scale finally
justifies revisiting.

Sync tuning (Phase 2d) turned out to be already built: page size is a caller
option, delta pull runs off a persisted watermark, and the full-ID reconcile
scan catches deletes — all three landed inside the Phase 1 sync driver and are
tested there. What it left undone was *tuning against a real network*, and
`bench/run-adapters.ts` closes that: the page-size lever and the deploy diff's
listing cost are now measured against real services across a swept round-trip
time rather than modelled from a mock on localhost.

What remains genuinely unmeasured is a **hosted** service — real auth against a
real identity provider, a real provider's rate limits, a real replica's lag, and
a real CDN purge. Every failure the local stack injects is one that was
anticipated, and anticipated failures are the ones already handled.
