import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../src/build.ts'
import { tmpdir, cleanup, seedStore, blogDocs, makeImages } from './fixture.ts'
import { fingerprint } from '../src/hash-tree.ts'

const BLOG = resolve(import.meta.dirname, '../example/blog/site.ts')
const STAMPED_ENFORCE = resolve(import.meta.dirname, 'sites/stamped-enforce.ts')
const STAMPED_OFF = resolve(import.meta.dirname, 'sites/stamped-off.ts')
const NO_TEMPLATE = resolve(import.meta.dirname, 'sites/no-template.ts')
const BLOG_ASSETS = resolve(import.meta.dirname, 'sites/blog-assets.ts')
const BLOG_HIGHLIGHT = resolve(import.meta.dirname, 'sites/blog-highlight.ts')

// The asset-site module reads these at import time and ESM caches it, so they
// are fixed once for the whole file rather than per test.
const assetWork = tmpdir('build-assets')
process.env.TEST_ASSET_SRC = join(assetWork, 'sources')
process.env.TEST_ASSET_CACHE = join(assetWork, 'cache')

const dirs: string[] = [assetWork]
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

let plainDb = ''
const POSTS = 25

before(async () => {
  const d = work('build-plain')
  plainDb = join(d, 'content.db')
  await seedStore(plainDb, blogDocs({ posts: POSTS }))
})

describe('build', () => {
  test('renders every route to exactly one file', async () => {
    const out = join(work('build-out'), 'dist')
    const r = await build({ site: BLOG, dbPath: plainDb, outDir: out, workers: 1, skipAssets: true })

    assert.equal(r.site, 'example-blog')
    assert.equal(r.documents, blogDocs({ posts: POSTS }).length)
    assert.ok(r.routes > POSTS, 'routes exceed posts — archives, tags, authors, pages')
    assert.ok(r.bytes > 0)
    // The invariant that catches slice arithmetic bugs and silent skips alike.
    assert.equal(fingerprint(out).length, r.routes, 'one output file per resolved route')

    for (const f of ['index.html', 'posts/post-0/index.html', 'sitemap.xml', 'feed.xml',
                     'posts/page/1/index.html', 'authors/author-0/index.html']) {
      assert.ok(existsSync(join(out, f)), `expected ${f}`)
    }
  })

  test('two builds of the same corpus are byte-identical', async () => {
    // This is success criterion 1 stated as a test. Without it, "output is a
    // pure function of content plus code" is a claim in a design note, and the
    // Phase 2 deploy diff silently degrades to a full-site upload the first time
    // a template reaches for the clock.
    const a = join(work('build-det-a'), 'dist')
    const b = join(work('build-det-b'), 'dist')
    await build({ site: BLOG, dbPath: plainDb, outDir: a, workers: 1, skipAssets: true })
    await build({ site: BLOG, dbPath: plainDb, outDir: b, workers: 1, skipAssets: true })
    assert.deepEqual(fingerprint(a), fingerprint(b))
  })

  test('the byte-identical check can actually detect a difference', async () => {
    // Negative control for the test above. Without it, "two builds match" would
    // pass just as happily if fingerprint compared two empty lists or ignored file
    // contents -- the strongest test in the suite would be the emptiest, and
    // nothing would say so.
    const a = join(work('build-neg-a'), 'dist')
    const b = join(work('build-neg-b'), 'dist')
    await build({ site: BLOG, dbPath: plainDb, outDir: a, workers: 1, skipAssets: true })
    await build({ site: BLOG, dbPath: plainDb, outDir: b, workers: 1, skipAssets: true })
    assert.deepEqual(fingerprint(a), fingerprint(b))

    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(b, 'index.html'), readFileSync(join(b, 'index.html'), 'utf8') + ' ')
    assert.notDeepEqual(fingerprint(a), fingerprint(b), 'one trailing byte must be enough to fail the check')
  })

  test('highlighted builds are byte-identical, which is what licenses the exemption', async () => {
    // The syntax highlighter is the one place in the codebase where the
    // determinism guard is deliberately suspended, on the argument that the
    // tokenizer's clock read cannot reach the output. That argument was made by
    // reading a pinned dependency, so this is the check that survives an
    // upgrade: two builds of one corpus, one of them on a busy worker pool
    // (which is exactly the condition a wall-clock bailout would fire under).
    const db = join(work('build-hl-db'), 'content.db')
    await seedStore(db, blogDocs({ posts: 8, code: true }))
    const a = join(work('build-hl-a'), 'dist')
    const b = join(work('build-hl-b'), 'dist')
    const plain = join(work('build-hl-plain'), 'dist')
    await build({ site: BLOG_HIGHLIGHT, dbPath: db, outDir: a, workers: 1, skipAssets: true })
    await build({ site: BLOG_HIGHLIGHT, dbPath: db, outDir: b, workers: 4, skipAssets: true })
    assert.deepEqual(fingerprint(a), fingerprint(b))

    // And the highlighter actually ran — otherwise this asserts that two
    // unhighlighted builds match, which the plain-tier test already covers.
    await build({ site: BLOG, dbPath: db, outDir: plain, workers: 1, skipAssets: true })
    const page = join('posts', 'post-0', 'index.html')
    assert.notEqual(
      readFileSync(join(a, page), 'utf8'),
      readFileSync(join(plain, page), 'utf8'),
      'the highlight tier must produce different HTML than the plain tier')
  })

  test('the worker pool produces the same bytes as the single-threaded path', async () => {
    // The two paths share prepare() and renderRange() precisely so they cannot
    // drift; this asserts the sharing actually holds end to end.
    const one = join(work('build-w1'), 'dist')
    const many = join(work('build-w4'), 'dist')
    const r1 = await build({ site: BLOG, dbPath: plainDb, outDir: one, workers: 1, skipAssets: true })
    const r4 = await build({ site: BLOG, dbPath: plainDb, outDir: many, workers: 4, skipAssets: true })
    assert.equal(r4.workers, 4)
    assert.equal(r1.routes, r4.routes)
    assert.equal(r1.bytes, r4.bytes)
    assert.deepEqual(fingerprint(one), fingerprint(many))
  })

  test('a worker pool wider than the route list still renders every route', async () => {
    const out = join(work('build-wide'), 'dist')
    const r = await build({ site: BLOG, dbPath: plainDb, outDir: out, workers: 64, skipAssets: true })
    assert.equal(fingerprint(out).length, r.routes)
  })

  test('clean removes output from a previous build', async () => {
    const out = join(work('build-clean'), 'dist')
    await build({ site: BLOG, dbPath: plainDb, outDir: out, workers: 1, skipAssets: true })
    const stale = join(out, 'stale', 'index.html')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(out, 'stale'), { recursive: true })
    writeFileSync(stale, 'old')
    await build({ site: BLOG, dbPath: plainDb, outDir: out, workers: 1, skipAssets: true, clean: true })
    assert.equal(existsSync(stale), false)
  })
})

describe('build — failure modes', () => {
  let stampDb = ''
  before(async () => {
    stampDb = join(work('build-stamp'), 'content.db')
    await seedStore(stampDb, blogDocs({ posts: 2 }))
  })

  test('a template reaching for the wall clock fails the build and names the route', async () => {
    const out = join(work('build-stamp-out'), 'dist')
    await assert.rejects(
      () => build({ site: STAMPED_ENFORCE, dbPath: stampDb, outDir: out, workers: 1 }),
      (e: unknown) => {
        const m = (e as Error).message
        return m.includes('Date.now()') && m.includes('/stamped/')
      },
    )
  })

  test('the same violation inside a worker is reported, not swallowed', async () => {
    // A worker that dies quietly at scale is how a Phase 0 crash first read as
    // a success. The parent names the slice and rethrows.
    const out = join(work('build-stamp-w'), 'dist')
    await assert.rejects(
      () => build({ site: STAMPED_ENFORCE, dbPath: stampDb, outDir: out, workers: 2 }),
      /DeterminismError.*Date\.now\(\)/s,
    )
  })

  test("determinism:'off' really opts out", async () => {
    const out = join(work('build-stamp-off'), 'dist')
    const r = await build({ site: STAMPED_OFF, dbPath: stampDb, outDir: out, workers: 1 })
    assert.equal(r.routes, 2)
    assert.match(readFileSync(join(out, 'stamped', 'index.html'), 'utf8'), /built at \d+/)
  })

  test('a route with no template fails the build', async () => {
    const out = join(work('build-orphan'), 'dist')
    await assert.rejects(
      () => build({ site: NO_TEMPLATE, dbPath: stampDb, outDir: out, workers: 1 }),
      /No template for route kind "orphan"/,
    )
  })

  test('a nonexistent site module is reported clearly', async () => {
    await assert.rejects(
      () => build({ site: '/nope/site.ts', dbPath: plainDb, outDir: join(work('build-nosite'), 'dist') }),
      /nope\/site\.ts/,
    )
  })
})

describe('build — asset integration', () => {
  let assetDb = ''
  let heroes: string[] = []

  before(async () => {
    heroes = await makeImages(process.env.TEST_ASSET_SRC as string, ['hero-a.jpg', 'hero-b.jpg'])
    assetDb = join(work('build-asset-db'), 'content.db')
    await seedStore(assetDb, blogDocs({ posts: 6, heroes }))
  })

  test('processes every source and wires the manifest into rendered pages', async () => {
    const out = join(work('build-asset-out'), 'dist')
    const r = await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: out, workers: 1 })

    assert.ok(r.assets)
    assert.equal(r.assets.sources, 2, 'the stage scans the directory, not the routes')
    // avif + webp, and only widths at or below the 900px intrinsic width.
    assert.equal(r.assets.stats.misses, 8)
    assert.equal(r.assets.stats.hits, 0)
    assert.equal(r.assets.published, 8)

    const html = readFileSync(join(out, 'posts', 'post-0', 'index.html'), 'utf8')
    assert.match(html, /<picture><source type="image\/avif"/)
    assert.match(html, /width="900" height="600"/)
    assert.match(html, /loading="eager"/)

    // Every URL the page references must exist on disk.
    for (const url of [...html.matchAll(/\/assets\/img\/[A-Za-z0-9.\-]+/g)].map((m) => m[0])) {
      assert.ok(existsSync(join(out, url.slice(1))), `missing derivative ${url}`)
    }
  })

  test('never upscales past the source width', async () => {
    const out = join(work('build-asset-up'), 'dist')
    await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: out, workers: 1 })
    const names = readdirSync(join(out, 'assets', 'img'))
    // Configured widths are 400/800/1200/1600; sources are 900px wide.
    assert.equal(names.length, 8, 'two sources x two formats x two usable widths')
  })

  test('a clean rebuild reuses the cache instead of re-encoding', async () => {
    // The cache lives outside outDir precisely so this holds. If it lived under
    // the output, `clean: true` would throw away work that Phase 2c measured at
    // ~59 minutes for 20,000 sources.
    const out = join(work('build-asset-warm'), 'dist')
    await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: out, workers: 1, clean: true })
    const warm = await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: out, workers: 1, clean: true })

    assert.ok(warm.assets)
    assert.equal(warm.assets.stats.misses, 0, 'a content-addressed cache cannot miss on unchanged sources')
    assert.equal(warm.assets.stats.hits, 8)
    assert.equal(warm.assets.published, 8, 'derivatives are re-linked into the cleaned output')
    assert.ok(existsSync(join(out, 'assets', 'img')))
  })

  test('asset builds are byte-identical too', async () => {
    const a = join(work('build-asset-a'), 'dist')
    const b = join(work('build-asset-b'), 'dist')
    await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: a, workers: 1 })
    await build({ site: BLOG_ASSETS, dbPath: assetDb, outDir: b, workers: 3 })
    assert.deepEqual(fingerprint(a), fingerprint(b))
  })

  test('a hero naming an unprocessed source fails the build', async () => {
    const db = join(work('build-asset-bad'), 'content.db')
    await seedStore(db, blogDocs({ posts: 3, heroes: ['does-not-exist.jpg'] }))
    await assert.rejects(
      () => build({ site: BLOG_ASSETS, dbPath: db, outDir: join(work('build-asset-bad-out'), 'dist'), workers: 1 }),
      /no such source/,
    )
  })
})
