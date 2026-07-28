import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startMockCms } from '../src/cms-mock.ts'
import { blogDocs } from '../example/blog/fixture.ts'
import { tmpdir, cleanup } from './fixture.ts'
import { acquireLock } from '../src/build-lock.ts'

const REPO = resolve(import.meta.dirname, '..')
const CLI = resolve(REPO, 'src/cli.ts')
const SECRET = 'cli-test-secret'

const dirs: string[] = []
after(() => dirs.forEach(cleanup))

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The whole `serve` command as a child process.
 *
 * Everything else in the suite drives createPipeline and createService directly,
 * which leaves the actual user-facing surface untested: argument parsing, the
 * http CMS adapter against a live URL, the startup trigger, and signal shutdown.
 * A wiring mistake in any of those produces a service that starts and never
 * publishes -- silent, and invisible to every other test here.
 *
 * Port 0 rather than a fixed port, and the real one is read back out of the
 * service's own startup log. A hardcoded port makes the suite fail when anything
 * else on the machine happens to hold it.
 */
async function serve(o: { extraArgs?: string[] } = {}) {
  const docs = blogDocs()
  const cms = await startMockCms(docs)
  const d = tmpdir('serve-cli')
  dirs.push(d)
  const remote = join(d, 'remote')

  const child = spawn(process.execPath, [
    '--no-warnings', CLI, 'serve',
    '--site', resolve(REPO, 'example/blog/site.ts'),
    '--db', join(d, 'content.db'),
    '--out', join(d, 'dist'),
    '--cms', cms.url,
    '--to', remote,
    '--port', '0',
    '--secret', SECRET,
    '--poll', '0',
    '--debounce', '100',
    '--workers', '2',
    ...(o.extraArgs ?? []),
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })

  let log = ''
  child.stdout.on('data', (c) => { log += String(c) })
  child.stderr.on('data', (c) => { log += String(c) })

  // Exit is recorded rather than awaited on demand, so stop() is idempotent.
  // Awaiting 'exit' from an already-exited child waits for an event that will
  // never fire again -- and with no handles left the event loop simply drains,
  // which node:test reports as "promise still pending" with no hint of the cause.
  let exited: number | null = null
  let cmsClosed = false
  child.on('exit', (c) => { exited = c ?? -1 })

  // Wait for the port, rather than sleeping a guessed interval.
  let port = 0
  for (let i = 0; i < 100 && port === 0; i++) {
    const m = /"url":"http:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
    if (m) port = Number(m[1])
    else await wait(50)
  }
  assert.notEqual(port, 0, `service never reported a port. log:\n${log}`)

  const url = `http://127.0.0.1:${port}`
  return {
    docs,
    remote,
    url,
    log: () => log,
    signed: (path: string, body = '') =>
      fetch(`${url}${path}`, {
        method: 'POST', body, headers: { 'x-webhook-token': SECRET },
      }),
    status: async () => {
      const r = await fetch(`${url}/status`, { headers: { 'x-webhook-token': SECRET } })
      return await r.json() as Record<string, any>
    },
    /** Poll until the service reports `n` completed runs, rather than sleeping. */
    async untilRuns(n: number, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const s = await this.status()
        if (s.runs >= n && !s.running && !s.pending) return s
        if (Date.now() > deadline) {
          assert.fail(`only ${s.runs} runs after ${timeoutMs}ms. log:\n${log}`)
        }
        await wait(100)
      }
    },
    async stop(): Promise<number> {
      if (exited === null) {
        child.kill('SIGTERM')
        await new Promise<void>((r) => {
          if (exited !== null) return r()
          child.on('exit', () => r())
        })
      }
      if (!cmsClosed) {
        cmsClosed = true
        await cms.close()
      }
      return exited as unknown as number
    },
  }
}

describe('serve command', () => {
  test('publishes on startup, on a signed webhook, and shuts down cleanly', async () => {
    const s = await serve()
    try {
      // Health is the one unauthenticated endpoint, so a load balancer can ask.
      const health = await fetch(`${s.url}/health`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { ok: true })

      // The startup trigger publishes without needing a webhook. That is also how
      // a restart recovers a publish left outstanding by a crashed build.
      await s.untilRuns(1)
      assert.ok(existsSync(s.remote), 'startup should have published the site')
      assert.ok(readdirSync(s.remote).length > 0)

      const unauth = await fetch(`${s.url}/webhook`, { method: 'POST', body: '{}' })
      assert.equal(unauth.status, 401)

      // Edit a post in the CMS and deliver a webhook naming its new revision.
      const post = s.docs.find((x) => x.type === 'post')!
      post.doc.title = 'Retitled through the CLI'
      post.doc.updated_at = Number(post.doc.updated_at) + 5000
      post.doc.rev = 'cli-rev-2'

      const hook = await s.signed('/webhook', JSON.stringify({ type: post.type, id: post.doc.id, rev: 'cli-rev-2' }))
      assert.equal(hook.status, 202)
      assert.deepEqual(await hook.json(), { queued: true, expectations: 1 })

      const after = await s.untilRuns(2)
      assert.equal(after.healthy, true, after.lastError)
      const report = after.lastReport
      assert.equal(report.skipped, null)
      assert.ok(report.deploy.uploaded > 0, 'the edit must reach the target')
      // Partial, not full: the deploy diff is doing its job. Deliberately not
      // asserted against Phase 0's fan-out figures -- this corpus is ten posts,
      // and the edit moves updated_at as well as the title, so it is a different
      // edit from the one those numbers describe.
      assert.ok(
        report.deploy.uploaded < report.build.files,
        `uploaded ${report.deploy.uploaded} of ${report.build.files} -- the whole site`)
      // The mirror had the announced revision, so the check passed on the first
      // look and no catch-up pull was needed.
      assert.equal(report.readAfterWrite.checked, true)
      assert.equal(report.readAfterWrite.outstanding.length, 0)

      assert.equal(await s.stop(), 0)
      // Deliveries stop being accepted before the in-flight run is awaited, so a
      // sender is never told "queued" for work that is about to be abandoned.
      assert.match(s.log(), /service\.stopping/)
      assert.match(s.log(), /service\.stopped/)
    } finally {
      await s.stop().catch(() => {})
    }
  })

  test('the build endpoint forces a publish when sync sees nothing new', async () => {
    const s = await serve()
    try {
      await s.untilRuns(1)

      // No CMS change at all. An ordinary webhook would sync, find nothing, and
      // skip -- which is correct, and is why a template edit needs this endpoint.
      const skipRun = await s.signed('/webhook', '{}')
      assert.equal(skipRun.status, 202)
      const skipped = await s.untilRuns(2)
      assert.equal(skipped.lastReport.skipped !== null, true)
      assert.equal(skipped.skipped, 1)

      const forced = await s.signed('/webhook/build')
      assert.equal(forced.status, 202)
      const after = await s.untilRuns(3)
      assert.equal(after.lastReport.skipped, null, 'a forced trigger must build')
      assert.ok(after.lastReport.build.routes > 0)
      // Nothing changed, so the diff finds nothing to upload. That is the deploy
      // diff working, not a failure.
      assert.equal(after.lastReport.deploy.uploaded, 0)
    } finally {
      await s.stop().catch(() => {})
    }
  })

  test('refuses to start with no secret', async () => {
    const d = tmpdir('serve-cli-noauth')
    dirs.push(d)
    const child = spawn(process.execPath, [
      '--no-warnings', CLI, 'serve',
      '--site', resolve(REPO, 'example/blog/site.ts'),
      '--db', join(d, 'content.db'),
      '--out', join(d, 'dist'),
      '--cms', 'http://127.0.0.1:1',
      '--to', join(d, 'remote'),
      '--port', '0',
    ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEBHOOK_SECRET: '', WEBHOOK_HMAC_SECRET: '' } })
    let out = ''
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { out += String(c) })
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)))
    // An open endpoint that triggers a full build is a denial of service needing
    // no payload, so this has to fail at startup and not merely warn.
    assert.equal(code, 1)
    assert.match(out, /refuses to start with no authentication/)
  })
})

// sync writes the store and, on its way out, flips the database into a
// shareable journal mode. Both are changes made underneath whatever else has
// the file open, so it belongs under the same lock as every other writer -- and
// it was the one mutating command that did not take it.
describe('cli sync takes the build lock', () => {
  const run = (args: string[], cwd: string) =>
    new Promise<{ code: number; err: string }>((res) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (d) => { err += String(d) })
      child.stdout.on('data', () => {})
      child.on('exit', (code) => res({ code: code ?? -1, err }))
    })

  test('refuses while another writer holds it, and succeeds once released', async () => {
    const dir = tmpdir('cli-sync-lock')
    dirs.push(dir)
    const cms = await startMockCms(blogDocs({ posts: 2 }))
    try {
      const dbPath = join(dir, 'content.db')
      const held = acquireLock(dir, { label: 'a build already running' })
      const blocked = await run(['sync', '--db', dbPath, '--cms', cms.url], REPO)
      assert.notEqual(blocked.code, 0, 'sync must not write while another writer holds the lock')
      assert.match(blocked.err, /another writer holds the build lock/)

      // The negative control in the same test: the refusal has to be about the
      // lock, not about the command being broken.
      held.release()
      const ok = await run(['sync', '--db', dbPath, '--cms', cms.url], REPO)
      assert.equal(ok.code, 0, ok.err)
    } finally {
      await cms.close()
    }
  })
})
