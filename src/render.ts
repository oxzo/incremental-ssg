// Rendering: markdown, the template context, and route dispatch.
//
// Generalised from the Phase 0 harness, which hardcoded a switch over a blog's
// route kinds. The engine now dispatches on `Route.kind` into the site's own
// template map, so the only thing here that knows about content is nothing.
import MarkdownIt from 'markdown-it'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { mimeOf } from './assets.ts'
import { allowNondeterministic } from './determinism.ts'
import type { AssetManifest } from './assets.ts'
import type { AssetEntry } from './asset-cache.ts'
import type { MarkdownTier, PictureOptions, RenderContext, Route, SiteConfig } from './config.ts'

export type Renderer = { md: MarkdownIt; tier: MarkdownTier }

/**
 * Syntax highlighting is a consistent ~4.0x per-page multiplier (Phase 0), which
 * is why the tier is a site-level choice rather than always-on. Shiki's
 * highlighter is built once per thread; building it per page dominated
 * everything else in an early harness run.
 *
 * `tokenizeTimeLimit: 0` is load-bearing and must not be tidied away. Shiki
 * defaults it to 500ms *per line*, and the underlying tokenizer implements that
 * budget by reading the wall clock and, on expiry, returning a partial token
 * stream and carrying on. So a sufficiently pathological line yields different
 * HTML depending on how loaded the machine was at that instant -- and this build
 * runs ten workers competing for cores, which is exactly when it would trigger.
 *
 * That defect would be close to undebuggable from its symptom: a handful of
 * pages differing between two builds of identical content, appearing and
 * disappearing with machine load, surfacing to a user as a deploy diff that
 * re-uploads pages nobody edited. The determinism guard caught it on the first
 * highlighted build ever run through the product, which is the argument for the
 * guard.
 *
 * Setting it to 0 disables the bailout, so a pathological line takes as long as
 * it takes. That is the right trade here and it is the project's stated one: a
 * build whose failure mode is *slow* beats one whose failure mode is *silently
 * wrong*.
 *
 * The exemption is then needed because the tokenizer stamps its start time
 * *before* testing whether the budget is enabled, so the call happens even
 * though its value is now dead. Verified by reading the vendored tokenizer: the
 * timestamp's only consumer sits inside a `timeLimit !== 0` branch.
 *
 * Be precise about what protects this, because it is tempting to over-credit
 * the test suite. The byte-identity test catches a *deterministic* divergence
 * in this path and will fail loudly if an upgrade changes the emitted markup.
 * It cannot catch a reinstated time budget: that bailout only fires on a
 * pathologically slow line, so a green run is one sample of a race — the same
 * weak evidence a passing concurrency test provides. What actually protects
 * this is the explicit `tokenizeTimeLimit: 0` and this comment. Re-read the
 * tokenizer when shiki is upgraded; do not infer from a green suite that the
 * budget is still off.
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
      lang === 'ts'
        ? allowNondeterministic(() =>
            hl.codeToHtml(code, { lang: 'ts', theme: 'github-dark', tokenizeTimeLimit: 0 }))
        : '',
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

/**
 * A route path that cannot be written, and why.
 *
 * Terminal by nature rather than by the rails' classification: the route came
 * out of the site's own `routes()`, so re-running produces it again.
 */
export class UnsafeRouteError extends Error {
  constructor(route: string, index: number, why: string) {
    super(
      `route ${index} (${JSON.stringify(route)}) ${why}. Route paths are ` +
      `site-absolute URL paths ("/posts/a/"), and the engine writes one file per ` +
      `route inside the output directory -- so a path that escapes it, or that ` +
      `two routes share, is a write this build cannot account for.`)
    this.name = 'UnsafeRouteError'
  }
}

/**
 * Where every route writes, proven to be inside `outDir`, plus the identity of
 * the set.
 *
 * Two problems, one pass, because both need the whole route list resolved once
 * and neither can be answered per route.
 *
 * **Containment.** `outputPath` joins a route straight into `outDir` and writes
 * the result. Route paths come from the site's `routes()`, which interpolates
 * CMS-derived slugs and ids -- so a slug containing `..` is a filesystem write
 * primitive, reachable by anyone who can edit a document. Nothing downstream
 * catches it: the file lands outside the tree, the seal never sees it, and the
 * deploy diff never hears about it. This is the codebase's recurring hazard
 * rotated ninety degrees -- not a set assumed complete, but a path assumed
 * in-tree.
 *
 * **Identity.** Every render worker resolves the site independently so their
 * slices line up by construction, which only works if they all resolve the
 * *same* site. The parent compared route counts, and two workers can resolve
 * different route sets of equal length -- rendering slices of incompatible sites
 * and both reporting success. The digest here is what they actually compare.
 *
 * The digest covers each route's kind and path: which file, from which template.
 * It deliberately does not cover the data a route carries, for cost (the sitemap
 * route holds every other route's path, so hashing route data would hash the
 * site twice) and because a worker resolving the same paths with different data
 * is a determinism failure, which the determinism window and the byte-identity
 * test already cover on their own axis.
 */
export type OutputPlan = {
  /** Absolute output file per route, in route order. */
  paths: string[]
  /** Identity of the resolved route set; every worker must produce the same one. */
  digest: string
}

export function planOutputs(outDir: string, routes: Route[]): OutputPlan {
  const root = resolve(outDir)
  // A prefix test needs the separator, or `/out-old` passes as being inside
  // `/out`. Compared against `root + sep` for exactly that reason.
  const prefix = root.endsWith(sep) ? root : root + sep
  const paths: string[] = []
  const firstUse = new Map<string, number>()
  const h = createHash('sha256')

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]
    const p = route?.path
    const bad = (why: string): never => { throw new UnsafeRouteError(String(p), i, why) }

    if (typeof p !== 'string' || p === '') bad('is not a non-empty string')
    // A NUL truncates the path at the syscall boundary, so the string checked
    // here and the path opened are different. Not a containment threat, and the
    // reason is worth stating rather than leaving as an implied one: truncation
    // can only shorten, and a shorter path under a validated prefix is still
    // under it. Refused because a route naming a file the filesystem will not
    // name is a mistake, and refusing it here reports the route index where
    // letting it reach writeFileSync reports only a mangled path.
    if (p.includes('\0')) bad('contains a NUL byte')
    // Rejected rather than normalised. A backslash is a separator on Windows and
    // an ordinary filename character on POSIX, so accepting it means one site
    // emits a different tree per platform. On POSIX this check is the only thing
    // that stops "/..\\..\\x" -- it resolves to a single in-tree filename here
    // and to a traversal there, and a build that passes on the dev box would be
    // the one that escapes in CI.
    if (p.includes('\\')) bad('contains a backslash')

    // The invariant, checked before the spelling rules below rather than after,
    // so it is the thing that actually rejects an escape and the rules stay
    // independently meaningful. Ordered the other way, ".." caught every real
    // traversal first and this line became unreachable defence -- present,
    // untestable, and impossible to tell apart from working.
    const full = resolve(outputPath(root, p))
    if (full === root || !full.startsWith(prefix)) bad('resolves outside the output directory')

    // Reached only by a ".." that stays inside the tree, like "/posts/../a.html".
    // Refused anyway: it names a file it does not look like, and two routes that
    // spell one output differently collide below with no way to tell which was
    // intended.
    if (p.split('/').includes('..')) bad('contains a ".." segment')

    const prior = firstUse.get(full)
    if (prior !== undefined) {
      bad(
        `writes the same file as route ${prior} (${JSON.stringify(routes[prior].path)}). ` +
        `One would silently overwrite the other while both counted as rendered`)
    }
    firstUse.set(full, i)
    paths.push(full)
    h.update(`${route.kind} ${p} `)
  }

  return { paths, digest: h.digest('hex').slice(0, 16) }
}

/** Write one already-planned output path. */
export function writeFile(path: string, html: string): number {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html)
  return Buffer.byteLength(html)
}

// `writeOut(outDir, route, html)` used to live here and is gone deliberately. It
// derived the output path from the route a second time, at write time, so the
// path that was validated and the path that was written came from two calls that
// could drift. Everything now writes a planned path, so a route becomes a file in
// exactly one place. bench/render-core.ts keeps its own copy -- that is the Phase
// 0 harness, which is deliberately not the product.
