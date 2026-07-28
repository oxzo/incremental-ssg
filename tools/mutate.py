#!/usr/bin/env python3
"""Break each rail in turn and check that a test notices.

Rebuilt from scratch three times in this project before someone committed it.
The argument for it is in the notes: "it passed" and "it can detect the defect"
are different claims, and only the second one is evidence. A green suite that
has never been observed failing has unmeasured failure behaviour -- and this
project has twice had a green concurrency test that could not detect the bug it
was written for.

Each mutation is a literal string swap in a source file. Applying it must make
at least one test fail; a mutation that survives is printed as SURVIVED and is
the actionable output -- it means that line is unprotected.

    python3 tools/mutate.py                 # every mutation
    python3 tools/mutate.py --filter s3     # only mutations whose id matches
    python3 tools/mutate.py --list          # show them without running
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Generous enough for a slow suite, short enough that a hang is diagnosed rather
# than waited out. A mutation that needs longer than this is a hang, not a test.
TIMEOUT = 90


@dataclass
class Mutation:
    id: str
    path: str
    old: str
    new: str
    why: str
    tests: str


MUTATIONS: list[Mutation] = [
    # --- the Directus adapter -------------------------------------------------
    Mutation(
        "cms-delta-single-column",
        "src/cms-directus.ts",
        "return { _or: [{ date_created: { _gt: at } }, { date_updated: { _gt: at } }] }",
        "return { date_updated: { _gt: at } }",
        "filtering on date_updated alone silently misses every newly created document",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-keyset-ignores-cursor",
        "src/cms-directus.ts",
        "const keyset = { seq: { _gt: seq } }",
        "const keyset = { seq: { _gt: 0 } }",
        "a cursor that does not advance re-reads page one forever",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-blank-doc-id-allowed",
        "src/cms-directus.ts",
        "if (typeof id !== 'string' || id === '') {\n      // The one shape",
        "if (false) {\n      // The one shape",
        "a blank doc_id collapses every such document onto one store row",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-retry-after-uncapped",
        "src/cms-directus.ts",
        "? Math.min(Math.max(wait, 0), maxRetryAfterMs)",
        "? Math.max(wait, 0)",
        "an upstream Retry-After of an hour stalls publishing for an hour",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-4xx-retried",
        "src/cms-directus.ts",
        "throw new RailError('cms.request', true, `${res.status} ${res.statusText} on ${path}: ${detail}`)",
        "throw new RailError('cms.request', false, `${res.status} ${res.statusText} on ${path}: ${detail}`)",
        "retrying a 403 is a loop that looks busy and never publishes",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-bad-credentials-retried",
        "src/cms-directus.ts",
        "throw new RailError('cms.auth', true, `login failed: ${res.status} ${res.statusText}`)",
        "throw new RailError('cms.auth', false, `login failed: ${res.status} ${res.statusText}`)",
        "wrong credentials do not improve with retrying",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-envelope-not-stripped",
        "src/cms-directus.ts",
        "for (const [k, v] of Object.entries(row)) if (!ENVELOPE.has(k)) doc[k] = v",
        "for (const [k, v] of Object.entries(row)) doc[k] = v",
        "timestamps in the body make a touch look like a content change",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-revision-array-unhandled",
        "src/cms-directus.ts",
        "const first = Array.isArray(docs) ? docs[0] : docs",
        "const first = docs",
        "a multi-key update delivers an array where a single-key one delivers an object",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-cursor-reset-on-garbage",
        "src/cms-directus.ts",
        "throw new RailError('cms.cursor', true, `unparseable cursor ${JSON.stringify(cursor)}`)",
        "return { index: 0, seq: 0 }",
        "silently restarting on a bad cursor turns one bug into an infinite sync",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "cms-no-retry",
        "src/cms-directus.ts",
        "const attempts = Math.max(1, opts.attempts ?? 4)",
        "const attempts = 1",
        "a single transient 500 fails the whole sync",
        "test/cms-directus.test.ts",
    ),
    # --- the S3 deploy target -------------------------------------------------
    Mutation(
        "s3-multipart-etag-trusted",
        "src/deploy-s3.ts",
        "return /^[0-9a-f]{32}$/i.test(clean) ? clean.toLowerCase() : undefined",
        "return clean.toLowerCase()",
        "a multipart ETag can never equal a local md5, so the object re-uploads forever",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-truncated-listing-accepted",
        "src/deploy-s3.ts",
        "        if (token === undefined) {\n          throw new RailError(",
        "        if (false) {\n          throw new RailError(",
        "exiting on a missing continuation token reports a short listing as complete",
        "test/deploy-s3.test.ts",
    ),
    # The three mutations below are why the listing loop has a request cap. The
    # first two break a check that decides whether to *continue*, so without a
    # bound that outlives them the harness gets a hang rather than a failure --
    # which is what s3-truncated-listing-accepted did for the whole of Tier A,
    # and why CI excluded it by name. Each of these three now stops in single
    # digits of requests.
    Mutation(
        "s3-repeated-token-accepted",
        "src/deploy-s3.ts",
        "        if (issued.has(token)) {",
        "        if (false) {",
        "a token the server re-issues asks for a page it has already answered, and nothing else in the loop can see it",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-listing-unbounded",
        "src/deploy-s3.ts",
        "        if (requests === maxListRequests) {",
        "        if (false) {",
        "the only bound in the listing loop that does not depend on another check in it being right",
        "test/deploy-s3.test.ts",
    ),
    # The classification, not the check. The cap is the one refusal here whose
    # terminal bit is a judgement rather than a reading: it cannot tell a bucket
    # that really is that large (terminal in fact) from a listing that is looping
    # (transient), so the choice between them is pinned by a test rather than
    # left to whoever edits the line next.
    Mutation(
        "s3-listing-cap-terminal",
        "src/deploy-s3.ts",
        "            false,\n            `bucket listing did not end within",
        "            true,\n            `bucket listing did not end within",
        "a service that halts on this waits for a human over what is most likely a server's bad minute",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-delete-errors-ignored",
        "src/deploy-s3.ts",
        "if (errors.length > 0) {",
        "if (false) {",
        "S3 reports per-key delete failures inside a 200; ignoring them records deletions that did not happen",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-delete-chunk-too-large",
        "src/deploy-s3.ts",
        "for (let i = 0; i < paths.length; i += 1000) {\n        const chunk = paths.slice(i, i + 1000)",
        "for (let i = 0; i < paths.length; i += 10000) {\n        const chunk = paths.slice(i, i + 10000)",
        "DeleteObjects caps at 1000 keys per request",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-directory-markers-kept",
        "src/deploy-s3.ts",
        "if (o.Key.endsWith('/')) continue",
        "if (false) continue",
        "a zero-byte directory marker matches no local file and is deleted every deploy",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-wrong-digest-algorithm",
        "src/deploy-s3.ts",
        "digestAlgorithm: 'md5'",
        "digestAlgorithm: 'sha256'",
        "hashing locally with sha256 against md5 ETags reports every object modified",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-claims-path-purge",
        "src/deploy-s3.ts",
        "      pathPurge: false,",
        "      pathPurge: true,",
        "claiming a purge capability that does nothing reports success for a step that never ran",
        "test/deploy-s3.test.ts",
    ),
    Mutation(
        "s3-page-size-uncapped",
        "src/deploy-s3.ts",
        "Math.min(\n    checkNumber(opts.pageSize, 1000, { name: 'pageSize', min: 1, integer: true }),\n    1000,\n  )",
        "checkNumber(opts.pageSize, 1000, { name: 'pageSize', min: 1, integer: true })",
        "the ListObjectsV2 API caps MaxKeys at 1000 regardless of what is asked",
        "test/deploy-s3.test.ts",
    ),
    # The shape this line had before, which is the shape A2 named and this
    # subsystem kept: a clamp is transparent to NaN, so it reads as a validation
    # and is not one.
    Mutation(
        "s3-page-size-nan-accepted",
        "src/deploy-s3.ts",
        "checkNumber(opts.pageSize, 1000, { name: 'pageSize', min: 1, integer: true })",
        "(opts.pageSize ?? 1000)",
        "MaxKeys: NaN lists zero objects and reports the listing complete, which the diff answers with a full re-upload",
        "test/deploy-s3.test.ts",
    ),
    # --- the crash window inside sync ------------------------------------------
    #
    # Not covered here, deliberately: the *ordering* of the watermark write and
    # the marker clear, and of the dirty flag against sync's clear of the marker.
    # Both are one-statement windows, and this project has already learned once
    # that a race test sampling tens of draws across a microsecond window
    # certifies nothing (see the build-lock note). Those two are justified by
    # construction and their source comments say so rather than implying a
    # coverage that does not exist. What is mutated below is the part a test can
    # actually observe: whether the marker is written, cleared, and read at all.
    Mutation(
        "sync-mutating-never-set",
        "src/sync.ts",
        "    if (batch.length > 0 || unwanted.length > 0) markMutating()",
        "    if (false) markMutating()",
        "a sync that dies mid-write leaves no record, so the restart's own 'nothing changed' is believed and the publish is lost",
        "test/sync.test.ts",
    ),
    Mutation(
        "sync-mutating-never-cleared",
        "src/sync.ts",
        "  store.setMeta(SYNC_MUTATING, '0')",
        "  store.setMeta(SYNC_MUTATING, '1')",
        "a marker a completed sync never clears trades one lost publish for a rebuild on every poll forever",
        "test/sync.test.ts",
    ),
    Mutation(
        "service-ignores-sync-marker",
        "src/service.ts",
        "        dirty = report.dirtyOnEntry || report.syncInterrupted",
        "        dirty = report.dirtyOnEntry",
        "sync records the interrupted write and the pipeline skips anyway, which is the whole defect with an extra step",
        "test/service.test.ts",
    ),
    # --- numbers that failed to parse -----------------------------------------
    #
    # These matter more than their size suggests. Every limit in this codebase is
    # a comparison, and every comparison against NaN is false, so one unparsed
    # option does not fail loudly -- it removes a rail while everything reports
    # success. Each mutation below restores the exact shape the code had before.
    Mutation(
        "numbers-nan-accepted",
        "src/rails.ts",
        "    Number.isFinite(value) &&",
        "    true &&",
        "NaN reaching a threshold turns every comparison enforcing it false, which reads as no limit",
        "test/numeric-guards.test.ts",
    ),
    Mutation(
        "numbers-range-ignored",
        "src/rails.ts",
        "    value >= o.min &&",
        "    true &&",
        "a zero worker count or a negative delete ratio is a policy nobody chose, arriving silently",
        "test/numeric-guards.test.ts",
    ),
    Mutation(
        "cli-number-unvalidated",
        "src/cli.ts",
        '  if (!Number.isFinite(n)) fail(`--${flag} must be a number, got "${raw}"`)',
        "  if (false) fail(`--${flag} must be a number`)",
        "the original defect: a typo in a numeric flag reaches the rails as NaN instead of being refused",
        "test/numeric-guards.test.ts",
    ),
    # --- the build seal, and what it binds ------------------------------------
    Mutation(
        "seal-binds-only-size",
        "src/deploy.ts",
        "  if (actual !== seal.digest) {",
        "  if (scan.files !== seal.files || scan.bytes !== seal.bytes) {",
        "the shape this replaced: any post-build edit preserving the total size validates and is published",
        "test/deploy.test.ts",
    ),
    Mutation(
        "seal-fold-ignores-paths",
        "src/hash-tree.ts",
        "    h.update(`${Buffer.byteLength(rel)}:${rel}${Buffer.byteLength(hash)}:${hash}`)",
        "    h.update(`${Buffer.byteLength(hash)}:${hash}`)",
        "a tree holding the same bytes under different names would fold to the same seal value",
        "test/deploy.test.ts",
    ),
    Mutation(
        "seal-fold-order-dependent",
        "src/hash-tree.ts",
        "  const entries = [...digests].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))",
        "  const entries = [...digests]",
        "a seal that depends on walk order is a seal that disagrees with itself when the filesystem reorders",
        "test/deploy.test.ts",
    ),
    # --- what counts as a tree -------------------------------------------------
    #
    # The walk in hash-tree.ts defines both what the seal binds and what the
    # deploy publishes, so these two lines are the definition rather than a
    # detail of a helper. Not mutated, and said so in the source: lstat over
    # stat. Swapping them would break the import and kill on an unresolved name
    # rather than on a missed defect, which is a kill for the wrong reason. The
    # broken-symlink test pins it instead -- stat throws ENOENT there before
    # anything can classify the entry.
    Mutation(
        "tree-symlink-followed",
        "src/hash-tree.ts",
        "      if (st.isSymbolicLink()) {",
        "      if (false) {",
        "one directory symlink in the output seals and publishes an arbitrary subtree of the filesystem",
        "test/tree-walk.test.ts",
    ),
    Mutation(
        "tree-nonregular-accepted",
        "src/hash-tree.ts",
        "      if (!st.isFile()) {",
        "      if (false) {",
        "readFileSync on a FIFO blocks forever, so the build stops with no error and no output",
        "test/tree-walk.test.ts",
    ),
    # --- what --clean is allowed to delete -------------------------------------
    #
    # Mutated through checkCleanScope, which deletes nothing. Breaking a rail
    # whose subject is rm -rf has to be safe to do on purpose, or the harness
    # becomes the most dangerous thing in the repository.
    Mutation(
        "clean-scope-unchecked",
        "src/build.ts",
        "    if (!isInside(root, p)) continue",
        "    if (true) continue",
        "the shape this replaced: --clean is rm -rf on a caller-supplied path with nothing between it and the disk",
        "test/clean-scope.test.ts",
    ),
    Mutation(
        "clean-scope-root-slips",
        "src/rails.ts",
        "  return c.startsWith(p.endsWith(sep) ? p : p + sep)",
        "  return c.startsWith(p + sep)",
        "'/' + sep is '//' and matches nothing, so the single most destructive argument is the one that passes",
        "test/clean-scope.test.ts",
    ),
    # --- content type transitions ---------------------------------------------
    Mutation(
        "sync-type-not-in-identity",
        "src/sync.ts",
        "      if (known.get(key) !== documentIdentity(item.type, hash)) changed++",
        "      if (known.get(key) !== documentIdentity('', hash)) changed++",
        "comparing content alone reports a document that changed type as unchanged, and routes are resolved per type",
        "test/sync.test.ts",
    ),
    Mutation(
        "sync-keeps-unrendered-type",
        "src/sync.ts",
        "        if (known.has(key)) unwanted.push({ type: item.type, id: item.id })",
        "        if (false) unwanted.push({ type: item.type, id: item.id })",
        "a document moved out of scope keeps its stored row, which no reconcile path can see, and its page stays published",
        "test/sync.test.ts",
    ),
    # --- the route plan: containment, collisions, and cross-worker identity ----
    #
    # The four path rules are ordered so each one rejects something the others do
    # not, which is what makes all four killable here. An earlier draft put the
    # ".." rule ahead of the containment check; it caught every real traversal
    # first, and the containment line -- the actual invariant -- became
    # unreachable, present and untestable at once. The mutation that would have
    # exposed that is `route-containment-off`.
    Mutation(
        "route-containment-off",
        "src/render.ts",
        "    if (full === root || !full.startsWith(prefix)) bad('resolves outside the output directory')",
        "    if (false) bad('resolves outside the output directory')",
        "a CMS slug containing '..' becomes a filesystem write outside the output tree, which no later stage sees",
        "test/route-plan.test.ts",
    ),
    Mutation(
        "route-dotdot-allowed",
        "src/render.ts",
        "    if (p.split('/').includes('..')) bad('contains a \"..\" segment')",
        "    if (false) bad('contains a \"..\" segment')",
        "an in-tree '..' names a file it does not look like, and collides with the route that spells it plainly",
        "test/route-plan.test.ts",
    ),
    Mutation(
        "route-backslash-allowed",
        "src/render.ts",
        "    if (p.includes('\\\\')) bad('contains a backslash')",
        "    if (false) bad('contains a backslash')",
        "a backslash is a separator on Windows and a filename character on POSIX, so the same site emits two trees",
        "test/route-plan.test.ts",
    ),
    Mutation(
        "route-duplicates-allowed",
        "src/render.ts",
        "    if (prior !== undefined) {",
        "    if (false) {",
        "two routes writing one file both count as rendered while one silently overwrites the other",
        "test/route-plan.test.ts",
    ),
    Mutation(
        "workers-compare-counts",
        "src/build.ts",
        "    const digests = [...new Set(done.map((d) => d.digest))]",
        "    const digests = [...new Set(done.map((d) => String(d.routes)))]",
        "the shape this replaced: two workers resolving different route sets of equal length agree and the build ships the mixture",
        "test/route-plan.test.ts",
    ),
    # --- the second destructive path, and three rails that were simply absent --
    #
    # From an external review's second pass. The asset one is the dangerous one:
    # the garbage collector deletes everything in its cache that this build did
    # not produce, so a cache pointed at the sources deletes the originals --
    # reproduced at three PNGs, all three gone, stage reporting success.
    Mutation(
        "assets-overlapping-roots-allowed",
        "src/assets.ts",
        "  checkDisjointRoots([",
        "  if (false) checkDisjointRoots([",
        "a derivative cache pointing at the source directory deletes the user's original images, which cannot be regenerated",
        "test/clean-scope.test.ts",
    ),
    Mutation(
        "roots-prefix-unseparated",
        "src/rails.ts",
        "  return c.startsWith(p.endsWith(sep) ? p : p + sep)",
        "  return c.startsWith(p)",
        "/site/img-cache reads as inside /site/img, so both scope rails fire on layouts that were doing nothing wrong",
        "test/clean-scope.test.ts",
    ),
    Mutation(
        "cli-sync-locks-the-wrong-dir",
        "src/cli.ts",
        "await withLock(dirname(dbPath), { label: 'cli sync'",
        "await withLock(dirname(dirname(dbPath)), { label: 'cli sync'",
        "sync mutates the store and flips its journal mode while a build's workers hold the same file open",
        "test/serve-cli.test.ts",
    ),
    Mutation(
        "service-force-unlock-persists",
        "src/service.ts",
        "    forceUnlockRemaining = false",
        "    forceUnlockRemaining = true",
        "a one-time lock rescue becomes a standing licence to steal the lock from a live writer, for the life of the process",
        "test/service.test.ts",
    ),
    Mutation(
        "service-stop-leaves-pending",
        "src/service.ts",
        "      if (pending !== null) {",
        "      if (false) {",
        "a stop with queued work never settles, so idle() waits forever and status() reports pending on a stopped service",
        "test/service.test.ts",
    ),
    Mutation(
        "determinism-skips-routes",
        "src/build.ts",
        "  const routes = runDeterministic('site.routes()', () => cfg.routes(site), mode)",
        "  const routes = cfg.routes(site)",
        "a clock read in routes() changes which pages exist, so a single-worker build seals a different tree every time",
        "test/build.test.ts",
    ),
    # --- (type, id) is what identifies a document ------------------------------
    #
    # `id` alone was the primary key, and a multi-collection CMS makes that a
    # collision rather than a key. Each of these restores one half of the old
    # behaviour; the first two are the bug itself, and the rest are the places
    # that had to learn the new key and could silently keep using the old one.
    Mutation(
        "store-key-is-id-alone",
        "src/store.ts",
        "        PRIMARY KEY (type, id)",
        "        PRIMARY KEY (id)",
        "two collections sharing a doc_id overwrite each other, and keep doing it on every sync forever",
        "test/store.test.ts",
    ),
    Mutation(
        "store-upsert-conflicts-on-id",
        "src/store.ts",
        "       ON CONFLICT(type,id) DO UPDATE SET",
        "       ON CONFLICT(id) DO UPDATE SET",
        "the upsert resolves against the wrong uniqueness, so a document with a shared id replaces the other type's row",
        "test/store.test.ts",
    ),
    Mutation(
        "store-identities-keyed-by-id",
        "src/store.ts",
        "    for (const r of rows) out.set(documentKey(r.type, r.id), documentIdentity(r.type, r.hash))",
        "    for (const r of rows) out.set(r.id, documentIdentity(r.type, r.hash))",
        "change detection compares against a map keyed differently from the one it is looked up in, so every sync reports every document as changed",
        "test/sync.test.ts",
    ),
    Mutation(
        "sync-reconcile-drops-the-type",
        "src/sync.ts",
        "      deleted += store.deleteMissing(new Set(live.map((l) => documentKey(l.type, l.id))), {",
        "      deleted += store.deleteMissing(new Set(live.map((l) => l.id)), {",
        "a reconcile built from ids alone compares them against (type, id) keys, finds every one missing, and proposes deleting the whole mirror",
        "test/sync.test.ts",
    ),
    Mutation(
        "sync-duplicate-document-accepted",
        "src/sync.ts",
        "      if (seen.has(key)) {",
        "      if (false) {",
        "two documents at one (type, id) silently overwrite each other, which the composite key does not fix and was never meant to",
        "test/sync.test.ts",
    ),
    Mutation(
        "store-revision-ignores-type",
        "src/store.ts",
        "      .prepare('SELECT revision FROM documents WHERE type = ? AND id = ?')\n      .get(type, id) as",
        "      .prepare('SELECT revision FROM documents WHERE id = ?')\n      .get(id) as",
        "the read-after-write check answers for whichever document shares the id, so it reports the mirror caught up when it has not",
        "test/store.test.ts",
    ),
    # --- the listing count, and what it is allowed to claim -------------------
    #
    # CmsPage.total was declared, threaded through, and read by nothing, so none
    # of these lines existed to be broken. The first mutation is the finding; the
    # rest guard the ways a count can be worse than no count at all.
    Mutation(
        "sync-short-listing-accepted",
        "src/sync.ts",
        "  if (expected !== undefined && pulled < expected) {",
        "  if (false) {",
        "a listing that came back short is reconciled as deletions, and the ratio ceiling passes anything under half the mirror",
        "test/sync.test.ts",
    ),
    Mutation(
        "sync-short-listing-two-sided",
        "src/sync.ts",
        "  if (expected !== undefined && pulled < expected) {",
        "  if (expected !== undefined && pulled !== expected) {",
        "a document created while the pull ran makes the count an undercount, so the rail refuses a CMS that behaved correctly",
        "test/sync.test.ts",
    ),
    Mutation(
        "directus-count-is-a-remainder",
        "src/cms-directus.ts",
        "      if (seq === 0) {",
        "      if (true) {",
        "counting every page double-counts a keyset remainder, so total exceeds the pull and sync refuses complete listings",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "directus-missing-count-guessed",
        "src/cms-directus.ts",
        "        else countable = false",
        "        else expected += 0",
        "a response with no meta reports total 0 instead of no total, which reads as an empty CMS rather than an unknown one",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "directus-count-not-reset",
        "src/cms-directus.ts",
        "      if (o.cursor === null) {",
        "      if (false) {",
        "the service reuses one adapter, so the second sync inherits the first's total and refuses a complete pull",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "directus-count-not-requested",
        "src/cms-directus.ts",
        # Anchored on the line above, because listIds() now asks for the same
        # meta one indent deeper -- and this string is a substring of that one.
        "        filter: JSON.stringify(filter),\n        meta: 'filter_count',",
        "        filter: JSON.stringify(filter),\n        meta: '',",
        "the count is never asked for, so every listing reports no total and the completeness check silently does nothing",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "directus-truncated-listing-accepted",
        "src/cms-directus.ts",
        "        if (Number.isFinite(count) && rows.length < count) {",
        "        if (false) {",
        "a server-side listing cap truncates the id listing silently, and deleteMissing reads the missing ids as deletions",
        "test/cms-directus.test.ts",
    ),
    Mutation(
        "directus-truncation-counts-kept-ids",
        "src/cms-directus.ts",
        "        if (Number.isFinite(count) && rows.length < count) {",
        "        if (Number.isFinite(count) && out.length < count) {",
        "rows with an unusable doc_id are dropped on purpose, so counting kept ids refuses a listing that was complete",
        "test/cms-directus.test.ts",
    ),
    # --- draining a pool before reporting that it failed ----------------------
    #
    # Both pools used to reject while their work continued. The tell was not in
    # the code, which reads correctly, but in the effects: a rejected promise
    # says nothing about the threads and runners behind it. Each mutation here
    # restores one half of the old behaviour, and the tests that kill them have
    # to be able to fail by *observing more work than they asked for* -- a shape
    # no assertion on the rejection value can reach.
    Mutation(
        "pool-runs-on-after-failure",
        "src/pool.ts",
        "        if (failed) return",
        "        if (false) return",
        "runners keep pulling after a sibling threw, so the deploy uploads the rest of the list into a live bucket after deploy() reported failure",
        "test/pool.test.ts",
    ),
    Mutation(
        "pool-falsy-throw-ignored",
        "src/pool.ts",
        "        if (failed) return",
        "        if (failure !== undefined) return",
        "a job throwing undefined reads as no-failure-yet, so the pool rejects with undefined having run the whole list anyway",
        "test/pool.test.ts",
    ),
    Mutation(
        "pool-last-failure-wins",
        "src/pool.ts",
        "          if (!failed) {",
        "          if (true) {",
        "a later failure overwrites the first, and the rejection sends a reader to a consequence rather than the cause",
        "test/pool.test.ts",
    ),
    Mutation(
        "build-pool-not-drained",
        "src/build.ts",
        "      await Promise.all(threads.map((wk) => wk.terminate()))",
        "      await Promise.resolve()",
        "surviving workers render on after build() rejected and after the build lock was released, writing into a tree nobody is holding",
        "test/build.test.ts",
    ),
    Mutation(
        "build-drain-loses-the-diagnosis",
        "src/build.ts",
        "      throw e",
        "      throw new Error('the build failed and its worker pool was drained')",
        "the drain replaces the failure that caused it, so the report names the cleanup instead of the bug",
        "test/build.test.ts",
    ),
    # --- the injection proxy, which is test infrastructure that can also lie ---
    Mutation(
        "proxy-truncation-is-a-noop",
        "stack/proxy.ts",
        "  if (n <= 0 || !xml.includes('<ListBucketResult')) return { body: xml, dropped: 0 }",
        "  return { body: xml, dropped: 0 }",
        "a truncation fault that does not truncate makes its test pass for the wrong reason",
        "test/deploy-s3.test.ts",
    ),
]


def run(mutation: Mutation) -> tuple[bool, str]:
    path = ROOT / mutation.path
    original = path.read_text()
    if mutation.old not in original:
        return False, "PATTERN NOT FOUND (mutation is stale)"
    if original.count(mutation.old) > 1:
        return False, "PATTERN AMBIGUOUS (matches more than once)"
    try:
        path.write_text(original.replace(mutation.old, mutation.new, 1))
        try:
            proc = subprocess.run(
                ["node", "--no-warnings", "--test", mutation.tests],
                cwd=ROOT, capture_output=True, text=True, timeout=TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            # Not a kill. A hang means a test leaked a handle instead of
            # reporting a failure -- the suite cannot tell you it detected the
            # defect if it never finishes. This is how the missing after() hooks
            # in these test files were found.
            return False, f"HUNG (no result in {TIMEOUT}s -- a test is leaking a handle)"
        if proc.returncode != 0:
            return True, "killed"
        return False, "SURVIVED"
    finally:
        path.write_text(original)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--filter", default="")
    # Named exclusions, for a mutation known to be unreliable for a reason that
    # is not the line it targets. Nothing uses it as of the bounded listing loop
    # -- s3-truncated-listing-accepted was the one exclusion, CI carried it for
    # the mutated loop's non-termination, and the cap retired it.
    #
    # Kept rather than removed with its user, because the next mutation of this
    # shape wants a named gap and a comment over either a silent skip or a red
    # run that means nothing. It rejects an id matching nothing, so an exclusion
    # that has stopped applying fails loudly instead of quietly excluding
    # nothing.
    ap.add_argument("--exclude", default="", help="comma-separated mutation ids to skip")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    skip = {x.strip() for x in args.exclude.split(",") if x.strip()}
    unknown = skip - {m.id for m in MUTATIONS}
    if unknown:
        # A typo'd exclusion silently excludes nothing, which is the failure mode
        # where CI looks stricter than it is.
        print(f"unknown --exclude id(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    selected = [m for m in MUTATIONS if args.filter in m.id and m.id not in skip]
    if skip:
        print(f"skipping {len(skip)} mutation(s) by name: {', '.join(sorted(skip))}\n")
    if args.list:
        for m in selected:
            print(f"{m.id:34s} {m.path:24s} {m.why}")
        return 0

    survivors = []
    hung = []
    stale = []
    for i, m in enumerate(selected, 1):
        killed, note = run(m)
        # Three ways to not be killed, and they are fixed in three different
        # places, so the summary keeps them apart. Lumping them together is not
        # cosmetic: a real unprotected line hiding among stale patterns is
        # exactly the report nobody reads twice.
        #
        #   SURVIVED -- the suite ran and noticed nothing. The line is unprotected.
        #   HUNG     -- it never finished, usually a leaked handle or an unbounded
        #               wait in the *test*, or a mutated loop that outlives it.
        #   STALE    -- the source moved and the mutation no longer matches
        #               anything. It is testing nothing, and has been since the
        #               edit that moved it.
        if killed:
            mark = "\033[32m kill \033[0m"
        elif note.startswith("HUNG"):
            mark = "\033[33m HUNG \033[0m"
        elif note.startswith("PATTERN"):
            mark = "\033[35m STALE \033[0m"
        else:
            mark = "\033[31m SURVIVED \033[0m"
        print(f"[{i:2d}/{len(selected)}] {mark} {m.id}")
        if not killed:
            print(f"          {note}: {m.why}")
            (hung if note.startswith("HUNG")
             else stale if note.startswith("PATTERN")
             else survivors).append(m)

    print()
    for label, group in (
        ("survived -- those lines are unprotected", survivors),
        ("never finished -- the test leaks a handle or waits unbounded", hung),
        ("no longer match the source -- they have been testing nothing", stale),
    ):
        if group:
            print(f"{len(group)} of {len(selected)} mutations {label}:")
            for m in group:
                print(f"  {m.id}  ({m.path})")
    if survivors or hung or stale:
        return 1
    print(f"all {len(selected)} mutations killed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
