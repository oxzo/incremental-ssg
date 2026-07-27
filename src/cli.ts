#!/usr/bin/env node
// Command line entry point.
//
//   sync    pull the CMS into the local document mirror
//   build   render the mirror to static HTML
//   deploy  upload and purge only the files the build changed
//
// Three commands rather than one because they fail differently and are
// triggered differently: sync is the only stage that touches the CMS, a build
// must be runnable offline against whatever the last sync left behind, and
// deploy is the only stage that can damage a live site.
import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { httpCmsAdapter } from './cms.ts'
import { DocumentStore } from './store.ts'
import { sync } from './sync.ts'
import { build } from './build.ts'
import { deploy } from './deploy.ts'
import { directoryTarget } from './deploy-mock.ts'
import { loadSite } from './config.ts'

const USAGE = `incremental-ssg

  sync   --site <module> --db <file> --cms <url>
         [--page-size N] [--full] [--no-reconcile]
         [--no-delta] [--no-id-listing]

  build  --site <module> --db <file> --out <dir>
         [--workers N] [--clean] [--skip-assets]

  deploy --out <dir> --to <dir> [--db <file> | --work-dir <dir>]
         [--dry-run] [--force] [--max-delete-ratio R]
         [--purge-added] [--no-digests] [--concurrency N]

Notes
  --page-size is the dominant lever on sync wall time: at 300ms round-trip,
  50 per page costs ~125s where 500 per page costs ~13s.
  --full ignores the stored watermark and re-pulls everything.
  --no-delta / --no-id-listing declare a CMS that lacks those capabilities,
  which changes the strategy (always full) and disables delete detection.

  deploy requires a build that ran with --clean, because nothing removes
  output an earlier build left behind and a stale page reads as unchanged.
  --to names a local directory standing in for the live site: no real host
  adapter exists yet, the same way the CMS is still a mock behind its
  interface. --dry-run prints the plan without touching the target.
  --no-digests simulates a target that cannot report content hashes, which
  degrades the diff to a full upload rather than to silence.
`

const fail = (msg: string): never => {
  console.error(`error: ${msg}\n\n${USAGE}`)
  process.exit(2)
}

const ms = (n: number) => `${n.toFixed(0)}ms`
const need = (v: string | undefined, flag: string) => v ?? fail(`--${flag} is required`)

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

  const adapter = httpCmsAdapter({
    baseUrl,
    capabilities: { deltaSync: !values['no-delta'], idListing: !values['no-id-listing'] },
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
    },
  })
  const r = await build({
    site: resolve(need(values.site, 'site')),
    dbPath: resolve(need(values.db, 'db')),
    outDir: resolve(need(values.out, 'out')),
    workers: values.workers ? Number(values.workers) : undefined,
    clean: values.clean,
    skipAssets: values['skip-assets'],
  })
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

  const target = directoryTarget({
    dir: resolve(need(values.to, 'to')),
    capabilities: { digestListing: !values['no-digests'] },
  })
  // The rails throw messages written to be read by a person deciding whether to
  // override them. A stack trace buries the explanation under the frames, which
  // is the wrong trade for the one command that can damage a live site.
  const r = await deploy({
    outDir,
    target,
    workDir,
    dryRun: values['dry-run'],
    force: values.force,
    purgeAdded: values['purge-added'],
    maxDeleteRatio: values['max-delete-ratio'] ? Number(values['max-delete-ratio']) : undefined,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
  }).catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
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
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE)
} else {
  fail(command ? `unknown command "${command}"` : 'no command given')
}
