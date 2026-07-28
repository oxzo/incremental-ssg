// A reverse proxy that injects the failures a mock never produces.
//
// This is what makes a local stack worth more than the mock it replaces. Real
// software on localhost is honest about protocol, auth and pagination, and it
// is useless for everything the network does: round-trip time, rate limits,
// truncated responses, connections that die mid-body. Those are injected here,
// in front of the real service, so the adapter meets them without needing a
// hosted CMS or a bad day to produce them.
//
// The honest limit, stated because it is easy to forget once the dial is in
// front of you: **every failure here is a failure somebody anticipated.** The
// reason this project's rails exist is that anticipated failures are the ones
// already handled. A real host will fail in ways this file does not contain,
// and nothing measured through this proxy is evidence about those.
//
// Latency injection in particular is not a substitute for a real network -- it
// is better for one purpose and worse for another. Better: RTT becomes a swept
// variable rather than a single sample, so a cost model can be validated across
// a range instead of anchored on whatever one host happened to do. Worse: it is
// a constant, and real RTT has a distribution, a tail, and correlations with
// load that a fixed delay does not reproduce.
import { createServer, request as httpRequest, Agent } from 'node:http'
import type { IncomingMessage, ServerResponse, Server, IncomingHttpHeaders } from 'node:http'

export type FaultConfig = {
  /** Added round-trip time, milliseconds, applied before the response is sent. */
  latencyMs?: number
  /** Return 429 on every Nth request. 0 disables. */
  rateLimitEvery?: number
  /** Value of Retry-After on an injected 429, in seconds. Omit to send none. */
  retryAfterSec?: number
  /** Return 500 on every Nth request. 0 disables. */
  failEvery?: number
  /** Destroy the socket mid-response on every Nth request. 0 disables. */
  abortEvery?: number
  /**
   * Silently drop the last N objects from an S3 listing *and* report it
   * complete. The dangerous shape: not a parse error, not a short read, but a
   * well-formed listing that is missing entries and says it is not.
   */
  dropListingEntries?: number
  /**
   * Remove the continuation token while leaving IsTruncated true. The shape that
   * makes a naive pagination loop exit and report a short listing as complete.
   */
  stripContinuationToken?: boolean
  /** Apply faults only to requests whose path matches. */
  only?: RegExp
}

export type ProxyOptions = FaultConfig & {
  /** Origin to forward to, e.g. http://127.0.0.1:8055 */
  origin: string
  port?: number
  host?: string
  onEvent?: (event: Record<string, unknown>) => void
}

export type RunningProxy = {
  url: string
  port: number
  /** Requests seen, and how many of each fault fired. */
  stats: () => { requests: number; rateLimited: number; failed: number; aborted: number; truncated: number }
  /** Change the faults without restarting -- this is how a sweep varies RTT. */
  configure: (next: FaultConfig) => void
  close: () => Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Drop the last `n` <Contents> entries and force IsTruncated to false.
 *
 * String surgery rather than an XML parser on purpose: the value of this fault
 * is that the response stays *well-formed and plausible*. A parser round-trip
 * would normalise the document and risk producing something no real S3 would
 * emit, which would make a passing test evidence about the wrong thing.
 */
function truncateListing(xml: string, n: number): { body: string; dropped: number } {
  if (n <= 0 || !xml.includes('<ListBucketResult')) return { body: xml, dropped: 0 }
  const parts = xml.split('<Contents>')
  if (parts.length <= 1) return { body: xml, dropped: 0 }
  const keep = Math.max(1, parts.length - n)
  const dropped = parts.length - keep
  if (dropped <= 0) return { body: xml, dropped: 0 }

  let body = parts.slice(0, keep).join('<Contents>')
  const tail = parts[parts.length - 1]
  const close = tail.lastIndexOf('</ListBucketResult>')
  if (close !== -1) body += tail.slice(close)
  else body += '</ListBucketResult>'

  body = body
    .replace(/<IsTruncated>true<\/IsTruncated>/, '<IsTruncated>false</IsTruncated>')
    .replace(/<NextContinuationToken>[\s\S]*?<\/NextContinuationToken>/, '')
  return { body, dropped }
}

/**
 * Forward one request, preserving the client's Host header verbatim.
 *
 * node:http rather than fetch, and the reason is specific. AWS SigV4 signs the
 * Host header; the SDK is pointed at the proxy, so it signs the *proxy's* host.
 * undici's fetch treats Host as a forbidden header and rewrites it to the target
 * URL's, so the origin recomputes a different signature and rejects everything
 * with SignatureDoesNotMatch. http.request sends the headers it is given.
 *
 * Nothing in the S3 unit tests catches this, because the fake S3 does not verify
 * signatures. It appeared the first time the proxy was pointed at real object
 * storage -- which is the argument for the stack existing at all.
 */
function forwardVia(originUrl: URL, agent: Agent) {
  return (path: string, method: string, headers: IncomingHttpHeaders, body: Buffer) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const outHeaders: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(headers)) {
        if (k === 'connection' || k === 'content-length') continue
        if (v !== undefined) outHeaders[k] = v
      }
      if (body.length > 0) outHeaders['content-length'] = String(body.length)

      const upstream = httpRequest(
        {
          protocol: originUrl.protocol,
          hostname: originUrl.hostname,
          port: originUrl.port,
          path,
          method,
          headers: outHeaders,
          agent,
          // setHost:false stops node appending its own Host and duplicating the
          // one being forwarded on purpose.
          setHost: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }),
          )
          res.on('error', reject)
        },
      )
      upstream.on('error', reject)
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
}

export async function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const origin = opts.origin.replace(/\/$/, '')
  // A private agent with keep-alive off, not the global one.
  //
  // node:http's global agent keeps sockets alive by default, and a live socket
  // holds the event loop open. Closing the proxy's *server* does nothing about
  // sockets the proxy opened as a *client*, so a test file that used a proxy
  // passed every assertion and then never exited -- which node --test reports as
  // the whole run hanging, not as a failure. Same shape as the leaked-handle
  // teardown bug in the test files: a hang is a worse outcome than a failure,
  // because it reads as infrastructure trouble rather than as a defect.
  const agent = new Agent({ keepAlive: true })
  const forward = forwardVia(new URL(origin), agent)
  let cfg: FaultConfig = { ...opts }
  let requests = 0
  let rateLimited = 0
  let failed = 0
  let aborted = 0
  let truncated = 0

  const emit = (event: Record<string, unknown>) => opts.onEvent?.(event)
  const every = (n: number | undefined, count: number) => n !== undefined && n > 0 && count % n === 0

  /**
   * Every request gets an answer, even when this file has a bug.
   *
   * Learned the hard way. A stale variable reference threw inside the handler,
   * so the response was never written -- and a client waiting on a response that
   * never comes does not fail, it *hangs*. One typo in a fault injector stalled
   * an entire test run, and the symptom (node --test never finishing) pointed
   * nowhere near the cause. Two wrong diagnoses went by before the real one:
   * first the client agent's keep-alive, then the server's; both were tested
   * against the bug and both were exonerated.
   *
   * A proxy that throws must fail the request, never hang it, because a hang is
   * the one failure mode that carries no information about where it came from.
   */
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      emit({ event: 'proxy.handler-error', path: req.url ?? '/', error: String(e) })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errors: [{ message: `proxy handler failed: ${String(e)}` }] }))
      } else {
        res.end()
      }
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/'
    const faultable = cfg.only === undefined || cfg.only.test(path)
    const n = ++requests

    // Latency goes first, and is charged even to a request that is about to be
    // refused. A rate-limited request still costs a round trip in reality, and
    // charging it only on success would flatter every retry measurement.
    if (cfg.latencyMs) await sleep(cfg.latencyMs)

    if (faultable && every(cfg.rateLimitEvery, n)) {
      rateLimited++
      emit({ event: 'proxy.429', path, n })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.retryAfterSec !== undefined) headers['retry-after'] = String(cfg.retryAfterSec)
      res.writeHead(429, headers)
      res.end(JSON.stringify({ errors: [{ message: 'injected rate limit' }] }))
      return
    }

    if (faultable && every(cfg.failEvery, n)) {
      failed++
      emit({ event: 'proxy.500', path, n })
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: 'injected server error' }] }))
      return
    }

    // Read the client body before forwarding. Buffering rather than streaming
    // is deliberate: uploads here are single-digit MB and buffering makes the
    // abort fault deterministic, which streaming would not.
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)

    let upstream: { status: number; headers: IncomingHttpHeaders; body: Buffer }
    try {
      upstream = await forward(path, req.method ?? 'GET', req.headers, body)
    } catch (e) {
      emit({ event: 'proxy.upstream-error', path, error: String(e) })
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: 'proxy upstream unreachable' }] }))
      return
    }

    let out = upstream.body
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (k === 'content-length' || k === 'transfer-encoding' || k === 'content-encoding') continue
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }

    if (faultable && cfg.dropListingEntries) {
      const text = out.toString('utf8')
      const { body: cut, dropped } = truncateListing(text, cfg.dropListingEntries)
      if (dropped > 0) {
        truncated++
        emit({ event: 'proxy.truncated-listing', path, dropped })
        out = Buffer.from(cut, 'utf8')
      }
    }

    if (faultable && cfg.stripContinuationToken) {
      const text = out.toString('utf8')
      if (text.includes('<NextContinuationToken>')) {
        truncated++
        emit({ event: 'proxy.stripped-continuation', path })
        out = Buffer.from(text.replace(/<NextContinuationToken>[\s\S]*?<\/NextContinuationToken>/, ''), 'utf8')
      }
    }

    // Half the response, then the socket dies. This is the shape that a naive
    // client reports as a parse error and a careless one reports as success
    // with a short body.
    if (faultable && every(cfg.abortEvery, n)) {
      aborted++
      emit({ event: 'proxy.abort', path, n })
      res.writeHead(upstream.status, headers)
      res.write(out.subarray(0, Math.floor(out.length / 2)))
      res.socket?.destroy()
      return
    }

    res.writeHead(upstream.status, { ...headers, 'content-length': String(out.length) })
    res.end(out)
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? 0)

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats: () => ({ requests, rateLimited, failed, aborted, truncated }),
    configure: (next: FaultConfig) => {
      cfg = { ...cfg, ...next }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        agent.destroy()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.filename === process.argv[1]) {
  const arg = (k: string, d?: string) => {
    const i = process.argv.indexOf(`--${k}`)
    return i === -1 ? d : process.argv[i + 1]
  }
  const num = (k: string) => {
    const v = arg(k)
    return v === undefined ? undefined : Number(v)
  }
  const origin = arg('origin')
  if (origin === undefined) {
    console.error('usage: node stack/proxy.ts --origin <url> [--port N] [--latency MS]')
    console.error('       [--rate-limit-every N] [--retry-after SEC] [--fail-every N]')
    console.error('       [--abort-every N] [--drop-listing N]')
    process.exit(2)
  }
  const proxy = await startProxy({
    origin,
    port: num('port') ?? 0,
    latencyMs: num('latency'),
    rateLimitEvery: num('rate-limit-every'),
    retryAfterSec: num('retry-after'),
    failEvery: num('fail-every'),
    abortEvery: num('abort-every'),
    dropListingEntries: num('drop-listing'),
    onEvent: (e) => console.log(JSON.stringify(e)),
  })
  console.log(JSON.stringify({ event: 'proxy.listening', url: proxy.url, origin }))
  process.on('SIGINT', async () => {
    console.log(JSON.stringify({ event: 'proxy.stats', ...proxy.stats() }))
    await proxy.close()
    process.exit(0)
  })
}
