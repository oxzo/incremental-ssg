// What pool() does to the jobs it did not run.
//
// The rejection value was never the interesting part -- it was right before and
// it is right now. What was wrong is that rejecting said nothing about the work:
// the runners that had not failed kept pulling from the queue and finished the
// entire list in the background, after the caller had been told the operation
// failed. For the deploy that is uploads landing in a live bucket after
// deploy() threw and the build lock reported no writer left.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/pool.ts'

/** A job list that records the order it actually ran in. */
function tracked(n: number, failAt: number | null, ms = 20) {
  const ran: number[] = []
  const jobs = Array.from({ length: n }, (_, i) => async () => {
    await new Promise((r) => setTimeout(r, i === failAt ? 1 : ms))
    ran.push(i)
    if (i === failAt) throw new Error(`job ${i} failed`)
    return i
  })
  return { ran, jobs }
}

/** Long enough that a pool which kept pulling would finish every remaining job. */
const settle = () => new Promise((r) => setTimeout(r, 400))

describe('pool', () => {
  test('a failing job stops the queue instead of draining it in the background', async () => {
    const { ran, jobs } = tracked(12, 0)
    await assert.rejects(() => pool(jobs, 3), /job 0 failed/)
    // The three that were in flight when it threw, and nothing after them. The
    // bound is the pool width, not the length of the rest of the list -- a
    // promise cannot be cancelled, so the ones already started are owed a wait.
    assert.equal(ran.length, 3)
    await settle()
    assert.equal(ran.length, 3, 'jobs kept running after pool() rejected')
  })

  test('every job still runs when none of them fail', async () => {
    // The negative control. A drain that stops honest work would pass the test
    // above by doing far too much: the failure is what stops the queue, not the
    // pool deciding on its own that it has done enough.
    const { ran, jobs } = tracked(12, null, 5)
    const out = await pool(jobs, 3)
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    assert.equal(ran.length, 12)
  })

  test('results keep input order, not completion order', async () => {
    // Jobs finish backwards; the array must not.
    const jobs = Array.from({ length: 6 }, (_, i) => async () => {
      await new Promise((r) => setTimeout(r, (6 - i) * 10))
      return i * 2
    })
    assert.deepEqual(await pool(jobs, 3), [0, 2, 4, 6, 8, 10])
  })

  test('the first failure is the one reported', async () => {
    // Two jobs fail; the later one must not overwrite the diagnosis. A rejection
    // naming the second failure sends a reader to a consequence.
    const jobs = [
      async () => { throw new Error('first') },
      async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('second') },
    ]
    await assert.rejects(() => pool(jobs, 2), /first/)
  })

  test('a job throwing a falsy value still stops the pool', async () => {
    // Nothing forbids `throw undefined`, and a stop condition written as
    // `failure !== undefined` would read that as "no failure yet" and keep
    // going -- rejecting with undefined while running the whole list.
    const ran: number[] = []
    const jobs = Array.from({ length: 9 }, (_, i) => async () => {
      await new Promise((r) => setTimeout(r, i === 0 ? 1 : 20))
      ran.push(i)
      if (i === 0) throw undefined
      return i
    })
    await assert.rejects(() => pool(jobs, 3).then(() => { throw new Error('resolved') }))
    await settle()
    assert.equal(ran.length, 3)
  })

  test('an empty job list is not a failure', async () => {
    assert.deepEqual(await pool([], 4), [])
  })
})
