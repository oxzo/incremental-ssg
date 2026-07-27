import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginDeterministicWindow, runDeterministic, allowNondeterministic, DeterminismError,
} from '../src/determinism.ts'

describe('determinism window', () => {
  test('Date.now() throws and the error names the route', () => {
    assert.throws(
      () => runDeterministic('/posts/hello/', () => Date.now()),
      (e: unknown) => e instanceof DeterminismError && e.api === 'Date.now()' && e.where === '/posts/hello/',
    )
  })

  test('new Date() with no arguments throws', () => {
    assert.throws(
      () => runDeterministic('/', () => new Date()),
      (e: unknown) => e instanceof DeterminismError && e.api === 'new Date()',
    )
  })

  test('new Date(value) is allowed, because a content timestamp is deterministic', () => {
    const iso = runDeterministic('/', () => new Date(1_700_000_000_000).toISOString())
    assert.equal(iso, '2023-11-14T22:13:20.000Z')
  })

  test('a Date built inside the window is a real Date', () => {
    const d = runDeterministic('/', () => new Date(0))
    assert.ok(d instanceof Date)
    assert.equal(d.getTime(), 0)
  })

  test('pure Date statics still work', () => {
    const parsed = runDeterministic('/', () => Date.parse('2023-11-14T22:13:20.000Z'))
    assert.equal(parsed, 1_700_000_000_000)
    assert.equal(runDeterministic('/', () => Date.UTC(2023, 0, 1)), Date.UTC(2023, 0, 1))
  })

  test('Math.random() throws', () => {
    assert.throws(
      () => runDeterministic('/feed.xml', () => Math.random()),
      (e: unknown) => e instanceof DeterminismError && e.api === 'Math.random()',
    )
  })

  test('crypto.randomUUID() throws', () => {
    assert.throws(
      () => runDeterministic('/', () => crypto.randomUUID()),
      (e: unknown) => e instanceof DeterminismError && e.api === 'crypto.randomUUID()',
    )
  })

  test('performance.now() throws', () => {
    assert.throws(
      () => runDeterministic('/', () => performance.now()),
      (e: unknown) => e instanceof DeterminismError && e.api === 'performance.now()',
    )
  })

  test('globals are restored after the window closes', () => {
    const realNow = Date.now
    const realRandom = Math.random
    runDeterministic('/', () => 1)
    assert.equal(Date.now, realNow)
    assert.equal(Math.random, realRandom)
    assert.ok(typeof Date.now() === 'number')
    assert.ok(Math.random() >= 0)
  })

  test('globals are restored even when the render throws', () => {
    const realRandom = Math.random
    assert.throws(() => runDeterministic('/', () => { throw new Error('template blew up') }), /template blew up/)
    assert.equal(Math.random, realRandom, 'a failed build must not leave the process poisoned')
  })

  test('the label follows the route being rendered', () => {
    const w = beginDeterministicWindow('enforce')
    try {
      w.setLabel('/a/')
      assert.throws(() => Date.now(), (e: unknown) => (e as DeterminismError).where === '/a/')
      w.setLabel('/b/')
      assert.throws(() => Date.now(), (e: unknown) => (e as DeterminismError).where === '/b/')
    } finally {
      w.end()
    }
  })

  test("mode 'off' installs nothing", () => {
    const w = beginDeterministicWindow('off')
    try {
      assert.ok(typeof Date.now() === 'number')
      assert.ok(typeof new Date().getTime() === 'number')
      assert.ok(Math.random() >= 0)
    } finally {
      w.end()
    }
  })

  test('an exemption permits the call and returns the real value', () => {
    // The claim an exemption makes is "this cannot affect output", not "time has
    // stopped" -- so it hands the callee a real clock, because a library given a
    // frozen one may take paths nobody reasoned about.
    const before = Date.now()
    const inside = runDeterministic('/', () => allowNondeterministic(() => Date.now()))
    assert.ok(inside >= before && inside <= Date.now())
    assert.equal(runDeterministic('/', () => allowNondeterministic(() => typeof Math.random())), 'number')
  })

  test('the guard is back the instant the exemption returns', () => {
    assert.throws(
      () => runDeterministic('/', () => {
        allowNondeterministic(() => Date.now())
        return Date.now()
      }),
      DeterminismError)
  })

  test('an exemption that throws still restores the guard', () => {
    // The failure this prevents is the worst kind: an exemption leaking past its
    // own scope silently disarms the guard for the rest of the build.
    assert.throws(
      () => runDeterministic('/', () => {
        try {
          allowNondeterministic(() => { throw new Error('boom') })
        } catch { /* swallowed on purpose */ }
        return Date.now()
      }),
      DeterminismError)
  })

  test('nested exemptions restore one level at a time', () => {
    assert.throws(
      () => runDeterministic('/', () => {
        allowNondeterministic(() => {
          allowNondeterministic(() => Date.now())
          // Still inside the outer exemption, so this must not throw.
          Date.now()
        })
        return Date.now()
      }),
      DeterminismError)
  })

  test('an exemption outside any window is inert', () => {
    assert.equal(typeof allowNondeterministic(() => Date.now()), 'number')
    assert.equal(typeof Date.now(), 'number')
  })

  test('end() is idempotent', () => {
    const w = beginDeterministicWindow('enforce')
    w.end()
    w.end()
    assert.ok(typeof Date.now() === 'number')
  })
})
