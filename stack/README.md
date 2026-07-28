# The local stack — a real CMS and a real S3 target

Six phases shipped against mocks on both ends. A mock only fails in the ways
somebody remembered to write, so auth, cursor pagination, listing caps, ETags
and rate limits had never been exercised by anything. This directory stands up
real software instead: **Directus** (the CMS end) and **MinIO** (the deploy end),
both in rootless podman containers, both bootstrapped without a signup form.

```sh
stack/up.sh            # start both, wait for readiness
stack/down.sh          # stop, keep the data
stack/down.sh --clean  # stop and destroy the volumes
```

Credentials live in `stack/env.sh` and are fixtures rather than secrets — see the
comment at the top of that file for why they are committed and why that shape
must not be copied for anything real.

## What this does and does not buy

It closes the *cost model* gap: real HTTP, real auth, real pagination, real
ETags, and — with `stack/proxy` in front — RTT and failure injection that can be
swept rather than sampled. Localhost RTT is meaningless on its own, which is why
the proxy exists; injected latency is what makes the page-size lever measurable
at all.

It does **not** close the unknown-unknowns gap. Every injected failure is a
failure that was anticipated, and the reason this work exists is that
anticipated failures are the ones already handled. A real hosted CMS and a real
CDN will fail in ways not represented here.

## Directus 12.1.1 — capabilities as measured, not as documented

Verified against a running instance on 2026-07-28 by provisioning collections
and flows and observing actual responses. Every claim below was produced by a
request, not from memory.

| `CmsCapabilities` | Verdict | What it actually took |
|---|---|---|
| `deltaSync` | **true**, conditionally | An `_or` filter over *two* timestamp fields |
| `idListing` | **true** | `?fields=<key>&limit=-1`, plus `meta=total_count` |
| `webhookRevisions` | **true**, with provisioning | A two-operation flow, and one flow per event type |

### Delta sync needs both timestamp fields, not one

`date_updated` (the `date-updated` special) is **null on create** and only
populates on a subsequent update. `date_created` is the mirror image. So neither
field alone is a complete change watermark, and the natural-looking filter —
`date_updated > watermark` — silently misses **every newly created document**.

The working filter is an `_or` across both:

```json
{"_or": [{"date_created": {"_gt": "<watermark>"}},
         {"date_updated": {"_gt": "<watermark>"}}]}
```

Residual limit worth knowing: a row created *before* its timestamp fields were
added to the collection has null in both, and is therefore invisible to any
delta filter forever. Only a full pull or the id-reconcile scan will ever see it.

### Pagination must be keyset, and that constrains the schema

Directus rejects `_gt` on a `string` field — `"string" field type does not
contain the "_gt" filter operator` — so keyset pagination on a string business
key is not available, leaving offset pagination as the obvious fallback.

Offset pagination is **not safe here**, and the reason is specific rather than
general. The sync driver feeds the set of ids it pulled straight into
`DocumentStore.deleteMissing` after a full pull. If offset paging drifts because
a document was inserted or removed mid-pull, the skipped document is absent from
that set — so it is not merely missed, it is **deleted from the store and
unpublished from the live site**. This is the same assumed-complete-set hazard
the codebase has now met in `AssetCache.gc`, `DocumentStore.deleteMissing`, the
deploy seal, the deploy diff's silent mirror image, and Phase 5's queue
argument. This is its sixth appearance and its first from outside the codebase.

The fix is a schema convention rather than adapter cleverness: every synced
collection carries an **integer auto-increment primary key** used only for
ordering, and the string document id lives in a separate unique column. `_gt`
works on the integer, so pagination is true keyset — stable across inserts and
deletes mid-pull. Nothing leaks: `CmsPage.cursor` is opaque by contract, so the
engine never learns that the cursor is a Directus row number.

### Webhooks: removed in v12, and the replacement has three payload shapes

The legacy `/webhooks` endpoint returns **404** in 12.1.1 — the migration log
shows a `Remove Webhooks` step. Flows replace it, and an outgoing notification
is an `event` trigger plus a `request` operation.

The raw trigger carries no revision and does not identify the document by its
business key, so a bare flow cannot satisfy `revisionOf()`. Chaining an
`item-read` operation ahead of the `request` fixes that — but the three event
types deliver **three different shapes**, which is what makes a single flow fail
silently:

| Event | Key field | Type | Read-back |
|---|---|---|---|
| `items.create` | `key` | integer, singular | works |
| `items.update` | `keys` | string array | works |
| `items.delete` | `keys` | string array | **impossible** — the row is gone |

A flow written against `{{$trigger.keys}}` therefore works for updates and
**silently produces nothing for creates**, because the template resolves to
nothing and the read operation aborts the flow before the request runs. Deletes
die at the same step for a different reason. Both failures are invisible from
the outside: the edit succeeds, no error surfaces, and no notification arrives.

Two further shape facts, both of which will crash a naive parser:

- A single-key update returns the read-back as an **object**; a multi-key update
  returns an **array**.
- Delete carries no revision at all, and needs none — nothing is being read back
  after a write, so the service only needs "something changed" and the reconcile
  scan determines what.

### The flow budget is five, which decides the provisioning shape

An unlicensed Directus refuses to create a sixth **active event-triggered** flow
— `403 {"code":"LIMIT_EXCEEDED"}`. The limit was measured rather than read: an
earlier attempt to register three flows per collection died on the sixth, and
creating flows one at a time afterwards showed inactive flows and non-event
triggers do not count against the budget. Fifteen flows was never available.

So `stack/seed.ts` registers **three flows, one per event type, each scoped to
every collection**, with the collection late-bound in the read operation via
`{{$trigger.collection}}`. That template does resolve dynamically — verified by
triggering two different collections through the same flow and observing each
report its own, rather than inferring it from a single observation where the
collection happened to match. Three of five leaves headroom; per-collection
flows would have needed a licence.

## MinIO

Stands in for S3/R2 behind `DeployTarget`. It speaks the S3 API, so the adapter
uses `@aws-sdk/client-s3` — the vendor SDK rather than hand-rolled SigV4 — and
the identical code path later points at R2 or S3 with only credentials and an
endpoint changing.

`purge()` is an explicitly recorded no-op: there is no CDN in front of this, and
a target that pretended to purge would be worse than one that says it cannot.

### The proxy has to forward Host verbatim, and that is a SigV4 fact

Putting the fault proxy in front of MinIO failed every request with
`SignatureDoesNotMatch` until the proxy stopped rewriting the `Host` header.
SigV4 signs Host; the SDK is pointed at the proxy, so it signs the *proxy's*
host, and an origin that receives a different one recomputes a different
signature.

Two things made this worth writing down rather than just fixing. The proxy had
to move from `fetch` to `node:http`, because undici treats `Host` as a forbidden
header and silently rewrites it — the header cannot be forwarded through `fetch`
at all. And **the S3 unit tests never caught it**, because `test/s3-fake.ts` does
not verify signatures: every fault test passed against the fake and the identical
configuration failed instantly against real object storage. That gap is the
entire argument for this directory existing.
