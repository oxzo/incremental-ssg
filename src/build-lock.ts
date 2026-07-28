// The single-writer build lock.
//
// Two writers must never share the store, the output tree, or the seal:
//
//   - `clean: true` from one build empties the other's output mid-render, and
//     the victim then writes a seal describing a tree that no longer exists.
//     The deploy validates the tree against that seal, finds it short, and
//     refuses -- which is the good case. The bad case is the counts happening to
//     match while the files are from two different builds.
//   - sync writes the SQLite mirror while another build's workers read it, and
//     `prepareForReaders` switches journal mode underneath live readers.
//   - both write build-seal.json, so a deploy can validate one build's tree
//     against the other build's counts.
//
// An in-process mutex does not cover this, and that is the whole reason this is
// a file. The service is not the only writer: an operator running `cli build` by
// hand during a scheduled publish is the likeliest collision there is, and it is
// exactly the one a promise-based lock inside one process cannot see.
//
// The stale-lock policy is a real decision, not a detail. A build that dies
// holding the lock must not wedge publishing forever -- one crash would turn
// into a site that silently stops updating, the failure mode this project keeps
// naming -- so a lock whose holder is *provably* gone is reclaimed
// automatically. A lock whose holder might still be alive is never stolen,
// because two concurrent builds are a correctness failure where a stalled
// service is only a liveness one.
//
// The honest limit: pid liveness cannot see pid reuse. If the holder died and
// something unrelated later took its pid, this refuses to reclaim and needs
// `force`. Recording the holder's start time would not fix it either -- the
// comparison that would (start time against the pid's actual start time) is not
// portable. So the gap is documented and left, rather than papered over with a
// heuristic that fails silently.
import { writeFileSync, readFileSync, rmSync, mkdirSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RailError } from './rails.ts'

export const LOCK_FILE = 'build.lock'

export type LockInfo = {
  /** Identifies this specific acquisition, so release cannot unlink someone else's lock. */
  token: string
  pid: number
  host: string
  /** Wall clock at acquisition. For humans reading a stuck lock, not for staleness logic. */
  startedAt: number
  /** What took it -- `serve poll`, `cli build`. Shows up in the refusal message. */
  label: string
}

export type Lock = {
  info: LockInfo
  path: string
  /**
   * Drop the lock. Returns false when the file was already gone or held someone
   * else's token, which means this lock was force-broken while it was held and
   * two writers may have overlapped -- worth reporting rather than swallowing.
   */
  release(): boolean
}

export function lockPath(workDir: string): string {
  return join(workDir, LOCK_FILE)
}

export function readLock(workDir: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(workDir), 'utf8')) as LockInfo
    return typeof info.pid === 'number' && typeof info.token === 'string' ? info : null
  } catch {
    return null
  }
}

/**
 * Is this pid running?
 *
 * EPERM means the process exists and belongs to another user: alive, and not
 * ours to reclaim. ESRCH is the only answer that means "definitely gone", so it
 * is the only one treated as reclaimable.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type AcquireOptions = {
  label?: string
  /** Break a lock even if its holder looks alive. Means "yes, I know, I meant it". */
  force?: boolean
}

/**
 * Take the lock, or throw a RailError explaining who holds it.
 *
 * Terminal, and this is the one classification worth arguing about. A held lock
 * usually clears on its own -- the other build finishes -- so transient looks
 * right. But the service takes this lock around its *own* pipeline, so if it
 * ever sees the lock held, the holder is something else: a hand-run command, a
 * second service instance, or a dead process whose pid got reused. None of those
 * resolve on a five-second backoff, and a service that retries into a
 * second instance of itself every few seconds forever is worse than one that
 * says so and stops. `force` is the documented way out.
 */
export function acquireLock(workDir: string, opts: AcquireOptions = {}): Lock {
  mkdirSync(workDir, { recursive: true })
  const path = lockPath(workDir)
  const info: LockInfo = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
    label: opts.label ?? 'build',
  }
  const body = JSON.stringify(info, null, 2)

  // Two attempts, not a loop: the first can lose to an EEXIST it then reclaims,
  // and the second is the post-reclaim retry. Any further collision means
  // another writer won the same reclaim race, and that writer is alive -- so
  // spinning would just be a slower way to report a held lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Staged in a uniquely-named temp file and linked into place, rather than
    // created with `wx` and then written. `wx` is atomic about *creating* the
    // file but not about filling it, which leaves a window where the lock exists
    // and is empty -- and a racer reading it there finds unparseable JSON,
    // concludes the lock is corrupt, deletes it, and takes its own. Two winners,
    // from a lock file that was never corrupt, only young.
    //
    // linkSync is the primitive that closes it: the file is complete before it
    // has a name, and link fails with EEXIST rather than overwriting. Same
    // temp-then-atomic shape AssetCache uses for derivatives, and the same
    // uniqueness rule Phase 1 learned there -- the qualifier covers every
    // writer, not every process, so it is a uuid and not a pid.
    const staged = `${path}.${info.token}.tmp`
    try {
      writeFileSync(staged, body, { flag: 'wx' })
      linkSync(staged, path)
      return {
        info,
        path,
        release: () => {
          const held = readLock(workDir)
          if (!held || held.token !== info.token) return false
          rmSync(path, { force: true })
          return true
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e

      const held = readLock(workDir)
      const held_desc = held
        ? `pid ${held.pid} on ${held.host} (${held.label}, since ${new Date(held.startedAt).toISOString()})`
        : 'an unreadable lock file'

      // An unparseable lock file vouches for nothing, and because the link above
      // publishes it complete, unparseable can no longer mean "being written right
      // now". So it is genuine corruption or a file from some other tool, and
      // treating it as a live holder would wedge publishing forever on contents
      // that cannot even name a suspect.
      const reclaimable =
        opts.force === true ||
        held === null ||
        (held.host === hostname() && !alive(held.pid))

      if (!reclaimable) {
        throw new RailError(
          'build-lock',
          true,
          `another writer holds the build lock at ${path}: ${held_desc}. Two builds ` +
          `sharing one store, output tree and seal corrupt all three -- one build's ` +
          `clean deletes the other's pages mid-render, and the seal then describes a ` +
          `tree that does not exist. Wait for it to finish, or pass --force-unlock / ` +
          `{force:true} if you are certain the holder is gone (a reused pid on this ` +
          `host looks alive and cannot be told apart from the real thing).`)
      }

      if (attempt > 0) {
        throw new RailError(
          'build-lock',
          true,
          `lost the race to reclaim the stale build lock at ${path}; it is now held by ` +
          `another writer. Nothing is wrong -- retry once that writer finishes.`)
      }
      rmSync(path, { force: true })
    } finally {
      // The staged file has served its purpose either way: linked into place, or
      // orphaned by an EEXIST. Leaving orphans would litter the work directory
      // with one file per lost race.
      rmSync(staged, { force: true })
    }
  }
  // Unreachable: the loop either returns or throws on both attempts. Present so
  // this is a total function rather than one relying on the reader to check.
  throw new RailError('build-lock', true, `could not acquire the build lock at ${path}`)
}

/**
 * Run `fn` holding the lock.
 *
 * Release is in a finally, so a throwing build leaves no lock behind. That
 * matters more than it looks: without it, every crashed build would need the
 * stale-lock path above, and the stale-lock path is the one with the pid-reuse
 * gap. The common case should never reach it.
 */
export async function withLock<T>(
  workDir: string,
  opts: AcquireOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = acquireLock(workDir, opts)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}
