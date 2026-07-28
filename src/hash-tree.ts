// Content fingerprint of a directory tree.
//
// This started life in test/fixture.ts as the direct test of success criterion
// 1 -- "output is a pure function of content plus code" -- and it is also
// exactly the primitive the deploy diff needs. Two implementations of "hash the
// output tree" in one repository is how they drift, so there is one, and it
// lives here rather than in the test scaffolding that happened to need it first.
//
// The algorithm is a parameter because the comparison has to be apples to
// apples with whatever the deploy target's listing reports. S3-style ETags are
// md5 for single-part uploads; hashing our side with sha256 and comparing
// against that would report every object as modified, forever.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Forward-slashed path relative to the tree root -> content digest. */
export type TreeDigests = Map<string, string>

/**
 * Every regular file under `dir`, depth-first, sorted by name at each level.
 *
 * Uses readdir's dirent types rather than a stat per entry. The difference is
 * one syscall per file against two, which is noise on a demo and is not on a
 * 24,000-route site where this runs on every build (the seal) and again on
 * every deploy.
 */
function walk(dir: string, visit: (abs: string, rel: string) => void) {
  if (!existsSync(dir)) return
  const rec = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const p = join(d, e.name)
      // A symlink reports neither isDirectory nor isFile, so it falls through to
      // the stat below rather than being silently skipped or silently followed.
      if (e.isDirectory()) rec(p)
      else if (e.isFile()) visit(p, relative(dir, p).split(sep).join('/'))
      else if (statSync(p).isDirectory()) rec(p)
      else visit(p, relative(dir, p).split(sep).join('/'))
    }
  }
  rec(dir)
}

export type TreeScan = {
  files: number
  bytes: number
  /** One digest map per requested algorithm, in the order they were asked for. */
  digests: TreeDigests[]
}

/**
 * Everything a caller can learn from reading the tree, in one pass over it.
 *
 * Multiple algorithms because the deploy needs two and the bytes should only be
 * read once. The diff compares against whatever the target's listing reports --
 * md5, for S3-style ETags -- while the build seal is always sha256, because the
 * build writes the seal without knowing which target will consume it. Hashing
 * the same buffer twice is CPU on bytes already in hand; walking the tree twice
 * is a second full read.
 *
 * `bytes` comes from the buffer rather than a stat, which also removes the
 * second syscall per file that the old stat-only walk paid.
 */
export function scanTree(dir: string, algorithms: string[]): TreeScan {
  const digests: TreeDigests[] = algorithms.map(() => new Map())
  let files = 0
  let bytes = 0
  walk(dir, (abs, rel) => {
    const body = readFileSync(abs)
    files++
    bytes += body.byteLength
    for (let i = 0; i < algorithms.length; i++) {
      digests[i].set(rel, createHash(algorithms[i]).update(body).digest('hex'))
    }
  })
  return { files, bytes, digests }
}

/** Content digest of every file in the tree. Reads every byte. */
export function hashTree(dir: string, algorithm = 'sha256'): TreeDigests {
  return scanTree(dir, [algorithm]).digests[0]
}

/**
 * One value standing for a whole tree: which files exist, and what is in them.
 *
 * Folded from a digest map the caller already has, so proving a tree matches
 * costs no extra read. Paths are included and the lines are sorted, so a file
 * renamed to another with identical content changes the value, and the walk
 * order does not.
 *
 * This is what the build seal binds. Before it, the seal recorded file count and
 * total size -- which proves a tree was not truncated and proves nothing about
 * its contents, so any same-size edit after the build passed validation and was
 * published.
 */
export function foldDigests(digests: TreeDigests): string {
  const entries = [...digests].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const h = createHash('sha256')
  for (const [rel, hash] of entries) {
    // Length-prefixed, not separator-joined. The first version of this folded
    // `${rel} ${hash}\n` lines, and a test written to ask whether two trees
    // could produce one value answered yes: {"a": "h1", "b": "h2"} and
    // {"a h1\nb": "h2"} serialise to identical bytes. Contrived as a filename
    // and not contrived as a property -- the whole point of a seal is that one
    // value stands for exactly one tree, and a separator only holds while no
    // path contains it. Byte lengths rather than string lengths because update()
    // writes UTF-8 and `.length` counts UTF-16 units.
    h.update(`${Buffer.byteLength(rel)}:${rel}${Buffer.byteLength(hash)}:${hash}`)
  }
  return h.digest('hex')
}

/**
 * The same tree as sorted `relpath digest` lines.
 *
 * Comparing these between two builds is the byte-identity test. Comparing route
 * counts or spot-checking a page would pass while a footer timestamp quietly
 * made every file differ -- which is exactly the failure the deploy diff cannot
 * survive, because it degrades silently to a full-site upload rather than
 * breaking.
 */
export function fingerprint(dir: string, algorithm = 'sha256'): string[] {
  return [...hashTree(dir, algorithm)].map(([rel, hash]) => `${rel} ${hash}`).sort()
}

// `statTree` used to live here: file count and total size, reading no content.
// It was the cheap half of hashing, and it was what the build seal bound -- one
// stat per file, no reads, and no evidence about what any of those bytes were.
// Gone with the seal that needed it. Both callers now take the full scan, and
// keeping a stat-only walk beside it would be a second answer to "what is in
// this tree" that nothing checks against the first.
