// Serve the built site out of the R2 bucket the deploy diff writes to.
//
// This is the only piece of the demo that is not the product: `cli serve`
// publishes to R2 exactly as it would to S3, and this Worker is the reader in
// front of it, because an R2 bucket has no public URL of its own without a
// custom domain on Cloudflare.
//
// GET only, deliberately. Cloudflare's docs warn that a Worker fronting R2 must
// define its own authorization logic -- that warning is about *mutations*. A
// handler that implements nothing but GET exposes precisely what a public bucket
// would expose and nothing else, so the authorization question has one answer:
// everything in this bucket is already meant to be public, because it is a
// static site.

/**
 * The three members of an R2 object this Worker touches, declared here rather
 * than pulled from @cloudflare/workers-types.
 *
 * Not a preference. test/demo-worker.test.ts imports `keysFor` and
 * `cacheControl` from this file to check the path mapping under Node, so the
 * file is type-checked in two worlds: the Workers runtime, where R2Bucket is
 * ambient, and the Node project, where it is not and where loading the Workers
 * globals would collide with Node's own Request/Response/fetch. A structural
 * declaration of exactly what is used satisfies both and overstates neither --
 * and if R2's shape drifts, `wrangler deploy` type-checks against the real ones.
 */
export interface R2ObjectBody {
  body: ReadableStream
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

export interface SiteBucket {
  get(key: string): Promise<R2ObjectBody | null>
}

export interface Env {
  SITE: SiteBucket
}

/**
 * Map a request path to an object key.
 *
 * The build emits directory-style routes -- `/posts/post-7/` is
 * `posts/post-7/index.html` on disk -- so the index resolution lives here rather
 * than in the build. Three shapes, in the order they are tried:
 *
 *   /                 -> index.html
 *   /posts/post-7/    -> posts/post-7/index.html
 *   /feed.xml         -> feed.xml
 *
 * A path with no extension and no trailing slash is the ambiguous one; it gets
 * the index treatment too, then a redirect, so `/posts/post-7` and
 * `/posts/post-7/` do not become two URLs serving one page.
 */
export function keysFor(pathname: string): { key: string; redirectTo?: string } {
  const path = decodeURIComponent(pathname).replace(/^\/+/, '')

  if (path === '') return { key: 'index.html' }
  if (path.endsWith('/')) return { key: `${path}index.html` }

  // Has a file extension in the last segment: serve it directly.
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (last.includes('.')) return { key: path }

  // Extensionless: it is a route, and its canonical form has a trailing slash.
  return { key: `${path}/index.html`, redirectTo: `/${path}/` }
}

/**
 * Cache-Control by kind, and the split is a property of the build rather than a
 * guess.
 *
 * Asset derivatives are content-addressed -- the hash is in the filename, so a
 * changed image is a *new* URL and the old one can be cached indefinitely.
 * HTML is not addressed that way: `/posts/post-7/index.html` keeps its URL
 * across edits, so caching it at the edge is what would require a purge. Serving
 * it `no-cache` is what keeps `pathPurge: false` in the deploy target honest;
 * there is nothing stale to invalidate because nothing is held.
 */
export function cacheControl(key: string): string {
  if (key.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  return 'public, max-age=0, must-revalidate'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    }

    const url = new URL(request.url)
    const { key, redirectTo } = keysFor(url.pathname)

    const object = await env.SITE.get(key)
    if (object === null) {
      // No 404.html is emitted, so this is plain text rather than a pretend page.
      return new Response('404 not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    // Only redirect once the object is known to exist: redirecting first would
    // turn every genuine 404 into a redirect to another 404.
    if (redirectTo !== undefined) {
      return Response.redirect(new URL(redirectTo + url.search, url.origin).toString(), 308)
    }

    const headers = new Headers()
    // The content type is whatever the deploy stored, not a second mapping table
    // in this file. src/deploy-s3.ts sets it on PUT from deploy.ts's CONTENT_TYPES,
    // so a new extension is handled in one place rather than two that can drift.
    object.writeHttpMetadata(headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
    headers.set('cache-control', cacheControl(key))
    headers.set('etag', object.httpEtag)
    // A static site has no reason to be framed or sniffed.
    headers.set('x-content-type-options', 'nosniff')

    if (request.method === 'HEAD') return new Response(null, { headers })
    return new Response(object.body, { headers })
  },
}
