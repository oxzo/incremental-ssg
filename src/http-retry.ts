// One HTTP request, and the policy for what to do when it does not work.
//
// Extracted from cms-directus.ts rather than written for cms.ts, which is the
// order that matters: the Directus adapter had a timeout, an attempt budget, a
// capped Retry-After and a total-wait budget, and `httpCmsAdapter` -- the
// adapter every other CMS starts from -- had a bare `fetch` and a plain Error.
// Copying the shape across would have produced the drift this codebase has
// already met twice, in pool() and in the two spellings of isInside(): two
// copies of a primitive stay identical exactly until one of them is fixed.
//
// The classification is the load-bearing part, not the backoff. A 429 or a 5xx
// is a fact about right now and retrying is the correct response; a 403 or a 404
// is a fact about the request and retrying it is a loop. Getting it backwards is
// silent in both directions (src/rails.ts), so it is decided here from the
// status rather than guessed downstream from a message.
//
// What is deliberately NOT here: authentication. A token, when to refresh it,
// and what a 401 means are the adapter's business, and folding them in would
// make this module know about a CMS. The seam is `send`, which the caller builds
// per attempt, and `onUnauthorized`, which it answers per 401.
import { RailError, isTerminal, checkNumber } from './rails.ts'

export type RetryOptions = {
  /** Per-request timeout. A hung socket is the failure a retry loop cannot see. */
  timeoutMs?: number
  /** Attempts per request, including the first. */
  attempts?: number
  /** First backoff step; doubles per attempt. */
  backoffMs?: number
  /** Cap on a server-supplied Retry-After, so a hostile header cannot wedge sync. */
  maxRetryAfterMs?: number
  /**
   * Budget for total time spent waiting between attempts of one request. Caps by
   * accumulation what maxRetryAfterMs caps per attempt.
   */
  maxTotalWaitMs?: number
}

export type RetryPolicy = Required<RetryOptions>

/**
 * Resolve the options once, at adapter construction, rather than per request.
 *
 * Through checkNumber for the reason every other count in this codebase is: each
 * of these is enforced by a comparison, and every comparison against NaN is
 * false. A timeout of NaN is `AbortSignal.timeout(NaN)`, which is not a deadline
 * -- so the one guard against a hung socket would be missing while the code
 * saying it exists reads correctly.
 */
export function retryPolicy(o: RetryOptions = {}): RetryPolicy {
  return {
    timeoutMs: checkNumber(o.timeoutMs, 15_000, { name: 'timeoutMs', min: 1, integer: true }),
    attempts: checkNumber(o.attempts, 4, { name: 'attempts', min: 1, integer: true }),
    backoffMs: checkNumber(o.backoffMs, 250, { name: 'backoffMs', min: 0, integer: true }),
    maxRetryAfterMs: checkNumber(o.maxRetryAfterMs, 30_000, {
      name: 'maxRetryAfterMs', min: 0, integer: true,
    }),
    maxTotalWaitMs: checkNumber(o.maxTotalWaitMs, 60_000, {
      name: 'maxTotalWaitMs', min: 0, integer: true,
    }),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type RetryHooks = {
  /**
   * A 401 arrived. Return true to spend another attempt, false to refuse.
   *
   * This is where "an expired token is a stale one, not an unauthorised one"
   * lives -- and it lives in the caller because exactly one re-login can fix a
   * stale token, and only the caller knows whether it has already tried.
   * Answering true unconditionally would turn genuinely bad credentials into a
   * loop.
   */
  onUnauthorized?: () => boolean | Promise<boolean>
}

/**
 * Send one request, retrying the failures a retry can fix, and return its body.
 *
 * `send` is called once per attempt and is handed the deadline signal, so a
 * caller that has to do work first -- log in, refresh a token, re-sign -- does it
 * inside the attempt rather than ahead of the loop, and its failures are
 * classified on the same terms as the request's own. A RailError thrown from
 * `send` is honoured: terminal leaves immediately, transient spends an attempt.
 *
 * Returns the body as text rather than parsed JSON, because the byte count is
 * the caller's to keep and a second stringify to measure it would be a lie about
 * what came over the wire.
 */
export async function requestWithRetry(
  rail: string,
  label: string,
  policy: RetryPolicy,
  send: (signal: AbortSignal) => Promise<Response>,
  hooks: RetryHooks = {},
): Promise<string> {
  let lastError: unknown = null

  /**
   * A budget for time spent *waiting*, separate from the per-request timeout.
   *
   * The per-attempt cap on Retry-After stops one hostile header from stalling
   * publishing; this stops the same thing happening by accumulation, which no
   * per-attempt cap can see. Both matter, and the failure they prevent is the
   * one this project keeps naming as the worst available: a service that is
   * busy forever and publishes nothing, with nobody watching.
   *
   * It also makes the waits *bounded* rather than merely capped, which is what
   * lets a test observe the behaviour instead of waiting out the header.
   */
  const waitDeadline = performance.now() + policy.maxTotalWaitMs
  const waitFor = async (ms: number) => {
    const left = waitDeadline - performance.now()
    if (ms > left) {
      throw new RailError(
        rail,
        false,
        `${label}: retry budget exhausted — next wait of ${Math.round(ms)}ms exceeds the ${Math.round(Math.max(left, 0))}ms left`,
      )
    }
    await sleep(ms)
  }

  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    if (attempt > 0) await waitFor(policy.backoffMs * 2 ** (attempt - 1))
    let res: Response
    try {
      res = await send(AbortSignal.timeout(policy.timeoutMs))
    } catch (e) {
      // Includes the abort. A timeout is retryable by construction: the point
      // of the deadline is that a hung socket never returns a status at all.
      // A terminal refusal from `send` -- credentials that are wrong rather
      // than a CMS that is down -- is not, and leaves here.
      if (isTerminal(e)) throw e
      lastError = e
      continue
    }

    if (res.ok) return await res.text()

    if (res.status === 401 && hooks.onUnauthorized !== undefined) {
      if (await hooks.onUnauthorized()) {
        lastError = new Error(`401 unauthorized on ${label}`)
        continue
      }
    }

    if (res.status === 429) {
      // Honoured, but capped: an upstream that says "come back in an hour" must
      // not be able to stall publishing for an hour on its own say-so.
      const header = res.headers.get('retry-after')
      const wait = header === null ? null : Number(header) * 1000
      const delay = wait !== null && Number.isFinite(wait)
        ? Math.min(Math.max(wait, 0), policy.maxRetryAfterMs)
        : policy.backoffMs * 2 ** attempt
      lastError = new Error(`429 rate limited on ${label}`)
      await waitFor(delay)
      continue
    }

    if (res.status >= 500) {
      lastError = new Error(`${res.status} ${res.statusText} on ${label}`)
      continue
    }

    const detail = (await res.text()).slice(0, 300)
    throw new RailError(rail, true, `${res.status} ${res.statusText} on ${label}: ${detail}`)
  }

  throw new RailError(
    rail,
    false,
    `${label} failed after ${policy.attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
