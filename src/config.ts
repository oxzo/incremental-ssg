// The seam between the engine and a site.
//
// Phase 0/2b/2c ran against a hardcoded blog schema (post / author / tag / page /
// settings) baked into the benchmark. That was correct for measuring and wrong as
// a product: the engine has no business knowing what a "post" is. Everything the
// engine owns -- sync, store, the worker pool, writing, the asset cache -- is
// schema-blind. Everything that knows the schema (indexes, routes, templates)
// lives in a SiteConfig the build loads by path.
//
// The split is also what makes worker-pool rendering work: a worker is handed a
// module path, not a closure, so the site definition must be a module.
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import type { AssetEntry, Fmt } from './asset-cache.ts'

/** A content document as stored. Only `id` is guaranteed by the engine. */
export type Doc = { id: string } & Record<string, unknown>

/** Documents grouped by content type, in stable order (see DocumentStore.byType). */
export type DocsByType = Map<string, Doc[]>

/**
 * One output file. `kind` selects the template; everything else is the site's
 * own payload (a post id, a page number, a tag slug).
 */
export type Route = { kind: string; path: string } & Record<string, unknown>

/** Plain markdown, or markdown with syntax highlighting (~4.0x the per-page cost). */
export type MarkdownTier = 'plain' | 'highlight'

export type PictureOptions = {
  alt: string
  /** The `sizes` attribute. Omit only if the image is a fixed width. */
  sizes?: string
  /** Above-the-fold images should pass 'eager'; default is 'lazy'. */
  loading?: 'lazy' | 'eager'
  className?: string
}

/** What a template is given. Everything on it is synchronous by construction. */
export type RenderContext<S> = {
  /** The site index built once per build by SiteConfig.index. */
  site: S
  route: Route
  /** Markdown to HTML at the configured tier. */
  md(text: string): string
  /**
   * Look up a processed image by its path relative to the asset source dir.
   * Synchronous because assets are a *stage*, not a render-time side effect --
   * every source is encoded before the first route renders.
   */
  image(src: string): AssetEntry
  /** `<picture>` with srcset, a fallback `<img>`, and intrinsic width/height for CLS. */
  picture(src: string, opts: PictureOptions): string
  /** HTML-escape. Templates emit strings, so this is not optional hygiene. */
  esc(s: string): string
}

export type Template<S> = (ctx: RenderContext<S>, route: Route) => string

export type SiteAssets = {
  /** Directory scanned for source images. Every file in it is processed. */
  sources: string
  /**
   * The derivative cache. Content-addressed, so it is safe -- and valuable -- to
   * keep between builds: Phase 2c measured a warm build at 33ms against 4.23s
   * cold, and extrapolated 27s against 59min at 20,000 sources.
   *
   * Keep this OUTSIDE the site output directory. If it lives under `outDir`,
   * every `clean: true` build throws the cache away and pays the cold cost
   * again, which is the entire win of Phase 2c deleted by a convenience flag.
   */
  outDir: string
  /**
   * Where derivatives are placed inside the site output, hardlinked from the
   * cache (copied if the filesystem refuses). Links are metadata-only, so
   * publishing 160,000 derivatives costs approximately nothing.
   */
  publishTo?: string
  /** URL prefix the derivatives are served under. */
  publicPath?: string
  widths?: number[]
  formats?: Fmt[]
  quality?: Partial<Record<Fmt, number>>
  effort?: Partial<Record<Fmt, number>>
  concurrency?: number
  /**
   * Delete derivatives this build did not reference. Safe only because the asset
   * stage processes every source in `sources` -- a partial keep-set deletes live
   * files (Phase 2c). Off by default; the build turns it on only when it
   * completed the full scan.
   */
  gc?: boolean
}

export type SiteConfig<S> = {
  name: string
  /** Content types to pull and load. Documents of other types are ignored. */
  contentTypes: string[]
  /**
   * Build every index the templates need, once per build. Deliberately a hook
   * rather than something the engine derives: an accidentally O(N^2) tag filter
   * inside a template would make the full build look slow for reasons that have
   * nothing to do with the engine.
   */
  index(docs: DocsByType): S
  routes(site: S): Route[]
  /** Keyed by Route.kind. A route with no template is a build error, not a skip. */
  templates: Record<string, Template<S>>
  assets?: SiteAssets
  markdown?: MarkdownTier
  /**
   * 'enforce' (default) makes wall-clock and randomness throw inside the render
   * window, so "builds are diffable" is a property rather than a hope. See
   * src/determinism.ts for exactly what is and is not guarded.
   */
  determinism?: 'enforce' | 'off'
}

/** Identity helper; exists so a site module gets inference and arity checking. */
export function defineSite<S>(cfg: SiteConfig<S>): SiteConfig<S> {
  return cfg
}

/**
 * Load a site definition from a module path.
 *
 * By path rather than by value because render workers cannot be handed a
 * closure -- each thread imports the module itself. That constraint is the
 * reason SiteConfig is a module export instead of an object the caller builds.
 */
export async function loadSite(modulePath: string): Promise<SiteConfig<unknown>> {
  const abs = isAbsolute(modulePath) ? modulePath : resolve(modulePath)
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>
  const cfg = (mod.default ?? mod.site) as SiteConfig<unknown> | undefined
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`${modulePath} has no default export (or named export \`site\`) holding a SiteConfig`)
  }
  for (const field of ['name', 'contentTypes', 'index', 'routes', 'templates'] as const) {
    if (cfg[field] === undefined) throw new Error(`${modulePath}: SiteConfig is missing \`${field}\``)
  }
  return cfg
}
