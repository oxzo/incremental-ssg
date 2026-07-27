// Test-only scaffolding. Sample content lives with the example site, so the
// suite exercises the same corpus a reader can run via `npm run demo`.
//
// Working files go to real disk under .tmp/ rather than /tmp, which is tmpfs on
// the dev box. Tests do not measure anything, but the benchmarks next door do,
// and one convention beats remembering which directory is a RAM disk.
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, sep } from 'node:path'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { blogDocs } from '../example/blog/fixture.ts'
import type { MockDoc } from '../src/cms-mock.ts'
import type { CmsCapabilities } from '../src/cms.ts'

export { blogDocs, makeImages, EPOCH } from '../example/blog/fixture.ts'

const ROOT = resolve(import.meta.dirname, '../.tmp')

export function tmpdir(prefix: string): string {
  mkdirSync(ROOT, { recursive: true })
  return mkdtempSync(join(ROOT, `${prefix}-`))
}

export function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Content fingerprint of an output tree: sorted `relpath sha256` lines.
 *
 * Comparing these between two builds is the direct test of success criterion 1
 * ("output is a pure function of content plus code"). Comparing route counts or
 * spot-checking a page would pass while a footer timestamp quietly made every
 * file differ -- which is exactly the failure the Phase 2 deploy diff cannot
 * survive.
 */
export function hashTree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else {
        const rel = relative(dir, p).split(sep).join('/')
        out.push(`${rel} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * Fill a store by running the real pipeline: mock CMS over HTTP, real adapter,
 * real sync driver. Writing rows straight into SQLite would be faster and would
 * test the half of sync that never breaks.
 */
export async function seedStore(
  dbPath: string,
  docs: MockDoc[] = blogDocs(),
  capabilities?: Partial<CmsCapabilities>,
) {
  const cms = await startMockCms(docs)
  const store = new DocumentStore(dbPath)
  try {
    const adapter = httpCmsAdapter({ baseUrl: cms.url, capabilities })
    const result = await sync(adapter, store, { pageSize: 500 })
    return result
  } finally {
    store.close()
    await cms.close()
  }
}
