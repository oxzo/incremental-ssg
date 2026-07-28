// The deploy diff: hash what was built, compare it against what is live, and
// upload, delete, and purge only the difference.
//
// This is the phase the Phase 0 gate made *more* valuable rather than less. A
// typical content edit changes 6 output files out of 24,449, so without a diff
// every edit re-uploads and re-purges the entire site. The fan-out data that
// killed the incremental render engine is the same data that justifies this.
//
// Two things about the shape here are deliberate and easy to "fix" wrongly:
//
// 1. It keeps no cross-build state. The comparison is against the *remote
//    listing* -- what is actually live -- not against a local record of what we
//    uploaded last time. A local "what did I upload" cache is precisely the
//    class of thing that can be wrong, and a restored-but-stale CI cache would
//    make a correct tool skip a real upload. The build seal below is not that
//    cache: it is this build's own completion token, written by this build and
//    read by this deploy, and it says nothing about the remote.
//
// 2. It refuses to act on a build that did not finish. A diff computed from an
//    incomplete output tree issues deletes for pages that are still live, and
//    unlike the two earlier instances of this hazard in this codebase
//    (AssetCache.gc, DocumentStore.deleteMissing) it does so against
//    production. Same rail shape as those two, third occurrence.
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { hashTree, statTree } from './hash-tree.ts'
import { pool } from './pool.ts'
import { RailError, checkNumber } from './rails.ts'
import type { TreeDigests } from './hash-tree.ts'

/** Bumped when a change here makes an existing seal file unreadable. */
export const SEAL_SCHEMA = 1
export const SEAL_FILE = 'build-seal.json'

/**
 * Proof that a build ran to completion and emitted exactly this tree.
 *
 * Lives in the work directory rather than the output directory on purpose: a
 * file inside outDir would become part of the tree it is describing, and would
 * then show up in the deploy diff as a site page.
 */
export type BuildSeal = {
  schema: number
  site: string
  outDir: string
  routes: number
  files: number
  bytes: number
  /**
   * The build emptied outDir first, so the tree is a pure function of content
   * plus code. See the third rail in deploy() for why this is not cosmetic.
   */
  clean: boolean
}

export type DeployCapabilities = {
  /**
   * The listing carries a content digest per object. Without it a modified file
   * is indistinguishable from an unchanged one, so every common path has to be
   * re-uploaded -- the driver says so rather than reporting them unchanged.
   */
  digestListing: boolean
  /** Individual paths can be purged. Without it, purging is all-or-nothing. */
  pathPurge: boolean
}

export type RemoteObject = {
  /** Forward-slashed path relative to the site root, matching the local tree. */
  path: string
  /** Absent when the target cannot report one for this object. */
  digest?: string
}

export type DeployTarget = {
  name: string
  capabilities: DeployCapabilities
  /**
   * Digest algorithm the listing reports. Local files are hashed with this one
   * so the two sides are comparable without a side table of our own hashes.
   */
  digestAlgorithm: string
  list(): Promise<RemoteObject[]>
  put(path: string, body: Buffer, contentType: string): Promise<void>
  remove(paths: string[]): Promise<void>
  purge(paths: string[]): Promise<void>
}

export type DeployPlan = {
  added: string[]
  modified: string[]
  deleted: string[]
  unchanged: number
  /** URLs whose content at that address changed. See planDeploy for the rule. */
  purge: string[]
  /**
   * The target could not report digests, so `modified` is every common path
   * because nothing here can tell which of them actually changed.
   */
  digestsUnavailable: boolean
}

export type PlanOptions = {
  /**
   * Include added paths in the purge set. Off by default: nothing is cached at
   * a URL that did not exist, so the only reason to purge one is a CDN that
   * negatively caches 404s. Turning it on is cheap for a content edit and
   * expensive on an image change, where content-addressed derivative names mean
   * a single edited source produces eight adds.
   */
  purgeAdded?: boolean
}

/**
 * Compute the difference between the built tree and the live site.
 *
 * Deliberately pure and deliberately unguarded -- it will happily describe a
 * catastrophic delete so that a dry run can show you one. Both safety rails
 * live in deploy(), which is the function that acts.
 */
export function planDeploy(
  local: TreeDigests,
  remote: RemoteObject[],
  opts: PlanOptions = {},
): DeployPlan {
  const live = new Map(remote.map((o) => [o.path, o.digest]))
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  let unchanged = 0
  let digestsUnavailable = false

  for (const [path, digest] of local) {
    if (!live.has(path)) {
      added.push(path)
      continue
    }
    // No digest from the target means "cannot tell", and the safe reading of
    // "cannot tell" is "changed". Reporting it unchanged would silently skip a
    // real upload, which is the one failure this whole stage exists to avoid.
    const remoteDigest = live.get(path)
    if (remoteDigest === undefined) {
      digestsUnavailable = true
      modified.push(path)
    } else if (remoteDigest !== digest) {
      modified.push(path)
    } else {
      unchanged++
    }
  }
  for (const { path } of remote) if (!local.has(path)) deleted.push(path)

  added.sort()
  modified.sort()
  deleted.sort()

  // A modified page serves stale bytes until purged; a deleted page serves a
  // page that should now be gone, which is worse. Adds are opt-in above.
  const purge = [...(opts.purgeAdded ? added : []), ...modified, ...deleted].sort()

  return { added, modified, deleted, unchanged, purge, digestsUnavailable }
}

export type DeployOptions = {
  outDir: string
  target: DeployTarget
  /** The seal returned by build(). Omit to read it from workDir instead. */
  seal?: BuildSeal
  /** Where build() wrote the seal. Required unless `seal` is passed. */
  workDir?: string
  /** Refuse to delete more than this share of the live site. */
  maxDeleteRatio?: number
  /** Override both rails. Means "yes, I know, I meant it". */
  force?: boolean
  purgeAdded?: boolean
  /** Compute and return the plan without touching the target. */
  dryRun?: boolean
  /** Concurrent uploads. */
  concurrency?: number
}

export type DeployResult = {
  target: string
  plan: DeployPlan
  uploaded: number
  bytes: number
  deleted: number
  purged: number
  dryRun: boolean
  ms: { hash: number; list: number; upload: number; remove: number; purge: number; total: number }
}

const now = () => performance.now()

export function sealPath(workDir: string): string {
  return join(workDir, SEAL_FILE)
}

export function writeSeal(workDir: string, seal: BuildSeal) {
  mkdirSync(workDir, { recursive: true })
  writeFileSync(sealPath(workDir), JSON.stringify(seal, null, 2))
}

/**
 * Remove any seal before a build starts.
 *
 * Without this, a build that dies halfway leaves the *previous* build's seal in
 * place, and the next deploy reads it as proof that the truncated tree on disk
 * is complete. The counts check below would usually catch that, but "usually"
 * is not the standard for the guard whose entire job is being sure.
 */
export function clearSeal(workDir: string) {
  rmSync(sealPath(workDir), { force: true })
}

export function readSeal(workDir: string): BuildSeal | null {
  try {
    const seal = JSON.parse(readFileSync(sealPath(workDir), 'utf8')) as BuildSeal
    return seal.schema === SEAL_SCHEMA ? seal : null
  } catch {
    return null
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Verify the build finished, diff the tree against the live site, and apply it.
 *
 * Rail one: there must be a seal, it must describe *this* output directory, and
 * the tree on disk must still match its file count and byte total. A build that
 * crashed after rendering half the routes writes no seal, so the deploy stops
 * with the site intact rather than deleting every page the build never got to.
 *
 * Rail two: a delete set larger than `maxDeleteRatio` of the live site is
 * refused. Same default and same reasoning as AssetCache.gc and
 * DocumentStore.deleteMissing -- the shape of "a partial listing looks exactly
 * like a mass deletion" has now appeared three times in this codebase, so treat
 * it as a pattern rather than three coincidences.
 *
 * Rail three is the mirror image of rail two and easier to miss, because its
 * failure is silence rather than damage. Nothing in the build removes output
 * that a previous build left behind: a deleted post's page and an edited
 * image's old derivatives both survive in outDir until something empties it. A
 * diff taken from such a tree reports those files as *unchanged* -- byte for
 * byte they match what is live -- so the page stays published forever and no
 * error is ever raised. So the tree has to come from a clean build, which costs
 * only the cheap half of the build: the asset cache lives outside outDir
 * precisely so that emptying it throws away no encoding work.
 */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const t0 = now()
  const { outDir, target } = opts
  const { force = false } = opts
  // Checked before anything is read or listed, because the rail below is a
  // comparison and a comparison against NaN is false -- an unparsed ratio does
  // not raise here, it silently removes the ceiling.
  const maxDeleteRatio = checkNumber(opts.maxDeleteRatio, 0.5, {
    name: 'maxDeleteRatio', min: 0, max: 1,
  })
  // Checked here too, rather than where it is used further down, so a bad value
  // refuses before this function has read a byte or listed the target.
  const concurrency = checkNumber(opts.concurrency, 8, {
    name: 'concurrency', min: 1, integer: true,
  })

  const seal = opts.seal ?? (opts.workDir ? readSeal(opts.workDir) : null)
  if (!seal) {
    // Transient: the next build writes a seal. This is the canonical
    // self-clearing rail -- it fires precisely because a build died, and the
    // remedy is the thing a retry does anyway.
    throw new RailError(
      'deploy-no-seal',
      false,
      `deploy() found no build seal${opts.workDir ? ` in ${opts.workDir}` : ''}. A build ` +
      `writes one only after every route has been rendered and counted, so a missing ` +
      `seal means the last build did not finish -- and a diff against a partial tree ` +
      `issues deletes for pages that are still live. Re-run the build.`)
  }
  if (seal.outDir !== outDir) {
    // Terminal: two directories were configured to disagree, and no number of
    // retries reconciles a configuration mistake.
    throw new RailError(
      'deploy-seal-mismatch',
      true,
      `deploy() seal describes ${seal.outDir} but was asked to deploy ${outDir}. ` +
      `Deploying one build's tree against another build's seal would validate the ` +
      `wrong thing.`)
  }
  if (!seal.clean && !force) {
    // Terminal: whoever called build() passed clean:false, and calling it again
    // the same way produces the same unclean tree. The service always builds
    // with clean:true, so this firing under the service means its wiring is
    // wrong -- which is worth halting on rather than retrying past.
    throw new RailError(
      'deploy-not-clean',
      true,
      `deploy() refuses a build that did not clean ${outDir} first. Nothing removes ` +
      `output left by an earlier build, so a deleted page and an edited image's old ` +
      `derivatives are still sitting in the tree -- and because they match what is ` +
      `live byte for byte, the diff reports them unchanged and they stay published ` +
      `forever, silently. Rebuild with clean output (--clean, or {clean:true}), or ` +
      `override with --force / {force:true} if you know this tree is complete.`)
  }
  const actual = statTree(outDir)
  if (actual.files !== seal.files || actual.bytes !== seal.bytes) {
    // Transient: something mutated the tree after the build, and a clean rebuild
    // re-establishes agreement between tree and seal.
    throw new RailError(
      'deploy-tree-mismatch',
      false,
      `deploy() output tree does not match its seal: ${actual.files} files / ` +
      `${actual.bytes} bytes on disk against ${seal.files} / ${seal.bytes} sealed. ` +
      `Something changed or removed build output after the build completed; ` +
      `re-run the build rather than deploying a tree nothing vouches for.`)
  }

  const th = now()
  const local = hashTree(outDir, target.digestAlgorithm)
  const hashMs = now() - th

  const tl = now()
  const remote = await target.list()
  const listMs = now() - tl

  const plan = planDeploy(local, remote, { purgeAdded: opts.purgeAdded })

  if (
    remote.length > 0 &&
    plan.deleted.length / remote.length > maxDeleteRatio &&
    !force
  ) {
    // Terminal, and the clearest case of the distinction. The build emitted
    // fewer pages than the site has; rebuilding from the same store emits the
    // same short tree and refuses again. A service that retried this would
    // re-refuse every few seconds forever while the site went stale -- busy logs,
    // no publishing, no alert. Halting and reporting unhealthy is the only shape
    // that surfaces it.
    throw new RailError(
      'deploy-delete-ratio',
      true,
      `deploy() would delete ${plan.deleted.length} of ${remote.length} live objects ` +
      `(${((plan.deleted.length / remote.length) * 100).toFixed(0)}%), over the ` +
      `${maxDeleteRatio * 100}% limit. This usually means the build emitted fewer ` +
      `pages than the site actually has. Pass --force / {force:true}, or raise ` +
      `--max-delete-ratio, if the sweep is intended.`)
  }

  if (opts.dryRun) {
    return {
      target: target.name, plan, uploaded: 0, bytes: 0, deleted: 0, purged: 0, dryRun: true,
      ms: { hash: hashMs, list: listMs, upload: 0, remove: 0, purge: 0, total: now() - t0 },
    }
  }

  // Upload before delete, always. The reverse order opens a window where a page
  // that merely moved is missing from the live site; this order only ever
  // leaves an extra file around briefly.
  const uploads = [...plan.added, ...plan.modified]
  const tu = now()
  let bytes = 0
  await pool(
    uploads.map((path) => async () => {
      const body = readFileSync(join(outDir, path))
      bytes += body.byteLength
      await target.put(path, body, contentTypeFor(path))
    }),
    // Validated at the top rather than clamped with Math.max(1, …), which passes
    // NaN straight through: pool() then sizes its worker array from NaN, gets
    // zero workers, runs no uploads at all, and returns cleanly. A deploy that
    // uploads nothing and reports success is the same silent-stale failure the
    // rails above exist to prevent.
    concurrency,
  )
  const uploadMs = now() - tu

  const tr = now()
  if (plan.deleted.length > 0) await target.remove(plan.deleted)
  const removeMs = now() - tr

  const tp = now()
  let purged = 0
  if (plan.purge.length > 0 && target.capabilities.pathPurge) {
    await target.purge(plan.purge)
    purged = plan.purge.length
  }
  const purgeMs = now() - tp

  return {
    target: target.name,
    plan,
    uploaded: uploads.length,
    bytes,
    deleted: plan.deleted.length,
    purged,
    dryRun: false,
    ms: {
      hash: hashMs, list: listMs, upload: uploadMs,
      remove: removeMs, purge: purgeMs, total: now() - t0,
    },
  }
}
