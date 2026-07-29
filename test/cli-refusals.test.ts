// A refusal, as an operator actually receives it.
//
// The rails throw text written to be read by a person deciding whether to
// override them -- `sync.short-listing` and `cms.duplicate-document` are each
// several sentences on what was not done and why. `die` in src/cli.ts exists to
// print that text and nothing else, because a stack trace buries the
// explanation under the frames.
//
// Every command routed through it except `sync`, which was an omission rather
// than a decision: it is the command whose two most carefully worded refusals
// are the ones above. A rail nobody can read is most of the way to a rail that
// is not there, so this file checks the delivery rather than the throw.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { DocumentStore, STORE_SCHEMA } from '../src/store.ts'
import { tmpdir, cleanup } from './fixture.ts'

const CLI = resolve(import.meta.dirname, '../src/cli.ts')

const dirs: string[] = []
const work = (name: string) => {
  const d = tmpdir(name)
  dirs.push(d)
  return d
}
after(() => dirs.forEach(cleanup))

/** Run the CLI and return its exit code and stderr. */
function cli(args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, err }))
  })
}

/**
 * A store the library will refuse to open, and the shortest path to a *library*
 * refusal rather than a flag one.
 *
 * The distinction is the whole point of this file. `num()` in src/cli.ts already
 * refuses a bad flag by name and exits 2 before anything runs; what was missing
 * was the other half -- a rail thrown from inside the library, several frames
 * down, after the command had started work.
 */
function poisonedStore(name: string): string {
  const dbPath = join(work(name), 'content.db')
  const s = new DocumentStore(dbPath)
  s.setMeta('schema', String(STORE_SCHEMA - 1))
  s.close()
  return dbPath
}

describe('the CLI reports a library refusal as a message, not a stack', () => {
  test('sync prints the rail text and exits 1', async () => {
    const { code, err } = await cli(['sync', '--db', poisonedStore('cli-sync'), '--cms', 'http://127.0.0.1:1'])
    assert.equal(code, 1, 'exits through die(), not on an unhandled rejection')
    // The message, in full and on the first line.
    assert.match(err, /^error: store schema \d+ != \d+/m)
    assert.match(err, /Delete the database and re-sync/)
    // And not a stack. `at ` with a file reference is what a stack trace looks
    // like, and it is exactly what this used to print instead.
    assert.doesNotMatch(err, /\n\s+at .*src[\\/]/)
  })

  test('build and deploy already did, which is what made sync the odd one', async () => {
    // The control, and the argument that this was an omission rather than a
    // choice: the other commands that run to completion have had `.catch(die)`
    // all along, and all of them throw the same kind of rail from the same
    // library. `serve` is not here because it does not run to completion -- it
    // starts a server and stays up, so its refusals belong to the service and
    // are covered in test/service.test.ts.
    const db = poisonedStore('cli-build')
    for (const args of [
      ['build', '--site', 'nope.ts', '--db', db, '--out', join(work('cli-out'), 'dist')],
      ['deploy', '--out', join(work('cli-out2'), 'dist'), '--to', work('cli-to'), '--db', db],
    ]) {
      const { code, err } = await cli(args)
      assert.equal(code, 1, `${args[0]} exits through die()`)
      assert.match(err, /^error: /m, `${args[0]} prints a message`)
      assert.doesNotMatch(err, /\n\s+at .*src[\\/]/, `${args[0]} prints no stack`)
    }
  })
})
