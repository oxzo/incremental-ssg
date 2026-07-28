// What `--clean` is allowed to delete.
//
// clean() is `rm -rf` on a path the caller supplied, and the only thing standing
// between it and the rest of the disk is which path that is. The README has
// carried the rule in prose since Phase 2c -- keep the asset cache outside the
// output directory -- and prose is not somewhere the code can read it.
//
// Every dangerous case here goes through checkCleanScope, which deletes nothing.
// A test that proves `--out /` is refused by calling clean('/') and hoping is a
// test whose failure mode is the filesystem.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCleanScope, clean } from '../src/build.ts'
import { runAssetStage } from '../src/assets.ts'
import { makeImages } from '../example/blog/fixture.ts'
import { checkDisjointRoots, RailError } from '../src/rails.ts'

const roots: string[] = []
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

const refuses = (outDir: string, protect: { label: string; path: string }[], message: RegExp) =>
  assert.throws(
    () => checkCleanScope(outDir, protect),
    (e: unknown) =>
      e instanceof RailError && e.rail === 'build.clean-scope' && e.terminal && message.test(e.message),
  )

describe('clean scope — refused', () => {
  /**
   * The one the README already warns about, in the one place a build cannot
   * consult. Phase 2c measured the cache at 4.23s cold against 33ms warm, and
   * extrapolated 59 minutes against 27s at 20,000 sources -- so this is a
   * convenience flag deleting the entire win of a phase.
   */
  test('refuses to clean an output directory holding the asset cache', () => {
    refuses('/site/dist', [{ label: 'the asset derivative cache', path: '/site/dist/.cache' }],
      /would delete the asset derivative cache/)
  })

  /**
   * Worse than the cache, because there is nothing to regenerate from. The
   * derivatives are a function of these files; these files are not a function of
   * anything.
   */
  test('refuses to clean an output directory holding the asset sources', () => {
    refuses('/site/public', [{ label: 'the asset source directory', path: '/site/public/img' }],
      /would delete the asset source directory/)
  })

  test('refuses to clean an output directory holding the document store', () => {
    refuses('/site/dist', [{ label: 'the document store', path: '/site/dist/content.db' }],
      /would delete the document store/)
  })

  test('refuses to clean an output directory holding the site module', () => {
    refuses('/site', [{ label: 'the site module', path: '/site/site.ts' }], /would delete the site module/)
  })

  test('refuses when the output directory is the protected path itself', () => {
    refuses('/site/cache', [{ label: 'the asset derivative cache', path: '/site/cache' }],
      /would delete the asset derivative cache/)
  })

  /**
   * Not a special case, and that is the point: `--out /` is refused because
   * everything the build needs is inside it, so the general rule already covers
   * the most destructive argument available.
   *
   * It is also the case a naive prefix test gets wrong. `'/' + sep` is `'//'`
   * and matches nothing, which would leave exactly this argument passing.
   */
  test('refuses the root directory, because everything the build needs is under it', () => {
    refuses('/', [{ label: 'the document store', path: '/srv/site/content.db' }], /would delete the document store/)
  })
})

describe('clean scope — allowed', () => {
  /**
   * The normal layout, and the reason the rule is one-directional. `dist` lives
   * inside the site directory in every project that has ever existed; deleting
   * `dist` does not delete the directory containing it. A rule written as
   * "these paths must not overlap" would refuse the default arrangement.
   */
  test('allows an output directory that lives inside the site directory', () => {
    checkCleanScope('/site/dist', [
      { label: 'the site module', path: '/site/site.ts' },
      { label: 'the asset derivative cache', path: '/site/.asset-cache' },
    ])
  })

  /**
   * The prefix has to end at a separator. Without that, `/site/out-cache` reads
   * as inside `/site/out` and a correct layout is refused -- a rail that fires
   * on a build that was doing nothing wrong, which costs more trust than the one
   * it saves.
   */
  test('allows a sibling whose name merely starts with the output directory', () => {
    checkCleanScope('/site/out', [{ label: 'the asset derivative cache', path: '/site/out-cache' }])
  })

  test('deletes the output directory when nothing protected is inside it', () => {
    const base = mkdtempSync(join(tmpdir(), 'issg-clean-'))
    roots.push(base)
    const out = join(base, 'dist')
    mkdirSync(join(out, 'posts'), { recursive: true })
    writeFileSync(join(out, 'posts', 'a.html'), 'a')
    writeFileSync(join(base, 'content.db'), 'not inside the output')

    clean(out, [{ label: 'the document store', path: join(base, 'content.db') }])
    assert.equal(existsSync(out), false, 'the output directory is gone')
    assert.equal(existsSync(join(base, 'content.db')), true, 'and its neighbour is not')
  })
})

// The other destructive path in this pipeline, and the one that reaches files
// `--clean` never could. The asset stage's garbage collector deletes everything
// in its derivative cache that the current build did not produce. Point the
// cache at the source images and that means the originals -- reproduced before
// this rail existed: three PNGs in, three PNGs deleted, stage reported success,
// and the ratio ceiling never fired because the derivatives outnumbered them.
describe('asset roots must be disjoint', () => {
  const R = (p: string) => ({ label: p, path: p })

  test('the cache being the source directory is refused', () => {
    assert.throws(
      () => checkDisjointRoots([R('/site/img'), R('/site/img')]),
      (e: Error) => {
        assert.ok(e instanceof RailError)
        assert.equal(e.rail, 'assets.overlapping-roots')
        // Terminal: a layout is a configuration, not a moment.
        assert.equal(e.terminal, true)
        assert.match(e.message, /the same directory as/)
        return true
      })
  })

  test('the cache inside the source directory is refused', () => {
    assert.throws(() => checkDisjointRoots([R('/site/img'), R('/site/img/cache')]), /is inside/)
  })

  test('the source directory inside the cache is refused, which is the other order', () => {
    // Containment is not symmetric in the message but must be in the check: a gc
    // over /site/cache walks everything under it, sources included.
    assert.throws(() => checkDisjointRoots([R('/site/cache/img'), R('/site/cache')]), /is inside/)
  })

  test('publishing into the sources is refused', () => {
    assert.throws(
      () => checkDisjointRoots([R('/site/img'), R('/site/cache'), R('/site/img')]),
      /assets\.overlapping-roots|the same directory as/)
  })

  test('sibling directories sharing a prefix are allowed', () => {
    // The negative control, and the case a naive startsWith gets wrong:
    // /site/img-cache is not inside /site/img. A rail that fires on a correct
    // layout costs more trust than the one it saves.
    checkDisjointRoots([R('/site/img'), R('/site/img-cache'), R('/site/img-public')])
  })

  test('three genuinely separate roots are allowed', () => {
    checkDisjointRoots([R('/a/sources'), R('/b/cache'), R('/c/publish')])
  })
})

describe('the asset stage refuses before it reads or writes anything', () => {
  test('an overlapping cache does not reach the garbage collector', async () => {
    // The wiring, not the predicate. Without the call in runAssetStage the rule
    // above is a function nobody invokes, and the originals go with the sweep --
    // which is what this reproduced before the rail existed.
    const dir = mkdtempSync(join(tmpdir(), 'assets-overlap-'))
    roots.push(dir)
    const sources = join(dir, 'img')
    await makeImages(sources, ['keep-me.png'])
    await assert.rejects(
      () => runAssetStage({ sources, outDir: sources, gc: true }),
      /assets\.overlapping-roots|deletes everything in its/)
    assert.equal(existsSync(join(sources, 'keep-me.png')), true, 'the original must survive')
  })
})
