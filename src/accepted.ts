// The durable half of a 202.
//
// The webhook endpoint answers `{ queued: true }` and, until this existed, that
// was a claim about a variable in memory. A crash between the acknowledgement
// and the run took the trigger with it.
//
// For an ordinary content webhook that costs a delay rather than a publish: the
// content is in the CMS, the watermark has not covered it, and the next poll --
// or start()'s unconditional syncing trigger -- finds it. The case that is
// genuinely lost is the one whose justification is not in the CMS at all. A
// forced trigger (POST .../build) exists for what sync cannot see: a template
// edit, a config change, a halt a human has just fixed. Restarted, the startup
// trigger is unforced, sync reports nothing changed, and the skip rule drops it.
// Carrying the force bit across a restart is what this is for.
//
// It records a *trigger*, not a publish, because that is what was acknowledged.
// `service:dirty` is the stronger claim -- a publish is outstanding -- and
// writing that here would make every webhook publish unconditionally, which is
// the liveness cost this project already rejected the reviewed fix for.
//
// A file rather than the store's meta table, and this is the one place the
// obvious choice is wrong. `service:dirty` and `sync:mutating` are written by
// the pipeline, which holds the build lock and is the only writer at that
// moment. This is written by the webhook handler while a build may be running,
// and DocumentStore.prepareForReaders() leaves the database in journal_mode =
// DELETE rather than WAL -- so a writer contends with every render worker's
// reader and can block on the 15-second busy timeout, stalling the response it
// exists to make honest. The build lock is already durable service state kept
// as a file in this directory; this sits beside it.
//
// Durability scope, stated rather than implied, matching the note on
// SYNC_MUTATING: this survives a *process crash*, which is the failure the
// service is exposed to. Surviving loss of power would additionally need an
// fsync, which is deliberately not done here -- it would buy a guarantee
// stronger than the store's own, which has never set SQLite's `synchronous`
// pragma.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const ACCEPTED_FILE = 'accepted.json'

export type AcceptedTrigger = {
  /** Whether any acknowledged-but-unrun trigger asked to publish regardless. */
  force: boolean
  /** Which sources contributed, for a human reading a recovered marker. */
  sources: string[]
}

export function acceptedPath(workDir: string): string {
  return join(workDir, ACCEPTED_FILE)
}

/**
 * Read the marker, or null if there is none.
 *
 * An unreadable or unparseable file is treated as *present but unspecific*
 * rather than absent, and that asymmetry is deliberate: this file only exists
 * when a trigger was acknowledged, so the failure to read one is not evidence
 * that no trigger is outstanding. Forcing in that case is the safe direction --
 * it costs one build, where guessing "nothing outstanding" costs the publish
 * this whole file exists to keep.
 */
export function readAccepted(workDir: string): AcceptedTrigger | null {
  let raw: string
  try {
    raw = readFileSync(acceptedPath(workDir), 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as Partial<AcceptedTrigger>
    return {
      force: v.force === true,
      sources: Array.isArray(v.sources) ? v.sources.map(String) : [],
    }
  } catch {
    return { force: true, sources: ['unreadable-marker'] }
  }
}

/**
 * Record an acknowledged trigger, atomically.
 *
 * Written to a temp name and renamed, so a crash mid-write cannot leave a
 * half-file that the reader above would have to interpret. Synchronous on
 * purpose: the caller's next statement is the 202, and an acknowledgement that
 * races its own durability is the bug this file is closing.
 */
export function writeAccepted(workDir: string, v: AcceptedTrigger) {
  const path = acceptedPath(workDir)
  const staged = `${path}.tmp-${process.pid}`
  writeFileSync(staged, JSON.stringify(v))
  renameSync(staged, path)
}

export function clearAccepted(workDir: string) {
  rmSync(acceptedPath(workDir), { force: true })
}
