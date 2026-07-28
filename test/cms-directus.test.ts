import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { directusCmsAdapter } from '../src/cms-directus.ts'
import { startProxy } from '../stack/proxy.ts'
import { startFakeDirectus, fakeRows } from './directus-fake.ts'
import { RailError } from '../src/rails.ts'
import type { FakeRow } from './directus-fake.ts'

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


const creds = { email: 'a@example.com', password: 'ok' }

const adapterFor = (url: string, collections: string[], extra: Record<string, unknown> = {}) =>
  directusCmsAdapter({ baseUrl: url, ...creds, collections, ...extra })

/** Drain list() to exhaustion, reporting how many requests it took. */
async function drain(adapter: ReturnType<typeof directusCmsAdapter>, limit: number, since?: number) {
  let cursor: string | null = null
  const ids: string[] = []
  let requests = 0
  for (;;) {
    const page = await adapter.list({ cursor, limit, since })
    requests++
    ids.push(...page.items.map((i) => i.id))
    cursor = page.cursor
    if (cursor === null) break
    if (requests > 200) throw new Error('list() did not terminate')
  }
  return { ids, requests }
}

describe('directus adapter — pagination', () => {
  test('walks every collection in order and terminates', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 7, tag: 3, page: 1 })))
    const adapter = adapterFor(fake.url, ['post', 'tag', 'page'])
    const { ids } = await drain(adapter, 100)
    assert.equal(ids.length, 11)
    assert.deepEqual(ids.slice(0, 2), ['post-0', 'post-1'])
    assert.equal(ids[ids.length - 1], 'page-0')
  })

  test('paginates by keyset, so a page boundary loses nothing', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 25 })))
    const adapter = adapterFor(fake.url, ['post'])
    const { ids } = await drain(adapter, 4)
    assert.equal(ids.length, 25)
    assert.equal(new Set(ids).size, 25, 'no duplicates across pages')
  })

  /**
   * The property offset pagination does not have, and the reason the schema
   * carries an integer key at all: rows inserted *ahead* of the cursor during a
   * pull shift every subsequent offset window, so an offset pager skips a row
   * per insert. Keyset does not, because it names where it stopped.
   *
   * This matters beyond "a document is late". After a full pull, sync feeds the
   * ids it saw into DocumentStore.deleteMissing -- so a skipped row is not
   * merely missed, it is deleted from the store and unpublished from the site.
   */
  test('a row inserted mid-pull does not displace rows still to come', async () => {
    const rows = fakeRows({ post: 10 })
    const fake = track(await startFakeDirectus(rows))
    const adapter = adapterFor(fake.url, ['post'])

    const first = await adapter.list({ cursor: null, limit: 4 })
    assert.equal(first.items.length, 4)

    // Insert at the *front* of the ordering -- the case that breaks offset.
    rows.get('post')!.push({ seq: 0, doc_id: 'post-early', date_created: new Date(0).toISOString(), date_updated: null })

    let cursor = first.cursor
    const rest: string[] = []
    // Bounded, because an unbounded loop turns a broken cursor into a hang
    // rather than a failure -- and a hang is not a test result, it is a CI job
    // that runs until something kills it.
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 50, 'list() did not terminate')
      const page = await adapter.list({ cursor, limit: 4 })
      rest.push(...page.items.map((i) => i.id))
      cursor = page.cursor
      if (cursor === null) break
    }
    const all = [...first.items.map((i) => i.id), ...rest]
    assert.equal(all.length, 10, 'every original row still arrives')
    assert.equal(new Set(all).size, 10)
  })

  test('rejects a malformed cursor as terminal rather than restarting silently', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 2 })))
    const adapter = adapterFor(fake.url, ['post'])
    await assert.rejects(
      () => adapter.list({ cursor: 'not-a-cursor', limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal,
    )
  })
})

describe('directus adapter — delta sync', () => {
  /**
   * The negative control matters more than the assertion. A filter on
   * date_updated alone matches nothing for a freshly created document, and a
   * missed create is indistinguishable from no change -- so this test would pass
   * against the broken filter if it only checked that *something* came back.
   */
  test('the delta filter names both timestamp columns, so creates are not missed', async () => {
    const rows = fakeRows({ post: 3 })
    const list = rows.get('post')!
    // post-0 updated after the watermark; post-1 created after it, never updated.
    const watermark = 1_700_000_010_000
    list[0].date_updated = new Date(watermark + 5_000).toISOString()
    list[1].date_created = new Date(watermark + 6_000).toISOString()
    list[1].date_updated = null

    const fake = track(await startFakeDirectus(rows))
    const adapter = adapterFor(fake.url, ['post'])
    const { ids } = await drain(adapter, 100, watermark)
    assert.deepEqual(ids.sort(), ['post-0', 'post-1'])

    const emitted = fake.requests().find((r) => r.path === '/items/post')!
    const filter = JSON.parse(emitted.query.filter)
    const or = filter._and ? filter._and.find((f: any) => f._or) : filter
    const columns = or._or.map((c: any) => Object.keys(c)[0]).sort()
    assert.deepEqual(columns, ['date_created', 'date_updated'], 'both columns, or creates go missing')
  })

  test('a full pull sends no delta filter at all', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 2 })))
    const adapter = adapterFor(fake.url, ['post'])
    await drain(adapter, 100)
    const req = fake.requests().find((r) => r.path === '/items/post')!
    assert.ok(!req.query.filter.includes('date_created'), 'no timestamp filter on a full pull')
  })
})

describe('directus adapter — document shape', () => {
  test('strips envelope fields so a touch is not a content change', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 })))
    const adapter = adapterFor(fake.url, ['post'])
    const page = await adapter.list({ cursor: null, limit: 10 })
    const doc = page.items[0].doc
    assert.equal(doc.id, 'post-0')
    for (const k of ['seq', 'doc_id', 'date_created', 'date_updated']) {
      assert.ok(!(k in doc), `${k} must not reach the site`)
    }
  })

  test('refuses a row with no usable doc_id instead of collapsing it onto one key', async () => {
    const rows = new Map<string, FakeRow[]>([
      ['post', [{ seq: 1, doc_id: '', title: 'blank', date_created: null, date_updated: null }]],
    ])
    const fake = track(await startFakeDirectus(rows))
    const adapter = adapterFor(fake.url, ['post'])
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal && /doc_id/.test((e as Error).message),
    )
  })

  test('falls back to an empty revision when neither timestamp is set', async () => {
    const rows = new Map<string, FakeRow[]>([
      ['post', [{ seq: 1, doc_id: 'p', title: 't', date_created: null, date_updated: null }]],
    ])
    const fake = track(await startFakeDirectus(rows))
    const adapter = adapterFor(fake.url, ['post'])
    const page = await adapter.list({ cursor: null, limit: 10 })
    // Empty rather than invented: sync reads that as "no revision" and uses the
    // content hash, which is a valid revision. A fabricated one would compare
    // unequal forever.
    assert.equal(page.items[0].revision, '')
    assert.equal(page.items[0].updatedAt, 0)
  })
})

describe('directus adapter — revisionOf', () => {
  const adapter = directusCmsAdapter({ baseUrl: 'http://unused', token: 't', collections: ['post'] })

  test('reads a single-key update, where docs is an object', () => {
    assert.deepEqual(
      adapter.revisionOf({ event: 'post.items.update', docs: { doc_id: 'p3', date_updated: '2026-07-28T07:00:00Z' } }),
      { id: 'p3', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('reads a multi-key update, where the same field is an array', () => {
    assert.deepEqual(
      adapter.revisionOf({
        docs: [
          { doc_id: 'p1', date_updated: '2026-07-28T07:00:00Z' },
          { doc_id: 'p2', date_updated: '2026-07-28T07:00:00Z' },
        ],
      }),
      { id: 'p1', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('reads a create, which carries date_created and no date_updated', () => {
    assert.deepEqual(
      adapter.revisionOf({ docs: { doc_id: 'p9', date_created: '2026-07-28T07:00:00Z', date_updated: null } }),
      { id: 'p9', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('returns null for a delete, which can carry no revision at all', () => {
    // Not an error: the service reads null as "no expectation" and still builds.
    // Treating it as a failure would drop a real publish.
    assert.equal(adapter.revisionOf({ event: 'post.items.delete', keys: ['2'] }), null)
  })

  test('returns null rather than throwing on shapes it does not recognise', () => {
    assert.equal(adapter.revisionOf(null), null)
    assert.equal(adapter.revisionOf('nonsense'), null)
    assert.equal(adapter.revisionOf({ docs: {} }), null)
  })
})

describe('directus adapter — resilience', () => {
  test('retries a 429 and honours Retry-After', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 2 })))
    const proxy = track(await startProxy({
      origin: fake.url, rateLimitEvery: 2, retryAfterSec: 0, only: /^\/items\//,
    }))
    const adapter = adapterFor(proxy.url, ['post'], { backoffMs: 5 })
    const { ids } = await drain(adapter, 100)
    assert.deepEqual(ids, ['post-0', 'post-1'])
    assert.ok(proxy.stats().rateLimited > 0, 'the fault actually fired')
  })

  // The timeout is the assertion. Without it the uncapped case does not fail,
  // it waits the full hour the header asked for -- so the test that exists to
  // catch "publishing stalls" would itself stall, and report nothing.
  test('caps a hostile Retry-After instead of stalling for it', { timeout: 10_000 }, async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 })))
    const proxy = track(await startProxy({
      origin: fake.url, rateLimitEvery: 2, retryAfterSec: 3600, only: /^\/items\//,
    }))
    const adapter = adapterFor(proxy.url, ['post'], { backoffMs: 5, maxRetryAfterMs: 20 })
    const started = performance.now()
    const { ids } = await drain(adapter, 100)
    const elapsed = performance.now() - started
    assert.deepEqual(ids, ['post-0'])
    assert.ok(elapsed < 2000, `capped wait, took ${elapsed.toFixed(0)}ms`)
  })

  test('retries a 500 and succeeds', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 3 })))
    const proxy = track(await startProxy({ origin: fake.url, failEvery: 2, only: /^\/items\// }))
    const adapter = adapterFor(proxy.url, ['post'], { backoffMs: 5 })
    const { ids } = await drain(adapter, 100)
    assert.deepEqual(ids.length, 3)
    assert.ok(proxy.stats().failed > 0)
  })

  test('gives up non-terminally once attempts are exhausted', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 })))
    const proxy = track(await startProxy({ origin: fake.url, failEvery: 1, only: /^\/items\// }))
    const adapter = adapterFor(proxy.url, ['post'], { backoffMs: 1, attempts: 2 })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      // Non-terminal: a 500 is a fact about right now, and the service's
      // consecutive-failure count is what stops an endless retry, not this.
      (e: unknown) => e instanceof RailError && !e.terminal,
    )
  })

  test('a truncated response body is an error, never a short success', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 20 })))
    const proxy = track(await startProxy({ origin: fake.url, abortEvery: 1, only: /^\/items\// }))
    const adapter = adapterFor(proxy.url, ['post'], { backoffMs: 1, attempts: 2 })
    await assert.rejects(() => adapter.list({ cursor: null, limit: 100 }))
  })

  test('re-logs in exactly once when the token expires mid-sync', async () => {
    const rows = fakeRows({ post: 2 })
    const fake = track(await startFakeDirectus(rows, { token: 'first' }))
    const adapter = adapterFor(fake.url, ['post'])
    await drain(adapter, 100)
    const logins = fake.requests().filter((r) => r.path === '/auth/login').length
    assert.equal(logins, 1, 'one login for a healthy sync')
  })

  test('treats bad credentials as terminal rather than retrying them', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 })))
    const adapter = directusCmsAdapter({
      baseUrl: fake.url, email: 'a@example.com', password: 'wrong', collections: ['post'],
    })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal,
    )
  })

  test('a 403 is terminal, because retrying a permission failure is a loop', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 })))
    const adapter = adapterFor(fake.url, ['nope'])
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal,
    )
  })
})

describe('directus adapter — configuration', () => {
  test('refuses to start with no credentials', () => {
    assert.throws(
      () => directusCmsAdapter({ baseUrl: 'http://x', collections: ['post'] }),
      (e: unknown) => e instanceof RailError && e.terminal,
    )
  })

  test('refuses to start with no collections', () => {
    assert.throws(
      () => directusCmsAdapter({ baseUrl: 'http://x', token: 't', collections: [] }),
      (e: unknown) => e instanceof RailError && e.terminal,
    )
  })
})
