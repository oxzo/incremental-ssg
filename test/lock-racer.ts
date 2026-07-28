// Acquires the build lock, holds it briefly, and reports the interval on stdout.
//
// Spawned N times at once by test/build-lock.test.ts. This exists as a separate
// process rather than a function the test calls in a loop because the property
// under test -- no two *independent* writers hold it at once -- is the one thing
// an in-process test cannot observe. acquireLock's create is synchronous, so
// Promise.all over it would serialise and pass without ever racing anything.
//
// It reports an interval rather than the word "won" because the number of
// winners per round is not the property. Under load, process startup spread can
// exceed the hold, so the first racer legitimately finishes before the last one
// starts: two racers win, having never overlapped. That is correct behaviour
// which a winner count reports as a defect. What must never happen is two
// intervals intersecting.
//
// Date.now() rather than performance.now(): these timestamps are compared
// *across processes*, and performance.now() counts from a per-process origin.
import { acquireLock } from '../src/build-lock.ts'

const workDir = process.argv[2]
const holdMs = Number(process.argv[3] ?? 0)

try {
  const lock = acquireLock(workDir, { label: `racer ${process.pid}` })
  const from = Date.now()
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
  // Stamped *before* the release, not after. Stamping after puts the unlink and
  // the clock read inside the reported interval, which manufactures a
  // one-millisecond overlap at every boundary that looks exactly like the defect
  // this test hunts -- observed while investigating, and the reason that
  // investigation nearly reported a lock bug that does not exist.
  const to = Date.now()
  const released = lock.release()
  process.stdout.write(JSON.stringify({ pid: process.pid, from, to, released }) + '\n')
} catch (e) {
  process.stdout.write(
    JSON.stringify({ pid: process.pid, lost: e instanceof Error ? e.message.slice(0, 60) : String(e) }) + '\n',
  )
}
