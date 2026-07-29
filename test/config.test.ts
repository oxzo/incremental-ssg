// The seam between the engine and a site, and what it refuses.
//
// `loadSite` is the first thing a new deployment runs and the first thing that
// can be wrong about it: a module that exports nothing the engine recognises, or
// a SiteConfig missing a field the build has no default for. Both threw plain
// Errors, which `isTerminal` reads as transient by design -- so `serve` pointed
// at a site module it could not load retried on a widening backoff instead of
// halting and naming the file.
//
// The default is right for an unclassified failure. It is wrong here, because
// ESM caches modules by URL: the import that failed returns the same answer for
// the life of the process, and what changes it is a person editing the file.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSite } from '../src/config.ts'
import { RailError } from '../src/rails.ts'
import { tmpdir, cleanup } from './fixture.ts'

const dirs: string[] = []
after(() => dirs.forEach(cleanup))

/** Write a site module and return its path. Each gets its own name, because
 *  ESM caches by URL and a reused path would serve the first test's module. */
let n = 0
function siteModule(source: string): string {
  const d = tmpdir('config')
  dirs.push(d)
  const path = join(d, `site-${n++}.ts`)
  writeFileSync(path, source)
  return path
}

describe('loadSite refuses a site module it cannot use', () => {
  test('a module exporting no SiteConfig is terminal', async () => {
    const path = siteModule('export const notTheSite = 1\n')
    await assert.rejects(
      () => loadSite(path),
      (e: unknown) => {
        assert.ok(e instanceof RailError)
        assert.match(e.message, /has no default export/)
        // Terminal: the next import of this URL returns the cached module and
        // the same answer. Retrying is a loop that publishes nothing.
        assert.equal(e.terminal, true)
        assert.equal(e.rail, 'site.config')
        return true
      })
  })

  test('a SiteConfig missing a required field is terminal, and names the field', async () => {
    const path = siteModule(
      'export default { name: "s", contentTypes: ["post"], index: () => ({}), templates: {} }\n')
    await assert.rejects(
      () => loadSite(path),
      (e: unknown) => {
        assert.ok(e instanceof RailError)
        assert.match(e.message, /is missing `routes`/)
        assert.equal(e.terminal, true)
        return true
      })
  })

  test('a complete SiteConfig loads, which is the control both refusals need', async () => {
    // Without this a rail that refused every module would pass the two above.
    const path = siteModule(
      'export default { name: "s", contentTypes: ["post"], index: () => ({}), ' +
      'routes: () => [], templates: {} }\n')
    const cfg = await loadSite(path)
    assert.equal(cfg.name, 's')
    assert.deepEqual(cfg.contentTypes, ['post'])
  })
})
