import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DocumentStore, STORE_SCHEMA, documentIdentity } from '../src/store.ts'
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
      [['a', documentIdentity('post', 'h-a')], ['b', documentIdentity('page', 'h-b')]])
    s.close()
  })

  test('deleteMissing drops documents the CMS no longer lists', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.equal(s.deleteMissing(new Set(['a', 'b', 'c'])), 1)
    assert.deepEqual([...s.ids()].sort(), ['a', 'b', 'c'])
    s.close()
  })

  test('deleteMissing is a no-op when nothing is missing', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post')])
    assert.equal(s.deleteMissing(new Set(['a', 'b'])), 0)
    s.close()
  })

  test('deleteMissing refuses an implausible sweep from a partial listing', () => {
    // The failure this rail exists for: a reconcile scan that dies halfway
    // returns a short list, and trusting it unpublishes most of the site while
    // every log line still says "sync complete".
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.throws(() => s.deleteMissing(new Set(['a'])), /over the 50% limit/)
    assert.equal(s.count(), 4, 'nothing may be deleted when the guard trips')
    s.close()
  })

  test('deleteMissing allows a large sweep when it is explicitly intended', () => {
    const s = new DocumentStore(fresh())
    s.upsertMany([doc('a', 'post'), doc('b', 'post'), doc('c', 'post'), doc('d', 'post')])
    assert.equal(s.deleteMissing(new Set(['a']), { force: true }), 3)
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
