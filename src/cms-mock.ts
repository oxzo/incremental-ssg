// Mock headless CMS -- cursor-paginated JSON with optional injected latency.
//
// Promoted from the Phase 2b harness because no real CMS has been chosen yet, so
// this is currently the only adapter target the pipeline has. It is a real HTTP
// server rather than an in-process stub on purpose: sync is the one stage that
// talks to the network, and stubbing that away would test everything except the
// part with the interesting failure modes.
//
// What it deliberately does NOT model, so nobody reads a green test as proof the
// real thing will work: auth, rate limiting, a pagination cap, replica lag, or
// partial-page failures.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockDoc = { type: string; doc: Record<string, unknown> & { id: string } }

export type MockCms = {
  server: Server
  port: number
  url: string
  /** Requests served, for asserting a delta sync actually made fewer of them. */
  requests: number
  close(): Promise<void>
}

export function startMockCms(docs: MockDoc[], latencyMs = 0): Promise<MockCms> {
  const state = { requests: 0 }
  const server = createServer((req, res) => {
    state.requests++
    const url = new URL(req.url ?? '/', 'http://localhost')
    const respond = () => {
      if (url.pathname === '/ids') {
        // The cheap scan that catches deletes and unpublishes. An `updatedAt >`
        // query can never return a document that is gone, so without this a
        // delete leaves an orphan page live forever.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ids: docs.map((d) => [d.doc.id, d.doc.rev ?? '', d.type]) }))
        return
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const sinceRaw = url.searchParams.get('since')
      const pool =
        sinceRaw === null
          ? docs
          : docs.filter((d) => Number(d.doc.updated_at ?? 0) > Number(sinceRaw))
      const slice = pool.slice(cursor, cursor + limit)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          items: slice,
          next: cursor + limit < pool.length ? String(cursor + limit) : null,
          total: pool.length,
        }),
      )
    }
    if (latencyMs > 0) setTimeout(respond, latencyMs)
    else respond()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        get requests() {
          return state.requests
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
