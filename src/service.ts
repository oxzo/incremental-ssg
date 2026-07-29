// The publish service: a trigger arrives, and some time later the site is live.
//
// Two independent pieces, kept apart because they fail differently and are the
// two things worth testing separately:
//
//   createPipeline -- one run: lock, sync, read-after-write check, build, deploy,
//     and the persisted dirty flag that makes the whole thing crash-safe.
//   createService  -- when runs happen: debounce a burst of editor saves into one
//     run, never lose a trigger that arrives mid-run, poll as a net under
//     unreliable webhook delivery, and decide what a refusal means with no human
//     watching.
//
// ---------------------------------------------------------------------------
// Why there is no durable event queue
//
// A queue is a set assumed complete, which is this codebase's recurring hazard
// on its fifth appearance (AssetCache.gc, DocumentStore.deleteMissing, the
// deploy seal, and the deploy diff's silent mirror image). The usual fix is to
// make the set durable. Here the better fix is to need a smaller set.
//
// The Phase 0 gate killed per-document invalidation: every build is a full
// build. So the pipeline can never act on *which* documents changed -- only on
// whether anything did. Persisting individual webhook payloads would store
// per-document detail that nothing downstream is able to read, and a queue whose
// entries cannot be acted on individually is a set with all the completeness
// hazards and none of the value.
//
// What must survive a crash is whether a publish is outstanding. That lives in
// the store's meta table as `service:dirty`, set *before* the build starts and
// cleared *only* after the deploy succeeds. The ordering is the whole guarantee.
// Set-after-build would lose a publish to a crash mid-build; clear-before-deploy
// would lose one to a crash mid-deploy. Either produces the silent-stale failure
// -- sync has already advanced its watermark, so the next run finds nothing
// changed and never rebuilds, and no error is ever raised.
//
// That paragraph named the hazard correctly and then placed the flag one stage
// too late, which an external review caught. "Before the build starts" is not
// early enough, because sync commits the mirror page by page: the same loss is
// available in the window between sync's first commit and its watermark write,
// and this stage cannot cover it -- the run that would set the flag has not
// reached this code yet. So sync carries its own marker for its own window
// (`sync:mutating`, and the reasoning lives in src/sync.ts), and the run reads
// it here as an outstanding publish. Two markers, because durable state moves
// ahead of the thing describing it in two places, and neither can vouch for the
// other.
//
// The one thing a per-event payload carries that the flag does not is the
// read-after-write revision, and that expires in seconds; after a restart it is
// worthless, because either the mirror caught up long ago or the poll will find
// it. So expectations are held in memory only, deliberately.
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname } from 'node:path'
import { DocumentStore } from './store.ts'
import { sync, SYNC_MUTATING } from './sync.ts'
import { build } from './build.ts'
import { deploy } from './deploy.ts'
import { loadSite } from './config.ts'
import { acquireLock, readLock } from './build-lock.ts'
import { readAccepted, writeAccepted, clearAccepted } from './accepted.ts'
import { isTerminal, railOf } from './rails.ts'
import type { CmsAdapter } from './cms.ts'
import type { DeployTarget } from './deploy.ts'
import type { LockInfo } from './build-lock.ts'

/** The one persisted bit: a publish is outstanding. */
export const DIRTY_KEY = 'service:dirty'

/**
 * One document the mirror is expected to catch up to, named the way the mirror
 * names documents: (type, id). An id alone would look up whichever document
 * happened to share it.
 */
export type Expectation = { type: string; id: string; revision: string }

export type TriggerSource = 'webhook' | 'poll' | 'manual' | 'startup' | 'retry'

export type Trigger = {
  source: TriggerSource
  /** Revisions a webhook claims are now readable. Checked, never trusted. */
  expectations: Expectation[]
  /** Build and deploy even if sync found nothing changed. See the skip rule below. */
  force: boolean
}

export type ReadAfterWrite = {
  /** False when the adapter declares no webhook revisions, or nothing was expected. */
  checked: boolean
  expected: number
  /** Expectations the mirror never caught up to. Non-empty is a warning, not a failure. */
  outstanding: Expectation[]
  attempts: number
  reason: string | null
}

export type RunReport = {
  source: TriggerSource
  /** Non-null when the run stopped before building, with the reason. */
  skipped: string | null
  dirtyOnEntry: boolean
  /** A previous sync died between its first commit and its watermark write. */
  syncInterrupted: boolean
  sync: {
    strategy: string
    pulled: number
    changed: number
    deleted: number
    requests: number
    /** More than one when the read-after-write check re-pulled. */
    syncs: number
  } | null
  readAfterWrite: ReadAfterWrite
  build: { routes: number; files: number; bytes: number } | null
  deploy: {
    added: number
    modified: number
    deleted: number
    unchanged: number
    uploaded: number
    purged: number
    dryRun: boolean
  } | null
  ms: number
}

export type LogEvent = Record<string, unknown> & { event: string }
export type Log = (e: LogEvent) => void

/** One line of JSON per event: greppable, and no dependency. */
export const jsonLog: Log = (e) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...e }))
}

export const silentLog: Log = () => {}

export type PipelineOptions = {
  /** Path to the site definition module. */
  site: string
  dbPath: string
  outDir: string
  /** Where the seal and the lock live. Default: next to the db. */
  workDir?: string
  adapter: CmsAdapter
  target: DeployTarget
  workers?: number
  pageSize?: number
  readAfterWrite?: {
    /** Store checks, including the first. Default 3. */
    attempts?: number
    /** Base wait between checks; grows linearly. Default 500ms. */
    backoffMs?: number
  }
  deploy?: {
    maxDeleteRatio?: number
    purgeAdded?: boolean
    concurrency?: number
    /** Plan and report without touching the target. Leaves the dirty flag set. */
    dryRun?: boolean
  }
  /**
   * Break a held build lock, once.
   *
   * For recovering from a reused pid, not for routine use -- and "once" is the
   * whole of it. Held across runs, a one-time recovery flag becomes a standing
   * licence to steal the lock from whatever legitimately holds it, for the
   * lifetime of the process: the operator asks for one rescue at 3am and the
   * service spends the next month ignoring the only thing preventing two
   * concurrent writers. Consumed by the first run, per createPipeline.
   */
  forceUnlock?: boolean
  log?: Log
}

export type Pipeline = (trigger: Trigger) => Promise<RunReport>

/**
 * One publish run, end to end.
 *
 * Always builds with `clean: true`. Not configurable, because the deploy's third
 * rail exists to refuse an unclean tree and the reason is that stale output
 * reads as *unchanged* and stays published forever. The asset cache lives
 * outside outDir precisely so cleaning costs no encoding work, so there is
 * nothing to trade away here.
 */
export function createPipeline(opts: PipelineOptions): Pipeline {
  const log = opts.log ?? jsonLog
  const workDir = opts.workDir ?? dirname(opts.dbPath)
  const rawAttempts = Math.max(1, opts.readAfterWrite?.attempts ?? 3)
  const rawBackoff = Math.max(0, opts.readAfterWrite?.backoffMs ?? 500)
  // Per pipeline, not per run. See PipelineOptions.forceUnlock: the flag is a
  // one-time rescue, and a rescue that repeats is not a rescue.
  let forceUnlockRemaining = opts.forceUnlock === true

  // Loaded once and cached: sync needs the site's content types, and re-importing
  // the module on every trigger would re-run its top level for nothing.
  let contentTypes: string[] | null = null
  const types = async () => {
    if (contentTypes === null) contentTypes = (await loadSite(opts.site)).contentTypes
    return contentTypes
  }

  return async function run(trigger: Trigger): Promise<RunReport> {
    const t0 = Date.now()
    const report: RunReport = {
      source: trigger.source,
      skipped: null,
      dirtyOnEntry: false,
      syncInterrupted: false,
      sync: null,
      readAfterWrite: { checked: false, expected: 0, outstanding: [], attempts: 0, reason: null },
      build: null,
      deploy: null,
      ms: 0,
    }

    // Consumed, not read. The flag answers "is the lock currently held by
    // something that is gone", which is a fact about one moment -- so it is
    // spent on the first attempt whether or not it was needed, and every run
    // after this one takes the lock on the same terms as any other writer.
    const force = forceUnlockRemaining
    forceUnlockRemaining = false
    const lock = acquireLock(workDir, {
      label: `serve ${trigger.source}`,
      force,
    })
    try {
      const contentTypes = await types()
      let dirty = false
      let syncs = 0

      const store = new DocumentStore(opts.dbPath)
      try {
        report.dirtyOnEntry = store.getMeta(DIRTY_KEY) === '1'
        // Read before sync() runs, because a completed sync clears it. A sync
        // that died mid-write left committed documents its watermark does not
        // cover, so the sync below will report them as unchanged -- correctly,
        // and uselessly. This marker is the only thing that remembers.
        report.syncInterrupted = store.getMeta(SYNC_MUTATING) === '1'
        dirty = report.dirtyOnEntry || report.syncInterrupted

        // Persisted *before* sync, not after, and the two markers overlap on
        // purpose. A completed sync clears `sync:mutating` on its way through,
        // so writing the flag afterwards leaves a window -- narrow, and holding
        // a WAL checkpoint -- in which the only record of an interrupted sync
        // has been erased and nothing has replaced it yet. A crash there loses
        // the publish exactly as before, one stage further along. Handing over
        // with both set briefly costs one meta write on a run that was going to
        // build anyway.
        //
        // This does not defeat the skip rule below: `dirty` is only true here
        // when a previous run left something outstanding. An idle poll finds
        // both markers clear, writes nothing, and still skips.
        if (dirty) store.setMeta(DIRTY_KEY, '1')

        const first = await sync(opts.adapter, store, {
          pageSize: opts.pageSize,
          contentTypes,
          reconcile: true,
        })
        syncs = 1

        // And again after sync, for the changes sync itself just found. A crash
        // between this line and a successful deploy leaves the flag set, so the
        // next run -- or the next process, after a restart -- rebuilds and
        // publishes even though its own sync will find nothing changed.
        if (first.changed > 0 || first.deleted > 0) {
          dirty = true
          store.setMeta(DIRTY_KEY, '1')
        }

        report.readAfterWrite = await checkReadAfterWrite(store, trigger, {
          adapter: opts.adapter,
          attempts: rawAttempts,
          backoffMs: rawBackoff,
          contentTypes,
          pageSize: opts.pageSize,
          onResync: (r) => {
            syncs++
            if (r.changed > 0 || r.deleted > 0) {
              dirty = true
              store.setMeta(DIRTY_KEY, '1')
            }
          },
        })

        report.sync = {
          strategy: first.strategy,
          pulled: first.pulled,
          changed: first.changed,
          deleted: first.deleted,
          requests: first.requests,
          syncs,
        }
      } finally {
        // Closed before the build: the render workers open this file read-only,
        // and sync's own prepareForReaders has already put it in a journal mode
        // they can share.
        store.close()
      }

      if (report.syncInterrupted) {
        log({
          event: 'sync.interrupted',
          note:
            'a previous sync committed documents its watermark never covered, so this ' +
            'run publishes instead of trusting its own "nothing changed"',
        })
      }

      if (report.readAfterWrite.outstanding.length > 0) {
        log({
          event: 'read-after-write.outstanding',
          outstanding: report.readAfterWrite.outstanding.map((e) => e.id),
          attempts: report.readAfterWrite.attempts,
          note:
            'the CMS acknowledged these revisions in a webhook but has not served them ' +
            'yet; publishing what is readable now and leaving the rest to a later run',
        })
      }

      // The skip rule. Safe for content, and a real gap for code: a template edit
      // changes the output while sync reports nothing changed, so an unforced
      // trigger will not notice it. That is why the manual endpoint forces, and
      // why restarting the service re-runs with the dirty flag it left behind.
      if (!dirty && !trigger.force) {
        report.skipped = 'sync found no changes and no publish was outstanding'
        log({ event: 'run.skipped', source: trigger.source, reason: report.skipped })
        return report
      }

      const b = await build({
        site: opts.site,
        dbPath: opts.dbPath,
        outDir: opts.outDir,
        workDir,
        workers: opts.workers,
        clean: true,
      })
      report.build = { routes: b.routes, files: b.seal.files, bytes: b.seal.bytes }

      const d = await deploy({
        outDir: opts.outDir,
        target: opts.target,
        seal: b.seal,
        workDir,
        maxDeleteRatio: opts.deploy?.maxDeleteRatio,
        purgeAdded: opts.deploy?.purgeAdded,
        concurrency: opts.deploy?.concurrency,
        dryRun: opts.deploy?.dryRun,
      })
      report.deploy = {
        added: d.plan.added.length,
        modified: d.plan.modified.length,
        deleted: d.plan.deleted.length,
        unchanged: d.plan.unchanged,
        uploaded: d.uploaded,
        purged: d.purged,
        dryRun: d.dryRun,
      }

      // Cleared last, and not at all on a dry run -- nothing was published, so
      // the publish is still outstanding and saying otherwise would lose it.
      if (!d.dryRun) {
        const done = new DocumentStore(opts.dbPath)
        try {
          done.setMeta(DIRTY_KEY, '0')
        } finally {
          done.close()
        }
      }

      report.ms = Date.now() - t0
      log({
        event: 'run.published',
        source: trigger.source,
        routes: report.build.routes,
        uploaded: report.deploy.uploaded,
        removed: report.deploy.deleted,
        unchanged: report.deploy.unchanged,
        dryRun: d.dryRun,
        ms: report.ms,
      })
      return report
    } finally {
      report.ms = Date.now() - t0
      if (!lock.release()) {
        // Our lock file was replaced while we held it, which means someone
        // force-broke it and another writer may have been running concurrently.
        log({
          event: 'build-lock.stolen',
          note:
            'the build lock was force-broken while this run held it; a second writer ' +
            'may have overlapped, so treat this run\'s output as unverified',
        })
      }
    }
  }
}

/**
 * Wait for the mirror to catch up to the revisions a webhook announced.
 *
 * A CMS acknowledges a save before its read API serves it -- replica lag, cache
 * invalidation, an index that trails the write. Sync immediately after a webhook
 * can therefore pull the *old* revision, and because the write already happened
 * no further webhook is coming: the site publishes stale content and stays that
 * way.
 *
 * So the expectation is checked against what actually landed in the store, and
 * an unsatisfied check re-pulls after a wait. A delta pull of one changed
 * document is milliseconds (Phase 2b), so this is cheap enough to just do.
 *
 * It gives up rather than blocking, and that is the deliberate part. Refusing to
 * publish until every expectation is satisfied converts a lagging read replica
 * into a site that never updates, which is strictly worse than publishing what
 * is readable now: sync's exclusive-boundary re-pull means a revision that
 * appears later with the same timestamp is still picked up, and the poll is the
 * net under it. Publishing something newer and reporting the gap beats holding
 * everything back for one document.
 */
async function checkReadAfterWrite(
  store: DocumentStore,
  trigger: Trigger,
  o: {
    adapter: CmsAdapter
    attempts: number
    backoffMs: number
    contentTypes: string[]
    pageSize?: number
    onResync: (r: { changed: number; deleted: number }) => void
  },
): Promise<ReadAfterWrite> {
  const out: ReadAfterWrite = {
    checked: false,
    expected: trigger.expectations.length,
    outstanding: [],
    attempts: 0,
    reason: null,
  }
  if (trigger.expectations.length === 0) {
    out.reason = 'no revisions were expected'
    return out
  }
  if (!o.adapter.capabilities.webhookRevisions) {
    // Same convention the sync driver already uses for a CMS with no id listing:
    // state the capability that is missing rather than behaving as though it were
    // present. A check against revisions the CMS does not put in its webhooks
    // would fail every time and mean nothing.
    out.reason = 'the adapter declares webhookRevisions: false'
    return out
  }

  out.checked = true
  let outstanding = trigger.expectations
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    out.attempts = attempt
    outstanding = outstanding.filter((e) => store.revisionOf(e.type, e.id) !== e.revision)
    if (outstanding.length === 0) break
    if (attempt === o.attempts) break
    await sleep(o.backoffMs * attempt)
    o.onResync(await sync(o.adapter, store, {
      pageSize: o.pageSize,
      contentTypes: o.contentTypes,
      // No reconcile scan on a catch-up pull. It costs a request, it answers a
      // question this loop is not asking, and a delete detected here would be
      // detected by the next run anyway.
      reconcile: false,
    }))
  }
  out.outstanding = outstanding
  if (outstanding.length > 0) {
    out.reason = `${outstanding.length} of ${out.expected} revisions were not readable after ${out.attempts} checks`
  }
  return out
}

export type ServiceOptions = {
  run: Pipeline
  /** Quiet period after the last trigger before a run starts. Default 2000ms. */
  debounceMs?: number
  /**
   * Longest a trigger waits, however many arrive after it. Default 15000ms.
   *
   * Without this cap a plain reset-on-every-event debounce starves: an editor
   * saving every second keeps pushing the deadline out and nothing ever builds.
   */
  maxDelayMs?: number
  /** Poll interval as the missed-webhook net. Default 60000ms; 0 disables it. */
  pollMs?: number
  /** First retry delay after a transient failure; doubles per failure. Default 5000ms. */
  retryMs?: number
  /** Cap on the doubling. Default 300000ms. */
  maxRetryMs?: number
  /** Wait before re-checking when a webhook's revisions never became readable. Default 5000ms. */
  catchUpMs?: number
  /** Consecutive failures before the service reports unhealthy. Default 3. */
  unhealthyAfter?: number
  /** Publish once at startup even with no pending work. Off by default. */
  buildOnStart?: boolean
  /** Work directory, so status() can report who holds the build lock. */
  lockDir?: string
  log?: Log
}

export type ServiceStatus = {
  healthy: boolean
  /** Set by a terminal refusal. Publishing is stopped until a forced trigger. */
  halted: { rail: string | null; message: string } | null
  running: boolean
  /** A trigger is waiting out its debounce window. */
  pending: boolean
  runs: number
  published: number
  skipped: number
  consecutiveFailures: number
  lastError: string | null
  lastReport: RunReport | null
  /** Whoever holds the build lock right now, including this service. */
  lock: LockInfo | null
}

export type Service = {
  notify(t: { source: TriggerSource; expectations?: Expectation[]; force?: boolean }): void
  start(): void
  stop(): Promise<void>
  status(): ServiceStatus
  /** Resolves when nothing is running, pending, or scheduled. Test hook. */
  idle(): Promise<void>
}

/**
 * When runs happen.
 *
 * The coalescing rules, each of which exists for a failure that would otherwise
 * be silent:
 *
 *   - A burst of saves becomes one run (debounce), but never waits longer than
 *     maxDelayMs from the first trigger in the burst (anti-starvation).
 *   - A trigger arriving *during* a run is not dropped and does not queue a
 *     second concurrent run: it sets pending, and the finishing run re-arms. Drop
 *     it instead and a publish that lands during a 10s build is lost with no
 *     error -- the store's dirty flag would still be clear, sync would report
 *     nothing changed, and the page would never go live.
 *   - Only webhook and manual triggers reset the debounce. A poll firing mid-burst
 *     must not push the deadline out; it is the net, not an editor.
 *   - A transient failure retries with doubling backoff and keeps publishing
 *     alive. A terminal refusal halts and reports unhealthy, because retrying
 *     something that cannot change is a loop that looks busy and never publishes.
 */
export function createService(opts: ServiceOptions): Service {
  const log = opts.log ?? jsonLog
  const debounceMs = opts.debounceMs ?? 2_000
  const maxDelayMs = opts.maxDelayMs ?? 15_000
  const pollMs = opts.pollMs ?? 60_000
  const retryMs = opts.retryMs ?? 5_000
  const maxRetryMs = opts.maxRetryMs ?? 300_000
  const catchUpMs = opts.catchUpMs ?? 5_000
  const unhealthyAfter = Math.max(1, opts.unhealthyAfter ?? 3)
  const lockDir = opts.lockDir ?? null

  type Pending = {
    sources: Set<TriggerSource>
    expectations: Expectation[]
    force: boolean
    /** For the maxDelay cap: when this burst started, not when the last event arrived. */
    firstAt: number
  }

  let pending: Pending | null = null
  let timer: NodeJS.Timeout | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let running: Promise<void> | null = null
  let stopped = false

  let halted: ServiceStatus['halted'] = null
  let consecutiveFailures = 0
  let runs = 0
  let published = 0
  let skipped = 0
  let lastError: string | null = null
  let lastReport: RunReport | null = null
  let idleWaiters: (() => void)[] = []

  const quiet = () => running === null && pending === null && timer === null && retryTimer === null

  function settle() {
    if (!quiet()) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  function notify(t: { source: TriggerSource; expectations?: Expectation[]; force?: boolean }) {
    if (stopped) return
    const force = t.force === true

    if (halted !== null) {
      // A forced trigger is the documented way out: it means a human changed
      // something and is asking for another attempt. An unforced one would just
      // re-run into the same refusal.
      if (!force) {
        log({ event: 'trigger.ignored', source: t.source, reason: 'halted', rail: halted.rail })
        return
      }
      log({ event: 'halt.cleared', by: t.source, rail: halted.rail })
      halted = null
      consecutiveFailures = 0
    }

    if (pending === null) {
      pending = { sources: new Set([t.source]), expectations: [], force, firstAt: Date.now() }
    } else {
      pending.sources.add(t.source)
      pending.force = pending.force || force
    }
    for (const e of t.expectations ?? []) pending.expectations.push(e)

    // Durable before this returns, so the caller's 202 is a claim about the
    // disk rather than about a variable. Only for the two sources that are an
    // outside party stating something happened: a poll marking here would leave
    // the marker permanently set on an idle site and make the skip rule
    // unreachable, and startup/retry are recoveries rather than new claims.
    //
    // Synchronous, so webhook.ts cannot answer before the record exists. That
    // ordering is the whole point and is why this is not deferred to the run.
    if (lockDir !== null && (t.source === 'webhook' || t.source === 'manual')) {
      writeAccepted(lockDir, { force: pending.force, sources: [...pending.sources] })
    }

    arm(t.source === 'webhook' || t.source === 'manual')
  }

  /** Schedule the pending trigger. `reset` restarts the quiet period. */
  function arm(reset: boolean) {
    if (stopped || pending === null || running !== null) return
    if (timer !== null) {
      if (!reset) return
      clearTimeout(timer)
    }
    const deadline = pending.firstAt + maxDelayMs
    const delay = Math.max(0, Math.min(debounceMs, deadline - Date.now()))
    timer = setTimeout(fire, delay)
  }

  function fire() {
    timer = null
    if (stopped || pending === null || running !== null) return
    const p = pending
    pending = null
    const trigger: Trigger = {
      // The most specific source wins the label: a burst that included a real
      // webhook is a webhook run even if a poll landed in the same window.
      source: p.sources.has('webhook')
        ? 'webhook'
        : p.sources.has('manual')
          ? 'manual'
          : (p.sources.values().next().value as TriggerSource),
      expectations: p.expectations,
      force: p.force,
    }
    running = execute(trigger)
  }

  async function execute(trigger: Trigger) {
    runs++
    let completed = false
    try {
      const report = await opts.run(trigger)
      completed = true
      lastReport = report
      lastError = null
      consecutiveFailures = 0
      if (report.skipped !== null) skipped++
      else published++

      // The mirror had not caught up. Come back sooner than the poll would.
      if (report.readAfterWrite.outstanding.length > 0) {
        scheduleRetry(catchUpMs, 'read-after-write', trigger.force)
      }
    } catch (e) {
      consecutiveFailures++
      lastError = e instanceof Error ? e.message : String(e)
      const rail = railOf(e)
      if (isTerminal(e)) {
        halted = { rail, message: lastError }
        log({
          event: 'run.halted',
          rail,
          error: lastError,
          note:
            'a terminal refusal cannot be cleared by retrying, so publishing is stopped ' +
            'and the last good site keeps serving; POST the build endpoint to retry',
        })
      } else {
        const delay = Math.min(maxRetryMs, retryMs * 2 ** (consecutiveFailures - 1))
        log({
          event: 'run.failed',
          rail,
          error: lastError,
          consecutiveFailures,
          retryInMs: delay,
          unhealthy: consecutiveFailures >= unhealthyAfter,
        })
        scheduleRetry(delay, 'failure', trigger.force)
      }
    } finally {
      running = null
      // The acknowledgement is discharged only by a run that finished, and only
      // if nothing arrived while it was in flight -- a later trigger inherits
      // the marker rather than being covered by this run. A failed or halted run
      // leaves it set on purpose: what was acknowledged has not happened, and a
      // restart should still know that.
      if (completed && pending === null && lockDir !== null) clearAccepted(lockDir)
      // A trigger that arrived while this run was in flight. Immediate, not
      // debounced: it already waited out a whole build.
      if (pending !== null && halted === null) arm(false)
      settle()
    }
  }

  function scheduleRetry(delay: number, why: string, force: boolean) {
    if (stopped || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      // `force` carries over so a manual publish that hit a transient failure is
      // still a manual publish on the retry, rather than being swallowed by the
      // nothing-changed skip.
      notify({ source: 'retry', force })
      settle()
    }, delay)
    log({ event: 'retry.scheduled', why, delayMs: delay })
  }

  return {
    notify,
    start() {
      stopped = false
      if (pollMs > 0) pollTimer = setInterval(() => notify({ source: 'poll' }), pollMs)
      // A trigger this process acknowledged and never ran. Recovered here rather
      // than left to the dirty flag, because the flag cannot represent the case
      // that needs recovering: a forced trigger's justification is not in the
      // CMS -- a template edit, a config change, a halt someone fixed -- so a
      // restart syncs, finds nothing changed, and the skip rule drops it. The
      // force bit is the payload; recovering ordinary webhooks is the cheap
      // side effect.
      const carried = lockDir === null ? null : readAccepted(lockDir)
      if (carried !== null) {
        log({ event: 'trigger.recovered', force: carried.force, sources: carried.sources })
      }
      // Always triggered, force or not. An unforced startup run still publishes
      // when the store's dirty flag survived a crash mid-build, which is how a
      // restart recovers an outstanding publish without republishing the whole
      // site on every restart.
      notify({
        source: 'startup',
        force: opts.buildOnStart === true || carried?.force === true,
      })
      log({ event: 'service.started', debounceMs, maxDelayMs, pollMs })
    },
    async stop() {
      stopped = true
      if (pollTimer !== null) clearInterval(pollTimer)
      if (timer !== null) clearTimeout(timer)
      if (retryTimer !== null) clearTimeout(retryTimer)
      pollTimer = timer = retryTimer = null
      await running
      // Pending work is discarded here, explicitly, rather than left set.
      //
      // Leaving it was the bug: quiet() requires `pending === null`, so a stop
      // with accepted-but-unrun work left idle() waiting forever and
      // status().pending reporting true on a service that had stopped and would
      // never run again. A shutdown that cannot report having shut down is worse
      // than one that drops a trigger.
      //
      // Dropping it is safe rather than merely convenient, and the reason is
      // worth stating because the trigger *was* acknowledged with a 202: nothing
      // about the publish lives in this variable. The content is in the CMS and
      // the watermark that has not covered it yet is in the store, so the
      // unconditional startup trigger re-syncs and finds it on the next start --
      // as does the next poll, if the process keeps running. What is lost is the
      // debounce's head start, not the publish.
      if (pending !== null) {
        log({ event: 'service.pending-dropped', sources: [...pending.sources] })
        pending = null
      }
      settle()
      log({ event: 'service.stopped', runs, published, skipped })
    },
    status() {
      return {
        healthy: halted === null && consecutiveFailures < unhealthyAfter,
        halted,
        running: running !== null,
        pending: pending !== null || timer !== null,
        runs,
        published,
        skipped,
        consecutiveFailures,
        lastError,
        lastReport,
        lock: lockDir === null ? null : readLock(lockDir),
      }
    },
    idle() {
      if (quiet()) return Promise.resolve()
      return new Promise<void>((res) => idleWaiters.push(res))
    },
  }
}
