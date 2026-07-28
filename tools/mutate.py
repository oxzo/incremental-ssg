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
        "const pageSize = Math.min(opts.pageSize ?? 1000, 1000)",
        "const pageSize = opts.pageSize ?? 1000",
        "the ListObjectsV2 API caps MaxKeys at 1000 regardless of what is asked",
        "test/deploy-s3.test.ts",
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
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    selected = [m for m in MUTATIONS if args.filter in m.id]
    if args.list:
        for m in selected:
            print(f"{m.id:34s} {m.path:24s} {m.why}")
        return 0

    survivors = []
    for i, m in enumerate(selected, 1):
        killed, note = run(m)
        # A hang is not a survival and must not read like one. Survived means the
        # suite ran and noticed nothing; hung means it never finished, which is
        # usually a leaked handle or an unbounded wait in the *test*, and is
        # fixed somewhere completely different.
        if killed:
            mark = "\033[32m kill \033[0m"
        elif note.startswith("HUNG"):
            mark = "\033[33m HUNG \033[0m"
        else:
            mark = "\033[31m SURVIVED \033[0m"
        print(f"[{i:2d}/{len(selected)}] {mark} {m.id}")
        if not killed:
            print(f"          {note}: {m.why}")
            survivors.append(m)

    print()
    if survivors:
        print(f"{len(survivors)} of {len(selected)} mutations survived -- those lines are unprotected:")
        for m in survivors:
            print(f"  {m.id}  ({m.path})")
        return 1
    print(f"all {len(selected)} mutations killed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
