// Acquires the build lock, holds it briefly, and reports the outcome on stdout.
//
// Spawned N times at once by test/build-lock.test.ts. This exists as a separate
// process rather than a function the test calls in a loop because the property
// under test -- exactly one winner among N *independent* writers -- is the one
// thing an in-process test cannot observe. acquireLock's create is synchronous,
// so Promise.all over it would serialise and pass without ever racing anything.
import { acquireLock } from '../src/build-lock.ts'

const workDir = process.argv[2]
const holdMs = Number(process.argv[3] ?? 0)

try {
  const lock = acquireLock(workDir, { label: `racer ${process.pid}` })
  // Announce the win before releasing, so the parent sees the overlap window if
  // two processes ever believe they hold it at once.
  process.stdout.write(`won ${process.pid}\n`)
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
  const released = lock.release()
  process.stdout.write(`released ${released}\n`)
} catch (e) {
  process.stdout.write(`lost ${e instanceof Error ? e.message.slice(0, 60) : e}\n`)
}
