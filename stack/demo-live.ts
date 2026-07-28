// The whole pipeline against real software on both ends.
//
// Same shape as example/blog/demo.ts, with the two mocks replaced: content comes
// out of a real Directus over real HTTP with real auth, and the built site goes
// into a real S3 bucket. Run stack/up.sh and stack/seed.ts first.
//
//   source stack/env.sh && node --no-warnings stack/demo-live.ts
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { directusCmsAdapter } from '../src/cms-directus.ts'
import { s3DeployTarget } from '../src/deploy-s3.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { build } from '../src/build.ts'
import { deploy } from '../src/deploy.ts'

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k} -- source stack/env.sh first`)
  return v
}

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.tmp'), { recursive: true })
const work = mkdtempSync(join(root, '.tmp', 'live-'))
const dbPath = join(work, 'content.db')
const outDir = join(work, 'dist')
const sitePath = join(root, 'example/blog/site.ts')

const ms = (n: number) => `${n.toFixed(1)}ms`

const adapter = directusCmsAdapter({
  baseUrl: env('ISSG_DIRECTUS_URL'),
  email: env('ISSG_DIRECTUS_EMAIL'),
  password: env('ISSG_DIRECTUS_PASSWORD'),
  collections: ['post', 'author', 'tag', 'page', 'settings'],
})

const purged: string[] = []
const target = s3DeployTarget({
  bucket: env('ISSG_S3_BUCKET'),
  endpoint: env('ISSG_S3_ENDPOINT'),
  region: env('ISSG_S3_REGION', 'us-east-1'),
  accessKeyId: env('ISSG_S3_ACCESS_KEY'),
  secretAccessKey: env('ISSG_S3_SECRET_KEY'),
  onPurge: (p) => purged.push(...p),
})

const store = new DocumentStore(dbPath)
const first = await sync(adapter, store, { pageSize: 500 })
console.log(
  `sync:     ${first.strategy} — ${first.pulled} pulled, ${first.changed} changed, ` +
  `${first.deleted} deleted, ${first.requests} requests, ${(first.bytes / 1024).toFixed(0)} KiB, ${ms(first.ms.total)}`)

const second = await sync(adapter, store, { pageSize: 500 })
console.log(
  `re-sync:  ${second.strategy} — ${second.pulled} pulled, ${second.changed} changed, ` +
  `${second.requests} requests, ${ms(second.ms.total)}`)
store.close()

const built = await build({ site: sitePath, dbPath, outDir, clean: true })
console.log(
  `build:    ${built.routes} routes, ${built.documents} docs, ${(built.bytes / 1024).toFixed(0)} KiB, ` +
  `${built.workers} workers, ${ms(built.ms.total)}`)

const full = await deploy({ outDir, target, seal: built.seal })
console.log(
  `deploy:   ${full.plan.added.length} added, ${full.plan.modified.length} modified, ` +
  `${full.plan.deleted.length} deleted, ${full.plan.unchanged} unchanged, ` +
  `${(full.bytes / 1024).toFixed(0)} KiB, ${ms(full.ms.total)} ` +
  `(hash ${ms(full.ms.hash)}, list ${ms(full.ms.list)}, upload ${ms(full.ms.upload)})`)

// The point of the diff, against a real bucket rather than a directory: a second
// deploy of an unchanged tree must move nothing. If ETag comparison were broken
// -- multipart digests, an algorithm mismatch, a prefix bug -- this line is
// where it shows, because every object would report as modified.
const again = await deploy({ outDir, target, seal: built.seal })
console.log(
  `re-deploy:${again.plan.added.length} added, ${again.plan.modified.length} modified, ` +
  `${again.plan.deleted.length} deleted, ${again.plan.unchanged} unchanged, ${ms(again.ms.total)}` +
  (again.plan.digestsUnavailable ? '  [target could not report digests]' : ''))

console.log(`purge:    ${purged.length} paths recorded, 0 issued (no CDN in front of a bucket)`)
console.log(`\nwork dir: ${work}`)
