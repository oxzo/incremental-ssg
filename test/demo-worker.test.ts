import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import worker, { keysFor, cacheControl } from '../demo/worker/src/index.ts'

// The Worker is the reader in front of the bucket `cli serve` deploys into, so
// the thing worth testing is the seam between them: every path the build emits
// must map to a key the deploy actually wrote, and nothing in this file may
// re-derive a content type the deploy already stored.

/** A stand-in for the R2 binding, holding the keys a real deploy would have. */
function fakeBucket(keys: string[]) {
  const set = new Set(keys)
  return {
    get: async (key: string) =>
      set.has(key)
        ? {
            body: `body of ${key}`,
            httpEtag: '"abc123"',
            writeHttpMetadata: (h: Headers) => h.set('content-type', 'text/html; charset=utf-8'),
          }
        : null,
  }
}

const req = (path: string, method = 'GET') =>
  new Request(`https://demo.workers.dev${path}`, { method })

describe('demo worker — path mapping', () => {
  test('root serves the index', () => {
    assert.deepEqual(keysFor('/'), { key: 'index.html' })
  })

  test('a directory-style route serves its index', () => {
    assert.deepEqual(keysFor('/posts/post-7/'), { key: 'posts/post-7/index.html' })
    assert.deepEqual(keysFor('/tags/tag-0/page/2/'), { key: 'tags/tag-0/page/2/index.html' })
  })

  test('a path with an extension is served directly', () => {
    assert.deepEqual(keysFor('/feed.xml'), { key: 'feed.xml' })
    assert.deepEqual(keysFor('/assets/img/hero-a.8b925a17c91b-cda0a47b.avif'), {
      key: 'assets/img/hero-a.8b925a17c91b-cda0a47b.avif',
    })
  })

  test('an extensionless route resolves to its index and asks for the canonical URL', () => {
    // Both forms must not serve the same page at two URLs, so one redirects.
    assert.deepEqual(keysFor('/posts/post-7'), {
      key: 'posts/post-7/index.html',
      redirectTo: '/posts/post-7/',
    })
  })

  test('a percent-encoded path is decoded before lookup', () => {
    assert.equal(keysFor('/tags/tag%2D0/').key, 'tags/tag-0/index.html')
  })

  /**
   * The mapping is only correct relative to what the build emits, and that is a
   * moving target. This walks a real output tree and asserts every emitted file
   * is reachable through some request path — so a change to the write step's
   * layout fails here rather than as a 404 on the live site.
   */
  test('every file in a built tree is reachable', (t) => {
    const root = resolve(import.meta.dirname, '..')
    const dist = join(root, '.tmp/live-service/dist')
    let files: string[]
    try {
      files = walk(dist)
    } catch {
      // Said out loud rather than returning quietly: a check that silently does
      // nothing reads exactly like a check that passed.
      t.diagnostic(`no built tree at ${dist} — run a build to exercise this against real output`)
      return
    }
    t.diagnostic(`checked ${files.length} emitted files`)
    assert.ok(files.length > 0)
    for (const rel of files) {
      const path = rel.endsWith('/index.html') ? `/${rel.slice(0, -'index.html'.length)}` : `/${rel}`
      assert.equal(keysFor(path).key, rel, `${path} did not map back to ${rel}`)
    }
  })
})

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

describe('demo worker — caching', () => {
  test('content-addressed assets are immutable, HTML is not', () => {
    // The hash is in the asset filename, so a changed image is a new URL and the
    // old one can be held forever. An HTML route keeps its URL across edits.
    assert.match(cacheControl('assets/img/hero-a.8b925a17c91b-cda0a47b.avif'), /immutable/)
    assert.doesNotMatch(cacheControl('posts/post-7/index.html'), /immutable/)
    assert.match(cacheControl('posts/post-7/index.html'), /max-age=0/)
  })
})

describe('demo worker — responses', () => {
  const env = { SITE: fakeBucket(['index.html', 'posts/post-7/index.html', 'feed.xml']) } as never

  test('serves an existing page with the stored content type', async () => {
    const res = await worker.fetch(req('/posts/post-7/'), env)
    assert.equal(res.status, 200)
    // Stored by the deploy, not re-derived here -- one mapping table, not two.
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })

  test('redirects the extensionless form only when the page exists', async () => {
    const hit = await worker.fetch(req('/posts/post-7'), env)
    assert.equal(hit.status, 308)
    assert.match(hit.headers.get('location') ?? '', /\/posts\/post-7\/$/)

    // A missing page must 404 rather than redirect to another 404.
    const miss = await worker.fetch(req('/posts/nope'), env)
    assert.equal(miss.status, 404)
  })

  test('404s an unknown path', async () => {
    const res = await worker.fetch(req('/does/not/exist/'), env)
    assert.equal(res.status, 404)
  })

  test('HEAD returns headers with no body', async () => {
    const res = await worker.fetch(req('/', 'HEAD'), env)
    assert.equal(res.status, 200)
    assert.equal(res.body, null)
  })

  test('refuses writes, because this Worker only ever reads', async () => {
    // The bucket is public-by-intent for reads; a PUT reaching it would be a
    // different thing entirely, so the method check is the authorization story.
    const res = await worker.fetch(req('/index.html', 'PUT'), env)
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
  })
})
