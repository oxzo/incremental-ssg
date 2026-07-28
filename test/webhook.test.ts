import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { startWebhookServer } from '../src/webhook.ts'
import { createService, silentLog } from '../src/service.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import type { RunReport, Trigger, Pipeline } from '../src/service.ts'

const adapter = httpCmsAdapter({ baseUrl: 'http://cms.invalid' })

function report(t: Trigger): RunReport {
  return {
    source: t.source,
    skipped: null,
    dirtyOnEntry: false,
    syncInterrupted: false,
    sync: null,
    readAfterWrite: { checked: false, expected: 0, outstanding: [], attempts: 0, reason: null },
    build: null,
    deploy: null,
    ms: 0,
  }
}

/**
 * An endpoint over a service whose runs are recorded but never execute.
 *
 * The endpoint's job is to authenticate, extract a revision and hand over a
 * trigger; whether a build follows is service.ts's decision and is tested there.
 * A real pipeline here would make every assertion wait on a render.
 */
async function endpoint(o: { secret?: string; hmacSecret?: string; allowUnauthenticated?: boolean } = {}) {
  const seen: Trigger[] = []
  const run: Pipeline = async (t) => {
    seen.push(t)
    return report(t)
  }
  const service = createService({ run, log: silentLog, debounceMs: 5, pollMs: 0 })
  const http = await startWebhookServer({
    service,
    adapter,
    port: 0,
    log: silentLog,
    ...o,
  })
  return {
    seen,
    service,
    url: http.url,
    post: (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${http.url}${path}`, { method: 'POST', body, headers }),
    get: (path: string, headers: Record<string, string> = {}) =>
      fetch(`${http.url}${path}`, { headers }),
    async close() {
      await http.close()
      await service.stop()
    },
  }
}

describe('webhook endpoint', () => {
  test('refuses to start with no authentication configured', async () => {
    // An open endpoint that triggers a full build is a denial of service needing
    // no payload. The refusal is here rather than in a deployment checklist
    // because a checklist is not enforcement.
    const service = createService({ run: async (t) => report(t), log: silentLog, pollMs: 0 })
    // Captured so that if the rail is ever removed this test fails on the
    // assertion instead of hanging forever on a listening socket nobody closes.
    let leaked: { close(): Promise<void> } | null = null
    try {
      await assert.rejects(
        (async () => {
          leaked = await startWebhookServer({ service, adapter, port: 0, log: silentLog })
        })(),
        /refuses to start with no authentication/)
    } finally {
      if (leaked !== null) await (leaked as { close(): Promise<void> }).close()
      await service.stop()
    }
  })

  test('starts unauthenticated when explicitly allowed', async () => {
    const e = await endpoint({ allowUnauthenticated: true })
    try {
      const res = await e.post('/webhook', '{}')
      assert.equal(res.status, 202)
    } finally {
      await e.close()
    }
  })

  test('a valid token is accepted in either header form', async () => {
    const e = await endpoint({ secret: 'sh-secret' })
    try {
      const forms: Record<string, string>[] = [
        { 'x-webhook-token': 'sh-secret' },
        { authorization: 'Bearer sh-secret' },
      ]
      for (const headers of forms) {
        const res = await e.post('/webhook', '{}', headers)
        assert.equal(res.status, 202, JSON.stringify(headers))
      }
    } finally {
      await e.close()
    }
  })

  test('a wrong, missing, or truncated token is rejected without triggering', async () => {
    const e = await endpoint({ secret: 'sh-secret' })
    try {
      const forms: Record<string, string>[] = [
        {},
        { 'x-webhook-token': 'wrong' },
        // A prefix must not pass: a length check that short-circuits before
        // comparing is the classic way this goes wrong.
        { 'x-webhook-token': 'sh-secre' },
        { 'x-webhook-token': 'sh-secretx' },
        { authorization: 'Bearer nope' },
      ]
      for (const headers of forms) {
        const res = await e.post('/webhook', '{}', headers)
        assert.equal(res.status, 401, JSON.stringify(headers))
        const body = await res.json() as { error: string }
        // No detail about which check failed and no echo of what was sent.
        assert.equal(body.error, 'unauthorized')
      }
      await e.service.idle()
      assert.equal(e.seen.length, 0, 'a rejected delivery must not queue a build')
    } finally {
      await e.close()
    }
  })

  test('an HMAC signature over the raw body is accepted, and a body swap is not', async () => {
    const e = await endpoint({ hmacSecret: 'hmac-key' })
    try {
      const body = JSON.stringify({ id: 'post-1', rev: 'r5' })
      const sig = createHmac('sha256', 'hmac-key').update(body).digest('hex')

      assert.equal((await e.post('/webhook', body, { 'x-webhook-signature': sig })).status, 202)
      // Bare hex and the sha256= prefix are both common in the wild.
      assert.equal(
        (await e.post('/webhook', body, { 'x-webhook-signature': `sha256=${sig}` })).status, 202)

      // The signature is over the body, so reusing it with different content is
      // exactly what it has to stop.
      const swapped = await e.post('/webhook', JSON.stringify({ id: 'post-9', rev: 'r5' }), {
        'x-webhook-signature': sig,
      })
      assert.equal(swapped.status, 401)
    } finally {
      await e.close()
    }
  })

  test('a body over the cap is refused', async () => {
    const seen: Trigger[] = []
    const service = createService({
      run: async (t) => { seen.push(t); return report(t) },
      log: silentLog, debounceMs: 5, pollMs: 0,
    })
    const http = await startWebhookServer({
      service, adapter, port: 0, log: silentLog,
      allowUnauthenticated: true, maxBodyBytes: 512,
    })
    try {
      const res = await fetch(`${http.url}/webhook`, {
        method: 'POST',
        body: 'x'.repeat(4096),
      })
      assert.equal(res.status, 413)
      await service.idle()
      assert.equal(seen.length, 0)
    } finally {
      await http.close()
      await service.stop()
    }
  })

  test('the revision in the payload becomes a read-after-write expectation', async () => {
    const e = await endpoint({ secret: 's' })
    try {
      const res = await e.post('/webhook', JSON.stringify({ id: 'post-3', rev: 'rev-42' }), {
        'x-webhook-token': 's',
      })
      assert.equal(res.status, 202)
      assert.deepEqual(await res.json(), { queued: true, expectations: 1 })
      await e.service.idle()
      assert.deepEqual(e.seen[0].expectations, [{ id: 'post-3', revision: 'rev-42' }])
      assert.equal(e.seen[0].force, false)
    } finally {
      await e.close()
    }
  })

  test('a payload with no usable revision still triggers a build', async () => {
    const e = await endpoint({ secret: 's' })
    try {
      // The build does not depend on the body -- it is a full build either way --
      // so refusing over an unexpected payload shape would drop a real publish.
      for (const body of ['', 'not json', '{}', JSON.stringify({ event: 'publish' })]) {
        const res = await e.post('/webhook', body, { 'x-webhook-token': 's' })
        assert.equal(res.status, 202, JSON.stringify(body))
        const parsed = await res.json() as { queued: boolean; expectations: number }
        assert.equal(parsed.queued, true)
        assert.equal(parsed.expectations, 0)
      }
      await e.service.idle()
      assert.ok(e.seen.length >= 1, 'an unparseable payload must still publish')
      assert.equal(e.seen[0].expectations.length, 0)
    } finally {
      await e.close()
    }
  })

  test('the build endpoint forces a publish', async () => {
    const e = await endpoint({ secret: 's' })
    try {
      const res = await e.post('/webhook/build', '', { 'x-webhook-token': 's' })
      assert.equal(res.status, 202)
      assert.deepEqual(await res.json(), { queued: true, forced: true })
      await e.service.idle()
      // Forced, because this is the only route to a rebuild after a template
      // edit -- sync cannot see code, so an unforced trigger would skip.
      assert.equal(e.seen[0].force, true)
      assert.equal(e.seen[0].source, 'manual')
    } finally {
      await e.close()
    }
  })

  test('health is unauthenticated and coarse; status is authenticated and detailed', async () => {
    const e = await endpoint({ secret: 's' })
    try {
      const health = await e.get('/health')
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { ok: true })

      // A load balancer must be able to ask, so /health carries no auth and no
      // detail. The detail is behind the same auth as everything else.
      assert.equal((await e.get('/status')).status, 401)
      const status = await e.get('/status', { 'x-webhook-token': 's' })
      assert.equal(status.status, 200)
      const body = await status.json() as { healthy: boolean; runs: number }
      assert.equal(body.healthy, true)
      assert.equal(typeof body.runs, 'number')
    } finally {
      await e.close()
    }
  })

  test('health reports 503 once the service is unhealthy', async () => {
    const service = createService({
      run: async () => { throw new Error('broken') },
      log: silentLog, debounceMs: 5, retryMs: 10_000, unhealthyAfter: 1, pollMs: 0,
    })
    const http = await startWebhookServer({
      service, adapter, port: 0, log: silentLog, allowUnauthenticated: true,
    })
    try {
      assert.equal((await fetch(`${http.url}/health`)).status, 200)
      await fetch(`${http.url}/webhook`, { method: 'POST', body: '{}' })
      await new Promise((r) => setTimeout(r, 60))
      // Something has to be able to see "busy forever and never publishing".
      assert.equal((await fetch(`${http.url}/health`)).status, 503)
    } finally {
      await http.close()
      await service.stop()
    }
  })

  test('unknown paths and methods are refused', async () => {
    const e = await endpoint({ allowUnauthenticated: true })
    try {
      assert.equal((await e.post('/nope', '{}')).status, 404)
      assert.equal((await e.get('/webhook')).status, 405)
      assert.equal((await e.get('/')).status, 405)
    } finally {
      await e.close()
    }
  })

  test('a webhook is answered before the build runs', async () => {
    let started = false
    let release: (() => void) | null = null
    const held = new Promise<void>((r) => { release = r })
    const service = createService({
      run: async (t) => { started = true; await held; return report(t) },
      log: silentLog, debounceMs: 1, pollMs: 0,
    })
    const http = await startWebhookServer({
      service, adapter, port: 0, log: silentLog, allowUnauthenticated: true,
    })
    try {
      // A CMS webhook sender times out in seconds and retries on timeout, so
      // holding the connection open for a ~10s build turns one publish into a
      // retry storm -- each retry arriving as another trigger.
      const res = await fetch(`${http.url}/webhook`, { method: 'POST', body: '{}' })
      assert.equal(res.status, 202)
      await res.json()
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(started, true, 'the build should be running by now')
      release!()
    } finally {
      await http.close()
      await service.stop()
    }
  })
})
