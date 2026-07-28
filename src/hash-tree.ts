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
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { RailError } from './rails.ts'

/** Forward-slashed path relative to the tree root -> content digest. */
export type TreeDigests = Map<string, string>

/**
 * Every regular file under `dir`, depth-first, sorted by name at each level.
 *
 * Uses readdir's dirent types rather than a stat per entry. The difference is
 * one syscall per file against two, which is noise on a demo and is not on a
 * 24,000-route site where this runs on every build (the seal) and again on
 * every deploy.
 *
 * **A tree here is regular files and directories.** Anything else is refused by
 * name, and a symlink is the case that matters: this walk defines what the seal
 * binds and what the deploy publishes, so following one would put bytes in both
 * that the tree does not own. A file link's target can change without anything
 * under the root being touched, which makes the seal disagree with a build that
 * did nothing wrong; a directory link is worse, because one of them publishes an
 * arbitrary subtree of the filesystem under a path in the site. planOutputs()
 * stopped a route writing outside the output tree, and this is the same hazard
 * from the other end -- nothing stopped the deploy reading outside it.
 *
 * Refusing is cheap here for a reason that is about this tree rather than about
 * symlinks: nothing in this pipeline creates one. Asset derivatives are
 * hardlinked (src/assets.ts, with a copy fallback), the build lock hardlinks its
 * staged file, and the renderer writes files. A site that wants linked content
 * in its output copies it instead, and the refusal says so.
 *
 * The root is exempt, deliberately. `dir` is the path the caller named rather
 * than something the build produced, and pointing --out at a symlinked volume is
 * a decision somebody made at the command line. The rule is about what turns up
 * *inside* a tree the build owns.
 */
function walk(dir: string, visit: (abs: string, rel: string) => void) {
  if (!existsSync(dir)) return
  const rec = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const p = join(d, e.name)
      const rel = () => relative(dir, p).split(sep).join('/')
      if (e.isDirectory()) {
        rec(p)
        continue
      }
      if (e.isFile()) {
        visit(p, rel())
        continue
      }
      // Neither, so this is a symlink -- or a dirent whose type the filesystem
      // declined to report, which some network and fuse mounts do and which
      // makes every is*() answer false, isSymbolicLink() included. One lstat
      // settles both, and it is lstat rather than stat so the answer is about
      // this entry instead of about whatever it points at. Only an entry that is
      // already unusual pays for it; the per-file syscall count above is
      // unchanged.
      //
      // lstat carries no mutation, on purpose, and is pinned by a test instead:
      // the broken-link case passes only with lstat, because stat throws ENOENT
      // before anything here can classify the entry. A mutation swapping the two
      // would die on an unresolved import rather than on a missed defect, which
      // is a kill for the wrong reason and worth less than the test.
      const st = lstatSync(p)
      if (st.isSymbolicLink()) {
        throw new RailError(
          'tree.symlink',
          true,
          `${rel()} is a symbolic link, and a tree this build seals and deploys is regular files ` +
          `and directories. Following it would seal and publish bytes that live outside the tree ` +
          `— for a directory link, an arbitrary amount of them. Copy the content in instead.`,
        )
      }
      if (st.isDirectory()) {
        rec(p)
        continue
      }
      if (!st.isFile()) {
        // A FIFO reaches readFileSync and blocks there, so the build stops with
        // no error and no output -- the failure mode this project's own harness
        // notes call worse than a crash. Sockets and device nodes are the same
        // shape with different endings.
        throw new RailError(
          'tree.entry',
          true,
          `${rel()} is not a regular file or a directory, and a tree this build seals and deploys ` +
          `is only those. Reading it would block or fail somewhere with less context than here.`,
        )
      }
      visit(p, rel())
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
