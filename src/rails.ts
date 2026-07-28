// The refusals, and whether re-running can clear them.
//
// Every safety rail in this codebase was designed against a human who typed a
// command and could read a refusal and decide what to do next. Phase 5 removes
// the human: the same throw that used to stop a person mid-command now stops a
// service at 3am, and a build that stops is a site that silently stops updating
// -- which this project's notes already name as the worst available failure.
//
// So a refusal has to carry one extra bit, and it is not severity. It is: can
// re-running possibly change the answer? That depends on what the rail checks,
// not on how bad the outcome would be, so it is decided at each throw site
// rather than guessed from an error message here.
//
//   terminal: false -- self-clearing. A build that died left no seal, and the
//     next build writes one. Output drifted from its seal, and a clean rebuild
//     re-establishes it. The service retries with backoff, and the persisted
//     dirty flag means the pending publish is not lost while it does.
//
//   terminal: true -- re-running reproduces the same refusal, because the rail
//     is reporting a fact about the content rather than an accident of timing.
//     Retrying is not caution, it is a loop that never ends and never publishes.
//     The service halts, leaves the last good site serving, and reports
//     unhealthy. Only a human -- or an explicit force -- moves it.
//
// The reason this distinction is worth a module rather than a boolean passed
// around: getting it backwards is silent in both directions. A self-clearing
// condition marked terminal wedges publishing after one crash. A genuinely
// stuck condition marked transient produces a service that looks busy forever
// while the site stays stale.

export class RailError extends Error {
  readonly rail: string
  readonly terminal: boolean

  constructor(rail: string, terminal: boolean, message: string) {
    super(message)
    this.name = 'RailError'
    this.rail = rail
    this.terminal = terminal
  }
}

/**
 * True only for a refusal that a retry cannot change.
 *
 * Anything that is not a RailError is transient by default, and that default is
 * deliberate: an unclassified failure is usually a crash, a network blip, or a
 * bug, and all three are worth retrying. The protection against retrying a
 * permanently broken build forever is not this function -- it is the service's
 * consecutive-failure count, which reports unhealthy while the backoff keeps
 * widening.
 */
export function isTerminal(e: unknown): boolean {
  return e instanceof RailError && e.terminal
}

export function railOf(e: unknown): string | null {
  return e instanceof RailError ? e.rail : null
}

/**
 * A configured number that must be usable, or a terminal refusal.
 *
 * This lives beside the rails rather than in a utility module because it exists
 * for one specific reason, and the reason is a property of how every rail here
 * is written. They are all comparisons -- `deleted / live > maxDeleteRatio`,
 * `width >= 1` -- and every comparison against NaN is false. So a single option
 * that failed to parse does not produce a wrong answer or an error. It produces
 * a rail that quietly stops firing, which is the failure mode this project
 * treats as worse than a crash.
 *
 * Measured, not hypothesised: `--max-delete-ratio not-a-number` reached the
 * deploy as NaN, the mass-deletion ceiling compared against it and passed, and
 * nine of ten live objects were deleted with no force flag and no warning. The
 * same shape appears wherever a count is trusted -- a NaN worker count builds a
 * pool of zero workers and seals an empty site, and a NaN upload concurrency
 * runs zero uploads and reports success.
 *
 * Terminal, because a value from a flag or a config file arrives identical on
 * every retry. A service retrying this would loop forever on a typo while the
 * site went stale.
 */
export function checkNumber(
  value: number | undefined,
  fallback: number,
  o: { name: string; min: number; max?: number; integer?: boolean },
): number {
  if (value === undefined) return fallback
  const ok =
    // Redundant at every call site as they stand -- each bounds its value with a
    // max or an integer rule, and both of those reject NaN and Infinity on their
    // own (`NaN >= min` is false). Kept because it is the clause that states the
    // contract rather than relying on one being supplied, and it is the only
    // guard an unbounded fractional option would have. Tested directly in
    // test/numeric-guards.test.ts, since no caller can exercise it.
    Number.isFinite(value) &&
    value >= o.min &&
    (o.max === undefined || value <= o.max) &&
    (o.integer !== true || Number.isInteger(value))
  if (ok) return value
  const range = o.max === undefined ? `at least ${o.min}` : `between ${o.min} and ${o.max}`
  throw new RailError(
    'invalid-number',
    true,
    `${o.name} must be ${o.integer ? 'a whole number' : 'a number'} ${range}, got ${value}. ` +
    `Refused rather than clamped: a value this far from usable is a mistake about ` +
    `what was intended, and guessing which limit was meant is how a typo becomes a ` +
    `silent policy change.`)
}
