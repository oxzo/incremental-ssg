import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DocumentStore, STORE_SCHEMA, documentIdentity, documentKey } from '../src/store.ts'
import type { RailError } from '../src/rails.ts'
import { tmpdir, cleanup } from './fixture.ts'

const dirs: string[] = []
const fresh = () => {
  const d = tmpdir('store')
  dirs.push(d)
  return join(d, 'content.db')
}
after(() => dirs.forEach(cleanup))

const doc = (id: string, type: string, updatedAt = 1, body: Record<string, unknown> = {}) => ({
  id,
  type,
  revision: `r-${id}`,
  updatedAt,
  hash: `h-${id}`,
  json: JSON.stringify({ id, ...body }),
})

describe('DocumentStore', () => {
  test('upserts and counts', () => {
    const s = new DocumentStore(fresh())
    assert.equal(s.upsertMany([doc('a', 'post'), doc('b', 'post')]), 2)
    assert.equal(s.count(), 2)
    // Same id again is an update, not a duplicate row.
    s.upsertMany([doc('a', 'post', 2)])
    assert.equal(s.count(), 2)
    s.close()
  })

  test('byType groups and orders by id, so index order does not depend on arrival order', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('post-c', 'post'), doc('a1', 'author'), doc('post-a', 'post'), doc('post-b', 'post')])
    const docs = s.byType(['post', 'author'])
    assert.deepEqual(
      (docs.get('post') ?? []).map((d) => d.id),
      ['post-a', 'post-b', 'post-c'],
    )
    assert.deepEqual((docs.get('author') ?? []).map((d) => d.id), ['a1'])
    s.close()
  })

  test('byType returns an empty list for a declared type with no documents', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post')])
    const docs = s.byType(['post', 'tag'])
    assert.deepEqual(docs.get('tag'), [])
    s.close()
  })

  test('byType ignores types the site did not declare', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('s', 'secret')])
    const docs = s.byType(['post'])
    assert.equal(docs.has('secret'), false)
    s.close()
  })

  test('meta round-trips and records the schema version', () => {
    const p = fresh()
    const s = new DocumentStore(p)
    assert.equal(s.getMeta('schema'), String(STORE_SCHEMA))
    assert.equal(s.getMeta('nope'), null)
    s.setMeta('sync:watermark', '1234')
    s.setMeta('sync:watermark', '5678')
    assert.equal(s.getMeta('sync:watermark'), '5678')
    s.close()
  })

  test('rejects a database written by an incompatible schema', () => {
    const p = fresh()
    const s = new DocumentStore(p)
    s.setMeta('schema', String(STORE_SCHEMA + 1))
    s.close()
    assert.throws(() => new DocumentStore(p), /schema/)
  })

  test('identities() exposes type and content, which is what change detection compares', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'page')])
    // Type is in the value, so a document that moves between two rendered types
    // with an unchanged body compares as different -- the case a hash-keyed
    // map reported as no change at all.
    assert.deepEqual(
      [...s.identities().entries()].sort(),
      [[documentKey('post', 'a'), documentIdentity('post', 'h-a')],
       [documentKey('page', 'b'), documentIdentity('page', 'h-b')]].sort())
    s.close()
  })

  test('deleteMissing drops documents the CMS no longer lists', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.equal(s.deleteMissing(live('a', 'b', 'c')), 1)
    assert.deepEqual([...s.refs()].map((r) => r.id).sort(), ['a', 'b', 'c'])
    s.close()
  })

  /**
   * A live set holds composite keys, because that is what identifies a document
   * now. Spelled through a helper rather than inline: passing bare ids here
   * still "works" in the sense that the rail fires -- every key mismatches, so
   * every document looks missing -- which is a test passing for a reason that
   * has nothing to do with what it claims to check.
   */
  const live = (...ids: string[]) => new Set(ids.map((i) => documentKey('post', i)))

  test('deleteMissing is a no-op when nothing is missing', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post')])
    assert.equal(s.deleteMissing(live('a', 'b')), 0)
    s.close()
  })

  test('deleteMissing refuses an implausible sweep from a partial listing', () => {
    // The failure this rail exists for: a reconcile scan that dies halfway
    // returns a short list, and trusting it unpublishes most of the site while
    // every log line still says "sync complete".
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.throws(() => s.deleteMissing(live('a')), /over the 50% limit/)
    assert.equal(s.count(), 4, 'nothing may be deleted when the guard trips')
    s.close()
  })

  test('deleteMissing allows a large sweep when it is explicitly intended', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.equal(s.deleteMissing(live('a'), { force: true }), 3)
    assert.equal(s.count(), 1)
    s.close()
  })

  test('prepareForReaders leaves the file openable by concurrent readers', () => {
    // Ten read-only workers racing to create a WAL -shm file was a real Phase 0
    // crash, and it only appeared at the largest corpus.
    const p = fresh()
    const w = new DocumentStore(p)
    w.upsertMany([doc('a', 'post')])
    w.prepareForReaders()
    w.close()
    const readers = Array.from({ length: 8 }, () => new DocumentStore(p, { readOnly: true }))
    for (const r of readers) assert.equal(r.count(), 1)
    readers.forEach((r) => r.close())
  })
})

describe('DocumentStore — (type, id) is the key', () => {
  test('the same id under two types is two documents', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('shared', 'post'), doc('shared', 'page')])
    assert.equal(s.count(), 2)
    assert.deepEqual(
      s.refs().map((r) => `${r.type}/${r.id}`).sort(),
      ['page/shared', 'post/shared'])
    s.close()
  })

  test('the same id under one type is one document, updated in place', () => {
    // The other half of the key: it must still be a key. Two upserts of the same
    // (type, id) is an update, not a second row.
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post')])
    s.upsertMany([{ ...doc('a', 'post'), hash: 'h2', revision: 'r2' }])
    assert.equal(s.count(), 1)
    assert.equal(s.revisionOf('post', 'a'), 'r2')
    s.close()
  })

  test('revisionOf answers for the named type only', () => {
    // The read-after-write check calls this. Answering for whichever document
    // happened to share the id would report the mirror caught up when it had
    // not, or never caught up at all.
    const s = new DocumentStore(fresh())
    s.upsertMany([{ ...doc('shared', 'post'), revision: 'rp' }, { ...doc('shared', 'page'), revision: 'rg' }])
    assert.equal(s.revisionOf('post', 'shared'), 'rp')
    assert.equal(s.revisionOf('page', 'shared'), 'rg')
    assert.equal(s.revisionOf('author', 'shared'), null)
    s.close()
  })

  test('deleteIds removes one row of a shared id and leaves the other', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('shared', 'post'), doc('shared', 'page')])
    assert.equal(s.deleteIds([{ type: 'page', id: 'shared' }]), 1)
    assert.deepEqual(s.refs().map((r) => `${r.type}/${r.id}`), ['post/shared'])
    s.close()
  })

  test('a mirror written by the previous schema is refused, not silently reused', () => {
    // The migration, such as it is. A v1 file has id as its primary key, so
    // reusing it would keep the collision this schema exists to remove -- and
    // the mirror is reproducible by construction, which is why the answer is to
    // delete and re-sync rather than to rewrite the table.
    const path = fresh()
    const s = new DocumentStore(path)
    s.setMeta('schema', String(STORE_SCHEMA - 1))
    s.close()
    assert.throws(
      () => new DocumentStore(path),
      (e: unknown) => {
        assert.match((e as Error).message, /Delete the database and re-sync/)
        // Terminal, and the least ambiguous case in the codebase: the file
        // records a version, the binary expects another, and the next run
        // compares the same two numbers. The remedy the message names is a
        // human deleting a file, which is the definition of terminal.
        //
        // A plain Error until the classification sweep, so `isTerminal` read it
        // as transient by default and the service retried a comparison that
        // cannot move -- busy logs, no publishing, and a stale site.
        assert.equal((e as RailError).terminal, true)
        assert.equal((e as RailError).rail, 'store.schema')
        return true
      })
  })
})
