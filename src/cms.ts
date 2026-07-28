// The CMS adapter interface, and a generic HTTP implementation of it.
//
// Only one CMS will ever be targeted, so the interface is not here for
// portability. It is here because the three things it exposes are exactly the
// three capabilities that differ sharply between CMSes, while document *shapes*
// barely differ at all:
//
//   1. cursor-based delta sync   -- absent => every sync is a full pull
//   2. cheap full-ID listing     -- absent => deletes are undetectable
//   3. revisions in webhooks     -- absent => no read-after-write check (Phase 5)
//
// A CMS missing all three does not need a different adapter so much as a
// different cost model, which is why `capabilities` is data the sync driver
// branches on rather than something each adapter silently works around.

export type CmsDocument = {
  id: string
  type: string
  /** Opaque, compared for equality only. Falls back to the hash if the CMS has none. */
  revision: string
  updatedAt: number
  doc: Record<string, unknown>
}

export type CmsPage = {
  items: CmsDocument[]
  /** Opaque continuation token; null when the listing is exhausted. */
  cursor: string | null
  /**
   * How many documents this listing yields for this query *in total*, counting
   * the ones already returned -- or undefined when the adapter cannot say.
   *
   * A total, not a remainder, and the distinction is the whole of the contract.
   * A CMS that paginates by keyset answers "how many match" relative to the
   * cursor, so the natural reading of its count shrinks with every page; a
   * driver comparing that against a running pull would be comparing two
   * different populations and refusing correct syncs. An adapter that can only
   * see remainders is expected to accumulate into this field rather than pass
   * one through.
   *
   * Optional because it is evidence, not a requirement, and `undefined` has to
   * stay distinguishable from zero: absence disables the completeness check in
   * sync(), it does not fail it. An adapter that cannot count says so by
   * omitting this rather than by guessing, because a guessed total refuses real
   * listings.
   */
  total?: number
}

export type CmsCapabilities = {
  /** Can list only documents changed since a watermark. */
  deltaSync: boolean
  /** Can list all ids cheaply, without pulling bodies. */
  idListing: boolean
  /** Webhook payloads carry a revision identifier. */
  webhookRevisions: boolean
}

export type ListOptions = {
  cursor: string | null
  limit: number
  /** Exclusive lower bound on updatedAt. Ignored unless capabilities.deltaSync. */
  since?: number
}

export type CmsAdapter = {
  name: string
  capabilities: CmsCapabilities
  list(opts: ListOptions): Promise<CmsPage>
  /** Complete id listing. The only thing that catches deletes and unpublishes. */
  listIds(): Promise<{ id: string; revision: string }[]>
  /** Phase 5: pull the changed document out of a webhook body. */
  revisionOf(payload: unknown): { id: string; revision: string } | null
  /** Bytes read over the wire, for reporting. */
  bytesRead(): number
}

export type HttpCmsOptions = {
  baseUrl: string
  name?: string
  capabilities?: Partial<CmsCapabilities>
  headers?: Record<string, string>
}

/**
 * Cursor-paginated JSON over HTTP -- the protocol the mock server speaks, and the
 * shape most headless CMS list endpoints reduce to.
 *
 * Page size is deliberately the caller's decision, not a constant here: Phase 2b
 * found request count dominates sync wall time far more than delta filtering
 * does (at 300ms RTT, 50-per-page cost 125s against 13s at 500-per-page), so the
 * page size is the single biggest lever in this file.
 */
export function httpCmsAdapter(opts: HttpCmsOptions): CmsAdapter {
  const base = opts.baseUrl.replace(/\/$/, '')
  const headers = opts.headers ?? {}
  let bytes = 0

  const getJson = async (url: string) => {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`CMS ${res.status} ${res.statusText} for ${url}`)
    const text = await res.text()
    bytes += Buffer.byteLength(text)
    return JSON.parse(text)
  }

  return {
    name: opts.name ?? 'http',
    capabilities: {
      deltaSync: opts.capabilities?.deltaSync ?? true,
      idListing: opts.capabilities?.idListing ?? true,
      webhookRevisions: opts.capabilities?.webhookRevisions ?? true,
    },
    async list(o: ListOptions): Promise<CmsPage> {
      const qs = new URLSearchParams({ limit: String(o.limit) })
      if (o.cursor !== null) qs.set('cursor', o.cursor)
      if (o.since !== undefined) qs.set('since', String(o.since))
      const page = await getJson(`${base}/documents?${qs}`)
      return {
        items: (page.items as any[]).map((it) => ({
          id: String(it.doc.id),
          type: String(it.type),
          revision: String(it.doc.rev ?? it.doc.revision ?? ''),
          updatedAt: Number(it.doc.updated_at ?? 0),
          doc: it.doc as Record<string, unknown>,
        })),
        cursor: page.next === null || page.next === undefined ? null : String(page.next),
        total: page.total,
      }
    },
    async listIds() {
      const body = await getJson(`${base}/ids`)
      return (body.ids as [string, string][]).map(([id, revision]) => ({
        id,
        revision: String(revision ?? ''),
      }))
    },
    revisionOf(payload: unknown) {
      const p = payload as any
      if (!p || typeof p !== 'object') return null
      const id = p.id ?? p.documentId ?? p?.doc?.id
      const revision = p.rev ?? p.revision ?? p?.doc?.rev
      if (id === undefined || revision === undefined) return null
      return { id: String(id), revision: String(revision) }
    },
    bytesRead: () => bytes,
  }
}
