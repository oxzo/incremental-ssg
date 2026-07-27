// The blog's content schema. This lives in the site, not the engine -- the whole
// point of the Phase 1 seam is that `src/` never learns what a "post" is.
export type Post = {
  id: string
  slug: string
  title: string
  author: string
  tags: string[]
  date: number
  body: string
  /** Optional hero image, keyed by path relative to the asset source dir. */
  hero?: string
}

export type Author = { id: string; slug: string; name: string; bio: string }
export type Tag = { id: string; slug: string; name: string }
export type Page = { id: string; slug: string; title: string; body: string }
export type Settings = {
  id: string
  siteName: string
  nav: { label: string; href: string }[]
  footer: string
}

/** Indexes built once per build, so no template does linear scans per page. */
export type BlogIndex = {
  /** Newest first, ties broken by id so the order is total and stable. */
  posts: Post[]
  postById: Map<string, Post>
  authors: Map<string, Author>
  tags: Map<string, Tag>
  pages: Page[]
  settings: Settings
  byTag: Map<string, Post[]>
  byAuthor: Map<string, Post[]>
  /** post id -> position in `posts`, for prev/next without a scan. */
  indexOf: Map<string, number>
}

export const PAGE_SIZE = 20
export const RELATED = 3
