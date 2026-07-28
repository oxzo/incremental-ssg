import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync, canonicalJson, SYNC_MUTATING, WATERMARK } from '../src/sync.ts'
import { tmpdir, cleanup, blogDocs, EPOCH } from './fixture.ts'
import type { MockDoc } from '../src/cms-mock.ts'
import type { CmsCapabilities, CmsDocument } from '../src/cms.ts'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'

const CRASHER = resolve(import.meta.dirname, 'sync-crasher.ts')

/**
 * Bare ids, for assertions that predate the (type, id) key and do not depend on
 * it. A convenience for tests whose fixtures use one type per id -- the store
 * itself deliberately offers no such view, because an id alone does not name a
 * document any more.
 */
const idsOf = (s: DocumentStore) => new Set(s.refs().map((r) => r.id))

const dirs: string[] = []
const fresh = () => {
  const d = tmpdir('sync')
  dirs.push(d)
  return join(d, 'content.db')
}
after(() => dirs.forEach(cleanup))

/**
 * A CMS plus a store, torn down together.
 *
 * Cleanup is registered here rather than left to each test's last line, and that
 * is not tidiness. Most tests below close on the happy path, so an assertion
 * that *fails* skips the close, leaves a listening server, and the file never
 * exits -- turning a detected defect into a hang. tools/mutate.py reads a hang
 * as "no result", so the suite would stop being able to tell anyone it caught
 * the bug it caught. Found exactly that way, by a mutation that failed the right
 * two tests and then hung.
 *
 * `close()` stays public and idempotent so the existing explicit calls are still
 * correct, and closing early still frees the port.
 */
const open: { close: () => Promise<void> }[] = []
after(async () => {
  for (const h of open) await h.close()
})

async function harness(docs: MockDoc[], capabilities?: Partial<CmsCapabilities>) {
  const cms = await startMockCms(docs)
  const dbPath = fresh()
  const store = new DocumentStore(dbPath)
  const adapter = httpCmsAdapter({ baseUrl: cms.url, capabilities })
  let closed = false
  const h = {
    store,
    adapter,
    cms,
    dbPath,
    async close() {
      if (closed) return
      closed = true
      store.close()
      await cms.close()
    },
  }
  open.push(h)
  return h
}

describe('canonicalJson', () => {
  test('sorts object keys so key order churn is not a content change', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  })

  test('recurses into nested objects and preserves array order', () => {
    assert.equal(canonicalJson({ z: { d: 1, c: 2 }, a: [3, 1, 2] }), '{"a":[3,1,2],"z":{"c":2,"d":1}}')
  })

  test('handles primitives, null, and dropped undefined members', () => {
    assert.equal(canonicalJson(null), 'null')
    assert.equal(canonicalJson('x'), '"x"')
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  })
})

describe('sync', () => {
  test('a first sync is a full pull and stores everything', async () => {
    const docs = blogDocs({ posts: 10 })
    const h = await harness(docs)
    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.strategy, 'full')
    assert.equal(r.pulled, docs.length)
    assert.equal(r.changed, docs.length, 'nothing was stored before, so everything changed')
    assert.equal(r.deleted, 0)
    assert.equal(h.store.count(), docs.length)
    await h.close()
  })

  test('paginates, and page size drives request count', async () => {
    const docs = blogDocs({ posts: 40 })
    const h = await harness(docs)
    const r = await sync(h.adapter, h.store, { pageSize: 10 })
    assert.equal(r.pulled, docs.length)
    // Phase 2b's headline sync finding: request count is the dominant lever on
    // wall time, and it is set here.
    assert.equal(r.requests, Math.ceil(docs.length / 10))
    await h.close()
  })

  test('a re-sync with no edits is a delta pull reporting zero changes', async () => {
    const h = await harness(blogDocs({ posts: 10 }))
    await sync(h.adapter, h.store, { pageSize: 500 })
    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.strategy, 'delta')
    assert.equal(r.changed, 0, 'unchanged documents must not report as changed')
    await h.close()
  })

  test('an edited document is the only reported change', async () => {
    const docs = blogDocs({ posts: 10 })
    const h = await harness(docs)
    await sync(h.adapter, h.store, { pageSize: 500 })

    const target = docs.find((d) => d.doc.id === 'post-3')
    assert.ok(target)
    target.doc.title = 'edited title'
    target.doc.updated_at = EPOCH + 60_000
    target.doc.rev = 'r2-post-3'

    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.strategy, 'delta')
    assert.equal(r.changed, 1)
    const stored = h.store.byType(['post']).get('post') ?? []
    assert.equal(stored.find((p) => p.id === 'post-3')?.title, 'edited title')
    await h.close()
  })

  test('reordering a document\'s keys is not an edit', async () => {
    const docs = blogDocs({ posts: 5 })
    const h = await harness(docs)
    await sync(h.adapter, h.store, { pageSize: 500 })

    const target = docs.find((d) => d.doc.id === 'post-1')
    assert.ok(target)
    const reversed: Record<string, unknown> & { id: string } = { id: target.doc.id }
    for (const k of Object.keys(target.doc).reverse()) reversed[k] = target.doc[k]
    target.doc = reversed

    const r = await sync(h.adapter, h.store, { pageSize: 500, full: true })
    assert.equal(r.changed, 0, 'canonical JSON means key order is not content')
    await h.close()
  })

  test('a delete is caught by the reconcile scan, which delta sync cannot see', async () => {
    const docs = blogDocs({ posts: 10 })
    const h = await harness(docs)
    await sync(h.adapter, h.store, { pageSize: 500 })
    const before = h.store.count()

    const i = docs.findIndex((d) => d.doc.id === 'post-5')
    docs.splice(i, 1)

    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.strategy, 'delta')
    // The delta pull returns no evidence at all that post-5 is gone -- an
    // `updatedAt >` query cannot return a document that no longer exists. Only
    // the id-listing scan catches it.
    assert.equal(r.changed, 0)
    assert.equal(r.deleted, 1)
    assert.equal(h.store.count(), before - 1)
    assert.equal(idsOf(h.store).has('post-5'), false)
    await h.close()
  })

  test('a full sync reconciles from what it already pulled, with no extra request', async () => {
    const docs = blogDocs({ posts: 10 })
    const h = await harness(docs)
    await sync(h.adapter, h.store, { pageSize: 500 })
    docs.splice(docs.findIndex((d) => d.doc.id === 'post-2'), 1)

    const r = await sync(h.adapter, h.store, { pageSize: 500, full: true })
    assert.equal(r.strategy, 'full')
    assert.equal(r.deleted, 1)
    // Pages until the cursor is exhausted, and no /ids call on top.
    assert.equal(r.requests, 1)
    await h.close()
  })

  test('an adapter without delta sync always pulls in full', async () => {
    const h = await harness(blogDocs({ posts: 5 }), { deltaSync: false })
    await sync(h.adapter, h.store, { pageSize: 500 })
    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.strategy, 'full', 'no delta capability means the cost model is full-pull-and-hash')
    assert.equal(r.changed, 0, 'hashing still identifies that nothing actually changed')
    await h.close()
  })

  test('an adapter without id listing does not delete anything', async () => {
    const docs = blogDocs({ posts: 5 })
    const h = await harness(docs, { idListing: false })
    await sync(h.adapter, h.store, { pageSize: 500 })
    const before = h.store.count()
    docs.splice(docs.findIndex((d) => d.doc.id === 'post-1'), 1)
    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.deleted, 0)
    assert.equal(h.store.count(), before, 'without an id listing, deletes are simply undetectable')
    await h.close()
  })

  test('a document sharing the watermark timestamp is not lost at the delta boundary', async () => {
    // `since` is exclusive, so querying at exactly the stored watermark drops
    // any document stamped in the same tick as the newest one already held --
    // a real risk with second-granularity CMS timestamps. The driver re-pulls
    // the boundary tick to close it.
    const docs = blogDocs({ posts: 5 })
    const h = await harness(docs)
    const first = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(first.watermark, EPOCH)

    docs.push({
      type: 'post',
      doc: {
        id: 'post-tie', slug: 'post-tie', title: 'same tick', author: 'author-0',
        tags: ['tag-0'], date: EPOCH, body: 'x', updated_at: EPOCH, rev: 'r1-post-tie',
      },
    })

    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.changed, 1)
    assert.equal(idsOf(h.store).has('post-tie'), true)
    await h.close()
  })

  test('a CMS without revisions gets the content hash as its revision', async () => {
    const docs: MockDoc[] = [{ type: 'settings', doc: { id: 'settings', siteName: 'x', updated_at: 1 } }]
    const h = await harness(docs)
    const r = await sync(h.adapter, h.store, { pageSize: 500 })
    assert.equal(r.changed, 1)
    // Revisions are compared for equality only, so a hash is a valid one.
    assert.equal(h.store.count(), 1)
    await h.close()
  })

  test('contentTypes filters what is stored', async () => {
    const docs = blogDocs({ posts: 5 })
    const h = await harness(docs)
    await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post'], reconcile: false })
    const stored = h.store.byType(['post', 'author'])
    assert.equal((stored.get('post') ?? []).length, 5)
    assert.equal((stored.get('author') ?? []).length, 0)
    await h.close()
  })
})

/**
 * A document that changes type, which is a change to the site and was not a
 * change to the store.
 *
 * Change detection compared content hashes keyed on id, so the type a document
 * carries was outside the comparison entirely. Routes are resolved per type, so
 * a document moving between two rendered types moves which pages exist -- and
 * the sync reported `changed: 0`, the service skipped the build, and the site
 * kept serving the old shape.
 *
 * The second half is worse and quieter. A document moving to a type this site
 * does *not* render kept its stored row: on a full pull it is in `seen`, and on
 * a delta pull `listIds()` carries no type at all, so neither reconcile path can
 * see it. Its page stayed published against content nothing would ever update.
 */
describe('content type transitions', () => {
  const TYPES = ['post', 'author', 'tag', 'page', 'settings']

  test('moving between two rendered types is a change, though the body is not', async () => {
    const docs = blogDocs({ posts: 3 })
    const h = await harness(docs)
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      const post = docs.find((d) => d.type === 'post')!
      const id = String(post.doc.id)

      // The only thing that differs is the type. Body, revision and timestamp
      // are untouched, so a comparison on content alone sees nothing at all --
      // which is exactly the case that used to slip through.
      post.type = 'page'

      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES, full: true })
      assert.equal(r.changed, 1, 'a type change must be reported as a change')
      // One, not zero, and the change is deliberate. Under a (type, id) key the
      // row at (post, id) genuinely ceased to exist -- the CMS no longer lists
      // anything there -- so the reconcile removes it and `deleted` counts a row
      // that really did leave the mirror. The document is not lost: it is now
      // the row at (page, id), asserted below. Reported honestly rather than
      // suppressed, because the service reads `deleted` to decide it must
      // publish, and route membership did change.
      assert.equal(r.deleted, 1, 'the row at the old type is gone; the document is not')

      const stored = h.store.byType(['page', 'post'])
      assert.ok(
        (stored.get('page') ?? []).some((d) => d.id === id),
        'the document should now be stored as a page')
      assert.ok(
        !(stored.get('post') ?? []).some((d) => d.id === id),
        'and no longer as a post')
    } finally {
      await h.close()
    }
  })

  test('an otherwise untouched re-sync still reports nothing changed', async () => {
    // The control. Type is now part of the compared identity, and both sides
    // build it through the same function -- so an unchanged corpus must still
    // report zero rather than every document suddenly looking new.
    const h = await harness(blogDocs({ posts: 4 }))
    try {
      const first = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      assert.ok(first.changed > 0)
      const again = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES, full: true })
      assert.equal(again.changed, 0)
      assert.equal(again.deleted, 0)
    } finally {
      await h.close()
    }
  })

  test('moving to an unrendered type removes the stored row, on a full pull', async () => {
    const docs = blogDocs({ posts: 3 })
    const h = await harness(docs)
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      const post = docs.find((d) => d.type === 'post')!
      const id = String(post.doc.id)
      assert.ok(idsOf(h.store).has(id))

      // Still in the CMS, no longer a type this site renders -- an editor moving
      // a post into an internal collection, or a config that stopped listing it.
      post.type = 'internal-note'

      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES, full: true })
      assert.equal(r.deleted, 1, 'the out-of-scope document must leave the mirror')
      assert.equal(idsOf(h.store).has(id), false)
    } finally {
      await h.close()
    }
  })

  test('and on a delta pull, where the change is invisible to the delta filter', async () => {
    // listIds() carries the type now, so a reconcile can see this transition
    // where it once could not -- the row at the old type is absent from a
    // listing that enumerates every collection. Kept because the delta path
    // reaches it by a different route than the full path, and because the delta
    // *filter* still cannot see a type change on its own.
    const docs = blogDocs({ posts: 3 })
    const h = await harness(docs)
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      const post = docs.find((d) => d.type === 'post')!
      const id = String(post.doc.id)

      post.type = 'internal-note'
      post.doc.updated_at = Number(post.doc.updated_at) + 1000

      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      assert.equal(r.strategy, 'delta', 'this test is only meaningful on the delta path')
      assert.equal(r.deleted, 1)
      assert.equal(idsOf(h.store).has(id), false)
    } finally {
      await h.close()
    }
  })

  test('a type dropping out of the site config removes its stored rows', async () => {
    // What the targeted removal is *for*, now that (type, id) is the key.
    //
    // It used to be the only path that could remove a document which moved from
    // a rendered type to an unrendered one, because a mirror keyed by id alone
    // could not see a type change. The composite key turned that into an
    // ordinary disappearance, which the reconcile handles. What is left is the
    // case a reconcile still cannot reach: the document is present in the CMS
    // and therefore in `seen`, so deleteMissing will spare it -- but the site
    // stopped listing its type. Config change, not content change, and the CMS
    // positively stated the type, so it keeps the ratio-free removal.
    const docs = blogDocs({ posts: 3 })
    const h = await harness(docs)
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'] })
      const pages = h.store.refs().filter((r) => r.type === 'page')
      assert.ok(pages.length > 0, 'the fixture must contain pages for this to mean anything')

      // The same corpus, with 'page' no longer rendered by this site.
      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post'], full: true })
      assert.equal(r.deleted, pages.length, 'every row at the dropped type must go')
      assert.equal(h.store.refs().some((x) => x.type === 'page'), false)
    } finally {
      await h.close()
    }
  })

  test('a document that was never stored is not reported as deleted', async () => {
    // The control for the two above: an excluded type that was never in scope
    // is not a transition and must not inflate the delete count, which the
    // service reads as "something changed, publish".
    const docs = blogDocs({ posts: 2 })
    docs.push({ type: 'internal-note', doc: { id: 'note-1', updated_at: 1, rev: 'r1' } })
    const h = await harness(docs)
    try {
      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      assert.equal(r.deleted, 0)
      assert.equal(idsOf(h.store).has('note-1'), false)
    } finally {
      await h.close()
    }
  })

  test('deleteIds removes exactly the named rows and no others', async () => {
    const h = await harness(blogDocs({ posts: 4 }))
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: TYPES })
      const all = h.store.refs()
      const doomed = all.slice(0, 2)
      // No ratio ceiling, deliberately: this is positive per-document evidence
      // from the CMS, not an inference from a listing that might be short. Half
      // the mirror would trip deleteMissing's rail; here it must not.
      assert.equal(h.store.deleteIds(doomed), 2)
      assert.equal(h.store.count(), all.length - 2)
      // An id that is not stored is not an error and is not counted.
      assert.equal(h.store.deleteIds([{ type: 'post', id: 'no-such-id' }]), 0)
      assert.equal(h.store.deleteIds([]), 0)
    } finally {
      await h.close()
    }
  })
})

/**
 * The window between sync's first commit and its watermark write.
 *
 * Documents land page by page and the watermark is written once at the end, so a
 * crash in between leaves a store that is ahead of the cursor describing it. The
 * loss is silent: the restart re-pulls from the old watermark, finds those
 * documents already stored, reports `changed: 0`, and advances the watermark
 * over them. Every individual step is correct and the publish is gone.
 */
describe('sync interrupted mid-write', () => {
  /**
   * Serves one page, then hangs -- and reports the hang so the caller can kill
   * the client while it waits.
   *
   * The second request is the kill point because sync commits each page before
   * asking for the next, so its arrival *proves* page one is durable. That makes
   * the test deterministic where a timer would be a guess: no sleep long enough
   * to be reliable, no sleep short enough to be fast.
   */
  function oneThenHang(docs: MockDoc[], onHang: () => void) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const cursor = url.searchParams.get('cursor')
      if (cursor !== null) {
        onHang()
        return // deliberately never answered
      }
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const slice = docs.slice(0, limit)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        items: slice,
        next: limit < docs.length ? String(limit) : null,
        total: docs.length,
      }))
    })
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        })
      })
    })
  }

  test('a sync killed after its first page leaves the marker set and the watermark behind', async () => {
    const docs = blogDocs({ posts: 8 })
    const dbPath = fresh()
    // A holder rather than a bare `let`. The CMS handler has to be able to kill
    // a child that does not exist yet -- the child needs the CMS's url -- and a
    // variable only ever assigned inside a callback is one the checker
    // reasonably concludes is still null everywhere else.
    const proc: { child: ChildProcess | null } = { child: null }
    let killed = false
    const cms = await oneThenHang(docs, () => {
      killed = true
      // SIGKILL, not SIGTERM: the point is a writer that stops existing, with no
      // opportunity to close the database or run a handler.
      proc.child?.kill('SIGKILL')
    })

    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--no-warnings', CRASHER, cms.url, dbPath, '4'],
          { stdio: ['ignore', 'pipe', 'inherit'] })
        proc.child = child
        let out = ''
        child.stdout!.on('data', (b) => { out += String(b) })
        child.on('error', reject)
        child.on('exit', (code, signal) => {
          assert.ok(!out.includes('completed'), 'the sync finished; the kill point never fired')
          resolve(signal === null ? code : null)
        })
      })
      assert.equal(killed, true, 'the CMS never saw a second request')
      assert.equal(exit, null, 'the child should have died by signal, not exited')

      const store = new DocumentStore(dbPath)
      try {
        // Page one is durable -- this is the content that has nothing pointing
        // at it, and the whole reason the marker has to exist.
        assert.equal(store.count(), 4)
        assert.equal(store.getMeta('sync:watermark'), null, 'the watermark must not have advanced')
        assert.equal(
          store.getMeta(SYNC_MUTATING), '1',
          'an interrupted sync must leave the marker that says so')
      } finally {
        store.close()
      }
    } finally {
      proc.child?.kill('SIGKILL')
      await cms.close()
    }
  })

  test('a completed sync clears the marker, so an idle poll is not wedged into rebuilding', async () => {
    const h = await harness(blogDocs({ posts: 3 }))
    try {
      // Set by hand, as a previous crashed sync would have left it. A completed
      // sync must clear it even though this run never mutated anything --
      // otherwise recovering from one crash costs a rebuild on every poll from
      // then on, which trades a lost publish for a permanently busy service.
      h.store.setMeta(SYNC_MUTATING, '1')
      await sync(h.adapter, h.store, { pageSize: 500 })
      assert.equal(h.store.getMeta(SYNC_MUTATING), '0')

      const idle = await sync(h.adapter, h.store, { pageSize: 500 })
      assert.equal(idle.changed, 0)
      assert.equal(h.store.getMeta(SYNC_MUTATING), '0')
    } finally {
      await h.close()
    }
  })
})

// What the CMS says it has, against what it actually sent.
//
// Until now the only completeness evidence was `cursor === null`, which is the
// CMS agreeing with itself. `seen` feeds deleteMissing, so a listing that comes
// back short does not merely miss documents -- it presents their absence as
// deletions, and the ratio ceiling passes anything under half the mirror.
describe('sync — a listing that came back short', () => {
  const doc = (id: string): CmsDocument => ({
    id,
    type: 'post',
    revision: `r-${id}`,
    updatedAt: EPOCH,
    doc: { id, title: id },
  })

  /**
   * An adapter that reports a count and delivers a list, independently.
   *
   * Written as a fake rather than driven through the mock HTTP server on
   * purpose: the rail reads `CmsPage.total`, which is an adapter-contract value,
   * and a lying HTTP server would test the http adapter's parsing on the way to
   * testing this. `deltaSync: false` keeps every sync a full pull, which is the
   * path where `seen` decides what gets deleted.
   */
  const counting = (docs: CmsDocument[], total: number | undefined, deliver = docs.length) => ({
    name: 'counting',
    capabilities: { deltaSync: false, idListing: true, webhookRevisions: false },
    async list() {
      return { items: docs.slice(0, deliver), cursor: null, total }
    },
    async listIds() {
      return docs.map((d) => ({ type: d.type, id: d.id, revision: d.revision }))
    },
    revisionOf: () => null,
    bytesRead: () => 0,
  })

  const ten = Array.from({ length: 10 }, (_, i) => doc(`d${i}`))

  /** A store already holding all ten, as a previous good sync would have left it. */
  async function seeded() {
    const store = new DocumentStore(fresh())
    await sync(counting(ten, 10), store, { pageSize: 500 })
    assert.equal(store.identities().size, 10)
    return store
  }

  test('is refused before anything is inferred from an absence', async () => {
    const store = await seeded()
    try {
      await assert.rejects(
        () => sync(counting(ten, 10, 6), store, { pageSize: 500 }),
        (e: Error) => {
          assert.match(e.message, /reported 10 documents .* and returned 6/)
          assert.equal((e as { rail?: string }).rail, 'sync.short-listing')
          // Transient: a document deleted mid-pull produces exactly this and
          // resolves itself, so a retry is the remedy rather than a human.
          assert.equal((e as { terminal?: boolean }).terminal, false)
          return true
        })
      // The four it did not send are still here. That is the whole point: they
      // exist, and the only evidence they did not was a listing that was short.
      assert.equal(store.identities().size, 10)
    } finally {
      store.close()
    }
  })

  test('leaves the watermark where it was, not only the rows', async () => {
    // Refusing just the delete pass would still advance the watermark past
    // documents that were never seen -- and `since` is exclusive, so a delta
    // pull can never ask for them again. Silent and permanent.
    const store = await seeded()
    try {
      const before = store.getMeta(WATERMARK)
      await assert.rejects(() => sync(counting(ten, 10, 6), store, { pageSize: 500 }))
      assert.equal(store.getMeta(WATERMARK), before)
      // And it stays marked, so the service treats the store as dirty and the
      // upserts that did commit are not stranded.
      assert.equal(store.getMeta(SYNC_MUTATING), '1')
    } finally {
      store.close()
    }
  })

  test('a listing that delivers what it promised is not refused', async () => {
    // The negative control. A rail that refused everything would pass the two
    // tests above.
    const store = await seeded()
    try {
      const r = await sync(counting(ten, 10), store, { pageSize: 500 })
      assert.equal(r.pulled, 10)
      assert.equal(r.deleted, 0)
      assert.equal(store.identities().size, 10)
    } finally {
      store.close()
    }
  })

  test('delivering MORE than the count promised is not refused', async () => {
    // One-sided on purpose: a document created while the pull was running makes
    // the count an undercount, and that is the CMS behaving correctly. A rail
    // that fires on correct behaviour costs more trust than the one it saves.
    const store = await seeded()
    try {
      const r = await sync(counting(ten, 8), store, { pageSize: 500 })
      assert.equal(r.pulled, 10)
    } finally {
      store.close()
    }
  })

  test('an adapter that reports no count disables the check rather than failing it', async () => {
    // Absence has to stay distinguishable from zero. An adapter that cannot
    // count says so by omitting the field, and the old behaviour is what it
    // gets: the four missing documents are reconciled away as deletes, guarded
    // only by the ratio ceiling. Stated by a test rather than left to be
    // discovered, because this is the gap the rail does not close.
    const store = await seeded()
    try {
      const r = await sync(counting(ten, undefined, 6), store, { pageSize: 500 })
      assert.equal(r.pulled, 6)
      assert.equal(r.deleted, 4)
      assert.equal(store.identities().size, 6)
    } finally {
      store.close()
    }
  })

})

// Two collections, one id. The mirror was keyed by id alone until this, and a
// multi-collection CMS puts no constraint across collections.
describe('sync — documents are identified by (type, id)', () => {
  const shared = (): MockDoc[] => [
    { type: 'post', doc: { id: 'shared', title: 'THE POST', updated_at: 1000, rev: 'rp' } },
    { type: 'page', doc: { id: 'shared', title: 'THE PAGE', updated_at: 1000, rev: 'rg' } },
    { type: 'post', doc: { id: 'post-only', title: 'a post', updated_at: 1000, rev: 'r1' } },
  ]

  test('an id shared across two types keeps both documents', async () => {
    const h = await harness(shared())
    try {
      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'] })
      assert.equal(r.pulled, 3)
      // Three sent, three stored. Under the old key this was three sent and two
      // stored, with the post's "shared" silently replaced by the page's.
      assert.equal(h.store.count(), 3)
      const stored = h.store.byType(['post', 'page'])
      assert.equal((stored.get('post') ?? []).find((d) => d.id === 'shared')?.title, 'THE POST')
      assert.equal((stored.get('page') ?? []).find((d) => d.id === 'shared')?.title, 'THE PAGE')
    } finally {
      await h.close()
    }
  })

  test('and the mirror converges, which is the half that made it expensive', async () => {
    // The finding that decided this item. A collision is not a one-time
    // overwrite: the two documents overwrite each other on every sync, because
    // `known` is a snapshot taken before the pull and the loser always differs
    // from it. `changed` therefore never reaches zero, and the service publishes
    // whenever it is non-zero -- so one shared id rebuilt and redeployed the
    // entire site on every poll, forever, with nothing reported anywhere.
    const h = await harness(shared())
    try {
      const first = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'] })
      assert.equal(first.changed, 3)
      const again = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'], full: true })
      assert.equal(again.changed, 0, 'a settled corpus must report no change')
      assert.equal(again.deleted, 0)
    } finally {
      await h.close()
    }
  })

  test('a delete reconcile does not confuse one for the other', async () => {
    // listIds() carries the type for this reason: a reconcile built from ids
    // alone would compare a set of ids against a set of (type, id) keys, find
    // every key missing, and propose deleting the whole mirror.
    const docs = shared()
    const h = await harness(docs)
    try {
      await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'] })
      docs.splice(1, 1) // the page's "shared" is deleted in the CMS
      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'], full: true })
      assert.equal(r.deleted, 1, 'exactly the page, not the post that shares its id')
      const stored = h.store.byType(['post', 'page'])
      assert.equal((stored.get('post') ?? []).find((d) => d.id === 'shared')?.title, 'THE POST')
      assert.equal((stored.get('page') ?? []).length, 0)
    } finally {
      await h.close()
    }
  })

  test('two documents at the SAME type and id are refused, terminally', async () => {
    // What the composite key does not fix and was never meant to: an id shared
    // *inside* one type, which happens when two collections are mapped onto one
    // type. There is no correct resolution, so it is a refusal rather than a
    // silent winner.
    const h = await harness([
      { type: 'post', doc: { id: 'dup', title: 'first', updated_at: 1000, rev: 'r1' } },
      { type: 'post', doc: { id: 'dup', title: 'second', updated_at: 1000, rev: 'r2' } },
    ])
    try {
      await assert.rejects(
        () => sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post'] }),
        (e: Error) => {
          assert.equal((e as { rail?: string }).rail, 'cms.duplicate-document')
          assert.equal((e as { terminal?: boolean }).terminal, true)
          assert.match(e.message, /both "dup" at type "post"/)
          return true
        })
    } finally {
      await h.close()
    }
  })

  test('the same corpus without duplicates is not refused', async () => {
    // The negative control for the refusal above: it has to fire on a repeated
    // (type, id) and not merely on a repeated id.
    const h = await harness([
      { type: 'post', doc: { id: 'dup', title: 'first', updated_at: 1000, rev: 'r1' } },
      { type: 'page', doc: { id: 'dup', title: 'second', updated_at: 1000, rev: 'r2' } },
    ])
    try {
      const r = await sync(h.adapter, h.store, { pageSize: 500, contentTypes: ['post', 'page'] })
      assert.equal(r.pulled, 2)
      assert.equal(h.store.count(), 2)
    } finally {
      await h.close()
    }
  })
})
