import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { AssetCache, defaultConfig, type AssetConfig } from '../src/asset-cache.ts'

let root: string
let srcDir: string

/** Deterministic, non-uniform source so encoders can't collapse it to nothing. */
async function makeImage(path: string, w: number, h: number, seed = 1) {
  const buf = Buffer.allocUnsafe(w * h * 3)
  let a = (seed * 2654435761) >>> 0
  for (let i = 0; i < buf.length; i += 3) {
    a = (a * 1664525 + 1013904223) >>> 0
    buf[i] = (a >>> 16) & 0xff
    buf[i + 1] = (a >>> 8) & 0xff
    buf[i + 2] = a & 0xff
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path)
}

const cfg = (outDir: string, over: Partial<AssetConfig> = {}): AssetConfig =>
  ({ ...defaultConfig(outDir), widths: [100, 200], formats: ['webp'], concurrency: 2, ...over })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'assetcache-'))
  srcDir = join(root, 'src')
  await mkdtemp(join(root, 'x-')) // ensure root exists before nested mkdir
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .png().toFile(join(root, '.keep.png')).catch(() => {})
  const { mkdir } = await import('node:fs/promises')
  await mkdir(srcDir, { recursive: true })
})
after(async () => { await rm(root, { recursive: true, force: true }) })

describe('AssetCache', () => {
  test('cold build encodes, warm build is all hits and byte-identical', async () => {
    const out = join(root, 'o1')
    const src = join(srcDir, 'a.png')
    await makeImage(src, 300, 200)

    const cold = new AssetCache(cfg(out))
    const e1 = await cold.process(src)
    assert.equal(cold.stats.misses, 2, 'two widths encoded')
    assert.equal(cold.stats.hits, 0)
    const bytes1 = await Promise.all(e1.derivatives.map((d) => readFile(d.file)))

    const warm = new AssetCache(cfg(out))
    const e2 = await warm.process(src)
    assert.equal(warm.stats.misses, 0, 'nothing re-encoded')
    assert.equal(warm.stats.hits, 2)
    assert.equal(warm.stats.msEncoding, 0)

    assert.deepEqual(e2.derivatives.map((d) => d.file), e1.derivatives.map((d) => d.file))
    const bytes2 = await Promise.all(e2.derivatives.map((d) => readFile(d.file)))
    bytes1.forEach((b, i) => assert.ok(b.equals(bytes2[i]), 'derivative bytes unchanged'))
  })

  test('editing the source is a miss, not a stale hit', async () => {
    const out = join(root, 'o2')
    const src = join(srcDir, 'b.png')
    await makeImage(src, 300, 200, 1)
    const first = new AssetCache(cfg(out))
    const e1 = await first.process(src)

    await makeImage(src, 300, 200, 2) // different pixels, same dimensions
    const second = new AssetCache(cfg(out))
    const e2 = await second.process(src)

    assert.equal(second.stats.hits, 0, 'changed content must not hit')
    assert.equal(second.stats.misses, 2)
    assert.notEqual(e2.hash, e1.hash)
    assert.notDeepEqual(e2.derivatives.map((d) => d.file), e1.derivatives.map((d) => d.file))
  })

  // The failure this guards against: flipping an encoder setting and silently
  // serving derivatives no current config can reproduce.
  for (const [label, over] of [
    ['quality', { quality: { webp: 30 } }],
    ['effort', { effort: { webp: 0 } }],
  ] as [string, Partial<AssetConfig>][]) {
    test(`changing ${label} is a miss, not a stale hit`, async () => {
      const out = join(root, `o3-${label}`)
      const src = join(srcDir, `c-${label}.png`)
      await makeImage(src, 300, 200)

      const a = new AssetCache(cfg(out))
      const e1 = await a.process(src)
      const b = new AssetCache(cfg(out, over))
      const e2 = await b.process(src)

      assert.equal(b.stats.hits, 0, `${label} change must invalidate`)
      const f1 = new Set(e1.derivatives.map((d) => d.file))
      for (const d of e2.derivatives) assert.ok(!f1.has(d.file), 'must not reuse old derivative')
    })
  }

  // Width is per-derivative, not global: reusing an unchanged width is correct
  // and desirable, so only the changed width may miss.
  test('changing the width list re-encodes only the widths that changed', async () => {
    const out = join(root, 'o3-width')
    const src = join(srcDir, 'c-width.png')
    await makeImage(src, 300, 200)

    const a = new AssetCache(cfg(out, { widths: [100, 200] }))
    const e1 = await a.process(src)
    const b = new AssetCache(cfg(out, { widths: [100, 250] }))
    const e2 = await b.process(src)

    assert.equal(b.stats.hits, 1, 'width 100 is unchanged and must be reused')
    assert.equal(b.stats.misses, 1, 'width 250 is new and must be encoded')
    assert.deepEqual(e2.derivatives.map((d) => d.width).sort((x, y) => x - y), [100, 250])

    const kept = e1.derivatives.find((d) => d.width === 100)!
    assert.ok(e2.derivatives.some((d) => d.file === kept.file), 'reuses the identical derivative')
    // The dropped 200px derivative is now an orphan, and gc is what reclaims it.
    b.seal()
    assert.equal((await b.gc()).deleted, 1)
  })

  test('every emitted derivative is a complete, decodable image of the right width', async () => {
    const out = join(root, 'o4')
    const src = join(srcDir, 'd.png')
    await makeImage(src, 500, 400)
    const c = new AssetCache(cfg(out, { widths: [100, 200, 400] }))
    const e = await c.process(src)

    for (const d of e.derivatives) {
      const m = await sharp(await readFile(d.file)).metadata()
      assert.equal(m.width, d.width, 'decoded width matches claimed width')
      assert.equal(m.format, 'webp')
    }
    const left = await readdir(out)
    assert.ok(!left.some((f) => f.includes('.tmp-')), 'no temp files survive a build')
  })

  test('never upscales past the intrinsic width', async () => {
    const out = join(root, 'o5')
    const src = join(srcDir, 'small.png')
    await makeImage(src, 150, 100)
    const c = new AssetCache(cfg(out, { widths: [100, 200, 1600] }))
    const e = await c.process(src)

    assert.deepEqual(e.derivatives.map((d) => d.width).sort((x, y) => x - y), [100])
    const m = await sharp(await readFile(e.derivatives[0].file)).metadata()
    assert.equal(m.width, 100)
  })

  test('a source smaller than every configured width still emits one derivative', async () => {
    const out = join(root, 'o6')
    const src = join(srcDir, 'tiny.png')
    await makeImage(src, 80, 60)
    const c = new AssetCache(cfg(out, { widths: [100, 200] }))
    const e = await c.process(src)
    assert.equal(e.derivatives.length, 1)
    assert.equal(e.derivatives[0].width, 80)
  })

  test('concurrent processing of the same source yields a valid file', async () => {
    const out = join(root, 'o7')
    const src = join(srcDir, 'race.png')
    await makeImage(src, 300, 200)
    // Four writers, not two. With two, a temp-filename collision between
    // instances only fails about half the time -- which is how the per-instance
    // counter bug survived Phase 2c and only surfaced once the suite got busier.
    const [x, y] = await Promise.all([
      new AssetCache(cfg(out)).process(src),
      new AssetCache(cfg(out)).process(src),
      new AssetCache(cfg(out)).process(src),
      new AssetCache(cfg(out)).process(src),
    ])
    assert.deepEqual(x.derivatives.map((d) => d.file), y.derivatives.map((d) => d.file))
    for (const d of x.derivatives) {
      const m = await sharp(await readFile(d.file)).metadata()
      assert.equal(m.width, d.width, 'atomic rename left a complete file')
    }
    assert.ok(!(await readdir(out)).some((f) => f.includes('.tmp-')))
  })

  test('gc deletes orphans and keeps everything referenced', async () => {
    const out = join(root, 'o8')
    const src = join(srcDir, 'g.png')
    await makeImage(src, 300, 200, 1)
    await new AssetCache(cfg(out)).process(src)
    const afterFirst = await readdir(out)
    assert.equal(afterFirst.length, 2)

    await makeImage(src, 300, 200, 2) // orphans the first two
    const c2 = new AssetCache(cfg(out))
    const e2 = await c2.process(src)
    assert.equal((await readdir(out)).length, 4, 'orphans still present before gc')

    c2.seal()
    const g = await c2.gc()
    assert.equal(g.deleted, 2)
    const left = (await readdir(out)).sort()
    assert.deepEqual(left, e2.derivatives.map((d) => d.file.split('/').pop()!).sort())
  })

  test('gc leaves another build\'s temp files alone', async () => {
    const out = join(root, 'o9')
    const src = join(srcDir, 'h.png')
    await makeImage(src, 300, 200)
    const c = new AssetCache(cfg(out))
    await c.process(src)
    await writeFile(join(out, 'other.tmp-999-0'), 'partial')
    c.seal()
    const g = await c.gc()
    assert.equal(g.deleted, 0)
    assert.ok((await readdir(out)).includes('other.tmp-999-0'))
  })

  // Documents a deliberate trade-off rather than asserting a property we have:
  // derivative names embed the source basename for debuggability, so a rename
  // re-encodes. Content is still the cache key; the filename is not path-derived.
  test('renaming the source re-encodes (basename is part of the name)', async () => {
    const out = join(root, 'o10')
    const a = join(srcDir, 'named-a.png')
    const b = join(srcDir, 'named-b.png')
    await makeImage(a, 300, 200)
    const c1 = new AssetCache(cfg(out))
    const e1 = await c1.process(a)
    await rename(a, b)
    const c2 = new AssetCache(cfg(out))
    const e2 = await c2.process(b)
    assert.equal(c2.stats.hits, 0)
    assert.equal(e2.hash, e1.hash, 'content hash is unchanged; only the label differs')
  })

  test('srcset is width-sorted and fallback is the largest', async () => {
    const out = join(root, 'o11')
    const src = join(srcDir, 's.png')
    await makeImage(src, 900, 600)
    const c = new AssetCache(cfg(out, { widths: [200, 400, 800], formats: ['webp'] }))
    const e = await c.process(src)
    const widths = e.srcset.webp.split(', ').map((s) => Number(s.match(/(\d+)w$/)![1]))
    assert.deepEqual(widths, [200, 400, 800])
    assert.equal(e.fallback.width, 800)
    assert.equal(e.width, 900)
    assert.equal(e.height, 600)
  })

  test('gc refuses to run on an unsealed instance', async () => {
    const out = join(root, 'o12')
    const src = join(srcDir, 'seal.png')
    await makeImage(src, 300, 200)
    const c = new AssetCache(cfg(out))
    await c.process(src)
    await assert.rejects(() => c.gc(), /requires seal\(\)/)
    assert.equal((await readdir(out)).length, 2, 'nothing deleted')
  })

  // The Phase 2c bench hit exactly this: gc against a cache that had not seen
  // every source deleted live derivatives.
  test('gc refuses a sweep that would delete most of the directory', async () => {
    const out = join(root, 'o13')
    const names = ['many-a.png', 'many-b.png', 'many-c.png'].map((n) => join(srcDir, n))
    for (const [i, p] of names.entries()) await makeImage(p, 300, 200, i + 1)
    const full = new AssetCache(cfg(out))
    for (const p of names) await full.process(p)
    assert.equal((await readdir(out)).length, 6)

    const partial = new AssetCache(cfg(out))
    await partial.process(names[0])   // forgot b and c -- a partial build
    partial.seal()
    // 4 of 6 doomed = 67%, over the limit.
    await assert.rejects(() => partial.gc(), /over the 50% limit/)
    assert.equal((await readdir(out)).length, 6, 'live derivatives survived')

    const forced = await partial.gc({ force: true })
    assert.equal(forced.deleted, 4, 'force still allows the sweep')
  })
})
