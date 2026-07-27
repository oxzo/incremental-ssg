// Sample content for the example site: a deterministic mini-corpus and real
// image files. Used by the demo and by the test suite, so the thing under test
// is the same content a reader can run by hand.
//
// Nothing here calls Date.now() or Math.random(). Both would defeat the point:
// the corpus has to be byte-identical between runs for "two builds produce
// identical output" to mean anything.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { MockDoc } from '../../src/cms-mock.ts'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = `system content build cache render page route document query invalidate
dependency graph fingerprint hash pipeline template layout archive index deploy edge
static incremental publish revision webhook consistency latency throughput schema`
  .split(/\s+/)
  .filter(Boolean)

const words = (rnd: () => number, n: number) =>
  Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')

const para = (rnd: () => number) =>
  Array.from({ length: 3 }, () => {
    const s = words(rnd, 10)
    return s.charAt(0).toUpperCase() + s.slice(1) + '.'
  }).join(' ')

function postBody(rnd: () => number, paras: number, code: boolean): string {
  const parts = [para(rnd), `## ${words(rnd, 3)}`]
  for (let i = 1; i < Math.max(1, paras); i++) parts.push(para(rnd))
  if (code) parts.push('```ts\n' + CODE_SAMPLE + '\n```')
  return parts.join('\n\n') + '\n'
}

/** Fixed epoch, never Date.now() -- corpora must be byte-identical across runs. */
export const EPOCH = 1_700_000_000_000

export type CorpusOptions = {
  posts?: number
  tags?: number
  authors?: number
  pages?: number
  seed?: number
  /** Assign these image keys round-robin as post heroes. */
  heroes?: string[]
  /**
   * Paragraphs per post body. The default keeps the demo and the test suite
   * fast; the Phase 0 benchmark corpus is ~900 words, which is roughly 30.
   */
  paras?: number
  /**
   * Include a fenced code block, so the 'highlight' markdown tier has something
   * to highlight. Without one the heavy tier costs the same as the light tier
   * and any comparison against Phase 0 is measuring the wrong thing.
   */
  code?: boolean
}

const CODE_SAMPLE = `export function fingerprint(deps: Dep[], code: string): string {
  const h = createHash('sha256')
  for (const d of deps.sort((a, b) => a.key < b.key ? -1 : 1)) {
    h.update(d.key); h.update('\\0'); h.update(d.hash); h.update('\\0')
  }
  h.update(code)
  return h.digest('hex').slice(0, 16)
}`

/** CMS-shaped documents. Fed through the mock server and the real sync driver. */
export function blogDocs(opts: CorpusOptions = {}): MockDoc[] {
  const nPosts = opts.posts ?? 25
  const nTags = opts.tags ?? 5
  const nAuthors = opts.authors ?? 3
  const nPages = opts.pages ?? 2
  const heroes = opts.heroes ?? []
  const rnd = mulberry32(opts.seed ?? 7)
  const out: MockDoc[] = []

  const put = (type: string, doc: Record<string, unknown> & { id: string }, updatedAt: number) => {
    out.push({ type, doc: { ...doc, updated_at: updatedAt, rev: `r1-${doc.id}` } })
  }

  for (let i = 0; i < nAuthors; i++) {
    put('author', { id: `author-${i}`, slug: `author-${i}`, name: words(rnd, 2), bio: para(rnd) }, EPOCH)
  }
  for (let i = 0; i < nTags; i++) {
    put('tag', { id: `tag-${i}`, slug: `tag-${i}`, name: words(rnd, 1) }, EPOCH)
  }
  for (let i = 0; i < nPages; i++) {
    put('page', { id: `page-${i}`, slug: `page-${i}`, title: words(rnd, 3), body: para(rnd) }, EPOCH)
  }
  for (let i = 0; i < nPosts; i++) {
    const tags = new Set<string>()
    while (tags.size < 2) tags.add(`tag-${Math.floor(rnd() * nTags)}`)
    const doc: Record<string, unknown> & { id: string } = {
      id: `post-${i}`,
      slug: `post-${i}`,
      title: words(rnd, 5),
      author: `author-${Math.floor(rnd() * nAuthors)}`,
      tags: [...tags],
      // Descending: post-0 is newest, so a new post inserts at the top of every
      // archive -- the pagination-shift case Phase 0 measured.
      date: EPOCH - i * 3_600_000,
      body: postBody(rnd, opts.paras ?? 2, opts.code ?? false),
    }
    if (heroes.length > 0) doc.hero = heroes[i % heroes.length]
    put('post', doc, EPOCH - i * 3_600_000)
  }

  put('settings', {
    id: 'settings',
    siteName: 'Fixture Site',
    nav: [{ label: 'about', href: '/pages/page-0/' }],
    footer: para(rnd),
  }, EPOCH)

  return out
}

/**
 * Real image files, deterministic in content.
 *
 * 900x600 on purpose: with widths [400, 800, 1200, 1600] configured, two are
 * below the intrinsic width and two above, so every run exercises the
 * never-upscale filter rather than only the happy path.
 */
export async function makeImages(dir: string, names: string[]): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (let i = 0; i < names.length; i++) {
    const p = join(dir, names[i])
    await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: (i * 60) % 256, g: (i * 37 + 20) % 256, b: (i * 91 + 40) % 256 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(p)
    written.push(names[i])
  }
  return written
}
