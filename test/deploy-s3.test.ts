import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { s3DeployTarget } from '../src/deploy-s3.ts'
import { startFakeS3, obj } from './s3-fake.ts'
import { startProxy } from '../stack/proxy.ts'
import { planDeploy } from '../src/deploy.ts'
import { RailError } from '../src/rails.ts'

/**
 * Teardown owned by an after() hook rather than a trailing close().
 *
 * A close on the last line of a test does not run when an assertion above it
 * fails -- the leaked server keeps a handle open, node --test waits for the
 * event loop to drain, and a failing test presents as a hang instead of a
 * failure. Found by tools/mutate.py, whose first mutation took 600s to not
 * report anything.
 */
const openables: { close: () => Promise<void> }[] = []
const track = <T extends { close: () => Promise<void> }>(x: T): T => {
  openables.push(x)
  return x
}
after(async () => {
  for (const o of openables.reverse()) await o.close().catch(() => {})
})


const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const targetFor = (url: string, extra: Record<string, unknown> = {}) =>
  s3DeployTarget({
    bucket: 'bucket',
    endpoint: url,
    accessKeyId: 'k',
    secretAccessKey: 's',
    forcePathStyle: true,
    ...extra,
  })

describe('s3 target — listing', () => {
  test('reports md5 ETags as usable digests', async () => {
    const fake = track(await startFakeS3({ objects: [obj('a.html', 'alpha'), obj('b.html', 'beta')] }))
    const listed = await targetFor(fake.url).list()
    assert.deepEqual(
      listed.sort((x, y) => (x.path < y.path ? -1 : 1)),
      [{ path: 'a.html', digest: md5('alpha') }, { path: 'b.html', digest: md5('beta') }],
    )
  })

  /**
   * A multipart ETag is `<hash>-<partcount>` and is not the MD5 of the object.
   * Comparing it to a local MD5 can never match, so treating it as a digest
   * marks the object modified on every deploy and silently re-uploads it
   * forever. Reporting no digest routes it into the diff's existing
   * "cannot tell" path, which says so.
   */
  test('refuses a multipart ETag as a digest rather than comparing it forever', async () => {
    const fake = track(await startFakeS3({
      objects: [obj('big.jpg', 'x'.repeat(64), 'd41d8cd98f00b204e9800998ecf8427e-3')],
    }))
    const listed = await targetFor(fake.url).list()
    assert.equal(listed[0].digest, undefined)

    const plan = planDeploy(new Map([['big.jpg', md5('x'.repeat(64))]]), listed)
    assert.ok(plan.digestsUnavailable, 'the caller is told, not quietly churned')
    assert.deepEqual(plan.modified, ['big.jpg'])
  })

  test('follows continuation tokens to the end of a paginated listing', async () => {
    const objects = Array.from({ length: 250 }, (_, i) => obj(`p/${String(i).padStart(4, '0')}.html`, `body ${i}`))
    const fake = track(await startFakeS3({ objects }))
    const listed = await targetFor(fake.url, { pageSize: 40 }).list()
    assert.equal(listed.length, 250)
    assert.equal(new Set(listed.map((o) => o.path)).size, 250)
    const lists = fake.requests().filter((r) => r.query['list-type'] === '2')
    assert.ok(lists.length >= 7, `paginated in ${lists.length} requests`)
  })

  test('caps page size at the API maximum instead of asking for more', async () => {
    const fake = track(await startFakeS3({ objects: [obj('a', 'a')] }))
    await targetFor(fake.url, { pageSize: 5000 }).list()
    assert.equal(Number(fake.requests()[0].query['max-keys']), 1000)
  })

  /**
   * Above the API ceiling is clamped; unparseable is refused. The two are not
   * the same kind of wrong, and the clamp cannot tell them apart on its own --
   * Math.min(NaN, 1000) is NaN.
   *
   * Measured before it was fixed: MaxKeys: NaN listed zero of twenty-five
   * objects and reported the listing complete. The deploy diff reads an empty
   * remote as a site that needs uploading rather than one that needs deleting,
   * so the visible symptom is a full re-upload on every deploy and no refusal
   * anywhere -- which is the same silence the delete-ratio rail was built to
   * break.
   */
  test('refuses a page size that failed to parse, rather than clamping it to NaN', () => {
    for (const bad of [NaN, 0, -10, 2.5, Infinity]) {
      assert.throws(
        () => targetFor('http://127.0.0.1:1', { pageSize: bad }),
        (e: unknown) => e instanceof RailError && e.terminal && /pageSize/.test((e as Error).message),
        `pageSize ${bad} was accepted`,
      )
    }
    assert.equal(targetFor('http://127.0.0.1:1', { pageSize: undefined }).name, 's3:bucket')
  })

  test('skips directory-marker objects, which match no local file', async () => {
    const fake = track(await startFakeS3({ objects: [obj('dir/', ''), obj('dir/a.html', 'a')] }))
    const listed = await targetFor(fake.url).list()
    // Without the skip, the diff deletes the marker on every single deploy.
    assert.deepEqual(listed.map((o) => o.path), ['dir/a.html'])
  })

  test('strips and re-applies a prefix so paths match the local tree', async () => {
    const fake = track(await startFakeS3({ objects: [obj('site/a.html', 'a'), obj('other/b.html', 'b')] }))
    const target = targetFor(fake.url, { prefix: 'site' })
    const listed = await target.list()
    assert.deepEqual(listed.map((o) => o.path), ['a.html'])
    await target.put('c.html', Buffer.from('c'), 'text/html')
    assert.ok(fake.objects.has('site/c.html'), 'uploads land under the prefix')
  })

  /**
   * The hazard this codebase keeps meeting, in its sixth subsystem. The diff
   * deletes anything live that the local tree lacks, so a listing that is short
   * and *says it is complete* does not report a smaller site -- it issues
   * deletes for pages that are still live.
   */
  test('a silently-truncated listing is caught by the diff as a mass delete', async () => {
    const objects = Array.from({ length: 60 }, (_, i) => obj(`${String(i).padStart(3, '0')}.html`, `body ${i}`))
    const fake = track(await startFakeS3({ objects }))
    const proxy = track(await startProxy({ origin: fake.url, dropListingEntries: 40 }))

    const honest = await targetFor(fake.url).list()
    const truncated = await targetFor(proxy.url).list()
    assert.equal(honest.length, 60)
    assert.ok(truncated.length < 60, `proxy actually truncated: ${truncated.length} of 60`)
    assert.equal(proxy.stats().truncated, 1)

    // The listing is the *remote* side, so a short one makes local files look
    // new rather than making live files look absent -- it re-uploads instead of
    // deleting. Recorded because the direction is the opposite of the instinct.
    const local = new Map(objects.map((o) => [o.key, md5(o.body.toString('utf8'))]))
    const plan = planDeploy(local, truncated)
    assert.ok(plan.added.length > 0, 'a short listing shows up as spurious adds')
    assert.equal(plan.deleted.length, 0)
  })

  // Timed out rather than left open: the failure mode this guards against is a
  // listing loop that never terminates, and an untimed test for it would hang.
  //
  // maxListRequests is set here for the harness rather than for the assertion.
  // Removing the refusal below sends the loop back to page one forever, and a
  // timeout does not stop the loop -- the mutation outlives the test and the run
  // hangs instead of failing, which is how this mutation earned a CI exclusion
  // before the cap existed. With the cap it stops after four requests and fails
  // the matcher, which is a result.
  test('refuses a truncated flag with no continuation token instead of stopping early', { timeout: 10_000 }, async () => {
    const objects = Array.from({ length: 30 }, (_, i) => obj(`${String(i).padStart(3, '0')}.html`, `b${i}`))
    const fake = track(await startFakeS3({ objects }))
    // IsTruncated stays true, the token is gone. A loop that exits when the
    // token is missing returns 10 of 30 objects and calls it a complete listing,
    // which is a mass delete on the next deploy.
    const proxy = track(await startProxy({ origin: fake.url, stripContinuationToken: true }))
    await assert.rejects(
      () => targetFor(proxy.url, { pageSize: 10, maxListRequests: 4 }).list(),
      (e: unknown) => e instanceof RailError && /no continuation token/.test((e as Error).message),
    )
    assert.equal(proxy.stats().truncated, 1, 'the fault actually fired')
  })

  /**
   * A token that comes back a second time is the loop not advancing, and it is
   * invisible to the check above: every response is well-formed, truncated, and
   * carries a token. Nothing in the loop exits, and the object count keeps
   * climbing on duplicates, so a "did this page add anything" rule does not see
   * it either.
   */
  test('refuses a continuation token the server has already issued', async () => {
    const objects = Array.from({ length: 40 }, (_, i) => obj(`${String(i).padStart(3, '0')}.html`, `b${i}`))
    const fake = track(await startFakeS3({ objects }))
    const proxy = track(await startProxy({ origin: fake.url, pinContinuationToken: true }))
    await assert.rejects(
      () => targetFor(proxy.url, { pageSize: 10, maxListRequests: 20 }).list(),
      (e: unknown) => e instanceof RailError && !e.terminal && /already given/.test((e as Error).message),
    )
    assert.ok(proxy.stats().pinned > 0, 'the fault actually fired')
    // Two requests, not twenty. The repeat is refused by name rather than by the
    // cap eventually noticing, which is the difference between a message that
    // says what happened and one that says how long it went on.
    assert.equal(fake.requests().filter((r) => r.query['list-type'] === '2').length, 2)
  })

  /**
   * The bound that holds when the other two do not.
   *
   * The cap is set *below* what an honest listing needs, so removing it makes
   * this test complete rather than hang. A test for a loop bound that can only
   * fail by running forever cannot report the bound's absence -- tools/mutate.py
   * reads that as no result, which is the state this whole item came out of.
   */
  test('refuses a listing that outruns the request cap instead of following it forever', async () => {
    const objects = Array.from({ length: 250 }, (_, i) => obj(`p/${String(i).padStart(4, '0')}.html`, `b${i}`))
    const fake = track(await startFakeS3({ objects }))
    await assert.rejects(
      () => targetFor(fake.url, { pageSize: 10, maxListRequests: 5 }).list(),
      (e: unknown) =>
        e instanceof RailError && !e.terminal && /did not end within 5 requests/.test((e as Error).message),
    )
    const lists = fake.requests().filter((r) => r.query['list-type'] === '2')
    assert.equal(lists.length, 5, 'it stopped at the cap rather than somewhere past it')
  })

  /**
   * The negative control for the refusals above: a page can retain nothing and
   * still be a listing that is advancing normally.
   *
   * The rule this replaced refused a truncated page that added no objects, which
   * reads as "the token is not advancing" and is not the same statement -- the
   * directory markers filtered out above are keys the server returned. A bucket
   * whose first page is all markers is a listing this deploy must follow, not
   * one it may refuse.
   */
  test('follows a page that retains nothing, because filtered keys are still progress', async () => {
    const markers = Array.from({ length: 10 }, (_, i) => obj(`${String(i).padStart(3, '0')}/`, ''))
    const files = Array.from({ length: 10 }, (_, i) => obj(`1${String(i).padStart(2, '0')}.html`, `b${i}`))
    const fake = track(await startFakeS3({ objects: [...markers, ...files] }))
    const listed = await targetFor(fake.url, { pageSize: 10 }).list()
    assert.deepEqual(listed.map((o) => o.path), files.map((o) => o.key))
  })
})

describe('s3 target — writes', () => {
  test('uploads and then reports the object as unchanged', async () => {
    const fake = track(await startFakeS3())
    const target = targetFor(fake.url)
    await target.put('a.html', Buffer.from('hello'), 'text/html')
    const listed = await target.list()
    assert.deepEqual(listed, [{ path: 'a.html', digest: md5('hello') }])
  })

  test('chunks deletes at the API limit of 1000 keys', async () => {
    const objects = Array.from({ length: 2300 }, (_, i) => obj(`${i}.html`, 'x'))
    const fake = track(await startFakeS3({ objects }))
    await targetFor(fake.url).remove(objects.map((o) => o.key))
    const deletes = fake.requests().filter((r) => r.method === 'POST' && 'delete' in r.query)
    assert.equal(deletes.length, 3, '2300 keys is three requests, not one oversized one')
    assert.equal(fake.objects.size, 0)
  })

  /**
   * S3 reports per-key delete failures inside a 200 response. A client that
   * checks only the status records a deletion that did not happen -- the same
   * silent-incompleteness shape as the truncated listing, from the write side.
   */
  test('raises per-key delete errors that arrive inside a 200', async () => {
    const fake = track(await startFakeS3({ objects: [obj('a.html', 'a'), obj('b.html', 'b')] }))
    fake.failDeletes.add('b.html')
    await assert.rejects(
      () => targetFor(fake.url).remove(['a.html', 'b.html']),
      (e: unknown) => e instanceof RailError && !e.terminal && /1 of 2/.test((e as Error).message),
    )
  })
})

describe('s3 target — capabilities', () => {
  test('declares md5 so the local side hashes comparably', () => {
    assert.equal(targetFor('http://x').digestAlgorithm, 'md5')
  })

  test('declares no path purge, because a bucket has no CDN in front of it', async () => {
    const purged: string[] = []
    const target = s3DeployTarget({
      bucket: 'b', endpoint: 'http://x', accessKeyId: 'k', secretAccessKey: 's',
      onPurge: (p) => purged.push(...p),
    })
    assert.equal(target.capabilities.pathPurge, false)
    await target.purge(['a.html'])
    // A no-op that records. Silently accepting the purge would make a deploy
    // report success for a step that never happened.
    assert.deepEqual(purged, ['a.html'])
  })
})
