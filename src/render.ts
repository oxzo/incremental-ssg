// Rendering: markdown, the template context, and route dispatch.
//
// Generalised from the Phase 0 harness, which hardcoded a switch over a blog's
// route kinds. The engine now dispatches on `Route.kind` into the site's own
// template map, so the only thing here that knows about content is nothing.
import MarkdownIt from 'markdown-it'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mimeOf } from './assets.ts'
import type { AssetManifest } from './assets.ts'
import type { AssetEntry } from './asset-cache.ts'
import type { MarkdownTier, PictureOptions, RenderContext, Route, SiteConfig } from './config.ts'

export type Renderer = { md: MarkdownIt; tier: MarkdownTier }

/**
 * Syntax highlighting is a consistent ~4.0x per-page multiplier (Phase 0), which
 * is why the tier is a site-level choice rather than always-on. Shiki's
 * highlighter is built once per thread; building it per page dominated
 * everything else in an early harness run.
 */
export async function createRenderer(tier: MarkdownTier = 'plain'): Promise<Renderer> {
  if (tier === 'plain') {
    return { md: new MarkdownIt({ html: true, linkify: true }), tier }
  }
  const { createHighlighter } = await import('shiki')
  const hl = await createHighlighter({ themes: ['github-dark'], langs: ['ts'] })
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, lang) =>
      lang === 'ts' ? hl.codeToHtml(code, { lang: 'ts', theme: 'github-dark' }) : '',
  })
  return { md, tier }
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class MissingAssetError extends Error {
  constructor(key: string, available: number) {
    super(
      `ctx.image(${JSON.stringify(key)}) -- no such source. The asset stage ` +
      `processed ${available} source(s); keys are paths relative to the ` +
      `configured asset source directory, e.g. "hero/banner.jpg". A typo here ` +
      `must fail the build rather than emit a broken <img>.`)
    this.name = 'MissingAssetError'
  }
}

export class MissingTemplateError extends Error {
  constructor(kind: string, known: string[]) {
    super(
      `No template for route kind ${JSON.stringify(kind)}. Known kinds: ` +
      `${known.join(', ') || '(none)'}. A route with no template is a build ` +
      `error, not a silently skipped page.`)
    this.name = 'MissingTemplateError'
  }
}

/**
 * Build the per-route context.
 *
 * The image helpers close over the manifest, so `ctx.image` is a plain object
 * lookup -- no I/O, no await, no chance of two routes racing to encode the same
 * source.
 */
export function createContextFactory<S>(
  site: S,
  renderer: Renderer,
  manifest: AssetManifest,
): (route: Route) => RenderContext<S> {
  const count = Object.keys(manifest).length

  const image = (src: string): AssetEntry => {
    const found = manifest[src]
    if (!found) throw new MissingAssetError(src, count)
    return found
  }

  const picture = (src: string, opts: PictureOptions): string => {
    const e = image(src)
    const formats = Object.keys(e.srcset).filter((f) => e.srcset[f] !== '')
    const sizes = opts.sizes ? ` sizes="${esc(opts.sizes)}"` : ''
    const cls = opts.className ? ` class="${esc(opts.className)}"` : ''
    // Intrinsic dimensions, so the browser reserves the right box before the
    // bytes arrive. Omitted rather than zeroed when sharp could not read them --
    // width="0" is worse than no width at all.
    const dims = e.width > 0 && e.height > 0 ? ` width="${e.width}" height="${e.height}"` : ''
    const img =
      `<img src="${esc(e.fallback.url)}"` +
      (formats.length > 0 ? ` srcset="${esc(e.srcset[formats[formats.length - 1]])}"${sizes}` : '') +
      ` alt="${esc(opts.alt)}"${dims}${cls}` +
      ` loading="${opts.loading ?? 'lazy'}" decoding="async">`

    // One format needs no <picture>; the element exists to let the browser pick.
    if (formats.length <= 1) return img
    const sources = formats
      .slice(0, -1)
      .map((f) => `<source type="${mimeOf(f)}" srcset="${esc(e.srcset[f])}"${sizes}>`)
      .join('')
    return `<picture>${sources}${img}</picture>`
  }

  return (route: Route): RenderContext<S> => ({
    site,
    route,
    md: (text: string) => renderer.md.render(text),
    image,
    picture,
    esc,
  })
}

export function renderRoute<S>(
  cfg: SiteConfig<S>,
  ctx: RenderContext<S>,
  route: Route,
): string {
  const template = cfg.templates[route.kind]
  if (!template) throw new MissingTemplateError(route.kind, Object.keys(cfg.templates))
  return template(ctx, route)
}

/** Directory-style routes become `index.html`; anything else is written verbatim. */
export function outputPath(outDir: string, route: string): string {
  return route.endsWith('/') ? join(outDir, route, 'index.html') : join(outDir, route)
}

export function writeOut(outDir: string, route: string, html: string): number {
  const p = outputPath(outDir, route)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, html)
  return Buffer.byteLength(html)
}
