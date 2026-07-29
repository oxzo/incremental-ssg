// The generic HTTP adapter, and the three things it did not do.
//
// `httpCmsAdapter` is the adapter every CMS that is not Directus starts from,
// and it was `await fetch(url, { headers })` with a plain `Error` on any non-ok
// status. cms-directus.ts had a deadline, an attempt budget, a capped
// Retry-After and a status classification; this had none of them, and the
// asymmetry was invisible because six phases ran against a mock that always
// answers.
//
// Both halves of the gap end in the same place. No deadline means a socket that
// opens and goes quiet never returns and never throws -- under `serve` that is
// the build lock held, consecutiveFailures at 0, /health answering 200, and the
// site quietly stale. No classification means a plain Error, which isTerminal
// reads as transient by design, so a permanent 403 is retried forever on a
// widening backoff. Busy and never publishing, from two directions.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { httpCmsAdapter } from '../src/cms.ts'
import { RailError } from '../src/rails.ts'

const servers: Server[] = []
// Pending delayed responses, cleared on teardown. A timer outliving the test
// keeps the event loop alive, and a file that does not exit is the one result
// that says nothing -- the same reason every close() here is in an after() hook
// rather than on a test's last line.
const timeouts: NodeJS.Timeout[][] = []
after(async () => {
  for (const list of timeouts) for (const t of list) clearTimeout(t)
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
})

/** One document, in the envelope the adapter parses. */
const PAGE = JSON.stringify({
  items: [{ type: 'post', doc: { id: 'p1', rev: 'r1', updated_at: 1 } }],
  next: null,
  total: 1,
})

/** The same document, in the envelope listIds() parses. */
const IDS = JSON.stringify({ ids: [['p1', 'r1', 'post']] })

const bodyFor = (url: string) => (url.startsWith('/ids') ? IDS : PAGE)

/**
 * A server that answers however the test needs it to, counting requests.
 *
 * `answer` returns a status, or `{ after: ms }` to accept the connection and
 * answer 200 that much later -- a slow server rather than a silent one.
 *
 * Slow rather than silent, and the difference is the whole reason this helper
 * takes a delay instead of a `'hang'`. The failure the deadline exists for is a
 * socket that opens and never speaks again, and a test built on one can only
 * fail by running forever: remove the deadline and the request never returns,
 * the file never exits, and tools/mutate.py reads that as no result rather than
 * as the missing rail. A server slower than the deadline reproduces what the
 * deadline actually promises -- a request that outruns it is abandoned -- and it
 * finishes either way. test/deploy-s3.test.ts made the same trade for its
 * request cap, for the same reason.
 */
async function cms(answer: (n: number) => number | { after: number }) {
  let requests = 0
  const timers: NodeJS.Timeout[] = []
  const server = createServer((req, res) => {
    const verdict = answer(++requests)
    const ok = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(bodyFor(req.url ?? '/'))
    }
    if (typeof verdict === 'object') {
      timers.push(setTimeout(ok, verdict.after))
      return
    }
    if (verdict === 200) return ok()
    res.writeHead(verdict, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'injected' }))
  })
  servers.push(server)
  timeouts.push(timers)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
  }
}

describe('httpCmsAdapter — a request that does not work', () => {
  // The elapsed time IS the assertion, not decoration. `fetch` has no default
  // timeout, so before this the only bound on a slow CMS was the CMS itself.
  test('abandons a request that outruns the deadline instead of waiting on it', { timeout: 10_000 }, async () => {
    // Twenty-five times the deadline. Removing the deadline makes this test
    // complete in ~1.5s and fail its rejection, rather than hang.
    const server = await cms(() => ({ after: 1_500 }))
    const adapter = httpCmsAdapter({
      baseUrl: server.url, timeoutMs: 60, attempts: 2, backoffMs: 1,
    })
    const started = performance.now()
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      // Non-terminal: a hung socket is a fact about right now. The abort is what
      // turns it into a failure at all, and the service's consecutive-failure
      // count is what stops the retrying.
      (e: unknown) => e instanceof RailError && !e.terminal,
    )
    const elapsed = performance.now() - started
    // Under the server's own 1,500ms, so the deadline is what ended it rather
    // than the response arriving.
    assert.ok(elapsed < 1_000, `bounded by the deadline, took ${elapsed.toFixed(0)}ms`)
    // Both attempts were spent, so the deadline fires per attempt rather than
    // once for the whole request.
    assert.equal(server.requests(), 2)
  })

  test('a 403 is terminal, because retrying a permission failure is a loop', async () => {
    const server = await cms(() => 403)
    const adapter = httpCmsAdapter({ baseUrl: server.url, attempts: 4, backoffMs: 1 })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && e.terminal && e.rail === 'cms.request',
    )
    // One attempt, not four. This is the half that a plain Error got wrong in
    // the *other* direction: unclassified means transient, so the service kept
    // asking a question that had already been answered permanently.
    assert.equal(server.requests(), 1)
  })

  test('a 500 is retried, and the listing completes once the CMS recovers', async () => {
    const server = await cms((n) => (n < 3 ? 500 : 200))
    const adapter = httpCmsAdapter({ baseUrl: server.url, attempts: 4, backoffMs: 1 })
    const page = await adapter.list({ cursor: null, limit: 10 })
    assert.deepEqual(page.items.map((i) => i.id), ['p1'])
    assert.equal(server.requests(), 3)
  })

  test('a 500 that never clears gives up non-terminally, so the service retries', async () => {
    const server = await cms(() => 500)
    const adapter = httpCmsAdapter({ baseUrl: server.url, attempts: 3, backoffMs: 1 })
    await assert.rejects(
      () => adapter.list({ cursor: null, limit: 10 }),
      (e: unknown) => e instanceof RailError && !e.terminal && /failed after 3 attempts/.test(e.message),
    )
    assert.equal(server.requests(), 3)
  })

  test('a 429 is honoured but capped, so an upstream cannot stall publishing', { timeout: 10_000 }, async () => {
    // Retry-After of an hour, capped to 20ms. Without the cap this test does not
    // fail either -- it waits out the header, which is the same non-result the
    // hang above produces.
    let requests = 0
    const server = createServer((_req, res) => {
      if (++requests === 1) {
        res.writeHead(429, { 'retry-after': '3600' })
        return res.end('slow down')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(PAGE)
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const adapter = httpCmsAdapter({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      backoffMs: 1,
      maxRetryAfterMs: 20,
    })
    const started = performance.now()
    const page = await adapter.list({ cursor: null, limit: 10 })
    const elapsed = performance.now() - started
    assert.deepEqual(page.items.map((i) => i.id), ['p1'])
    assert.ok(elapsed < 2_000, `capped wait, took ${elapsed.toFixed(0)}ms`)
  })

  test('the id listing is on the same terms as the document listing', async () => {
    // Two endpoints, one policy. listIds() feeds deleteMissing, so an unretried
    // blip there does not merely fail a sync -- it is the request whose answer
    // decides which documents still exist.
    const server = await cms((n) => (n === 1 ? 503 : 200))
    const adapter = httpCmsAdapter({ baseUrl: server.url, attempts: 3, backoffMs: 1 })
    assert.deepEqual(await adapter.listIds(), [{ type: 'post', id: 'p1', revision: 'r1' }])
    assert.equal(server.requests(), 2, 'the 503 was retried rather than thrown')
  })
})
