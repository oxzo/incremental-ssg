#!/usr/bin/env node
// Command line entry point.
//
//   sync    pull the CMS into the local document mirror
//   build   render the mirror to static HTML
//   deploy  upload and purge only the files the build changed
//   serve   webhook endpoint that does all three, unattended
//
// Four commands rather than one because they fail differently and are triggered
// differently: sync is the only stage that touches the CMS, a build must be
// runnable offline against whatever the last sync left behind, deploy is the only
// stage that can damage a live site, and serve is the only one that runs with
// nobody reading its output.
//
// build, deploy and serve all take the build lock. A lock only the service
// respects would not be a lock -- the collision worth preventing is an operator
// running `build` by hand while a scheduled publish is mid-render.
import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { httpCmsAdapter } from './cms.ts'
import { DocumentStore } from './store.ts'
import { sync } from './sync.ts'
import { build } from './build.ts'
import { deploy } from './deploy.ts'
import { directoryTarget } from './deploy-mock.ts'
import { directusCmsAdapter } from './cms-directus.ts'
import { s3DeployTarget } from './deploy-s3.ts'
import { loadSite } from './config.ts'
import { withLock } from './build-lock.ts'
import { createPipeline, createService, jsonLog } from './service.ts'
import { startWebhookServer } from './webhook.ts'

const USAGE = `incremental-ssg

  sync   --site <module> --db <file> --cms <url>
         [--page-size N] [--full] [--no-reconcile]
         [--no-delta] [--no-id-listing]

  build  --site <module> --db <file> --out <dir>
         [--workers N] [--clean] [--skip-assets] [--force-unlock]

  deploy --out <dir> --to <dir> [--db <file> | --work-dir <dir>]
         [--dry-run] [--force] [--max-delete-ratio R]
         [--purge-added] [--no-digests] [--concurrency N] [--force-unlock]

  serve  --site <module> --db <file> --out <dir> --cms <url> --to <dir>
         [--port N] [--host H] [--path /webhook]
         [--secret S] [--hmac-secret S] [--allow-unauthenticated]
         [--debounce MS] [--max-delay MS] [--poll MS]
         [--workers N] [--page-size N] [--build-on-start]
         [--dry-run] [--max-delete-ratio R] [--purge-added]

Notes
  --page-size is the dominant lever on sync wall time: at 300ms round-trip,
  50 per page costs ~125s where 500 per page costs ~13s.
  --full ignores the stored watermark and re-pulls everything.
  --no-delta / --no-id-listing declare a CMS that lacks those capabilities,
  which changes the strategy (always full) and disables delete detection.

  deploy requires a build that ran with --clean, because nothing removes
  output an earlier build left behind and a stale page reads as unchanged.
  --dry-run prints the plan without touching the target.

  --cms selects the adapter by scheme:
    http://host            the mock/generic cursor-paginated JSON API
    directus+http://host   a real Directus; needs DIRECTUS_COLLECTIONS and
                           either DIRECTUS_TOKEN or DIRECTUS_EMAIL+PASSWORD
  --to likewise:
    <dir>                  a local directory standing in for the live site,
                           which is how a deploy is rehearsed against something
                           that cannot damage anything
    s3://bucket[/prefix]   real object storage; needs S3_ACCESS_KEY_ID and
                           S3_SECRET_ACCESS_KEY, plus S3_ENDPOINT for MinIO/R2
  Credentials come from the environment only. A secret passed as a flag is
  visible to every user on the box via ps for the life of the process.
  --no-digests simulates a target that cannot report content hashes, which
  degrades the diff to a full upload rather than to silence.

  serve is the only unattended command. It refuses to start without --secret
  or --hmac-secret unless --allow-unauthenticated is passed: an open endpoint
  that triggers a full build is a denial of service needing no payload. Prefer
  WEBHOOK_SECRET / WEBHOOK_HMAC_SECRET in the environment over a flag, since
  a secret on the command line is visible in ps.
  It always builds with clean output, because the deploy refuses anything else.
  Editor saves arrive in bursts, so triggers are debounced (--debounce) but
  never delayed past --max-delay. --poll is the net under unreliable webhook
  delivery; a missed publish that silently never builds is the worst failure
  available here. Endpoints: POST <path>, POST <path>/build (forces a publish,
  and clears a halt), GET /health (unauthenticated, up or down), GET /status.

  --force-unlock breaks a held build lock. Only for a holder that is gone but
  whose pid has been reused -- concurrent builds corrupt the store, the output
  tree and the seal at once.
`

const fail = (msg: string): never => {
  console.error(`error: ${msg}\n\n${USAGE}`)
  process.exit(2)
}

const ms = (n: number) => `${n.toFixed(0)}ms`
const need = (v: string | undefined, flag: string) => v ?? fail(`--${flag} is required`)

/**
 * Pick a CMS adapter from --cms.
 *
 * The scheme selects the implementation, so one flag names both which service
 * and where it is. `directus+http://host` rather than a separate --cms-kind:
 * a URL and a kind that disagree is a class of misconfiguration that cannot be
 * expressed if there is only one string.
 *
 * Credentials come from the environment only, never a flag -- a secret on the
 * command line is visible to every user on the box via ps, for the whole life of
 * a long-running service.
 */
function cmsAdapterFrom(spec: string, opts: { deltaSync?: boolean; idListing?: boolean } = {}) {
  if (spec.startsWith('directus+')) {
    const baseUrl = spec.slice('directus+'.length)
    const collections = (process.env.DIRECTUS_COLLECTIONS ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    if (collections.length === 0) {
      fail('DIRECTUS_COLLECTIONS must list the collections to sync, comma-separated')
    }
    const token = process.env.DIRECTUS_TOKEN
    const email = process.env.DIRECTUS_EMAIL
    const password = process.env.DIRECTUS_PASSWORD
    if (!token && !(email && password)) {
      fail('set DIRECTUS_TOKEN, or DIRECTUS_EMAIL and DIRECTUS_PASSWORD')
    }
    return directusCmsAdapter({ baseUrl, collections, token, email, password })
  }
  return httpCmsAdapter({
    baseUrl: spec,
    capabilities: { deltaSync: opts.deltaSync ?? true, idListing: opts.idListing ?? true },
  })
}

/**
 * Pick a deploy target from --to: `s3://bucket/prefix`, or a local directory.
 *
 * The directory target is not a lesser option kept for tests -- it is how a
 * deploy is rehearsed against something that cannot damage a live site, which is
 * why --dry-run and a directory are different tools rather than the same one.
 */
function deployTargetFrom(spec: string, opts: { digestListing?: boolean } = {}) {
  if (spec.startsWith('s3://')) {
    const [bucket, ...rest] = spec.slice('s3://'.length).split('/')
    if (!bucket) fail('--to s3://<bucket>[/<prefix>] needs a bucket')
    const accessKeyId = process.env.S3_ACCESS_KEY_ID
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
    if (!accessKeyId || !secretAccessKey) {
      fail('set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY')
    }
    return s3DeployTarget({
      bucket,
      prefix: rest.join('/'),
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      accessKeyId,
      secretAccessKey,
    })
  }
  return directoryTarget({
    dir: resolve(spec),
    capabilities: { digestListing: opts.digestListing ?? true },
  })
}

/**
 * Report a refusal as a message, not a stack.
 *
 * The rails throw text written to be read by a person deciding whether to
 * override them, and a stack trace buries the explanation under the frames.
 */
const die = (e: unknown): never => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const command = process.argv[2]
const argv = process.argv.slice(3)

if (command === 'sync') {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      db: { type: 'string' },
      cms: { type: 'string' },
      'page-size': { type: 'string' },
      full: { type: 'boolean' },
      'no-reconcile': { type: 'boolean' },
      'no-delta': { type: 'boolean' },
      'no-id-listing': { type: 'boolean' },
    },
  })
  const dbPath = resolve(need(values.db, 'db'))
  const baseUrl = need(values.cms, 'cms')
  // The site is loaded only to learn which content types to keep; sync itself
  // has no opinion about the schema.
  const contentTypes = values.site ? (await loadSite(resolve(values.site))).contentTypes : undefined

  const adapter = cmsAdapterFrom(baseUrl, {
    deltaSync: !values['no-delta'],
    idListing: !values['no-id-listing'],
  })
  const store = new DocumentStore(dbPath)
  try {
    const r = await sync(adapter, store, {
      pageSize: values['page-size'] ? Number(values['page-size']) : undefined,
      full: values.full,
      reconcile: !values['no-reconcile'],
      contentTypes,
    })
    console.log(
      `${r.strategy}: ${r.pulled} pulled, ${r.changed} changed, ${r.deleted} deleted, ` +
      `${r.requests} requests, ${(r.bytes / 1024 / 1024).toFixed(1)} MiB, ${ms(r.ms.total)}`)
    if (r.deleted > 0) console.log(`  ${r.deleted} document(s) removed by the reconcile scan`)
  } finally {
    store.close()
  }
} else if (command === 'build') {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      db: { type: 'string' },
      out: { type: 'string' },
      workers: { type: 'string' },
      clean: { type: 'boolean' },
      'skip-assets': { type: 'boolean' },
      'force-unlock': { type: 'boolean' },
    },
  })
  const dbPath = resolve(need(values.db, 'db'))
  const r = await withLock(dirname(dbPath), { label: 'cli build', force: values['force-unlock'] }, () =>
    build({
      site: resolve(need(values.site, 'site')),
      dbPath,
      outDir: resolve(need(values.out, 'out')),
      workers: values.workers ? Number(values.workers) : undefined,
      clean: values.clean,
      skipAssets: values['skip-assets'],
    })).catch(die)
  console.log(
    `${r.site}: ${r.routes} routes from ${r.documents} documents, ` +
    `${(r.bytes / 1024 / 1024).toFixed(1)} MiB, ${r.workers} workers, ${ms(r.ms.total)}`)
  console.log(
    `  load ${ms(r.ms.load)}  index ${ms(r.ms.index)}  routes ${ms(r.ms.routes)}  ` +
    `assets ${ms(r.ms.assets)}  render ${ms(r.ms.render)}`)
  if (r.assets) {
    console.log(
      `  assets: ${r.assets.sources} sources, ${r.assets.stats.hits} cached, ` +
      `${r.assets.stats.misses} encoded, ${r.assets.published} published` +
      (r.assets.gc.deleted > 0 ? `, ${r.assets.gc.deleted} collected` : ''))
  }
} else if (command === 'deploy') {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      to: { type: 'string' },
      db: { type: 'string' },
      'work-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      'max-delete-ratio': { type: 'string' },
      'purge-added': { type: 'boolean' },
      'no-digests': { type: 'boolean' },
      concurrency: { type: 'string' },
      'force-unlock': { type: 'boolean' },
    },
  })
  const outDir = resolve(need(values.out, 'out'))
  // The seal lives beside the database by default, because that is where build
  // puts its work directory when it is not told otherwise.
  const workDir = values['work-dir']
    ? resolve(values['work-dir'])
    : values.db
      ? dirname(resolve(values.db))
      : fail('--work-dir or --db is required, to locate the build seal')

  const target = deployTargetFrom(need(values.to, 'to'), {
    digestListing: !values['no-digests'],
  })
  // Under the lock: this reads the seal and every emitted byte, and a build
  // running underneath it would be rewriting both while the diff is computed.
  const r = await withLock(workDir, { label: 'cli deploy', force: values['force-unlock'] }, () =>
    deploy({
      outDir,
      target,
      workDir,
      dryRun: values['dry-run'],
      force: values.force,
      purgeAdded: values['purge-added'],
      maxDeleteRatio: values['max-delete-ratio'] ? Number(values['max-delete-ratio']) : undefined,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    })).catch(die)
  const p = r.plan
  console.log(
    `${r.dryRun ? 'plan' : r.target}: ${p.added.length} added, ${p.modified.length} modified, ` +
    `${p.deleted.length} deleted, ${p.unchanged} unchanged`)
  if (!r.dryRun) {
    console.log(
      `  ${r.uploaded} uploaded (${(r.bytes / 1024 / 1024).toFixed(1)} MiB), ` +
      `${r.deleted} removed, ${r.purged} purged, ${ms(r.ms.total)}`)
    console.log(`  hash ${ms(r.ms.hash)}  list ${ms(r.ms.list)}  upload ${ms(r.ms.upload)}`)
  }
  if (p.digestsUnavailable) {
    console.log(
      `  note: the target reported no content digests, so every existing path was ` +
      `re-uploaded — the diff cannot tell which of them actually changed`)
  }
  if (p.deleted.length > 0) {
    for (const path of p.deleted.slice(0, 10)) console.log(`  - ${path}`)
    if (p.deleted.length > 10) console.log(`  - … and ${p.deleted.length - 10} more`)
  }
} else if (command === 'serve') {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      db: { type: 'string' },
      out: { type: 'string' },
      cms: { type: 'string' },
      to: { type: 'string' },
      'work-dir': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      path: { type: 'string' },
      secret: { type: 'string' },
      'hmac-secret': { type: 'string' },
      'allow-unauthenticated': { type: 'boolean' },
      debounce: { type: 'string' },
      'max-delay': { type: 'string' },
      poll: { type: 'string' },
      workers: { type: 'string' },
      'page-size': { type: 'string' },
      'build-on-start': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'max-delete-ratio': { type: 'string' },
      'purge-added': { type: 'boolean' },
      'force-unlock': { type: 'boolean' },
    },
  })
  const site = resolve(need(values.site, 'site'))
  const dbPath = resolve(need(values.db, 'db'))
  const outDir = resolve(need(values.out, 'out'))
  const workDir = resolve(values['work-dir'] ?? dirname(dbPath))

  const adapter = cmsAdapterFrom(need(values.cms, 'cms'))
  const target = deployTargetFrom(need(values.to, 'to'))

  const pipeline = createPipeline({
    site,
    dbPath,
    outDir,
    workDir,
    adapter,
    target,
    workers: values.workers ? Number(values.workers) : undefined,
    pageSize: values['page-size'] ? Number(values['page-size']) : undefined,
    forceUnlock: values['force-unlock'],
    deploy: {
      dryRun: values['dry-run'],
      purgeAdded: values['purge-added'],
      maxDeleteRatio: values['max-delete-ratio'] ? Number(values['max-delete-ratio']) : undefined,
    },
  })

  const service = createService({
    run: pipeline,
    lockDir: workDir,
    debounceMs: values.debounce ? Number(values.debounce) : undefined,
    maxDelayMs: values['max-delay'] ? Number(values['max-delay']) : undefined,
    pollMs: values.poll ? Number(values.poll) : undefined,
    buildOnStart: values['build-on-start'],
  })

  // Environment first: a secret passed as a flag is visible to every user on the
  // box via ps, for the whole life of a long-running service.
  const http = await startWebhookServer({
    service,
    adapter,
    port: values.port ? Number(values.port) : 8787,
    host: values.host,
    path: values.path,
    secret: process.env.WEBHOOK_SECRET ?? values.secret,
    hmacSecret: process.env.WEBHOOK_HMAC_SECRET ?? values['hmac-secret'],
    allowUnauthenticated: values['allow-unauthenticated'],
  }).catch(die)

  service.start()

  // Stop accepting deliveries first, then let the run in flight finish. The
  // reverse order would accept a webhook it is about to stop being able to serve,
  // and the sender would count it as delivered.
  let closing = false
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (closing) return
      closing = true
      jsonLog({ event: 'service.stopping', signal: sig })
      void (async () => {
        await http.close()
        await service.stop()
        process.exit(0)
      })()
    })
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE)
} else {
  fail(command ? `unknown command "${command}"` : 'no command given')
}
