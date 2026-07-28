// Provision the local stack: Directus collections, the notification flows, a
// seeded corpus, and the MinIO bucket.
//
// Idempotent by design -- every step checks before it creates, so re-running
// after a partial failure finishes the job rather than erroring or duplicating.
// That matters more than usual here because provisioning is ~40 API calls and
// the interesting failures are in the middle of them.
//
// The schema convention this establishes is load-bearing and is explained at
// length in stack/README.md: every collection carries an integer auto-increment
// primary key used *only* as a pagination cursor, with the engine's string
// document id in a separate unique column. Directus refuses `_gt` on a string
// field, so without the integer key the adapter would have to paginate by
// offset -- and an offset page that drifts mid-pull does not merely skip a
// document, it feeds an incomplete id set to DocumentStore.deleteMissing and
// unpublishes it.
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { blogDocs } from '../example/blog/fixture.ts'

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback
  if (v === undefined) throw new Error(`missing env ${k} -- source stack/env.sh first`)
  return v
}

const DIRECTUS = env('ISSG_DIRECTUS_URL', 'http://127.0.0.1:8055')
const EMAIL = env('ISSG_DIRECTUS_EMAIL', 'admin@example.com')
const PASSWORD = env('ISSG_DIRECTUS_PASSWORD', 'local-fixture-not-a-secret')

/** Where Directus should POST change notifications. Reachable *from the container*. */
const HOOK_URL = env('ISSG_HOOK_URL', 'http://host.containers.internal:8787/hooks/cms')
const HOOK_TOKEN = env('ISSG_HOOK_TOKEN', 'local-fixture-webhook-token')

let token = ''

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${DIRECTUS}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

// --- schema ------------------------------------------------------------------

type FieldSpec = { field: string; type: string; unique?: boolean; nullable?: boolean }

/**
 * The blog schema as typed Directus collections rather than one JSON blob table.
 *
 * A single `documents(id, type, json)` collection would have been an hour less
 * work and would have quietly dodged the whole point: with typed columns a CMS
 * field rename is a real, reproducible failure at the sync boundary, which is
 * what the schema validation there exists to catch.
 */
const COLLECTIONS: { name: string; fields: FieldSpec[] }[] = [
  {
    name: 'post',
    fields: [
      { field: 'slug', type: 'string' },
      { field: 'title', type: 'string' },
      { field: 'author', type: 'string' },
      { field: 'tags', type: 'json' },
      { field: 'date', type: 'bigInteger' },
      { field: 'body', type: 'text' },
      { field: 'hero', type: 'string', nullable: true },
    ],
  },
  { name: 'author', fields: [
    { field: 'slug', type: 'string' }, { field: 'name', type: 'string' }, { field: 'bio', type: 'text' },
  ] },
  { name: 'tag', fields: [
    { field: 'slug', type: 'string' }, { field: 'name', type: 'string' },
  ] },
  { name: 'page', fields: [
    { field: 'slug', type: 'string' }, { field: 'title', type: 'string' }, { field: 'body', type: 'text' },
  ] },
  { name: 'settings', fields: [
    { field: 'siteName', type: 'string' }, { field: 'nav', type: 'json' }, { field: 'footer', type: 'text' },
  ] },
]

/**
 * Both timestamp fields, always, and the reason is not symmetry.
 *
 * `date_updated` is null until a document is *updated*, so a delta filter on it
 * alone misses every newly created document -- silently, since a missed create
 * looks identical to no change. The adapter's delta filter is an `_or` across
 * the pair, and that only works if both exist from the moment the collection
 * does: a row created before its timestamp fields were added has null in both
 * and is invisible to delta sync forever.
 */
const TIMESTAMPS: any[] = [
  { field: 'date_created', type: 'timestamp', meta: { special: ['date-created'], readonly: true, hidden: true }, schema: {} },
  { field: 'date_updated', type: 'timestamp', meta: { special: ['date-updated'], readonly: true, hidden: true }, schema: {} },
]

async function collectionExists(name: string): Promise<boolean> {
  const res = await fetch(`${DIRECTUS}/collections/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return res.ok
}

async function ensureCollection(spec: { name: string; fields: FieldSpec[] }): Promise<void> {
  if (await collectionExists(spec.name)) {
    console.log(`  collection ${spec.name} exists`)
    return
  }
  const fields: any[] = [
    // Cursor key. Hidden because it is an implementation detail of pagination --
    // an editor has no reason to see it and no reason to be able to set it.
    { field: 'seq', type: 'integer', meta: { hidden: true },
      schema: { is_primary_key: true, has_auto_increment: true } },
    // The engine's document id. Unique so the CMS enforces what the store assumes.
    { field: 'doc_id', type: 'string', meta: { interface: 'input', required: true },
      schema: { is_unique: true, is_nullable: false } },
    ...spec.fields.map((f) => ({
      field: f.field,
      type: f.type,
      meta: { interface: f.type === 'text' ? 'input-multiline' : 'input' },
      schema: { is_nullable: f.nullable ?? true, is_unique: f.unique ?? false },
    })),
    ...TIMESTAMPS,
  ]
  await api('/collections', {
    method: 'POST',
    body: JSON.stringify({ collection: spec.name, schema: {}, meta: { note: 'incremental-ssg fixture' }, fields }),
  })
  console.log(`  collection ${spec.name} created`)
}

// --- notification flows ------------------------------------------------------

/**
 * Three flows total -- one per event type, each scoped to every collection.
 *
 * Two independent constraints force this exact shape.
 *
 * It cannot be one flow, because Directus delivers three different payload
 * shapes and a single template silently fails on two of them:
 *
 *   items.create -> `key`  (integer, singular)
 *   items.update -> `keys` (array of strings)
 *   items.delete -> `keys`, but the row is already gone
 *
 * A flow written against `{{$trigger.keys}}` works for updates and produces
 * *nothing at all* for creates: the template resolves to nothing, the read
 * operation aborts, and the request never runs. No error reaches the editor and
 * no notification reaches the service. Deletes fail at the same step for the
 * different reason that there is nothing left to read, which is why the delete
 * flow skips the read and forwards the bare trigger.
 *
 * And it cannot be three flows *per collection*, because an unlicensed Directus
 * caps concurrent **active event-triggered** flows at five -- measured, by
 * creating them until one was refused with `LIMIT_EXCEEDED`. Inactive flows and
 * non-event triggers do not count against it. Three per collection would need
 * fifteen. The collection is therefore late-bound: `{{$trigger.collection}}`
 * resolves inside the read operation, verified across two different collections
 * rather than inferred from one.
 */
async function ensureFlows(collections: string[]): Promise<void> {
  const existing = await api(`/flows?fields=id,name&limit=-1`)
  const byName = new Map<string, string>((existing.data ?? []).map((f: any) => [f.name, f.id]))

  const specs = [
    { suffix: 'create', scope: ['items.create'], keyExpr: '{{$trigger.key}}', read: true },
    { suffix: 'update', scope: ['items.update'], keyExpr: '{{$trigger.keys}}', read: true },
    { suffix: 'delete', scope: ['items.delete'], keyExpr: null, read: false },
  ]

  for (const spec of specs) {
    const name = `issg-${spec.suffix}`
    if (byName.has(name)) {
      console.log(`  flow ${name} exists`)
      continue
    }
    const flow = await api('/flows', {
      method: 'POST',
      body: JSON.stringify({
        name, status: 'active', trigger: 'event', accountability: 'all',
        options: { type: 'action', scope: spec.scope, collections },
      }),
    })
    const flowId = flow.data.id

    const headers = [
      { header: 'content-type', value: 'application/json' },
      { header: 'x-webhook-token', value: HOOK_TOKEN },
    ]

    // The delete flow forwards the trigger untouched. It carries no revision and
    // needs none: nothing is being read back after a write, so the service only
    // has to learn that something changed and the reconcile scan works out what.
    const body = spec.read
      ? `{"event":"{{$trigger.event}}","collection":"{{$trigger.collection}}","docs":{{$last}}}`
      : `{"event":"{{$trigger.event}}","collection":"{{$trigger.collection}}","keys":{{$trigger.keys}}}`

    const request = await api('/operations', {
      method: 'POST',
      body: JSON.stringify({
        flow: flowId, name: 'notify', key: 'notify', type: 'request',
        position_x: 37, position_y: 1,
        options: { method: 'POST', url: HOOK_URL, headers, body },
      }),
    })

    let head = request.data.id
    if (spec.read) {
      const read = await api('/operations', {
        method: 'POST',
        body: JSON.stringify({
          flow: flowId, name: 'read', key: 'read', type: 'item-read',
          position_x: 19, position_y: 1,
          options: {
            // Late-bound, so one flow serves every collection. See above.
            collection: '{{$trigger.collection}}',
            key: spec.keyExpr, permissions: '$full',
            query: { fields: ['doc_id', 'date_updated', 'date_created'] },
          },
          resolve: request.data.id,
        }),
      })
      head = read.data.id
    }
    await api(`/flows/${flowId}`, { method: 'PATCH', body: JSON.stringify({ operation: head }) })
    console.log(`  flow ${name} created`)
  }
}

// --- corpus ------------------------------------------------------------------

async function seedCorpus(posts: number): Promise<void> {
  const docs = blogDocs({ posts, tags: 5, authors: 3, pages: 2, paras: 2, code: true })
  const byType = new Map<string, any[]>()
  for (const d of docs) {
    const { id, updated_at, rev, ...rest } = d.doc as any
    const row: any = { doc_id: id, ...rest }
    const list = byType.get(d.type)
    if (list) list.push(row)
    else byType.set(d.type, [row])
  }

  for (const [type, rows] of byType) {
    const have = await api(`/items/${type}?aggregate[count]=doc_id`)
    const count = Number(have.data?.[0]?.count?.doc_id ?? have.data?.[0]?.count ?? 0)
    if (count > 0) {
      console.log(`  ${type}: ${count} rows already present, skipping`)
      continue
    }
    // Chunked because a single insert of 20k rows is one request that either
    // works or leaves nothing behind, and because Directus buffers the whole
    // body before it writes anything.
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      await api(`/items/${type}`, { method: 'POST', body: JSON.stringify(rows.slice(i, i + CHUNK)) })
    }
    console.log(`  ${type}: ${rows.length} rows inserted`)
  }
}

// --- MinIO -------------------------------------------------------------------

async function ensureBucket(): Promise<void> {
  const client = new S3Client({
    endpoint: env('ISSG_S3_ENDPOINT', 'http://127.0.0.1:9000'),
    region: env('ISSG_S3_REGION', 'us-east-1'),
    credentials: {
      accessKeyId: env('ISSG_S3_ACCESS_KEY', 'issglocal'),
      secretAccessKey: env('ISSG_S3_SECRET_KEY', 'issglocal-fixture'),
    },
    // MinIO serves buckets as a path segment rather than a subdomain. Real S3
    // and R2 both accept path style too, so this does not fork the code path.
    forcePathStyle: true,
  })
  const bucket = env('ISSG_S3_BUCKET', 'issg-site')
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    console.log(`  bucket ${bucket} exists`)
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    console.log(`  bucket ${bucket} created`)
  }
}

// --- main --------------------------------------------------------------------

const posts = Number(process.argv[2] ?? process.env.ISSG_SEED_POSTS ?? 25)

console.log(`Directus ${DIRECTUS}`)
const auth = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
token = auth.data.access_token

console.log('collections:')
for (const spec of COLLECTIONS) await ensureCollection(spec)

console.log(`flows (notifying ${HOOK_URL}):`)
await ensureFlows(COLLECTIONS.map((c) => c.name))

console.log(`corpus (${posts} posts):`)
await seedCorpus(posts)

console.log('object storage:')
await ensureBucket()

console.log('\nseeded.')
