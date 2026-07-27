import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  createContextFactory, createRenderer, esc, outputPath, renderRoute,
  MissingAssetError, MissingTemplateError,
} from '../src/render.ts'
import type { AssetManifest, ManifestEntry } from '../src/assets.ts'
import type { RenderContext, Route, SiteConfig } from '../src/config.ts'

type Index = { title: string }

const renderer = await createRenderer('plain')

function entry(key: string, formats: string[], width = 900, height = 600): ManifestEntry {
  const derivatives = formats.flatMap((f) =>
    [400, 800].map((w) => ({
      url: `/assets/img/${key}-${w}.${f}`, file: `/cache/${key}-${w}.${f}`,
      width: w, format: f as never, bytes: 100,
    })))
  const srcset: Record<string, string> = {}
  for (const f of formats) {
    srcset[f] = derivatives.filter((d) => d.format === (f as never))
      .map((d) => `${d.url} ${d.width}w`).join(', ')
  }
  const last = formats[formats.length - 1]
  return {
    key, src: `/src/${key}`, hash: 'abc', width, height, derivatives, srcset,
    fallback: derivatives.filter((d) => d.format === (last as never)).slice(-1)[0],
  }
}

const ctxFor = (manifest: AssetManifest) =>
  createContextFactory<Index>({ title: 'T' }, renderer, manifest)({ kind: 'home', path: '/' })

describe('esc', () => {
  test('escapes the four characters that break attributes and elements', () => {
    assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})

describe('outputPath', () => {
  test('directory routes become index.html', () => {
    assert.equal(outputPath('/out', '/posts/a/'), '/out/posts/a/index.html')
    assert.equal(outputPath('/out', '/'), '/out/index.html')
  })
  test('file routes are written verbatim', () => {
    assert.equal(outputPath('/out', '/sitemap.xml'), '/out/sitemap.xml')
  })
})

describe('render context', () => {
  test('md renders markdown', () => {
    const ctx = ctxFor({})
    assert.match(ctx.md('# hi'), /<h1>hi<\/h1>/)
  })

  test('image() returns the manifest entry', () => {
    const m: AssetManifest = { 'a.jpg': entry('a.jpg', ['webp']) }
    assert.equal(ctxFor(m).image('a.jpg').width, 900)
  })

  test('image() on an unknown key fails the build rather than emitting a broken img', () => {
    const ctx = ctxFor({ 'a.jpg': entry('a.jpg', ['webp']) })
    assert.throws(() => ctx.image('typo.jpg'), MissingAssetError)
    assert.throws(() => ctx.image('typo.jpg'), /processed 1 source/)
  })
})

describe('picture()', () => {
  test('two formats emit <picture> with a <source> for all but the fallback', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['avif', 'webp']) })
      .picture('a.jpg', { alt: 'A photo', sizes: '100vw' })
    assert.match(html, /^<picture>/)
    assert.equal((html.match(/<source /g) ?? []).length, 1, 'avif gets a source; webp is the img')
    assert.match(html, /<source type="image\/avif" srcset="[^"]*400w[^"]*800w" sizes="100vw">/)
    assert.match(html, /<img src="\/assets\/img\/a\.jpg-800\.webp"/)
  })

  test('three formats emit two sources, best first', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['avif', 'webp', 'jpeg']) })
      .picture('a.jpg', { alt: 'x' })
    const types = [...html.matchAll(/<source type="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(types, ['image/avif', 'image/webp'])
  })

  test('a single format emits a bare <img>, since <picture> would pick nothing', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['webp']) }).picture('a.jpg', { alt: 'x' })
    assert.equal(html.includes('<picture>'), false)
    assert.match(html, /^<img /)
    assert.match(html, /srcset="[^"]*400w/)
  })

  test('intrinsic dimensions are emitted for CLS', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['webp'], 1600, 900) }).picture('a.jpg', { alt: 'x' })
    assert.match(html, / width="1600" height="900"/)
  })

  test('dimensions are omitted rather than zeroed when sharp could not read them', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['webp'], 0, 0) }).picture('a.jpg', { alt: 'x' })
    assert.equal(html.includes('width="0"'), false)
    assert.equal(html.includes(' width='), false)
  })

  test('alt and class are escaped, and loading defaults to lazy', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['webp']) })
      .picture('a.jpg', { alt: 'a "quoted" <tag>', className: 'hero' })
    assert.match(html, /alt="a &quot;quoted&quot; &lt;tag&gt;"/)
    assert.match(html, /class="hero"/)
    assert.match(html, /loading="lazy"/)
  })

  test('an above-the-fold image can opt into eager loading', () => {
    const html = ctxFor({ 'a.jpg': entry('a.jpg', ['webp']) })
      .picture('a.jpg', { alt: 'x', loading: 'eager' })
    assert.match(html, /loading="eager"/)
  })
})

describe('renderRoute', () => {
  const cfg = {
    templates: {
      home: (ctx: RenderContext<Index>) => `<h1>${ctx.esc(ctx.site.title)}</h1>`,
    },
  } as unknown as SiteConfig<Index>

  test('dispatches on route kind', () => {
    const route: Route = { kind: 'home', path: '/' }
    assert.equal(renderRoute(cfg, ctxFor({}) as RenderContext<Index>, route), '<h1>T</h1>')
  })

  test('a route with no template is a build error, not a skipped page', () => {
    const route: Route = { kind: 'orphan', path: '/orphan/' }
    assert.throws(() => renderRoute(cfg, ctxFor({}) as RenderContext<Index>, route), MissingTemplateError)
    assert.throws(() => renderRoute(cfg, ctxFor({}) as RenderContext<Index>, route), /Known kinds: home/)
  })
})
