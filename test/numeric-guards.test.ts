// Numbers that failed to parse, and the rails they used to switch off.
//
// Every limit in this codebase is enforced by a comparison, and every comparison
// against NaN is false. That makes an unparsed option uniquely dangerous here:
// it does not produce a wrong answer or an error, it produces a rail that stops
// firing while everything downstream reports success. The mass-deletion ceiling
// is the clearest case -- `--max-delete-ratio nonsense` removed it entirely --
// but the same shape reaches a worker count (a pool of zero workers seals an
// empty site) and an upload concurrency (zero uploads, reported as a clean
// deploy).
//
// Each test below pairs the refusal with a control showing the same call
// succeeding on a valid value, because "it threw" and "it threw for the reason
// claimed" are different results and only the second one is evidence.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../src/build.ts'
import { deploy } from '../src/deploy.ts'
import { directoryTarget } from '../src/deploy-mock.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { RailError, checkNumber } from '../src/rails.ts'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { tmpdir, cleanup, seedStore, blogDocs } from './fixture.ts'

const REPO = resolve(import.meta.dirname, '..')
const CLI = resolve(REPO, 'src/cli.ts')
const BLOG = resolve(REPO, 'example/blog/site.ts')

const dirs: string[] = []
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

/** A built, sealed site whose live target holds more files than the tree does. */
async function readyToSweep() {
  const d = work('numeric')
  const dbPath = join(d, 'content.db')
  const outDir = join(d, 'dist')
  const remoteDir = join(d, 'remote')
  await seedStore(dbPath, blogDocs({ posts: 3 }))
  const b = await build({ site: BLOG, dbPath, outDir, workDir: d, workers: 1, clean: true, skipAssets: true })

  // Ten objects live that the build does not emit. Any sweep here is far over
  // the 50% default, so a rail that fires at all will fire on this.
  mkdirSync(join(remoteDir, 'stale'), { recursive: true })
  for (let i = 0; i < 10; i++) writeFileSync(join(remoteDir, 'stale', `old-${i}.html`), 'live')

  return { d, outDir, remoteDir, seal: b.seal, workDir: d }
}

describe('checkNumber, tested directly for the clause the call sites cannot reach', () => {
  // Every current caller bounds its value with a max, an integer rule, or both,
  // and each of those independently rejects NaN and Infinity -- `NaN >= min` is
  // false, and Infinity fails any max or integer test. So the finite check is
  // redundant *at today's call sites*, and mutating it away changed no observable
  // behaviour anywhere in the suite. Found by tools/mutate.py, which is what it
  // is for.
  //
  // It is kept rather than deleted because it is the clause that states the
  // contract: a number must be usable, not merely within a range someone
  // remembered to supply. A future option that is unbounded above and allows
  // fractions -- a timeout multiplier, a sampling rate -- would be guarded by
  // this clause alone. So it is tested on its own terms here rather than through
  // a caller that would pass for a different reason.
  test('an unbounded, non-integer option still rejects Infinity', () => {
    assert.throws(
      () => checkNumber(Infinity, 1, { name: 'multiplier', min: 0 }),
      (e: unknown) => (e as RailError).rail === 'invalid-number')
    assert.throws(
      () => checkNumber(Number.NaN, 1, { name: 'multiplier', min: 0 }),
      (e: unknown) => (e as RailError).rail === 'invalid-number')
    // The control: the same unbounded shape accepts an ordinary value, so the
    // two refusals above are about the values and not about the options object.
    assert.equal(checkNumber(2.5, 1, { name: 'multiplier', min: 0 }), 2.5)
    assert.equal(checkNumber(undefined, 1, { name: 'multiplier', min: 0 }), 1)
  })
})

describe('a delete ratio that failed to parse', () => {
  test('deploy refuses NaN instead of treating it as no limit', async () => {
    const s = await readyToSweep()
    await assert.rejects(
      () => deploy({
        outDir: s.outDir,
        target: directoryTarget({ dir: s.remoteDir }),
        seal: s.seal,
        workDir: s.workDir,
        maxDeleteRatio: Number('not-a-number'),
      }),
      (e: unknown) => {
        assert.ok(e instanceof RailError)
        assert.equal(e.rail, 'invalid-number')
        // Terminal: the same flag arrives identical on every retry, and a
        // service retrying it would loop forever while the site went stale.
        assert.equal(e.terminal, true)
        assert.match(e.message, /maxDeleteRatio/)
        return true
      })
  })

  test('and the sweep it was hiding is real -- the same deploy runs at ratio 1', async () => {
    // The control. Without this, the refusal above could be any refusal: this
    // shows the deploy is otherwise willing, so what the NaN switched off was a
    // ceiling standing between it and deleting every stale object.
    const s = await readyToSweep()
    const r = await deploy({
      outDir: s.outDir,
      target: directoryTarget({ dir: s.remoteDir }),
      seal: s.seal,
      workDir: s.workDir,
      maxDeleteRatio: 1,
    })
    assert.equal(r.plan.deleted.length, 10, 'the ten stale objects should have been swept')
    assert.equal(r.deleted, 10)
  })

  test('deploy refuses a ratio outside 0..1, and accepts both ends', async () => {
    const s = await readyToSweep()
    const call = (maxDeleteRatio: number) => deploy({
      outDir: s.outDir,
      target: directoryTarget({ dir: s.remoteDir }),
      seal: s.seal,
      workDir: s.workDir,
      maxDeleteRatio,
      dryRun: true,
    })
    await assert.rejects(() => call(1.5), /maxDeleteRatio/)
    await assert.rejects(() => call(-0.1), /maxDeleteRatio/)
    await assert.rejects(() => call(Infinity), /maxDeleteRatio/)
    // 0 and 1 are the meaningful ends -- "refuse any deletion" and "allow a full
    // sweep" -- so neither may be rejected as out of range.
    await call(0).then(
      () => assert.fail('ratio 0 should refuse the sweep, not the value'),
      (e) => assert.equal((e as RailError).rail, 'deploy-delete-ratio'))
    assert.equal((await call(1)).plan.deleted.length, 10)
  })

  test('deleteMissing refuses NaN, where the same call at 1 would empty the mirror', async () => {
    const d = work('numeric-store')
    const dbPath = join(d, 'content.db')
    await seedStore(dbPath, blogDocs({ posts: 4 }))
    const store = new DocumentStore(dbPath)
    try {
      const before = store.count()
      assert.ok(before > 0)
      // An empty live set is what a reconcile scan returns when it fails
      // halfway, and is the case the ceiling exists for.
      assert.throws(
        () => store.deleteMissing(new Set(), { maxDeleteRatio: Number('nonsense') }),
        (e: unknown) => (e as RailError).rail === 'invalid-number')
      assert.equal(store.count(), before, 'nothing may have been deleted')

      // Control: the same call with a valid ceiling reaches the real rail.
      assert.throws(
        () => store.deleteMissing(new Set(), { maxDeleteRatio: 0.5 }),
        (e: unknown) => (e as RailError).rail === 'store-delete-ratio')
      assert.equal(store.count(), before)
    } finally {
      store.close()
    }
  })
})

describe('counts that failed to parse', () => {
  test('build refuses NaN workers instead of sealing an empty site', async () => {
    const d = work('numeric-build')
    const dbPath = join(d, 'content.db')
    await seedStore(dbPath, blogDocs({ posts: 3 }))
    await assert.rejects(
      () => build({
        site: BLOG,
        dbPath,
        outDir: join(d, 'dist'),
        workDir: d,
        workers: Number('nope'),
        clean: true,
        skipAssets: true,
      }),
      (e: unknown) => {
        assert.equal((e as RailError).rail, 'invalid-number')
        assert.match((e as Error).message, /workers/)
        return true
      })
  })

  test('build refuses a fractional or zero worker count', async () => {
    const d = work('numeric-build2')
    const dbPath = join(d, 'content.db')
    await seedStore(dbPath, blogDocs({ posts: 3 }))
    const call = (workers: number) => build({
      site: BLOG, dbPath, outDir: join(d, 'dist'), workDir: d, workers, clean: true, skipAssets: true,
    })
    await assert.rejects(() => call(0), /workers/)
    await assert.rejects(() => call(2.5), /workers/)
    // Control: a valid count still builds the site it was always building.
    assert.ok((await call(1)).routes > 0)
  })

  test('deploy refuses NaN concurrency, which would have uploaded nothing', async () => {
    const s = await readyToSweep()
    await assert.rejects(
      () => deploy({
        outDir: s.outDir,
        target: directoryTarget({ dir: s.remoteDir }),
        seal: s.seal,
        workDir: s.workDir,
        maxDeleteRatio: 1,
        concurrency: Number(''),
      }),
      (e: unknown) => {
        assert.equal((e as RailError).rail, 'invalid-number')
        assert.match((e as Error).message, /concurrency/)
        return true
      })
  })

  test('sync refuses NaN pageSize, which would pull nothing and then propose deleting everything', async () => {
    const cms = await startMockCms(blogDocs({ posts: 3 }))
    const dbPath = join(work('numeric-sync'), 'content.db')
    const store = new DocumentStore(dbPath)
    try {
      await assert.rejects(
        () => sync(httpCmsAdapter({ baseUrl: cms.url }), store, { pageSize: Number('lots') }),
        (e: unknown) => {
          assert.equal((e as RailError).rail, 'invalid-number')
          assert.match((e as Error).message, /pageSize/)
          return true
        })
      assert.equal(store.count(), 0)
    } finally {
      store.close()
      await cms.close()
    }
  })
})

describe('the CLI rejects unusable numbers before doing any work', () => {
  /** Run the CLI and return its exit code and stderr. */
  function cli(args: string[]): Promise<{ code: number | null; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (b) => { err += String(b) })
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, err }))
    })
  }

  test('a non-numeric delete ratio is refused by name', async () => {
    const d = work('numeric-cli')
    const r = await cli([
      'deploy', '--out', join(d, 'dist'), '--to', join(d, 'remote'),
      '--work-dir', d, '--max-delete-ratio', 'not-a-number',
    ])
    assert.equal(r.code, 2)
    assert.match(r.err, /--max-delete-ratio must be a number/)
    // Named in the message, so the operator does not have to guess which of six
    // numeric flags on a `serve` line was the bad one.
    assert.match(r.err, /not-a-number/)
  })

  test('a non-numeric worker count is refused before the build starts', async () => {
    const d = work('numeric-cli2')
    const r = await cli([
      'build', '--site', BLOG, '--db', join(d, 'content.db'),
      '--out', join(d, 'dist'), '--workers', 'nope',
    ])
    assert.equal(r.code, 2)
    assert.match(r.err, /--workers must be a number/)
  })

  test('an out-of-range ratio and an empty value are both refused', async () => {
    const d = work('numeric-cli3')
    const over = await cli([
      'deploy', '--out', join(d, 'dist'), '--to', join(d, 'remote'),
      '--work-dir', d, '--max-delete-ratio', '2',
    ])
    assert.equal(over.code, 2)
    assert.match(over.err, /--max-delete-ratio must be at most 1/)

    // Number('') is 0, which would have read as a real choice rather than a
    // missing one -- and for a delete ratio those mean opposite things.
    const empty = await cli([
      'deploy', '--out', join(d, 'dist'), '--to', join(d, 'remote'),
      '--work-dir', d, '--max-delete-ratio', '',
    ])
    assert.equal(empty.code, 2)
    assert.match(empty.err, /--max-delete-ratio was given an empty value/)
  })
})
