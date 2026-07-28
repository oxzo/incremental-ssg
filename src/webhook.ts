// The HTTP surface: a CMS webhook arrives here and the service does the rest.
//
// Deliberately thin. Everything that decides *whether* and *when* to build lives
// in service.ts, so this file only authenticates, extracts the revision the
// payload claims, and hands over a trigger. That split is what lets the
// coalescing and refusal rules be tested without a socket.
//
// Three properties matter more than the routing:
//
// 1. It answers before it builds. A CMS webhook sender times out in seconds and
//    retries on timeout, so holding the connection open for a ~10s build turns
//    one publish into a retry storm -- each retry arriving as another trigger.
//    202 means "queued", which is exactly what happened.
//
// 2. It refuses to start unauthenticated. An open endpoint that triggers a
//    full site build is a free denial of service: no payload, no parsing, just
//    POST in a loop. The rail is the same shape as the others in this codebase --
//    refuse by default, require an explicit flag to override -- and it is here
//    rather than in a deployment checklist because a checklist is not enforcement.
//
// 3. The body is capped. An unbounded read on a public endpoint is the other
//    free denial of service, and the cap has to be enforced while streaming
//    rather than after, or the memory is already spent by the time it is checked.
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { jsonLog } from './service.ts'
import type { Service, Log, Expectation } from './service.ts'
import type { CmsAdapter } from './cms.ts'

export type WebhookOptions = {
  service: Service
  /** Supplies revisionOf(), which is how a payload becomes a read-after-write check. */
  adapter: CmsAdapter
  /** 0 binds an ephemeral port; the resolved one comes back in the result. */
  port?: number
  /** Default 127.0.0.1. Binding 0.0.0.0 puts the endpoint on the network. */
  host?: string
  /** Path the CMS posts to. Default /webhook. */
  path?: string
  /** Shared secret in x-webhook-token or Authorization: Bearer. */
  secret?: string
  /** HMAC-SHA256 over the raw body, in x-webhook-signature (sha256=<hex> or bare hex). */
  hmacSecret?: string
  /** Start with no authentication at all. Means "yes, I know, I meant it". */
  allowUnauthenticated?: boolean
  /** Default 1 MiB. */
  maxBodyBytes?: number
  log?: Log
}

export type WebhookServer = {
  url: string
  port: number
  server: Server
  close(): Promise<void>
}

const TOKEN_HEADER = 'x-webhook-token'
const SIG_HEADER = 'x-webhook-signature'

/** Length is compared first because timingSafeEqual throws on a mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Read the body, refusing anything over the cap while it streams.
 *
 * Returns null when the cap is hit. The cap is enforced *during* the stream and
 * the socket is paused rather than drained, because continuing to read a body
 * already known to be too large is doing the attacker's work -- pausing pushes
 * the backpressure down to TCP.
 *
 * It deliberately does not destroy the request. Destroying here kills the socket
 * before the handler can write its 413, so the client sees a connection reset
 * and cannot tell a size refusal from a crashed server. The caller sends the
 * response first and closes afterwards.
 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        req.pause()
        res(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // A webhook response is never worth caching, and a 202 cached by an
    // intermediary would swallow later deliveries.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Start the endpoint.
 *
 * Throws before binding if no authentication is configured, so the failure is a
 * startup error rather than an open port nobody notices.
 */
export async function startWebhookServer(opts: WebhookOptions): Promise<WebhookServer> {
  const log = opts.log ?? jsonLog
  const path = opts.path ?? '/webhook'
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024
  const host = opts.host ?? '127.0.0.1'
  const hasAuth = Boolean(opts.secret) || Boolean(opts.hmacSecret)

  if (!hasAuth && opts.allowUnauthenticated !== true) {
    throw new Error(
      `startWebhookServer() refuses to start with no authentication. An open endpoint ` +
      `that triggers a full site build is a denial of service that needs no payload -- ` +
      `POST in a loop and every build queues another. Pass a shared secret ` +
      `(--secret / WEBHOOK_SECRET), an HMAC secret (--hmac-secret / ` +
      `WEBHOOK_HMAC_SECRET), or --allow-unauthenticated if this port is genuinely ` +
      `unreachable from anywhere untrusted.`)
  }

  /**
   * Null when authorised; otherwise the reason to report.
   *
   * With both a token and an HMAC secret configured, either satisfies it. That is
   * OR rather than AND on purpose: the two exist because different CMSes offer
   * different mechanisms, so requiring both would mean no real sender could
   * authenticate. Configure only the one the CMS actually sends.
   */
  function authorise(req: IncomingMessage, raw: Buffer): string | null {
    if (!hasAuth) return null
    if (opts.secret) {
      const header = req.headers[TOKEN_HEADER]
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
      const given = typeof header === 'string' ? header : bearer
      if (given !== undefined && safeEqual(given, opts.secret)) return null
      if (!opts.hmacSecret) return 'bad or missing token'
    }
    if (opts.hmacSecret) {
      const given = String(req.headers[SIG_HEADER] ?? '').replace(/^sha256=/, '')
      const want = createHmac('sha256', opts.hmacSecret).update(raw).digest('hex')
      if (given !== '' && safeEqual(given, want)) return null
      return 'bad or missing signature'
    }
    return 'bad or missing token'
  }

  const server = createServer((req, res) => {
    // One catch around the whole handler. An unhandled rejection here would take
    // the process down, and the process is the publish service.
    void handle(req, res).catch((e: unknown) => {
      log({ event: 'webhook.error', error: e instanceof Error ? e.message : String(e) })
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const route = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    // Unauthenticated on purpose, and coarse on purpose. A load balancer has to
    // be able to ask, and the answer carries no detail beyond up or down --
    // /status is where the detail lives, behind the same auth as everything else.
    if (route === '/health' && method === 'GET') {
      const healthy = opts.service.status().healthy
      return send(res, healthy ? 200 : 503, { ok: healthy })
    }

    if (method !== 'POST' && route !== '/status') {
      return send(res, 405, { error: `${method} not allowed on ${route}` })
    }

    const raw = await readBody(req, maxBody)
    if (raw === null) {
      log({ event: 'webhook.rejected', reason: 'body too large', route })
      // Answer, then hang up. The rest of the body is never read, so the socket
      // cannot be reused -- closing it once the 413 is flushed is what turns an
      // oversized delivery into a refusal the sender can actually see.
      res.on('finish', () => req.destroy())
      return send(res, 413, { error: `body exceeds ${maxBody} bytes` })
    }

    const denied = authorise(req, raw)
    if (denied !== null) {
      // No detail about which check failed, and no echo of what was sent.
      log({ event: 'webhook.rejected', reason: denied, route })
      return send(res, 401, { error: 'unauthorized' })
    }

    if (route === '/status') {
      return send(res, 200, opts.service.status())
    }

    if (route === `${path}/build` && method === 'POST') {
      // Forced, because this is the escape hatch for everything sync cannot see:
      // a template edit, a config change, or a halt that a human has just fixed.
      opts.service.notify({ source: 'manual', force: true })
      log({ event: 'webhook.accepted', route, forced: true })
      return send(res, 202, { queued: true, forced: true })
    }

    if (route === path && method === 'POST') {
      // A payload that does not parse is still a trigger. The build does not
      // depend on the body -- it is a full build either way -- so refusing here
      // would drop a real publish over a payload shape this adapter did not
      // expect. The revision check is the only thing that needs the body, and it
      // degrades to "no expectation" rather than to an error.
      let expectations: Expectation[] = []
      let payloadNote: string | null = null
      if (raw.length > 0) {
        try {
          const found = opts.adapter.revisionOf(JSON.parse(raw.toString('utf8')))
          if (found !== null) expectations = [found]
          else payloadNote = 'no revision found in payload'
        } catch {
          payloadNote = 'payload was not JSON'
        }
      } else {
        payloadNote = 'empty payload'
      }

      opts.service.notify({ source: 'webhook', expectations })
      log({
        event: 'webhook.accepted',
        route,
        expectations: expectations.map((e) => `${e.type}/${e.id}`),
        ...(payloadNote ? { note: payloadNote } : {}),
      })
      return send(res, 202, { queued: true, expectations: expectations.length })
    }

    return send(res, 404, { error: `no route for ${method} ${route}` })
  }

  await new Promise<void>((res) => server.listen(opts.port ?? 0, host, () => res()))
  const port = (server.address() as AddressInfo).port
  log({
    event: 'webhook.listening',
    url: `http://${host}:${port}${path}`,
    authenticated: hasAuth,
  })

  return {
    url: `http://${host}:${port}`,
    port,
    server,
    close: () => new Promise<void>((res) => server.close(() => res())),
  }
}
