// Route paths that leave the output tree, collide with each other, or differ
// between the workers that resolved them.
//
// One test file because one pass answers all three. `planOutputs` resolves the
// whole route list once, proves every output path stays inside outDir, refuses
// two routes that would write the same file, and returns a digest of the set --
// which is the value the render workers are made to agree on. Splitting these
// would mean building that pass twice.
//
// The integration tests assert more than "it threw": a refusal that happens
// after the write it was meant to prevent is not a refusal, so each one also
// checks the filesystem.
import { test, describe, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../src/build.ts'
import { planOutputs, UnsafeRouteError } from '../src/render.ts'
import { readSeal } from '../src/deploy.ts'
import { tmpdir, cleanup, seedStore, blogDocs } from './fixture.ts'
import type { Route } from '../src/config.ts'

const SITES = resolve(import.meta.dirname, 'sites')
const ESCAPING = join(SITES, 'escaping-route.ts')
const DUPLICATE = join(SITES, 'duplicate-routes.ts')
const SAME_LENGTH = join(SITES, 'same-length-routes.ts')

const dirs: string[] = []
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

let db = ''
before(async () => {
  db = join(work('route-plan'), 'content.db')
  await seedStore(db, blogDocs({ posts: 6 }))
})

const r = (path: string, kind = 'home'): Route => ({ kind, path })

describe('planOutputs containment', () => {
  test('the ordinary shapes still resolve where they always did', () => {
    const plan = planOutputs('/out', [
      r('/'), r('/about/'), r('/sitemap.xml'), r('/posts/a/'),
    ])
    assert.deepEqual(plan.paths, [
      '/out/index.html', '/out/about/index.html', '/out/sitemap.xml', '/out/posts/a/index.html',
    ])
  })

  test('a path that escapes the tree is refused, and says that is why', () => {
    // These are rejected by the containment check rather than by the ".."
    // spelling rule, which is the ordering the implementation relies on: the
    // invariant does the rejecting, so it stays the thing under test.
    for (const path of [
      '/../escaped.html',
      '/posts/../../escaped.html',
      '/..',
      '/posts/a/../../../etc/passwd',
    ]) {
      assert.throws(
        () => planOutputs('/out', [r(path)]),
        (e: unknown) => {
          assert.ok(e instanceof UnsafeRouteError, `${path} should be refused`)
          assert.match(e.message, /outside the output directory/)
          return true
        },
        `expected ${path} to be refused`)
    }
  })

  test('a ".." that stays inside the tree is still refused', () => {
    // Reached only after containment passes, so this is the case that makes the
    // segment rule load-bearing on its own rather than shadowed by the check
    // above. "/posts/../a.html" writes /out/a.html -- in-tree, and named as
    // something it is not.
    assert.throws(
      () => planOutputs('/out', [r('/posts/../a.html')]),
      (e: unknown) => {
        assert.match((e as Error).message, /".." segment/)
        return true
      })
  })

  test('a NUL byte is refused, though containment does not depend on it', () => {
    // Deliberately not claimed as a traversal defence. Truncation at the syscall
    // only shortens the path, and a shorter path under a validated prefix is
    // still under it -- so no mutation covers this line, and that is correct
    // rather than a gap. What it buys is the route index in the message instead
    // of a mangled path out of writeFileSync.
    assert.throws(() => planOutputs('/out', [r('/a\0/../../x')]), /NUL byte/)
    assert.throws(() => planOutputs('/out', [r('/a\0.html')]), /NUL byte/)
  })

  test('a backslash is refused rather than normalised', () => {
    // A separator on Windows and a filename character on POSIX. Accepting it
    // means one site emits two different trees, and the traversal it hides is
    // only reachable on the platform where it works.
    assert.throws(() => planOutputs('/out', [r('/..\\..\\escaped.html')]), /backslash/)
    assert.throws(() => planOutputs('/out', [r('/a\\b.html')]), /backslash/)
  })

  test('an empty or non-string path is refused', () => {
    assert.throws(() => planOutputs('/out', [r('')]), /non-empty string/)
    assert.throws(
      () => planOutputs('/out', [{ kind: 'home' } as unknown as Route]),
      /non-empty string/)
  })

  test('a path that resolves to the output directory itself is refused', () => {
    // Not a traversal, and still not writable: there is no file to write.
    assert.throws(() => planOutputs('/out', [r('/.')]), /outside the output directory/)
  })

  test('a sibling directory sharing a prefix is not mistaken for being inside', () => {
    // The separator in the prefix test is what makes this fail. Comparing
    // against "/out" alone would accept "/out-old/x" as being under it.
    assert.throws(
      () => planOutputs('/out', [r('/../out-old/x.html')]), /outside the output directory/)
    // And the legitimate near-miss still resolves, so the rule above is not
    // rejecting on the string looking suspicious.
    assert.deepEqual(planOutputs('/out', [r('/out-old/x.html')]).paths, ['/out/out-old/x.html'])
  })
})

describe('planOutputs duplicates', () => {
  test('two routes writing one file are refused, and both are named', () => {
    assert.throws(
      () => planOutputs('/out', [r('/a/'), r('/b/'), r('/a/')]),
      (e: unknown) => {
        assert.ok(e instanceof UnsafeRouteError)
        assert.match(e.message, /route 2/)
        assert.match(e.message, /same file as route 0/)
        return true
      })
  })

  test('a collision that only appears after normalisation is caught too', () => {
    // "/about/" and "/about/index.html" are different strings and one file. A
    // duplicate check keyed on the route path would pass this.
    assert.throws(
      () => planOutputs('/out', [r('/about/'), r('/about/index.html')]),
      /same file as route 0/)
  })

  test('paths that only look similar are not treated as duplicates', () => {
    // The control for the two above: a file and a directory of the same name
    // are genuinely two outputs, and refusing them would break real sites.
    const plan = planOutputs('/out', [r('/a'), r('/a/'), r('/ab')])
    assert.deepEqual(plan.paths, ['/out/a', '/out/a/index.html', '/out/ab'])
  })
})

describe('planOutputs digest', () => {
  test('the same route set digests the same, in the same order', () => {
    const set = [r('/'), r('/about/', 'about'), r('/posts/a/', 'post')]
    assert.equal(planOutputs('/out', set).digest, planOutputs('/out', [...set]).digest)
  })

  test('a different route set of equal length digests differently', () => {
    // The whole point. This is the pair the old count comparison could not tell
    // apart, and it is the smallest possible disagreement: one path.
    const a = [r('/'), r('/about/', 'about')]
    const b = [r('/'), r('/aboot/', 'about')]
    assert.equal(a.length, b.length)
    assert.notEqual(planOutputs('/out', a).digest, planOutputs('/out', b).digest)
  })

  test('the same paths from different templates digest differently', () => {
    // Kind is in the digest because it selects the template, so two workers
    // agreeing on every path while disagreeing on how to render them is still a
    // build assembled from two sites.
    assert.notEqual(
      planOutputs('/out', [r('/a/', 'post')]).digest,
      planOutputs('/out', [r('/a/', 'page')]).digest)
  })

  test('reordering the same routes digests differently', () => {
    // Order decides which worker renders which route, so two workers that agree
    // on the set but not its order would still render overlapping slices and
    // leave gaps.
    assert.notEqual(
      planOutputs('/out', [r('/a/'), r('/b/')]).digest,
      planOutputs('/out', [r('/b/'), r('/a/')]).digest)
  })

  test('the digest does not depend on the output directory', () => {
    // It is the identity of the route set, not of one build's destination.
    const set = [r('/'), r('/about/', 'about')]
    assert.equal(planOutputs('/out', set).digest, planOutputs('/elsewhere', set).digest)
  })
})

describe('build refuses a route set it cannot write', () => {
  test('an escaping route fails the build and writes nothing outside outDir', async () => {
    const d = work('route-escape')
    const outDir = join(d, 'dist')
    const probe = join(d, 'escaped-by-route.html')

    await assert.rejects(
      () => build({ site: ESCAPING, dbPath: db, outDir, workDir: d, workers: 1, clean: true, skipAssets: true }),
      (e: unknown) => {
        assert.equal((e as Error).name, 'UnsafeRouteError')
        assert.match((e as Error).message, /outside the output directory/)
        return true
      })

    // The assertion that matters. Throwing after the write would be a report,
    // not a refusal.
    assert.equal(existsSync(probe), false, 'a file was written outside the output directory')
    // And no seal, so a deploy cannot act on the half-built tree either.
    assert.equal(readSeal(d), null)
  })

  test('the same escaping route is refused in the parallel path too', async () => {
    // Worth its own test: the single-threaded and pooled paths are the two that
    // must not drift, and a check living in only one of them is the shape this
    // codebase already keeps meeting.
    const d = work('route-escape-par')
    const probe = join(d, 'escaped-by-route.html')
    await assert.rejects(
      () => build({ site: ESCAPING, dbPath: db, outDir: join(d, 'dist'), workDir: d, workers: 3, clean: true, skipAssets: true }),
      /outside the output directory/)
    assert.equal(existsSync(probe), false)
  })

  test('duplicate routes fail the build rather than overwriting silently', async () => {
    const d = work('route-dupe')
    const outDir = join(d, 'dist')
    await assert.rejects(
      () => build({ site: DUPLICATE, dbPath: db, outDir, workDir: d, workers: 1, clean: true, skipAssets: true }),
      (e: unknown) => {
        assert.equal((e as Error).name, 'UnsafeRouteError')
        assert.match((e as Error).message, /same file as route/)
        return true
      })
    assert.equal(readSeal(d), null)
  })
})

describe('workers must agree on the route set, not its size', () => {
  test('same-length different route sets fail the build', async () => {
    const d = work('route-disagree')
    await assert.rejects(
      () => build({
        site: SAME_LENGTH, dbPath: db, outDir: join(d, 'dist'), workDir: d,
        workers: 3, clean: true, skipAssets: true,
      }),
      (e: unknown) => {
        assert.match((e as Error).message, /workers disagree on the route set/)
        // The count is still reported, because "142 routes vs 142 routes" is
        // what tells the reader the sets differ rather than their sizes.
        assert.match((e as Error).message, /\d+ routes \(/)
        return true
      })
    assert.equal(readSeal(d), null, 'a build that refused must leave no seal')
  })

  test('and the same site under one worker builds, so the refusal is about disagreement', async () => {
    // The control. With a single worker there is nobody to disagree with, and
    // the site is otherwise perfectly buildable -- so the failure above is the
    // agreement check firing and not this fixture being broken.
    const d = work('route-agree')
    const b = await build({
      site: SAME_LENGTH, dbPath: db, outDir: join(d, 'dist'), workDir: d,
      workers: 1, clean: true, skipAssets: true,
    })
    assert.ok(b.routes > 0)
    assert.ok(readdirSync(join(d, 'dist')).length > 0)
  })
})
