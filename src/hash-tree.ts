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

/** Every regular file under `dir`, depth-first, sorted by name at each level. */
function walk(dir: string, visit: (abs: string, rel: string) => void) {
  if (!existsSync(dir)) return
  const rec = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) rec(p)
      else visit(p, relative(dir, p).split(sep).join('/'))
    }
  }
  rec(dir)
}

/** Content digest of every file in the tree. Reads every byte. */
export function hashTree(dir: string, algorithm = 'sha256'): TreeDigests {
  const out: TreeDigests = new Map()
  walk(dir, (abs, rel) => {
    out.set(rel, createHash(algorithm).update(readFileSync(abs)).digest('hex'))
  })
  return out
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

/**
 * File count and total size, reading no content.
 *
 * The cheap half of hashing, used by the build seal: it costs one stat per file
 * (tens of milliseconds at 24k routes) and still binds the seal to the actual
 * size of what was emitted, so a truncated or half-written tree does not pass
 * for a complete one.
 */
export function statTree(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  walk(dir, (abs) => {
    files++
    bytes += statSync(abs).size
  })
  return { files, bytes }
}
