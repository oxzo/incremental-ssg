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
