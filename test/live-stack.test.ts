// Integration tests against the actual containers, skipped unless they are up.
//
// The fakes in test/directus-fake.ts and test/s3-fake.ts encode shapes that were
// measured once, by hand, against a real Directus and a real MinIO. Encoded
// shapes rot: a CMS upgrade changes a payload, a field special stops behaving
// the way it did, and every fake-backed test keeps passing against a fiction.
//
// This file is the check on that. It is the only thing in the suite that can
// tell you the fakes have drifted from the thing they imitate, which is why it
// asserts the *shape* facts the fakes depend on rather than re-testing adapter
// logic the unit tests already cover.
//
//   source stack/env.sh && ISSG_LIVE=1 npm test
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { directusCmsAdapter } from '../src/cms-directus.ts'
import { s3DeployTarget } from '../src/deploy-s3.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'

const LIVE = process.env.ISSG_LIVE === '1'
const DIRECTUS = process.env.ISSG_DIRECTUS_URL ?? 'http://127.0.0.1:8055'
const EMAIL = process.env.ISSG_DIRECTUS_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.ISSG_DIRECTUS_PASSWORD ?? 'local-fixture-not-a-secret'
const root = resolve(import.meta.dirname, '..')

const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const freshStore = () => {
  const d = mkdtempSync(join(root, '.tmp', 'live-test-'))
  dirs.push(d)
  return new DocumentStore(join(d, 'content.db'))
}

const adapter = () =>
  directusCmsAdapter({
    baseUrl: DIRECTUS,
    email: EMAIL,
    password: PASSWORD,
    collections: ['post', 'author', 'tag', 'page', 'settings'],
  })

let reachable = false
before(async () => {
  if (!LIVE) return
  try {
    const res = await fetch(`${DIRECTUS}/server/ping`, { signal: AbortSignal.timeout(2000) })
    reachable = res.ok
  } catch {
    reachable = false
  }
  // Loud rather than skipped: ISSG_LIVE=1 is an explicit request for these to
  // run, so a silently-skipped suite would be the worst of both worlds.
  if (!reachable) throw new Error(`ISSG_LIVE=1 but ${DIRECTUS} is not reachable -- run stack/up.sh`)
})

/**
 * Always runs, and exists only to make the tier's absence visible.
 *
 * A skipped `describe` contributes zero tests to the summary, so without this
 * line a run with ISSG_LIVE unset is indistinguishable from one where the live
 * checks passed — the reader sees a green suite and no mention of the thing that
 * did not happen. Silent omission is the failure mode this codebase keeps
 * meeting; a suite is allowed to skip its integration tier, not to hide that it
 * did.
 */
test('live tier reports whether it ran', (t) => {
  t.diagnostic(
    LIVE
      ? `live tier ENABLED against ${DIRECTUS}`
      : 'live tier SKIPPED — set ISSG_LIVE=1 with stack/up.sh running to exercise the real services',
  )
})

describe('live stack — Directus', { skip: LIVE ? false : 'set ISSG_LIVE=1 with stack/up.sh running' }, () => {
  test('a full pull returns every document exactly once', async () => {
    const store = freshStore()
    const res = await sync(adapter(), store, { pageSize: 500, full: true })
    assert.ok(res.pulled > 0, 'the corpus is not empty -- run stack/seed.ts')
    assert.equal(res.pulled, store.count(), 'no document arrived twice or went missing')
    store.close()
  })

  /**
   * The fake asserts this by construction; only the live instance can confirm it
   * is still true. If a Directus upgrade started stamping date_updated on
   * create, the two-column filter would still be correct -- but the reason for
   * it, and the comment explaining it, would have quietly become false.
   */
  test('date_updated is still null on create, which is why the delta filter names two columns', async () => {
    const login = await (
      await fetch(`${DIRECTUS}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      })
    ).json() as { data: { access_token: string } }
    const auth = { authorization: `Bearer ${login.data.access_token}`, 'content-type': 'application/json' }

    const created = await (
      await fetch(`${DIRECTUS}/items/tag`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ doc_id: `tag-live-probe`, slug: 'tag-live-probe', name: 'probe' }),
      })
    ).json() as { data: { date_updated: string | null; date_created: unknown; seq: number } }
    try {
      assert.equal(created.data.date_updated, null, 'date_updated populated on create — the adapter comment is now wrong')
      assert.ok(typeof created.data.date_created === 'string', 'date_created is the only timestamp a create sets')
    } finally {
      await fetch(`${DIRECTUS}/items/tag/${created.data.seq}`, { method: 'DELETE', headers: auth })
    }
  })

  test('a delta pull after a full pull returns far less than the corpus', async () => {
    const store = freshStore()
    const full = await sync(adapter(), store, { pageSize: 500, full: true })
    const delta = await sync(adapter(), store, { pageSize: 500 })
    assert.equal(delta.strategy, 'delta')
    assert.ok(delta.pulled < full.pulled / 10, `delta pulled ${delta.pulled} of ${full.pulled}`)
    assert.equal(delta.changed, 0, 'nothing changed between the two pulls')
    store.close()
  })

  test('listIds returns the same id set as a full pull', async () => {
    const store = freshStore()
    const res = await sync(adapter(), store, { pageSize: 500, full: true })
    const ids = await adapter().listIds()
    assert.equal(ids.length, res.pulled, 'the reconcile scan and the pull disagree')
    assert.equal(new Set(ids.map((i) => i.id)).size, ids.length, 'duplicate ids in the listing')
    store.close()
  })
})

describe('live stack — S3', { skip: LIVE ? false : 'set ISSG_LIVE=1 with stack/up.sh running' }, () => {
  const target = (extra: { pageSize?: number; prefix?: string } = {}) =>
    s3DeployTarget({
      bucket: process.env.ISSG_S3_BUCKET ?? 'issg-site',
      endpoint: process.env.ISSG_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: process.env.ISSG_S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.ISSG_S3_ACCESS_KEY ?? 'issglocal',
      secretAccessKey: process.env.ISSG_S3_SECRET_KEY ?? 'issglocal-fixture',
      prefix: 'live-test',
      ...extra,
    })

  test('an uploaded object lists back with a digest that matches its content', async () => {
    const t = target()
    const body = Buffer.from(`probe ${process.pid}`, 'utf8')
    await t.put('probe.txt', body, 'text/plain')
    try {
      const listed = await t.list()
      const found = listed.find((o) => o.path === 'probe.txt')
      assert.ok(found, 'the object we just uploaded is in the listing')
      // The whole deploy diff rests on this equality holding against a real
      // server, not just against the fake that was written to produce it.
      const { createHash } = await import('node:crypto')
      assert.equal(found.digest, createHash('md5').update(body).digest('hex'))
    } finally {
      await t.remove(['probe.txt'])
    }
  })

  /**
   * The objects are uploaded here rather than found, because the property only
   * exists above one page.
   *
   * This listed the bucket as it found it until 2026-07-28, and the bucket is
   * empty unless a demo:live run happened to leave a site in it -- so on a fresh
   * stack it compared two empty listings, agreed they matched, and reported that
   * pagination against a real server works. A listing longer than the page size
   * is the entire evidence here, and requiring it is what the old version left
   * out.
   */
  test('a real listing paginates past the page size and returns everything', async () => {
    const prefix = 'live-test/paginate'
    const t = target({ pageSize: 10, prefix })
    const paths = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(3, '0')}.txt`)
    await Promise.all(paths.map((p) => t.put(p, Buffer.from(p, 'utf8'), 'text/plain')))
    try {
      const small = await t.list()
      const whole = await target({ pageSize: 1000, prefix }).list()
      // More objects than one request can return, so this listing was assembled
      // by following MinIO's own continuation tokens rather than the fake's --
      // including past the check that refuses a token it has already seen, which
      // a server issuing one token per page must not trip.
      assert.ok(small.length > 10, `paginated: ${small.length} objects at a page size of 10`)
      assert.equal(small.length, paths.length, 'every uploaded object came back exactly once')
      // Page size must change the request count and nothing else. If it changes
      // the result, the continuation-token loop is wrong.
      assert.equal(small.length, whole.length)
      assert.deepEqual(
        small.map((o) => o.path).sort(),
        whole.map((o) => o.path).sort(),
      )
    } finally {
      await t.remove(paths)
    }
  })
})
