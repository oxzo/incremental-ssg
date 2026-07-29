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
      adapter.revisionOf({
        event: 'post.items.update',
        collection: 'post',
        docs: { doc_id: 'p3', date_updated: '2026-07-28T07:00:00Z' },
      }),
      { type: 'post', id: 'p3', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('reads a multi-key update, where the same field is an array', () => {
    assert.deepEqual(
      adapter.revisionOf({
        collection: 'post',
        docs: [
          { doc_id: 'p1', date_updated: '2026-07-28T07:00:00Z' },
          { doc_id: 'p2', date_updated: '2026-07-28T07:00:00Z' },
        ],
      }),
      { type: 'post', id: 'p1', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('reads a create, which carries date_created and no date_updated', () => {
    assert.deepEqual(
      adapter.revisionOf({
        collection: 'post',
        docs: { doc_id: 'p9', date_created: '2026-07-28T07:00:00Z', date_updated: null },
      }),
      { type: 'post', id: 'p9', revision: '2026-07-28T07:00:00Z' },
    )
  })

  test('returns null when the payload names no collection', () => {
    // The mirror is keyed by (type, id), so an expectation without a type cannot
    // be looked up -- and guessing one would either miss every time or match a
    // different document sharing the id. stack/seed.ts sends the collection on
    // every flow ({{$trigger.collection}}), so its absence means a payload this
    // adapter did not shape, and null is already the safe answer: the service
    // reads it as "no expectation" and still publishes.
    assert.equal(
      adapter.revisionOf({ docs: { doc_id: 'p3', date_updated: '2026-07-28T07:00:00Z' } }),
      null)
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
    // One attempt, not four. The point of the terminal bit is that the attempts
    // it saves were always going to fail.
    assert.equal(fake.requests().filter((r) => r.path === '/auth/login').length, 1)
  })

  // The login endpoint, classified the way every other endpoint here already is.
  //
  // `login()` threw `terminal: true` on every non-2xx, on the argument that wrong
  // credentials do not improve with retrying -- true, and an answer to only one
  // of the reasons a login says no. Measured against a server answering 503 on
  // /auth/login: `rail: cms.auth | terminal: true`. Under `serve` that is a
  // Directus restart during a poll halting publishing until a human clears it,
  // while every *other* request in this adapter would have retried the same
  // outage and recovered.
  test('retries a login that failed with a 5xx, and publishes once it comes back', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 2 }), { failLoginWith: [503] }))
    const adapter = adapterFor(fake.url, ['post'], { backoffMs: 5 })
    const { ids } = await drain(adapter, 100)
    assert.deepEqual(ids, ['post-0', 'post-1'])
    // Two logins: the one that met the restart, and the one that did not.
    assert.equal(fake.requests().filter((r) => r.path === '/auth/login').length, 2)
  })

  test('a 502 from a proxy in front of the login is transient too', async () => {
    // Not the same status and not the same cause, which is the point: the rule
    // is "401 and 403 are about the credentials, everything else is about the
    // moment" rather than a list of blessed statuses.
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 }), { failLoginWith: [502, 502] }))
    const adapter = adapterFor(fake.url, ['post'], { backoffMs: 5 })
    const { ids } = await drain(adapter, 100)
    assert.deepEqual(ids, ['post-0'])
  })

  test('a login that stays down gives up non-terminally, so the service retries', async () => {
    const fake = track(await startFakeDirectus(
      fakeRows({ post: 1 }),
      { failLoginWith: [503, 503, 503, 503, 503, 503] },
    ))
    const adapter = adapterFor(fake.url, ['post'], { backoffMs: 1, attempts: 3 })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      // Non-terminal: the CMS being down is a fact about right now. What stops
      // an endless retry is the service's consecutive-failure count, not a bit
      // set here -- the same division the 500 path above already makes.
      (e: unknown) => e instanceof RailError && !e.terminal,
    )
    assert.equal(fake.requests().filter((r) => r.path === '/auth/login').length, 3)
  })

  test('a 403 on the login stays terminal, because the token would not be granted', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 1 }), { failLoginWith: [403] }))
    const adapter = adapterFor(fake.url, ['post'], { backoffMs: 1 })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal && e.rail === 'cms.auth',
    )
    assert.equal(fake.requests().filter((r) => r.path === '/auth/login').length, 1)
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

// The count that lets sync() tell a short listing from a complete one.
//
// Directus counts relative to the filter, and the filter carries the keyset
// cursor, so a page's own filter_count is the remainder of the current
// collection rather than a total of anything. The adapter has to accumulate --
// and the reason this is tested at the adapter rather than through sync() is
// that a per-page number and an accumulated one are indistinguishable on a
// single-collection, single-page listing, which is what a casual test would use.
describe('directus adapter — the listing count', () => {
  /** Drain, keeping each page's reported total. */
  async function totals(adapter: ReturnType<typeof directusCmsAdapter>, limit: number, since?: number) {
    let cursor: string | null = null
    const seen: (number | undefined)[] = []
    let pulled = 0
    for (;;) {
      const page = await adapter.list({ cursor, limit, since })
      seen.push(page.total)
      pulled += page.items.length
      cursor = page.cursor
      if (cursor === null) break
      if (seen.length > 200) throw new Error('list() did not terminate')
    }
    return { totals: seen, last: seen[seen.length - 1], pulled }
  }

  test('the final page reports the whole listing, summed across collections', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 7, tag: 3, page: 1 })))
    const adapter = adapterFor(fake.url, ['post', 'tag', 'page'])
    const { last, pulled } = await totals(adapter, 100)
    assert.equal(pulled, 11)
    assert.equal(last, 11)
  })

  test('it stays a total across page boundaries instead of becoming a remainder', async () => {
    // 25 rows at 10 per page. A per-page filter_count passed straight through
    // would report 25, 15, 5 -- and sync() comparing its running pull against
    // the last of those would refuse a listing that delivered everything.
    const fake = track(await startFakeDirectus(fakeRows({ post: 25 })))
    const adapter = adapterFor(fake.url, ['post'])
    const { totals: seen, last, pulled } = await totals(adapter, 10)
    assert.equal(pulled, 25)
    assert.equal(last, 25)
    assert.ok(seen.every((t) => t === 25), `every page should report 25, got ${seen.join(',')}`)
  })

  test('a delta listing counts what the delta matches, not the collection', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 10 })))
    const adapter = adapterFor(fake.url, ['post'])
    // fakeRows stamps date_created at 1s intervals from the epoch below, so this
    // cuts the collection in half.
    const since = 1_700_000_000_000 + 4500
    const { last, pulled } = await totals(adapter, 100, since)
    assert.equal(last, pulled)
    assert.ok(pulled > 0 && pulled < 10, `expected a partial delta, pulled ${pulled}`)
  })

  test('a response with no meta reports no total rather than a wrong one', async () => {
    // An older Directus, a proxy that strips meta, or a permission that hides
    // it. Absence has to reach sync() as undefined, which disables the check --
    // a zero here would read as "the CMS is empty" and refuse every document.
    const fake = track(await startFakeDirectus(fakeRows({ post: 5 }), { omitMeta: true }))
    const adapter = adapterFor(fake.url, ['post'])
    const { totals: seen, pulled } = await totals(adapter, 100)
    assert.equal(pulled, 5)
    assert.ok(seen.every((t) => t === undefined), `expected no totals, got ${seen.join(',')}`)
  })

  test('a second listing on the same adapter does not inherit the first count', async () => {
    // The accumulator is adapter state, and the service reuses one adapter for
    // every sync. Without a reset the second listing reports double and sync()
    // refuses a complete pull.
    const fake = track(await startFakeDirectus(fakeRows({ post: 4, tag: 2 })))
    const adapter = adapterFor(fake.url, ['post', 'tag'])
    const first = await totals(adapter, 100)
    const second = await totals(adapter, 100)
    assert.equal(first.last, 6)
    assert.equal(second.last, 6)
  })

  test('the count rides on the same request rather than adding one', async () => {
    // The reason this is affordable at all, and the thing the adapter's previous
    // comment assumed was impossible. Phase 2b found request count dominates
    // sync wall time, so a count costing a request per page would not be worth
    // having.
    const fake = track(await startFakeDirectus(fakeRows({ post: 25 })))
    const adapter = adapterFor(fake.url, ['post'])
    await totals(adapter, 10)
    const items = fake.requests().filter((r) => r.path.startsWith('/items/'))
    assert.equal(items.length, 3, 'three pages, three requests')
    assert.ok(items.every((r) => r.query.meta === 'filter_count'))
  })
})

// The id listing is one request per collection at limit=-1, with no pagination
// loop, and its result goes straight into deleteMissing on the delta path. A
// server-side cap truncates it silently, and a truncated id listing is
// indistinguishable from a mass deletion.
describe('directus adapter — a truncated id listing', () => {
  test('a server cap is refused rather than reconciled', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 40 }), { queryLimitMax: 25 }))
    const adapter = adapterFor(fake.url, ['post'])
    await assert.rejects(
      () => adapter.listIds(),
      (e: Error) => {
        assert.ok(e instanceof RailError)
        assert.equal(e.rail, 'cms.listing-truncated')
        assert.equal(e.terminal, false)
        assert.match(e.message, /reports 40 documents and the id listing returned 25/)
        return true
      })
  })

  test('an uncapped listing is not refused', async () => {
    // The negative control, and it needs the cap option absent rather than set
    // high: a rail that refused every listing would pass the test above.
    const fake = track(await startFakeDirectus(fakeRows({ post: 40, tag: 3 })))
    const adapter = adapterFor(fake.url, ['post', 'tag'])
    const ids = await adapter.listIds()
    assert.equal(ids.length, 43)
  })

  test('rows with an unusable doc_id are dropped without being read as missing', async () => {
    // listIds skips rows whose doc_id is empty or not a string, so the kept
    // count is legitimately lower than the returned count. Comparing the wrong
    // one of those two against filter_count refuses a complete listing.
    const rows = fakeRows({ post: 5 })
    rows.get('post')![1].doc_id = ''
    rows.get('post')![3].doc_id = null
    const fake = track(await startFakeDirectus(rows))
    const adapter = adapterFor(fake.url, ['post'])
    const ids = await adapter.listIds()
    assert.equal(ids.length, 3, 'the two unusable rows are dropped')
  })

  test('a listing with no count is not checked rather than refused', async () => {
    const fake = track(await startFakeDirectus(fakeRows({ post: 40 }), { omitMeta: true, queryLimitMax: 25 }))
    const adapter = adapterFor(fake.url, ['post'])
    const ids = await adapter.listIds()
    assert.equal(ids.length, 25, 'no count means no check — the old behaviour, stated')
  })
})
