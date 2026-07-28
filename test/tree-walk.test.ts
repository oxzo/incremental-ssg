// What counts as a tree, and what the walk refuses to call one.
//
// scanTree defines two things at once: what the build seal binds, and what the
// deploy publishes. So "which entries are in the tree" is not a detail of a
// helper -- it is the definition both of those rest on, and every case here is
// one an output directory can contain without anything in the pipeline having
// put it there.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanTree } from '../src/hash-tree.ts'
import { RailError } from '../src/rails.ts'

const roots: string[] = []
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A tree with one real page in it, plus whatever the case adds. */
const tree = (build: (out: string, base: string) => void) => {
  const base = mkdtempSync(join(tmpdir(), 'issg-tree-'))
  roots.push(base)
  const out = join(base, 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'index.html'), '<h1>real</h1>')
  build(out, base)
  return out
}

const refuses = (out: string, rail: string, message: RegExp) =>
  assert.throws(
    () => scanTree(out, ['sha256']),
    (e: unknown) => e instanceof RailError && e.rail === rail && e.terminal && message.test(e.message),
  )

describe('tree walk — what is refused', () => {
  /**
   * Measured before this rail existed: hashed and counted, so its bytes went
   * into the seal and the deploy uploaded them under the link's path. The seal
   * then describes content the tree does not own, and that content can change
   * without anything under the root being touched -- so the deploy's drift
   * refusal fires for a build that did nothing wrong.
   */
  test('refuses a symlink to a file outside the tree, and names it', () => {
    const out = tree((out, base) => {
      writeFileSync(join(base, 'outside.txt'), 'bytes that live outside the tree')
      symlinkSync(join(base, 'outside.txt'), join(out, 'linked.txt'))
    })
    refuses(out, 'tree.symlink', /^linked\.txt is a symbolic link/)
  })

  /**
   * The one with reach. Measured before this rail existed: recursed, so an
   * entire foreign tree was sealed and published under a path in the site. One
   * link is an arbitrary subtree of the filesystem on a public bucket.
   *
   * planOutputs() closed this from the other end -- a route cannot write outside
   * the output tree -- and nothing stopped the deploy reading outside it.
   */
  test('refuses a symlink to a directory rather than publishing an arbitrary subtree', () => {
    const out = tree((out, base) => {
      const elsewhere = join(base, 'elsewhere')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'private.txt'), 'not part of the site')
      symlinkSync(elsewhere, join(out, 'sub'))
    })
    refuses(out, 'tree.symlink', /^sub is a symbolic link/)
  })

  /**
   * This is also what pins lstat over stat. stat throws ENOENT on a dangling
   * link before the walk can classify the entry, which is how this case used to
   * end: a raw filesystem error from the middle of a walk, naming a path the
   * caller never wrote.
   */
  test('refuses a broken symlink as a symlink, not as a missing file', () => {
    const out = tree((out, base) => symlinkSync(join(base, 'nothing-here'), join(out, 'dangling.txt')))
    refuses(out, 'tree.symlink', /^dangling\.txt is a symbolic link/)
  })

  /**
   * Reading the old code says infinite recursion; the kernel's own
   * symlink-resolution limit got there first and it died with ELOOP. Recorded
   * because the difference is the whole reason the four cases were measured
   * rather than reasoned about.
   */
  test('refuses a symlink cycle at the link instead of resolving into one', () => {
    const out = tree((out) => symlinkSync(out, join(out, 'loop')))
    refuses(out, 'tree.symlink', /^loop is a symbolic link/)
  })

  /**
   * A socket rather than a FIFO because a test can create one without shelling
   * out; they take the same branch. The FIFO is the motivating case: readFileSync
   * on one blocks forever, so the build stops with no error and no output, which
   * is the result this project's harness notes call worse than a crash.
   */
  test('refuses an entry that is neither a regular file nor a directory', async () => {
    const server = createServer()
    const out = tree(() => {})
    await new Promise<void>((r) => server.listen(join(out, 'sock'), () => r()))
    try {
      refuses(out, 'tree.entry', /^sock is not a regular file or a directory/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('tree walk — what is not refused', () => {
  /**
   * The negative control that makes the policy affordable. The asset stage
   * hardlinks every referenced derivative from the persistent cache into the
   * output, so a rule that caught hardlinks would refuse this project's own
   * builds. A hardlink is a second name for one inode and readdir reports it as
   * a regular file, which is why "refuse links" had to mean symlinks and had to
   * be checked rather than assumed.
   */
  test('accepts a hardlink, which is how every asset derivative gets into the output', () => {
    const out = tree((out, base) => {
      writeFileSync(join(base, 'derivative.avif'), 'pretend this is an encode')
      linkSync(join(base, 'derivative.avif'), join(out, 'assets.avif'))
    })
    const scan = scanTree(out, ['sha256'])
    assert.deepEqual([...scan.digests[0].keys()].sort(), ['assets.avif', 'index.html'])
  })

  /**
   * The stated boundary. The root is the path the caller named, not something
   * the build produced, and pointing --out at a symlinked volume is a decision
   * somebody made at the command line. Left working on purpose, and tested so
   * that "the rule is about entries inside the tree" is a fact rather than an
   * intention.
   */
  test('accepts a root that is itself a symlink, because the caller named it', () => {
    const out = tree(() => {})
    const alias = `${out}-alias`
    roots.push(alias)
    symlinkSync(out, alias)
    assert.equal(scanTree(alias, ['sha256']).files, 1)
  })

  test('walks an ordinary tree unchanged', () => {
    const out = tree((out) => {
      mkdirSync(join(out, 'posts'))
      writeFileSync(join(out, 'posts', 'a.html'), 'a')
    })
    const scan = scanTree(out, ['sha256'])
    assert.equal(scan.files, 2)
    assert.deepEqual([...scan.digests[0].keys()].sort(), ['index.html', 'posts/a.html'])
  })
})
