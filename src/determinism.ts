// Determinism enforcement for the render window.
//
// Success criterion 1 is "output is a pure function of content plus code", and
// the deploy diff in Phase 2 is worthless without it: a template that stamps
// `Date.now()` into a footer makes every page differ on every build, so the
// diff uploads the entire site every time and the whole point of Phase 0's
// verdict evaporates. Leaving this to discipline was the open question; this
// file closes it by making the nondeterministic call throw.
//
// WHAT IS GUARDED (inside the window only):
//   Date.now(), new Date() with no arguments, Math.random(),
//   performance.now(), crypto.randomUUID(), crypto.getRandomValues()
//
// WHAT IS NOT GUARDED, and why it is stated rather than implied:
//   - Filesystem, network, environment variables, process.hrtime. Blocking these
//     needs a real sandbox (permissions model or separate realm); a monkeypatch
//     that pretends to would be worse than an honest gap.
//   - References captured before the window opened. A module doing
//     `const now = Date.now` at import time keeps the real function. Templates
//     are called inside the window, so this only bites deliberately.
//   - Iteration order, locale, and timezone. These are stable within a build,
//     which is what diffability needs.
//
// `new Date(value)` is explicitly allowed -- rendering a document's own
// timestamp is the correct, deterministic thing to do, and it is what the
// example site's templates use.

export class DeterminismError extends Error {
  readonly api: string
  readonly where: string

  constructor(api: string, where: string) {
    super(
      `Nondeterministic ${api} called while rendering ${where}. Output must be a ` +
      `pure function of content plus code, or the deploy diff re-uploads every ` +
      `page on every build. Use a timestamp from the content, or set ` +
      `determinism:'off' in the site config if this build does not need to be diffable.`)
    this.name = 'DeterminismError'
    this.api = api
    this.where = where
  }
}

export type DeterminismWindow = {
  /** Names the route in any violation raised from here on. */
  setLabel(label: string): void
  /** Restores the real globals. Always call from a `finally`. */
  end(): void
}

const NOOP_WINDOW: DeterminismWindow = { setLabel() {}, end() {} }

/**
 * Swap the nondeterministic globals for throwing stand-ins.
 *
 * Installed once around the whole render loop rather than per route: the cost is
 * a handful of property writes either way, but per-route install/restore on
 * 24,000 routes churns globalThis for no benefit. The route name travels via
 * setLabel instead.
 */
export function beginDeterministicWindow(mode: 'enforce' | 'off' = 'enforce'): DeterminismWindow {
  if (mode === 'off') return NOOP_WINDOW

  let label = '<unknown route>'
  const realDate = globalThis.Date
  const realRandom = Math.random
  const restores: (() => void)[] = []

  const guardedDate = new Proxy(realDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) throw new DeterminismError('new Date()', label)
      return Reflect.construct(target, args, newTarget)
    },
    get(target, prop, receiver) {
      if (prop === 'now') {
        return () => {
          throw new DeterminismError('Date.now()', label)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  globalThis.Date = guardedDate as DateConstructor
  restores.push(() => {
    globalThis.Date = realDate
  })

  Math.random = () => {
    throw new DeterminismError('Math.random()', label)
  }
  restores.push(() => {
    Math.random = realRandom
  })

  // performance and crypto are host objects whose methods are not guaranteed
  // writable across runtimes. A guard we cannot install is not a reason to fail
  // the build -- it is a reason not to claim we installed it.
  patchMethod(globalThis.performance as unknown as Record<string, unknown>, 'now', 'performance.now()', () => label, restores)
  patchMethod(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID', 'crypto.randomUUID()', () => label, restores)
  patchMethod(globalThis.crypto as unknown as Record<string, unknown>, 'getRandomValues', 'crypto.getRandomValues()', () => label, restores)

  let ended = false
  return {
    setLabel(next: string) {
      label = next
    },
    end() {
      if (ended) return
      ended = true
      for (const r of restores.reverse()) r()
    },
  }
}

function patchMethod(
  host: Record<string, unknown> | undefined,
  name: string,
  api: string,
  label: () => string,
  restores: (() => void)[],
) {
  if (!host || typeof host[name] !== 'function') return
  const real = host[name]
  try {
    host[name] = () => {
      throw new DeterminismError(api, label())
    }
  } catch {
    return // non-writable; the omission is documented at the top of this file.
  }
  restores.push(() => {
    host[name] = real
  })
}

/** Convenience wrapper for a single call -- used by tests and single-route renders. */
export function runDeterministic<T>(label: string, fn: () => T, mode: 'enforce' | 'off' = 'enforce'): T {
  const w = beginDeterministicWindow(mode)
  w.setLabel(label)
  try {
    return fn()
  } finally {
    w.end()
  }
}
