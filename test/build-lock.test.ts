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
   * The property the file lock exists for, tested across real processes: no two
   * writers hold it at once -- NOT that exactly one of them wins.
   *
   * The winner count was the original assertion and it was wrong. It fails under
   * load for a reason that has nothing to do with the lock: once the box is busy
   * enough that process startup spreads wider than the hold, the first racer
   * releases before the last one starts, so two racers win having never
   * overlapped. Measured while chasing exactly that failure -- every 2-winner
   * round had a spawn spread of 40-45ms against a 40ms hold, every 1-winner round
   * had a spread of 0ms, and across 40 rounds under deliberate CPU load there was
   * not one overlapping interval. The old assertion was measuring the scheduler.
   *
   * That is the Phase 5 lesson arriving from the other side. There, a green
   * concurrency test certified a fix it had no power to check; here, a red one
   * reported a defect that did not exist. Same root cause both times: the
   * assertion was not the property.
   *
   * What this test still does NOT establish, stated because a passing
   * concurrency test invites the opposite assumption. The first version of
   * acquireLock created the lock with `wx` and filled it in a second syscall,
   * leaving a window where the file exists and is empty -- a racer reading it
   * there finds unparseable JSON, judges the lock corrupt, deletes it, and takes
   * a lock someone else holds. That version passes this test. It was checked, not
   * assumed: reverting to it and re-running gave clean round after clean round.
   * The window is real but microseconds wide, while process startup jitter is
   * tens of milliseconds, so these draws sample nowhere near finely enough to
   * land inside it.
   *
   * So the atomic staged-link in acquireLock is justified by construction rather
   * than by this test, and the test above -- an empty or unparseable lock file is
   * reclaimable -- is what makes the hazard concrete: that behaviour is correct
   * only because the file can never be observed incomplete.
   */
  test('no two of six concurrent processes ever hold the lock at the same time', async () => {
    const d = work('lock-race')

    async function race(holdMs: number, label: string): Promise<boolean> {
      const racers = Array.from({ length: 6 }, () => {
        const child = spawn(process.execPath, ['--no-warnings', RACER, d, String(holdMs)], {
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let out = ''
        child.stdout.on('data', (c) => { out += String(c) })
        return once(child, 'exit').then(() => out.trim())
      })
      const results = (await Promise.all(racers)).filter(Boolean).map((r) => JSON.parse(r))
      const held = results.filter((r) => r.lost === undefined)

      assert.ok(held.length >= 1, `${label}: nobody acquired the lock -- ${JSON.stringify(results)}`)
      for (const h of held) {
        assert.equal(h.released, true, `${label}: pid ${h.pid} lost the lock while holding it`)
      }
      // The property. Everything else here is scaffolding for this loop.
      for (let i = 0; i < held.length; i++) {
        for (let j = i + 1; j < held.length; j++) {
          const a = held[i]
          const b = held[j]
          assert.ok(
            a.from >= b.to || b.from >= a.to,
            `${label}: pids ${a.pid} [${a.from},${a.to}] and ${b.pid} [${b.from},${b.to}] overlapped`,
          )
        }
      }
      assert.equal(readLock(d), null, `${label}: lock left behind`)
      // One winner means the other five were refused while it held -- the only
      // outcome that exercised mutual exclusion at all. More than one means the
      // hold expired before the last racer started, so that round measured
      // sequential acquisition and proves nothing about the lock.
      return held.length === 1
    }

    // The hold escalates until a round is genuinely contended.
    //
    // A fixed hold cannot work when the load is not known in advance: too short
    // and every round serialises, so the test passes while testing nothing;
    // assert against that and it fails on a busy box for reasons that have
    // nothing to do with the lock. Both are the same defect this test already
    // had once -- the assertion not being the property. Escalating measures the
    // box rather than assuming it.
    let contended = false
    for (const holdMs of [40, 200, 800]) {
      for (let i = 0; i < 3 && !contended; i++) {
        contended = await race(holdMs, `hold ${holdMs}ms round ${i}`)
      }
      if (contended) break
    }
    assert.ok(
      contended,
      'six processes never overlapped even with an 800ms hold -- this box is too loaded for the ' +
      'test to say anything about mutual exclusion, which is different from the lock being wrong',
    )
  })
})
