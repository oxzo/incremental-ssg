// Edit fan-out through the *example site's templates*, sampled across the corpus.
//
// Phase 0 measured fan-out against the benchmark harness's template set and
// concluded content edits are constant-cost: 5-9 routes whether the site has 500
// posts or 20,000. That is one of the three findings the kill gate rests on.
//
// The first live publish through the service uploaded **408 files** for a single
// title edit. Every one of them genuinely contained the edited title, so the
// deploy diff was right; what was wrong was the expectation.
//
// The cause is in the templates, not the content model. Each post page carries a
// related-posts sidebar, and `related` takes the first RELATED entries from the
// post's *first tag's* list, which is sorted newest-first. So a handful of posts
// -- the newest few in each tag -- appear on the page of every post sharing that
// tag, while every other post appears on almost nothing. Fan-out is **bimodal**,
// and which mode you land in depends on which post you edit.
//
// That is why this samples rather than measuring one post. A first version of
// this benchmark edited post-7 alone, reported 9 routes, and would have
// "refuted" the 408 -- the same mistake Phase 0's own notes record about its
// first fan-out model, which appended text to the end of a body, left the
// excerpt untouched, and reported the best case as if it were typical.
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DocumentStore } from '../src/store.ts'
import { build } from '../src/build.ts'
import { hashTree } from '../src/hash-tree.ts'
import { blogDocs } from '../example/blog/fixture.ts'
import { startMockCms } from '../src/cms-mock.ts'
import { httpCmsAdapter } from '../src/cms.ts'
import { sync } from '../src/sync.ts'
import type { TreeDigests } from '../src/hash-tree.ts'

const root = resolve(import.meta.dirname, '..')
const sitePath = join(root, 'example/blog/site.ts')
const SIZES = (process.env.ISSG_FANOUT_SIZES ?? '500,2000').split(',').map(Number)

function changedCount(a: TreeDigests, b: TreeDigests): { total: number; postPages: number } {
  let total = 0
  let postPages = 0
  for (const [p, h] of b) {
    if (a.get(p) !== h) {
      total++
      if (p.startsWith('posts/')) postPages++
    }
  }
  for (const [p] of a) if (!b.has(p)) total++
  return { total, postPages }
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]

console.log('# Edit fan-out through the example site templates\n')
console.log('One title edit, sampled across the corpus. Fan-out is bimodal; a single')
console.log('sample is not a measurement of it.\n')

for (const n of SIZES) {
  const work = mkdtempSync(join(root, '.tmp', 'fanout-'))
  try {
    const dbPath = join(work, 'content.db')
    const cms = await startMockCms(blogDocs({ posts: n, paras: 1 }))
    const store = new DocumentStore(dbPath)
    await sync(httpCmsAdapter({ baseUrl: cms.url }), store, { pageSize: 500 })
    store.close()
    await cms.close()

    const before = join(work, 'before')
    const built = await build({ site: sitePath, dbPath, outDir: before, clean: true, skipAssets: true })
    const baseline = hashTree(before)

    // Sample the newest posts densely -- they are where the hot mode lives,
    // because the related list is newest-first -- plus an even spread of the
    // rest, so the cold mode is represented in proportion to nothing in
    // particular. This is a shape probe, not an expectation over real edits.
    const idx = new Set<number>()
    for (let i = 0; i < Math.min(12, n); i++) idx.add(i)
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 12))) idx.add(i)
    const samples = [...idx].sort((a, b) => a - b)

    const results: { id: string; total: number; postPages: number }[] = []
    const reader = new DocumentStore(dbPath)
    const originals = new Map<string, string>()
    for (const d of reader.byType(['post']).get('post') ?? []) {
      originals.set(d.id, JSON.stringify(d))
    }
    reader.close()

    for (const i of samples) {
      const id = `post-${i}`
      const original = originals.get(id)
      if (original === undefined) continue
      const doc = { ...JSON.parse(original), title: 'EDITED TITLE MARKER' }

      const s = new DocumentStore(dbPath)
      s.upsertMany([{ id, type: 'post', revision: 'r2', updatedAt: 1, hash: `edited-${id}`, json: JSON.stringify(doc) }])
      s.prepareForReaders()
      s.close()

      const after = join(work, 'after')
      await build({ site: sitePath, dbPath, outDir: after, clean: true, skipAssets: true })
      results.push({ id, ...changedCount(baseline, hashTree(after)) })

      // Put it back, so each sample is measured against the same baseline rather
      // than against the accumulated edits of the ones before it.
      const r = new DocumentStore(dbPath)
      r.upsertMany([{ id, type: 'post', revision: 'r1', updatedAt: 0, hash: `restored-${id}`, json: original }])
      r.prepareForReaders()
      r.close()
    }

    const totals = results.map((r) => r.total)
    const hot = results.filter((r) => r.total > 50)
    console.log(`## ${n} posts — ${built.routes} routes, ${results.length} posts sampled\n`)
    console.log(`| statistic | routes changed | share of site |`)
    console.log(`|---|---:|---:|`)
    for (const [label, v] of [
      ['minimum', Math.min(...totals)],
      ['median', median(totals)],
      ['maximum', Math.max(...totals)],
    ] as [string, number][]) {
      console.log(`| ${label} | ${v} | ${((v / built.routes) * 100).toFixed(1)}% |`)
    }
    console.log(
      `\n${hot.length} of ${results.length} sampled posts land in the expensive mode ` +
      `(>50 routes): ${hot.map((h) => `${h.id}=${h.total}`).join(', ') || 'none'}.`,
    )
    console.log(
      `The cheap mode is ${median(totals)} routes and does not vary; the expensive mode is ` +
      `${hot.length ? Math.max(...totals) : 'n/a'} and is roughly the number of posts sharing a tag.\n`,
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log('## What this means for the Phase 0 gate\n')
console.log('The gate is untouched: it rests on a full rebuild being fast enough, and it is.')
console.log('What needs qualifying is the *fan-out* table. "Content edits are constant-cost,')
console.log('5-9 routes at any scale" is true of the harness templates and true of the median')
console.log('edit here — and false for the small set of posts that appear in other posts\'')
console.log('related lists, where one title edit rewrites a large share of the site.')
console.log('')
console.log('The transferable form: **fan-out is a property of the template set, not of the')
console.log('content model**, and a template that embeds one document into many pages creates')
console.log('a hot minority no average over documents will reveal. Measure the distribution.')
