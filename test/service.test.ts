import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { createService, createPipeline, silentLog, DIRTY_KEY } from '../src/service.ts'
import { DocumentStore } from '../src/store.ts'
import { RailError } from '../src/rails.ts'
import { acquireLock } from '../src/build-lock.ts'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { directoryTarget } from '../src/deploy-mock.ts'
import { tmpdir, cleanup, blogDocs } from './fixture.ts'
import type { RunReport, Trigger, Pipeline } from '../src/service.ts'
import type { MockDoc } from '../src/cms-mock.ts'
import type { CmsCapabilities } from '../src/cms.ts'

const BLOG = resolve(import.meta.dirname, '../example/blog/site.ts')

const dirs: string[] = []
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

/** A report shaped like a successful publish, for tests that only watch scheduling. */
function ok(t: Trigger): RunReport {
  return {
    source: t.source,
    skipped: null,
    dirtyOnEntry: false,
    sync: { strategy: 'delta', pulled: 1, changed: 1, deleted: 0, requests: 1, syncs: 1 },
    readAfterWrite: { checked: false, expected: 0, outstanding: [], attempts: 0, reason: null },
    build: { routes: 10, files: 10, bytes: 100 },
    deploy: { added: 0, modified: 1, deleted: 0, unchanged: 9, uploaded: 1, purged: 1, dryRun: false },
    ms: 1,
  }
}

/**
 * A service wired to a recording fake run.
 *
 * The coalescing rules are the product here, and they are about *when* runs
 * happen. Driving them through a real build would make every assertion wait on
 * ~1s of rendering and would test the renderer instead.
 */
function harness(o: {
  onRun?: (t: Trigger, n: number) => Promise<RunReport>
  debounceMs?: number
  maxDelayMs?: number
  pollMs?: number
  retryMs?: number
  catchUpMs?: number
  unhealthyAfter?: number
}) {
  const seen: Trigger[] = []
  let n = 0
  const run: Pipeline = async (t) => {
    seen.push(t)
    n++
    return o.onRun ? await o.onRun(t, n) : ok(t)
  }
  const service = createService({
    run,
    log: silentLog,
    debounceMs: o.debounceMs ?? 30,
    maxDelayMs: o.maxDelayMs ?? 200,
    pollMs: o.pollMs ?? 0,
    retryMs: o.retryMs ?? 20,
    catchUpMs: o.catchUpMs ?? 20,
    unhealthyAfter: o.unhealthyAfter,
  })
  return { service, seen }
}

describe('service scheduling', () => {
  test('a burst of webhooks collapses into one run', async () => {
    const { service, seen } = harness({ debounceMs: 40 })
    for (let i = 0; i < 8; i++) {
      service.notify({ source: 'webhook', expectations: [{ id: `p${i}`, revision: 'r1' }] })
      await sleep(5)
    }
    await service.idle()
    assert.equal(seen.length, 1)
    // Every expectation in the burst survives the collapse. Dropping the ones
    // that arrived before the last would silently skip their read-after-write
    // checks, which is the coalescer's own version of a partial keep-set.
    assert.equal(seen[0].expectations.length, 8)
    await service.stop()
  })

  test('the max-delay cap fires under a stream that never goes quiet', async () => {
    // Debounce 40ms, cap 120ms, and an event every 10ms forever. A plain
    // reset-on-every-event debounce starves here and never builds at all.
    const { service, seen } = harness({ debounceMs: 40, maxDelayMs: 120 })
    const started = Date.now()
    const stream = setInterval(() => service.notify({ source: 'webhook' }), 10)
    await sleep(300)
    clearInterval(stream)
    assert.ok(seen.length >= 1, 'the cap never fired: a sustained stream starved the build')
    assert.ok(Date.now() - started < 400)
    await service.stop()
  })

  test('a trigger arriving mid-run queues exactly one more run, and is not lost', async () => {
    let release: (() => void) | null = null
    const held = new Promise<void>((r) => { release = r })
    const { service, seen } = harness({
      debounceMs: 5,
      onRun: async (t, n) => {
        if (n === 1) await held
        return ok(t)
      },
    })
    service.notify({ source: 'webhook' })
    await sleep(30)
    assert.equal(seen.length, 1, 'the first run should be in flight')

    // Three publishes land during the build. Dropping them would be silent: the
    // dirty flag is clear, the next sync finds nothing changed, and the pages
    // never go live.
    for (let i = 0; i < 3; i++) service.notify({ source: 'webhook' })
    await sleep(30)
    assert.equal(seen.length, 1, 'no second run may start while the first is in flight')

    release!()
    await service.idle()
    assert.equal(seen.length, 2, 'the mid-run triggers must produce exactly one follow-up run')
    await service.stop()
  })

  test('a poll does not delay a webhook waiting out its debounce', async () => {
    const at: number[] = []
    const { service, seen } = harness({
      debounceMs: 60,
      maxDelayMs: 10_000,
      onRun: async (t) => {
        at.push(Date.now())
        return ok(t)
      },
    })
    const started = Date.now()
    service.notify({ source: 'webhook' })
    // A poll every 15ms while the webhook's 60ms window runs. A poll is a real
    // trigger and may well cause a run of its own later -- what it must not do is
    // restart the quiet period, because then a 60s poll interval on a busy site
    // would keep pushing the deadline out and the edit would never go live.
    const polls = setInterval(() => service.notify({ source: 'poll' }), 15)
    await sleep(150)
    clearInterval(polls)
    await service.idle()

    assert.ok(at.length >= 1, 'nothing ran at all')
    const waited = at[0] - started
    assert.ok(waited < 110, `the webhook waited ${waited}ms for a 60ms debounce`)
    // Labelled by the most specific source in the burst, so a window that
    // contained a real webhook does not get logged as a poll.
    assert.equal(seen[0].source, 'webhook')
    await service.stop()
  })
})

describe('service failure handling', () => {
  test('a transient failure retries and publishing recovers', async () => {
    const { service, seen } = harness({
      debounceMs: 5,
      retryMs: 15,
      onRun: async (t, n) => {
        if (n < 3) throw new Error('CMS 503')
        return ok(t)
      },
    })
    service.notify({ source: 'webhook' })
    await sleep(200)
    await service.idle()
    assert.equal(seen.length, 3, 'a transient failure must keep retrying')
    const s = service.status()
    assert.equal(s.halted, null)
    assert.equal(s.consecutiveFailures, 0)
    assert.equal(s.healthy, true)
    await service.stop()
  })

  test('repeated transient failures report unhealthy without halting', async () => {
    const { service } = harness({
      debounceMs: 5,
      retryMs: 10,
      unhealthyAfter: 2,
      onRun: async () => { throw new Error('still broken') },
    })
    service.notify({ source: 'webhook' })
    await sleep(120)
    const s = service.status()
    // Still trying -- a broken build must not stop the service outright -- but
    // no longer claiming to be fine, because "busy forever and never publishing"
    // has to be visible to something.
    assert.equal(s.healthy, false)
    assert.equal(s.halted, null)
    assert.ok(s.consecutiveFailures >= 2)
    await service.stop()
  })

  test('a terminal refusal halts, and later triggers are ignored until forced', async () => {
    let attempts = 0
    const { service, seen } = harness({
      debounceMs: 5,
      retryMs: 10,
      onRun: async (t) => {
        attempts++
        if (attempts === 1) {
          throw new RailError('deploy-delete-ratio', true, 'would delete 900 of 1000 live objects')
        }
        return ok(t)
      },
    })
    service.notify({ source: 'webhook' })
    await sleep(80)
    const halted = service.status()
    assert.equal(halted.halted?.rail, 'deploy-delete-ratio')
    assert.equal(halted.healthy, false)
    assert.equal(seen.length, 1, 'a terminal refusal must not be retried')

    // An unforced trigger would just re-run into the same refusal.
    service.notify({ source: 'webhook' })
    service.notify({ source: 'poll' })
    await sleep(60)
    assert.equal(seen.length, 1, 'unforced triggers must not clear a halt')

    // A forced trigger is a human saying they changed something.
    service.notify({ source: 'manual', force: true })
    await sleep(80)
    await service.idle()
    assert.equal(seen.length, 2)
    assert.equal(service.status().halted, null)
    assert.equal(service.status().healthy, true)
    await service.stop()
  })

  test('an outstanding read-after-write schedules a sooner re-check', async () => {
    const { service, seen } = harness({
      debounceMs: 5,
      catchUpMs: 20,
      onRun: async (t, n) => {
        const r = ok(t)
        if (n === 1) {
          r.readAfterWrite = {
            checked: true, expected: 1, attempts: 3, reason: 'not readable',
            outstanding: [{ id: 'p1', revision: 'r9' }],
          }
        }
        return r
      },
    })
    service.notify({ source: 'webhook', expectations: [{ id: 'p1', revision: 'r9' }] })
    await sleep(150)
    await service.idle()
    // Without this the lagging document would wait out the whole poll interval.
    assert.ok(seen.length >= 2, 'a lagging mirror must be re-checked before the next poll')
    assert.equal(seen[1].source, 'retry')
    await service.stop()
  })
})

describe('pipeline', () => {
  /** The real pipeline over a mock CMS and a directory target. */
  async function pipelineFor(docs: MockDoc[], capabilities?: Partial<CmsCapabilities>) {
    const d = work('service')
    const cms = await startMockCms(docs)
    const adapter = httpCmsAdapter({ baseUrl: cms.url, capabilities })
    const dbPath = join(d, 'content.db')
    const run = createPipeline({
      site: BLOG,
      dbPath,
      outDir: join(d, 'dist'),
      workDir: d,
      adapter,
      target: directoryTarget({ dir: join(d, 'remote') }),
      workers: 1,
      log: silentLog,
      readAfterWrite: { attempts: 2, backoffMs: 5 },
    })
    return {
      run,
      dbPath,
      workDir: d,
      cms,
      dirty: () => {
        const s = new DocumentStore(dbPath)
        try {
          return s.getMeta(DIRTY_KEY)
        } finally {
          s.close()
        }
      },
      close: () => cms.close(),
    }
  }

  const trigger = (o: Partial<Trigger> = {}): Trigger =>
    ({ source: 'webhook', expectations: [], force: false, ...o })

  test('first run publishes, second run skips because nothing changed', async () => {
    const p = await pipelineFor(blogDocs())
    try {
      const first = await p.run(trigger())
      assert.equal(first.skipped, null)
      assert.ok(first.build!.routes > 0)
      assert.ok(first.deploy!.added > 0)
      // Cleared only after the deploy returned.
      assert.equal(p.dirty(), '0')

      const second = await p.run(trigger())
      assert.match(second.skipped ?? '', /no changes/)
      assert.equal(second.build, null)
      assert.equal(second.deploy, null)
    } finally {
      await p.close()
    }
  })

  test('force publishes even when sync found nothing changed', async () => {
    const p = await pipelineFor(blogDocs())
    try {
      await p.run(trigger())
      // This is the only route to a rebuild after a template edit: sync cannot
      // see code, so an unforced trigger would skip forever.
      const forced = await p.run(trigger({ source: 'manual', force: true }))
      assert.equal(forced.skipped, null)
      assert.ok(forced.build!.routes > 0)
      // Nothing changed, so the diff finds nothing to upload -- which is the
      // deploy diff working, not a failure.
      assert.equal(forced.deploy!.uploaded, 0)
    } finally {
      await p.close()
    }
  })

  test('an edit is published, and only the changed files are uploaded', async () => {
    const docs = blogDocs()
    const p = await pipelineFor(docs)
    try {
      await p.run(trigger())
      const post = docs.find((d) => d.type === 'post')!
      post.doc.title = 'A retitled post'
      post.doc.updated_at = Number(post.doc.updated_at) + 1000
      post.doc.rev = 'rev-2'

      const r = await p.run(trigger())
      assert.equal(r.skipped, null)
      assert.ok(r.sync!.changed >= 1)
      assert.ok(r.deploy!.uploaded > 0, 'the edit must reach the target')
      assert.ok(
        r.deploy!.uploaded < r.build!.files,
        'the whole site must not be re-uploaded for one edit')
      assert.equal(p.dirty(), '0')
    } finally {
      await p.close()
    }
  })

  test('a publish outstanding from a crashed build survives into the next run', async () => {
    const p = await pipelineFor(blogDocs())
    try {
      await p.run(trigger())
      // Exactly the state a crash between sync and deploy leaves: the watermark
      // has advanced, so sync will report nothing changed, and only the flag
      // remembers that a publish never went out. Clearing it here would be the
      // silent-stale failure -- the site stays behind and no error is raised.
      const s = new DocumentStore(p.dbPath)
      s.setMeta(DIRTY_KEY, '1')
      s.close()

      const r = await p.run(trigger({ source: 'startup' }))
      assert.equal(r.dirtyOnEntry, true)
      assert.equal(r.sync!.changed, 0, 'sync should indeed see nothing new')
      assert.equal(r.skipped, null, 'the outstanding publish must still be built')
      assert.equal(p.dirty(), '0')
    } finally {
      await p.close()
    }
  })

  test('a dry run publishes nothing and leaves the publish outstanding', async () => {
    const d = work('service-dry')
    const cms = await startMockCms(blogDocs())
    try {
      const dbPath = join(d, 'content.db')
      const run = createPipeline({
        site: BLOG,
        dbPath,
        outDir: join(d, 'dist'),
        workDir: d,
        adapter: httpCmsAdapter({ baseUrl: cms.url }),
        target: directoryTarget({ dir: join(d, 'remote') }),
        workers: 1,
        log: silentLog,
        deploy: { dryRun: true },
      })
      const r = await run(trigger())
      assert.equal(r.deploy?.dryRun, true)
      assert.equal(r.deploy?.uploaded, 0)
      const s = new DocumentStore(dbPath)
      // Saying the publish is done when nothing was uploaded would lose it.
      assert.equal(s.getMeta(DIRTY_KEY), '1')
      s.close()
    } finally {
      await cms.close()
    }
  })

  test('the read-after-write check is satisfied by what sync actually stored', async () => {
    const docs = blogDocs()
    const p = await pipelineFor(docs)
    try {
      await p.run(trigger())
      const post = docs.find((d) => d.type === 'post')!
      post.doc.title = 'Edited once more'
      post.doc.updated_at = Number(post.doc.updated_at) + 2000
      post.doc.rev = 'rev-77'

      const r = await p.run(trigger({
        expectations: [{ id: String(post.doc.id), revision: 'rev-77' }],
      }))
      assert.equal(r.readAfterWrite.checked, true)
      assert.equal(r.readAfterWrite.outstanding.length, 0)
      assert.equal(r.readAfterWrite.attempts, 1, 'the first check should already pass')
    } finally {
      await p.close()
    }
  })

  test('a revision the CMS never serves is reported, and the site still publishes', async () => {
    const docs = blogDocs()
    const p = await pipelineFor(docs)
    try {
      const post = docs.find((d) => d.type === 'post')!
      // The CMS acknowledged rev-99 in a webhook but its read API never serves
      // it. Refusing to publish would convert a lagging replica into a site that
      // never updates at all.
      const r = await p.run(trigger({
        expectations: [{ id: String(post.doc.id), revision: 'rev-99-never-served' }],
      }))
      assert.equal(r.readAfterWrite.checked, true)
      assert.equal(r.readAfterWrite.outstanding.length, 1)
      assert.equal(r.readAfterWrite.attempts, 2)
      assert.match(r.readAfterWrite.reason ?? '', /not readable/)
      assert.equal(r.skipped, null, 'the readable content must still be published')
      assert.ok(r.sync!.syncs > 1, 'an unsatisfied expectation must re-pull')
    } finally {
      await p.close()
    }
  })

  test('an adapter without webhook revisions says so instead of checking', async () => {
    const docs = blogDocs()
    const p = await pipelineFor(docs, { webhookRevisions: false })
    try {
      const r = await p.run(trigger({
        expectations: [{ id: String(docs[0].doc.id), revision: 'whatever' }],
      }))
      // Same convention the sync driver uses for a CMS with no id listing: name
      // the missing capability rather than run a check that means nothing.
      assert.equal(r.readAfterWrite.checked, false)
      assert.match(r.readAfterWrite.reason ?? '', /webhookRevisions: false/)
      assert.equal(r.sync!.syncs, 1, 'no catch-up pulls when the check cannot apply')
    } finally {
      await p.close()
    }
  })

  test('the pipeline refuses to run while another writer holds the lock', async () => {
    const p = await pipelineFor(blogDocs())
    const other = acquireLock(p.workDir, { label: 'cli build' })
    try {
      await assert.rejects(p.run(trigger()), (e: unknown) => {
        assert.ok(e instanceof RailError)
        assert.equal(e.rail, 'build-lock')
        assert.match(e.message, /cli build/)
        return true
      })
    } finally {
      other.release()
      await p.close()
    }
  })

  test('the lock is released after a run, so the next one proceeds', async () => {
    const p = await pipelineFor(blogDocs())
    try {
      await p.run(trigger())
      await p.run(trigger())
      const after = acquireLock(p.workDir, { label: 'proof' })
      after.release()
    } finally {
      await p.close()
    }
  })
})
