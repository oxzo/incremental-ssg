import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync, canonicalJson, SYNC_MUTATING } from '../src/sync.ts'
import { tmpdir, cleanup, blogDocs, EPOCH } from './fixture.ts'
import type { MockDoc } from '../src/cms-mock.ts'
import type { CmsCapabilities } from '../src/cms.ts'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'

const CRASHER = resolve(import.meta.dirname, 'sync-crasher.ts')

const dirs: string[] = []
const fresh = () => {
  const d = tmpdir('sync')
  dirs.push(d)
  return join(d, 'content.db')
}
after(() => dirs.forEach(cleanup))

/** A CMS plus a store, torn down together. */
async function harness(docs: MockDoc[], capabilities?: Partial<CmsCapabilities>) {
  const cms = await startMockCms(docs)
  const dbPath = fresh()
  const store = new DocumentStore(dbPath)
  const adapter = httpCmsAdapter({ baseUrl: cms.url, capabilities })
  return {
    store,
    adapter,
    cms,
    dbPath,
    async close() {
      store.close()
      await cms.close()
    },
  }
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
    assert.equal(h.store.ids().has('post-5'), false)
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
    assert.equal(h.store.ids().has('post-tie'), true)
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
    let child: ChildProcess | null = null
    let killed = false
    const cms = await oneThenHang(docs, () => {
      killed = true
      // SIGKILL, not SIGTERM: the point is a writer that stops existing, with no
      // opportunity to close the database or run a handler.
      child?.kill('SIGKILL')
    })

    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child = spawn(
          process.execPath,
          ['--no-warnings', CRASHER, cms.url, dbPath, '4'],
          { stdio: ['ignore', 'pipe', 'inherit'] })
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
      child?.kill('SIGKILL')
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
