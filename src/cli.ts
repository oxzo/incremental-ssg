#!/usr/bin/env node
// Command line entry point.
//
//   sync   pull the CMS into the local document mirror
//   build  render the mirror to static HTML
//
// Two commands rather than one because they fail differently and are triggered
// differently: sync is the only stage that touches the network, and a build must
// be runnable offline against whatever the last sync left behind.
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { httpCmsAdapter } from './cms.ts'
import { DocumentStore } from './store.ts'
import { sync } from './sync.ts'
import { build } from './build.ts'
import { loadSite } from './config.ts'

const USAGE = `incremental-ssg

  sync  --site <module> --db <file> --cms <url>
        [--page-size N] [--full] [--no-reconcile]
        [--no-delta] [--no-id-listing]

  build --site <module> --db <file> --out <dir>
        [--workers N] [--clean] [--skip-assets]

Notes
  --page-size is the dominant lever on sync wall time: at 300ms round-trip,
  50 per page costs ~125s where 500 per page costs ~13s.
  --full ignores the stored watermark and re-pulls everything.
  --no-delta / --no-id-listing declare a CMS that lacks those capabilities,
  which changes the strategy (always full) and disables delete detection.
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
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE)
} else {
  fail(command ? `unknown command "${command}"` : 'no command given')
}
