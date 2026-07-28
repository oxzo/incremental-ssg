import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../src/build.ts'
import { deploy, planDeploy, clearSeal, contentTypeFor, readSeal, SEAL_SCHEMA } from '../src/deploy.ts'
import { directoryTarget } from '../src/deploy-mock.ts'
import { hashTree, scanTree, foldDigests } from '../src/hash-tree.ts'
import { tmpdir, cleanup, seedStore, blogDocs, makeImages, EPOCH } from './fixture.ts'
import type { MockDoc } from '../src/cms-mock.ts'

const BLOG = resolve(import.meta.dirname, '../example/blog/site.ts')
const BLOG_ASSETS = resolve(import.meta.dirname, 'sites/blog-assets.ts')

const assetWork = tmpdir('deploy-assets')
process.env.TEST_ASSET_SRC = join(assetWork, 'sources')
process.env.TEST_ASSET_CACHE = join(assetWork, 'cache')

const dirs: string[] = [assetWork]
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

/**
 * A site whose content can be edited and re-synced, built into its own tree and
 * deployed to a directory standing in for the live site.
 *
 * The whole pipeline runs for real -- mock CMS over HTTP, real sync driver,
 * real build, real diff. Writing an output tree by hand would test the diff
 * against files this project never actually emits, which is the shape of test
 * that passes while the product is broken.
 */
async function site(docs: MockDoc[], sitePath = BLOG) {
  const d = work('deploy')
  const dbPath = join(d, 'content.db')
  const outDir = join(d, 'dist')
  const remoteDir = join(d, 'remote')
  await seedStore(dbPath, docs)
  return {
    dbPath,
    outDir,
    remoteDir,
    workDir: d,
    /** Re-pull after mutating `docs`; the stored watermark makes it a delta sync. */
    resync: () => seedStore(dbPath, docs),
    build: (opts: { clean?: boolean; skipAssets?: boolean } = {}) =>
      build({
        site: sitePath,
        dbPath,
        outDir,
        workers: 1,
        workDir: d,
        clean: opts.clean ?? true,
        skipAssets: opts.skipAssets ?? sitePath === BLOG,
      }),
  }
}

describe('planDeploy', () => {
  const local = (entries: [string, string][]) => new Map(entries)

  test('classifies added, modified, deleted and unchanged', () => {
    const p = planDeploy(
      local([['index.html', 'aaa'], ['new.html', 'bbb'], ['same.html', 'ccc']]),
      [
        { path: 'index.html', digest: 'old' },
        { path: 'same.html', digest: 'ccc' },
        { path: 'gone.html', digest: 'ddd' },
      ],
    )
    assert.deepEqual(p.added, ['new.html'])
    assert.deepEqual(p.modified, ['index.html'])
    assert.deepEqual(p.deleted, ['gone.html'])
    assert.equal(p.unchanged, 1)
    assert.equal(p.digestsUnavailable, false)
  })

  test('purges modified and deleted paths but not added ones by default', () => {
    // Nothing is cached at a URL that did not exist, so an add needs no purge
    // unless the CDN negatively caches 404s. It matters: a single edited image
    // produces eight adds, and purging all of them would cost more than the
    // upload did.
    const p = planDeploy(
      local([['a.html', '1'], ['b.html', '2']]),
      [{ path: 'b.html', digest: 'old' }, { path: 'c.html', digest: '3' }],
    )
    assert.deepEqual(p.purge, ['b.html', 'c.html'])

    const withAdds = planDeploy(
      local([['a.html', '1'], ['b.html', '2']]),
      [{ path: 'b.html', digest: 'old' }, { path: 'c.html', digest: '3' }],
      { purgeAdded: true },
    )
    assert.deepEqual(withAdds.purge, ['a.html', 'b.html', 'c.html'])
  })

  test('a path the target reports without a digest is modified, never unchanged', () => {
    // "Cannot tell" has to read as "changed". The other reading skips a real
    // upload and leaves stale bytes live, which is the one outcome this whole
    // stage exists to prevent.
    const p = planDeploy(local([['a.html', '1']]), [{ path: 'a.html' }])
    assert.deepEqual(p.modified, ['a.html'])
    assert.equal(p.unchanged, 0)
    assert.equal(p.digestsUnavailable, true)
  })

  test('an empty remote makes everything an add', () => {
    const p = planDeploy(local([['a.html', '1'], ['b.html', '2']]), [])
    assert.equal(p.added.length, 2)
    assert.equal(p.deleted.length, 0)
    assert.equal(p.unchanged, 0)
  })
})

describe('contentTypeFor', () => {
  test('names the types the pipeline actually emits', () => {
    assert.match(contentTypeFor('posts/x/index.html'), /^text\/html/)
    assert.match(contentTypeFor('feed.xml'), /^application\/xml/)
    assert.equal(contentTypeFor('assets/img/a.avif'), 'image/avif')
    assert.equal(contentTypeFor('assets/img/a.webp'), 'image/webp')
    assert.equal(contentTypeFor('weird.bin'), 'application/octet-stream')
  })
})

describe('deploy', () => {
  test('the first deploy uploads the whole site, the second uploads nothing', async () => {
    // The headline property. If a no-change rebuild ever uploads anything, the
    // determinism guarantee has regressed and the diff is worthless -- suspect
    // that before suspecting the diff.
    const s = await site(blogDocs({ posts: 12 }))
    const target = directoryTarget({ dir: s.remoteDir })

    const first = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.ok(first.plan.added.length > 12)
    assert.equal(first.plan.modified.length, 0)
    assert.equal(first.plan.deleted.length, 0)
    assert.equal(first.uploaded, first.plan.added.length)
    assert.equal(first.purged, 0, 'a site that did not exist has nothing cached to purge')

    const second = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.equal(second.uploaded, 0)
    assert.equal(second.deleted, 0)
    assert.equal(second.purged, 0)
    assert.equal(second.plan.unchanged, first.plan.added.length)
  })

  test('a content edit uploads single digits out of the whole site', async () => {
    // Phase 0 measured a body edit at 6 changed routes out of 24,449. This is
    // that claim asserted against the product rather than the fan-out harness:
    // the number is small and, more importantly, bounded well below the site.
    const docs = blogDocs({ posts: 20 })
    const s = await site(docs)
    const target = directoryTarget({ dir: s.remoteDir })
    const first = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    const post = docs.find((d) => d.doc.id === 'post-7')
    assert.ok(post)
    post.doc.title = 'an edited title'
    post.doc.updated_at = EPOCH + 60_000
    post.doc.rev = 'r2-post-7'
    await s.resync()

    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.equal(r.plan.added.length, 0)
    assert.ok(r.plan.modified.length > 0, 'the edit must reach the output')
    assert.ok(
      r.plan.modified.length < first.plan.added.length / 2,
      `a title edit changed ${r.plan.modified.length} of ${first.plan.added.length} files`)
    assert.deepEqual(r.plan.purge, r.plan.modified)
    assert.equal(r.deleted, 0)
  })

  test('a deleted document takes its page down and purges it', async () => {
    const docs = blogDocs({ posts: 12 })
    const s = await site(docs)
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.ok(target.paths().includes('posts/post-5/index.html'))

    docs.splice(docs.findIndex((d) => d.doc.id === 'post-5'), 1)
    await s.resync()

    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.ok(r.plan.deleted.includes('posts/post-5/index.html'))
    assert.equal(target.paths().includes('posts/post-5/index.html'), false)
    assert.ok(target.purged.includes('posts/post-5/index.html'),
      'an unpurged delete keeps serving a page that no longer exists')
  })

  test('uploads land before any delete', async () => {
    // Deleting first opens a window where a page that merely moved is missing
    // from the live site. This order can only ever leave an extra file around.
    const docs = blogDocs({ posts: 12 })
    const s = await site(docs)
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    docs.splice(docs.findIndex((d) => d.doc.id === 'post-5'), 1)
    await s.resync()
    target.ops.length = 0
    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    assert.ok(r.deleted > 0 && r.uploaded > 0, 'the test needs both kinds of operation')
    const firstRemove = target.ops.findIndex((o) => o.startsWith('remove '))
    const lastPut = target.ops.map((o) => o.startsWith('put ')).lastIndexOf(true)
    assert.ok(firstRemove > lastPut, `remove at ${firstRemove} preceded a put at ${lastPut}`)
  })

  test('a dry run reports the plan and touches nothing', async () => {
    const s = await site(blogDocs({ posts: 8 }))
    const target = directoryTarget({ dir: s.remoteDir })
    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal, dryRun: true })

    assert.ok(r.dryRun)
    assert.ok(r.plan.added.length > 8)
    assert.equal(r.uploaded, 0)
    assert.deepEqual(target.ops, [])
    assert.deepEqual(target.paths(), [])
  })

  test('a target without digest listing re-uploads instead of claiming unchanged', async () => {
    const s = await site(blogDocs({ posts: 8 }))
    const blind = directoryTarget({ dir: s.remoteDir, capabilities: { digestListing: false } })
    const first = await deploy({ outDir: s.outDir, target: blind, seal: (await s.build()).seal })
    assert.equal(first.plan.digestsUnavailable, false, 'nothing is common on an empty remote')

    const second = await deploy({ outDir: s.outDir, target: blind, seal: (await s.build()).seal })
    assert.equal(second.plan.digestsUnavailable, true)
    assert.equal(second.plan.unchanged, 0)
    assert.equal(second.uploaded, first.plan.added.length,
      'a target that cannot report digests degrades to a full upload, and says so')
  })

  test('an interrupted deploy leaves the site partly updated and the next one finishes it', async () => {
    // No transaction spans a deploy, so the honest claim is convergence rather
    // than atomicity: the next run diffs against whatever actually landed.
    const docs = blogDocs({ posts: 10 })
    const s = await site(docs)
    const flaky = directoryTarget({ dir: s.remoteDir, failAfter: 5 })
    const seal = (await s.build()).seal
    await assert.rejects(() => deploy({ outDir: s.outDir, target: flaky, seal, concurrency: 1 }),
      /failed after 5 operations/)

    const good = directoryTarget({ dir: s.remoteDir })
    const r = await deploy({ outDir: s.outDir, target: good, seal })
    assert.equal(r.plan.deleted.length, 0, 'the half-finished upload must not look like deletions')
    assert.ok(r.uploaded > 0)

    const settled = await deploy({ outDir: s.outDir, target: good, seal: (await s.build()).seal })
    assert.equal(settled.uploaded, 0)
    assert.deepEqual(hashTree(s.outDir), new Map(
      (await good.list()).map((o) => [o.path, o.digest as string])))
  })
})

describe('deploy — rails', () => {
  test('refuses when the build wrote no seal', async () => {
    const s = await site(blogDocs({ posts: 6 }))
    await s.build()
    clearSeal(s.workDir)
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), workDir: s.workDir }),
      /no build seal/)
  })

  test('a build that fails leaves no usable seal behind', async () => {
    // The rail that matters most: without clearing the seal up front, a build
    // that dies halfway leaves the *previous* build's seal in place and the
    // next deploy treats a truncated tree as complete.
    const docs = blogDocs({ posts: 8, heroes: ['nope.jpg'] })
    const s = await site(docs, BLOG_ASSETS)
    await assert.rejects(() => s.build())
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), workDir: s.workDir }),
      /no build seal/)
  })

  test('refuses when the output tree no longer matches its seal', async () => {
    const s = await site(blogDocs({ posts: 10 }))
    const seal = (await s.build()).seal
    rmSync(join(s.outDir, 'posts', 'post-3'), { recursive: true, force: true })
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), seal }),
      /does not match its seal/)
  })

  test('refuses a same-size edit to the built tree, which the old seal passed', async () => {
    // The case that made "proof that a build emitted exactly this tree" untrue.
    // The seal recorded file count and total bytes, so an edit preserving both
    // -- one character swapped in a published page -- validated cleanly and was
    // uploaded. Nothing downstream could catch it either: the diff would see a
    // changed file and dutifully publish the tampered version.
    const s = await site(blogDocs({ posts: 10 }))
    const seal = (await s.build()).seal

    const victim = join(s.outDir, 'index.html')
    const before = readFileSync(victim)
    const after = Buffer.from(before)
    // Same length, different content, and deliberately a byte that would render.
    after[after.indexOf(0x3e)] = 0x20
    writeFileSync(victim, after)
    assert.equal(after.length, before.length, 'the edit must not change the size')

    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), seal }),
      (e: unknown) => {
        assert.match((e as Error).message, /does not match its seal/)
        assert.match((e as Error).message, /content digest/)
        return true
      })

    // And the counts really do still agree, so the digest is what refused --
    // not the file/byte totals wearing a new message.
    assert.equal(scanTree(s.outDir, ['sha256']).files, seal.files)
    assert.equal(scanTree(s.outDir, ['sha256']).bytes, seal.bytes)
  })

  test('the same tree untouched still deploys, so the check is about content', async () => {
    // The control for the test above.
    const s = await site(blogDocs({ posts: 10 }))
    const seal = (await s.build()).seal
    const r = await deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), seal })
    assert.ok(r.uploaded > 0)
  })

  test('two files swapping content are refused, though every byte is still present', async () => {
    // Paths are folded in with their digests, so a tree holding exactly the same
    // multiset of bytes under different names is a different tree. Count, total
    // size and even the set of content hashes are unchanged here.
    const s = await site(blogDocs({ posts: 10 }))
    const seal = (await s.build()).seal
    const a = join(s.outDir, 'posts', 'post-1', 'index.html')
    const b = join(s.outDir, 'posts', 'post-2', 'index.html')
    const [ba, bb] = [readFileSync(a), readFileSync(b)]
    writeFileSync(a, bb)
    writeFileSync(b, ba)
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), seal }),
      /does not match its seal/)
  })

  test('the seal verifies against a target whose listing reports a different algorithm', async () => {
    // The deploy hashes local files with the *target's* algorithm so the diff is
    // comparable to its listing -- md5 for S3-style ETags -- while the seal is
    // always sha256. Both come out of one read of the tree; this checks the
    // wiring, since getting it wrong would either compare md5 to a sha256 seal
    // (every deploy refuses) or read 320 MB twice.
    const s = await site(blogDocs({ posts: 8 }))
    const seal = (await s.build()).seal
    const target = directoryTarget({ dir: s.remoteDir, digestAlgorithm: 'md5' })
    const r = await deploy({ outDir: s.outDir, target, seal })
    assert.ok(r.uploaded > 0)

    // And it still refuses a tampered tree through that same path.
    const victim = join(s.outDir, 'index.html')
    const body = readFileSync(victim)
    body[body.indexOf(0x3e)] = 0x20
    writeFileSync(victim, body)
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir, digestAlgorithm: 'md5' }), seal }),
      /does not match its seal/)
  })

  test('refuses a seal describing a different output directory', async () => {
    const a = await site(blogDocs({ posts: 6 }))
    const b = await site(blogDocs({ posts: 6 }))
    const seal = (await a.build()).seal
    await b.build()
    await assert.rejects(
      () => deploy({ outDir: b.outDir, target: directoryTarget({ dir: b.remoteDir }), seal }),
      /seal describes/)
  })

  test('refuses a build that did not clean its output directory', async () => {
    // The silent failure: nothing removes output an earlier build left behind,
    // so a stale page matches what is live byte for byte and the diff calls it
    // unchanged. No error is raised anywhere -- the page just never comes down.
    const s = await site(blogDocs({ posts: 6 }))
    const seal = (await s.build({ clean: false })).seal
    assert.equal(seal.clean, false)
    await assert.rejects(
      () => deploy({ outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), seal }),
      /did not clean/)
  })

  test('the stale-output hazard the clean rail exists for is real', async () => {
    // Demonstrates the failure rather than asserting the guard: build, delete a
    // post, rebuild *without* cleaning, and its page is still sitting in the
    // tree. Without the rail this deploys as "unchanged" and stays live.
    const docs = blogDocs({ posts: 10 })
    const s = await site(docs)
    await s.build()
    assert.ok(readdirSync(join(s.outDir, 'posts')).includes('post-5'))

    docs.splice(docs.findIndex((d) => d.doc.id === 'post-5'), 1)
    await s.resync()
    await s.build({ clean: false })
    assert.ok(readdirSync(join(s.outDir, 'posts')).includes('post-5'),
      'a non-clean build leaves the deleted post\'s page in the output tree')

    await s.build({ clean: true })
    assert.equal(readdirSync(join(s.outDir, 'posts')).includes('post-5'), false)
  })

  test('refuses to delete more than half the live site, and force overrides', async () => {
    const docs = blogDocs({ posts: 20 })
    const s = await site(docs)
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    const live = (await target.list()).length

    // Same shape as AssetCache.gc and DocumentStore.deleteMissing: a mass
    // deletion and a partial listing are indistinguishable from here.
    const empty = await site(blogDocs({ posts: 1 }))
    const seal = (await empty.build()).seal
    await assert.rejects(
      () => deploy({ outDir: empty.outDir, target, seal }),
      /over the 50% limit/)
    assert.equal((await target.list()).length, live, 'the refusal must not delete anything')

    const forced = await deploy({ outDir: empty.outDir, target, seal, force: true })
    assert.ok(forced.deleted > 0)
  })

  test('a raised ratio allows a sweep the default refuses', async () => {
    const s = await site(blogDocs({ posts: 20 }))
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    const small = await site(blogDocs({ posts: 1 }))
    const seal = (await small.build()).seal
    const r = await deploy({ outDir: small.outDir, target, seal, maxDeleteRatio: 0.99 })
    assert.ok(r.deleted > 0)
  })
})

describe('foldDigests', () => {
  const m = (...pairs: [string, string][]) => new Map(pairs)

  test('does not depend on the order the tree was walked in', () => {
    // Insertion order follows the filesystem walk, which is stable today and is
    // not something the seal should depend on.
    assert.equal(
      foldDigests(m(['a.html', 'h1'], ['b.html', 'h2'])),
      foldDigests(m(['b.html', 'h2'], ['a.html', 'h1'])))
  })

  test('changes when content changes', () => {
    assert.notEqual(foldDigests(m(['a.html', 'h1'])), foldDigests(m(['a.html', 'h2'])))
  })

  test('changes when a path changes, though the content does not', () => {
    // The reason paths are folded in at all: a tree holding the same bytes under
    // different names is a different site.
    assert.notEqual(foldDigests(m(['a.html', 'h1'])), foldDigests(m(['b.html', 'h1'])))
  })

  test('no two trees fold to one value, whatever a path contains', () => {
    // This test failed when written, against a fold that joined `path hash`
    // lines with newlines: the two maps below serialise to identical bytes, so
    // one seal value stood for two different trees. Length-prefixing is what
    // makes the encoding unambiguous rather than unambiguous-so-long-as-no-path-
    // contains-a-separator.
    assert.notEqual(
      foldDigests(m(['a', 'h1'], ['b', 'h2'])),
      foldDigests(m(['a h1\nb', 'h2'])))
    // The same question asked of the other separator, and of a path that ends
    // where another begins.
    assert.notEqual(
      foldDigests(m(['a', 'h1'], ['b', 'h2'])),
      foldDigests(m(['a', 'h1b'], ['', 'h2'])))
    assert.notEqual(
      foldDigests(m(['ab', 'h1'])),
      foldDigests(m(['a', 'bh1'])))
  })

  test('an empty tree folds to a stable value that is not any non-empty one', () => {
    assert.equal(foldDigests(m()), foldDigests(m()))
    assert.notEqual(foldDigests(m()), foldDigests(m(['a.html', 'h1'])))
  })
})

describe('the seal schema', () => {
  test('a seal from before the digest existed is not readable', async () => {
    // The bump is load-bearing rather than bookkeeping: a schema-1 seal has no
    // digest field, so reading it as current would compare the tree against
    // `undefined` and refuse every deploy -- or, written the other way round,
    // silently skip the check. Neither is a thing to leave to chance.
    const s = await site(blogDocs({ posts: 4 }))
    await s.build()
    const sealPath = join(s.workDir, 'build-seal.json')
    const current = JSON.parse(readFileSync(sealPath, 'utf8'))
    assert.equal(current.schema, SEAL_SCHEMA)
    assert.equal(typeof current.digest, 'string')

    const { digest, ...old } = current
    writeFileSync(sealPath, JSON.stringify({ ...old, schema: 1 }))
    assert.equal(readSeal(s.workDir), null)
    await assert.rejects(
      () => deploy({
        outDir: s.outDir, target: directoryTarget({ dir: s.remoteDir }), workDir: s.workDir,
      }),
      /no build seal/)
  })
})

describe('deploy — assets', () => {
  let heroes: string[] = []

  before(async () => {
    heroes = await makeImages(process.env.TEST_ASSET_SRC as string, ['hero-a.jpg', 'hero-b.jpg'])
  })

  test('a changed image is an add plus a delete, never a modify', async () => {
    // Derivative filenames are content-addressed, so editing a source cannot
    // produce a modified file at the same path -- the new bytes arrive under a
    // new name and the old name goes away. Correct, and alarming in a deploy
    // summary if nobody wrote it down.
    const s = await site(blogDocs({ posts: 6, heroes }), BLOG_ASSETS)
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    const before = target.paths().filter((p) => p.startsWith('assets/img/'))
    assert.equal(before.length, 8, 'two sources x two formats x two usable widths')

    // Replace hero-a with different content by generating a third image and
    // copying it over the source.
    const scratch = work('deploy-asset-scratch')
    await makeImages(scratch, ['a.jpg', 'b.jpg', 'c.jpg'])
    copyFileSync(join(scratch, 'c.jpg'), join(process.env.TEST_ASSET_SRC as string, 'hero-a.jpg'))

    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    const img = (xs: string[]) => xs.filter((p) => p.startsWith('assets/img/'))
    assert.equal(img(r.plan.modified).length, 0,
      'a content-addressed name cannot be modified in place')
    assert.equal(img(r.plan.added).length, 4, 'four widths-and-formats under new names')
    assert.equal(img(r.plan.deleted).length, 4, 'the old names are orphaned by the rename')
    assert.equal(target.paths().filter((p) => p.startsWith('assets/img/')).length, 8)
  })

  test('an unchanged image is not re-uploaded on rebuild', async () => {
    const s = await site(blogDocs({ posts: 6, heroes }), BLOG_ASSETS)
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    const second = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.equal(second.uploaded, 0)
    assert.equal(second.plan.deleted.length, 0)
  })
})

describe('deploy — html correctness', () => {
  test('uploaded bytes match the built tree exactly', async () => {
    const s = await site(blogDocs({ posts: 8 }))
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    for (const [rel] of hashTree(s.outDir)) {
      assert.deepEqual(
        readFileSync(join(s.remoteDir, rel)),
        readFileSync(join(s.outDir, rel)),
        `live bytes differ from built bytes at ${rel}`)
    }
  })

  test('a byte-level edit to one live file is caught and repaired', async () => {
    // The negative control for the diff itself: without it, "second deploy
    // uploads nothing" would pass just as happily if the comparison were
    // vacuous.
    const s = await site(blogDocs({ posts: 8 }))
    const target = directoryTarget({ dir: s.remoteDir })
    await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })

    const victim = join(s.remoteDir, 'index.html')
    writeFileSync(victim, readFileSync(victim, 'utf8') + ' ')

    const r = await deploy({ outDir: s.outDir, target, seal: (await s.build()).seal })
    assert.deepEqual(r.plan.modified, ['index.html'])
    assert.deepEqual(readFileSync(victim), readFileSync(join(s.outDir, 'index.html')))
  })
})
