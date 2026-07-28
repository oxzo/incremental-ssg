import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireLock, readLock, withLock, lockPath } from '../src/build-lock.ts'
import { RailError } from '../src/rails.ts'
import { tmpdir, cleanup } from './fixture.ts'

const RACER = resolve(import.meta.dirname, 'lock-racer.ts')

const dirs: string[] = []
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

/** Run `fn`, assert it threw a RailError, and hand the error back for inspection. */
function throwsRail(fn: () => unknown): RailError {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof RailError, `expected a RailError, got ${e}`)
    return e
  }
  assert.fail('expected a throw')
}

/** A pid that definitely is not running: a process we started and waited for. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid as number
  await once(child, 'exit')
  return pid
}

describe('build lock', () => {
  test('acquire writes a lock, release removes it', () => {
    const d = work('lock')
    assert.equal(readLock(d), null)
    const lock = acquireLock(d, { label: 'first' })
    const held = readLock(d)
    assert.equal(held?.pid, process.pid)
    assert.equal(held?.label, 'first')
    assert.equal(held?.host, hostname())
    assert.equal(lock.release(), true)
    assert.equal(existsSync(lockPath(d)), false)
  })

  test('a second acquire is refused while the first is held, and terminally', () => {
    const d = work('lock')
    const lock = acquireLock(d, { label: 'holder' })
    try {
      const e = throwsRail(() => acquireLock(d, { label: 'contender' }))
      assert.equal(e.rail, 'build-lock')
      // Terminal, so the service halts rather than retrying into a second
      // instance of itself every few seconds forever.
      assert.equal(e.terminal, true)
      assert.match(e.message, /holds the build lock/)
      assert.match(e.message, /holder/)
    } finally {
      lock.release()
    }
  })

  test('a lock whose holder is provably gone is reclaimed', async () => {
    const d = work('lock')
    writeFileSync(lockPath(d), JSON.stringify({
      token: 'stale', pid: await deadPid(), host: hostname(),
      startedAt: Date.now() - 60_000, label: 'crashed build',
    }))
    // The whole point: a build that died holding the lock must not wedge
    // publishing forever, which would turn one crash into a site that silently
    // stops updating.
    const lock = acquireLock(d, { label: 'after crash' })
    assert.equal(readLock(d)?.label, 'after crash')
    lock.release()
  })

  test('a lock held on another host is never reclaimed, even with a dead pid', async () => {
    const d = work('lock')
    // A pid means nothing on a machine we cannot see, so the liveness check has
    // no authority here and the lock must stand.
    writeFileSync(lockPath(d), JSON.stringify({
      token: 'elsewhere', pid: await deadPid(), host: 'some-other-box',
      startedAt: Date.now(), label: 'remote build',
    }))
    const e = throwsRail(() => acquireLock(d))
    assert.match(e.message, /some-other-box/)
  })

  test('an unreadable or empty lock file is reclaimed', () => {
    for (const junk of ['not json at all', '', '{"partial":']) {
      const d = work('lock')
      writeFileSync(lockPath(d), junk)
      const lock = acquireLock(d)
      assert.equal(readLock(d)?.pid, process.pid, `junk ${JSON.stringify(junk)} not reclaimed`)
      lock.release()
    }
    // The empty case is why acquireLock links a fully-written file into place
    // instead of creating it and filling it afterwards: an empty lock file is
    // indistinguishable from a lock that is one syscall old, and this behaviour
    // would then delete a live holder's lock. See the race test's comment.
  })

  test('force breaks a lock whose holder is alive', () => {
    const d = work('lock')
    const first = acquireLock(d, { label: 'alive' })
    const second = acquireLock(d, { label: 'forced', force: true })
    assert.equal(readLock(d)?.label, 'forced')
    // The loser of a force-break must not unlink the winner's lock on its way
    // out, or the file would disappear while `forced` still believes it holds it.
    assert.equal(first.release(), false)
    assert.equal(readLock(d)?.label, 'forced')
    assert.equal(second.release(), true)
  })

  test('withLock releases even when the body throws', async () => {
    const d = work('lock')
    await assert.rejects(withLock(d, {}, async () => { throw new Error('build failed') }))
    // A crashed build that left its lock behind would need the stale-lock path,
    // and the stale-lock path is the one with the pid-reuse gap. The common case
    // must never reach it.
    assert.equal(readLock(d), null)
    assert.equal(existsSync(lockPath(d)), false)
  })

  test('staged temp files are not left behind', () => {
    const d = work('lock')
    const a = acquireLock(d)
    assert.throws(() => acquireLock(d))
    a.release()
    assert.deepEqual(readdirSync(d), [])
  })

  /**
   * The property the file lock exists for, tested across real processes.
   *
   * Repeated, deliberately -- this project's own Phase 1 lesson is that a green
   * concurrency test is one sample of a race, and the temp-filename collision in
   * AssetCache passed by coin flip for an entire phase.
   *
   * What this test does NOT establish, stated because a passing concurrency test
   * invites the opposite assumption. The first version of acquireLock created the
   * lock with `wx` and filled it in a second syscall, leaving a window where the
   * file exists and is empty -- a racer reading it there finds unparseable JSON,
   * judges the lock corrupt, deletes it, and takes a lock someone else holds.
   * That version passes this test. It was checked, not assumed: reverting to it
   * and re-running gave 5 rounds of exactly one winner. The window is real but
   * microseconds wide, while process startup jitter is tens of milliseconds, so
   * thirty draws sample nowhere near finely enough to land inside it.
   *
   * So the atomic staged-link in acquireLock is justified by construction rather
   * than by this test, and the test below it -- an empty or unparseable lock file
   * is reclaimable -- is what makes the hazard concrete: that behaviour is
   * correct only because the file can never be observed incomplete.
   */
  test('exactly one of six concurrent processes wins the lock, every round', async () => {
    const d = work('lock-race')
    for (let round = 0; round < 5; round++) {
      const racers = Array.from({ length: 6 }, () => {
        const child = spawn(process.execPath, ['--no-warnings', RACER, d, '40'], {
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let out = ''
        child.stdout.on('data', (c) => { out += String(c) })
        return once(child, 'exit').then(() => out)
      })
      const results = await Promise.all(racers)
      const won = results.filter((r) => r.includes('won'))
      assert.equal(won.length, 1, `round ${round}: ${won.length} winners in ${JSON.stringify(results)}`)
      assert.match(won[0], /released true/)
      // And the winner cleaned up after itself, so the next round starts empty.
      assert.equal(readLock(d), null, `round ${round}: lock left behind`)
    }
  })
})
