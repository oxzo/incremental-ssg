// A real DeployTarget, against the S3 API.
//
// Written against MinIO in stack/, and deliberately not written *for* MinIO:
// the same code points at S3 or R2 by changing an endpoint and a credential
// pair, which is the whole reason the vendor SDK is here instead of hand-rolled
// SigV4. Signing requests correctly is a solved problem that stays solved only
// if somebody else maintains it.
//
// The deploy diff compares digests, so everything interesting in this file is
// about what an S3 listing's ETag does and does not mean.
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { RailError, checkNumber } from './rails.ts'
import type { DeployTarget, RemoteObject } from './deploy.ts'

export type S3TargetOptions = {
  bucket: string
  region?: string
  /** Set for MinIO/R2; omit for real S3. */
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Prefix inside the bucket. The site root maps to this. */
  prefix?: string
  name?: string
  /**
   * Path-style addressing (bucket in the path, not the hostname). Required by
   * MinIO, accepted by S3 and R2, so it does not fork the code path.
   */
  forcePathStyle?: boolean
  /** Objects per listing request. The API caps this at 1000. */
  pageSize?: number
  /**
   * How many requests one listing may send before it is refused.
   *
   * A ceiling on the loop, not on the bucket. At the API's maximum page size the
   * default permits ten million objects -- some four hundred times the largest
   * tree this project has ever built (23,027 files, `bench/RESULTS.md`) -- so it
   * cannot plausibly fire on a real listing, which is the property that lets it
   * be a hard refusal rather than a warning.
   *
   * It scales with pageSize, since the bound is on requests: at 100 objects per
   * request the same default permits a million objects rather than ten.
   */
  maxListRequests?: number
  /** Recorded no-op purges, for tests and reporting. */
  onPurge?: (paths: string[]) => void
}

/** S3 returns ETags wrapped in literal quotes. */
const unquote = (s: string): string => s.replace(/^"|"$/g, '')

/**
 * A multipart ETag is `<hash>-<partcount>` and is *not* the MD5 of the object.
 *
 * This matters more than it looks. An object uploaded in parts -- by another
 * tool, by the console, by anything that is not this deploy -- reports a digest
 * that cannot equal the local MD5 no matter what the bytes are, so treating it
 * as a content digest would mark that object modified on every deploy forever
 * and quietly re-upload it. Server-side encryption with KMS produces the same
 * shape for the same reason.
 *
 * Reporting `undefined` routes it into the diff's existing "cannot tell" path,
 * which reads it as changed and *says so* via digestsUnavailable, rather than
 * churning silently. Same upload either way; the difference is whether anyone
 * can find out why.
 */
const usableDigest = (etag: string | undefined): string | undefined => {
  if (etag === undefined) return undefined
  const clean = unquote(etag)
  return /^[0-9a-f]{32}$/i.test(clean) ? clean.toLowerCase() : undefined
}

export function s3DeployTarget(opts: S3TargetOptions): DeployTarget {
  const prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '')
  const key = (path: string) => (prefix === '' ? path : `${prefix}/${path}`)
  const unkey = (k: string) => (prefix === '' ? k : k.slice(prefix.length + 1))
  const pageSize = Math.min(opts.pageSize ?? 1000, 1000)
  const maxListRequests = checkNumber(opts.maxListRequests, 10_000, {
    name: 'maxListRequests',
    min: 1,
    integer: true,
  })

  const client = new S3Client({
    region: opts.region ?? 'us-east-1',
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
  })

  return {
    name: opts.name ?? `s3:${opts.bucket}${prefix ? `/${prefix}` : ''}`,

    capabilities: {
      digestListing: true,
      // No CDN sits in front of a bucket by itself. Claiming path purge here
      // would be a lie the diff would act on; see purge() below.
      pathPurge: false,
    },

    // ETags are MD5 for single-part uploads, so the local side must hash with
    // MD5 too or every object compares unequal. hash-tree.ts takes this as a
    // parameter for exactly this reason.
    digestAlgorithm: 'md5',

    /**
     * Every object under the prefix, following continuation tokens.
     *
     * The pagination is the correctness-critical part, not the ETag parsing. The
     * diff deletes anything live that the local tree does not contain, so a
     * listing that stops early does not report a smaller site -- it reports
     * those objects as absent and issues deletes for pages that are still live.
     * That is why a truncated response is followed rather than trusted, and why
     * a missing continuation token on a truncated page is a refusal rather than
     * a loop-exit.
     *
     * Following a listing to its end also means trusting the server to end it,
     * and the two refusals below are what happens when it does not. They are
     * ordered by how much they know: a token arriving a second time is a repeat
     * and is named as one, and everything else that keeps the loop running is
     * caught by the request cap.
     */
    async list(): Promise<RemoteObject[]> {
      const out: RemoteObject[] = []
      // Every token the server has issued, not only the last one, so a cycle of
      // any length is caught rather than just an immediate repeat. Affordable
      // because maxListRequests bounds how many there can be.
      const issued = new Set<string>()
      let token: string | undefined
      for (let requests = 0; ; requests++) {
        // Checked before the request, and deliberately the one rail here that
        // depends on nothing else being right. Every other check in this loop
        // decides whether to *continue*, so a bug in any of them is not a wrong
        // answer -- it is a deploy that never starts, which this project's notes
        // already name as worse than a crash.
        //
        // tools/mutate.py needs it for the same reason from the other side:
        // without a bound that survives them, breaking any one of these checks
        // hangs the harness instead of failing a test, and a hang is the one
        // result that says nothing about which line caused it.
        if (requests === maxListRequests) {
          throw new RailError(
            'deploy.listing',
            false,
            `bucket listing did not end within ${maxListRequests} requests (${out.length} objects so far). ` +
            `Not terminal, because this rail cannot tell a bucket that really is this large from a listing ` +
            `that is looping, and it sits where only the second is plausible — raise maxListRequests if the ` +
            `first is what happened.`,
          )
        }
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: opts.bucket,
            ...(prefix === '' ? {} : { Prefix: `${prefix}/` }),
            MaxKeys: pageSize,
            ContinuationToken: token,
          }),
        )
        for (const o of res.Contents ?? []) {
          if (o.Key === undefined) continue
          // A "directory marker" -- a zero-byte object whose key ends in / --
          // corresponds to no local file, so including it would make the diff
          // delete it on every run.
          if (o.Key.endsWith('/')) continue
          out.push({ path: unkey(o.Key), digest: usableDigest(o.ETag) })
        }
        if (!res.IsTruncated) break
        token = res.NextContinuationToken
        if (token === undefined) {
          throw new RailError(
            'deploy.listing',
            false,
            `bucket listing reported truncated with no continuation token after ${out.length} objects`,
          )
        }
        // A token the server has already issued means the next request is one it
        // has already answered, so the listing is repeating rather than
        // advancing. This is the exact form of "not making progress"; counting
        // objects *retained* per page is not, because the filter above can drop
        // every key on a page -- a page of directory markers does exactly that
        // -- while the listing itself advances normally.
        //
        // Not terminal: this is the server's pagination misbehaving, not a fact
        // about what is in the bucket, so the next attempt can list correctly. A
        // server that does it every time surfaces through the service's
        // consecutive-failure count, which has evidence across attempts that a
        // single throw site does not.
        if (issued.has(token)) {
          throw new RailError(
            'deploy.listing',
            false,
            `bucket listing re-issued a continuation token it had already given, after ${out.length} objects ` +
            `— the listing is repeating rather than advancing`,
          )
        }
        issued.add(token)
      }
      return out
    },

    async put(path: string, body: Buffer, contentType: string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key(path),
          Body: body,
          ContentType: contentType,
        }),
      )
    },

    /**
     * DeleteObjects caps at 1000 keys per request, and reports per-key errors in
     * a 200 response rather than by failing.
     *
     * A partial delete that returns success is the shape of failure this
     * codebase keeps meeting: the caller records the deletion, the object stays
     * live, and nothing ever notices. So the per-key Errors array is checked and
     * raised, non-terminal, because the usual cause is throttling.
     */
    async remove(paths: string[]): Promise<void> {
      for (let i = 0; i < paths.length; i += 1000) {
        const chunk = paths.slice(i, i + 1000)
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket: opts.bucket,
            Delete: { Objects: chunk.map((p) => ({ Key: key(p) })), Quiet: true },
          }),
        )
        const errors = res.Errors ?? []
        if (errors.length > 0) {
          const sample = errors.slice(0, 3).map((e) => `${e.Key}: ${e.Code}`).join('; ')
          throw new RailError(
            'deploy.remove',
            false,
            `${errors.length} of ${chunk.length} deletes failed (${sample})`,
          )
        }
      }
    },

    /**
     * A recorded no-op, and recorded is the point.
     *
     * There is no CDN in front of a bucket, so there is nothing to invalidate.
     * A target that silently accepted purges would report a successful deploy
     * whose stale-content step never happened -- and the failure would only ever
     * appear as "the site is showing yesterday's page", which is exactly the
     * symptom nobody traces back to a deploy summary that said success.
     *
     * capabilities.pathPurge is false, so the caller is told rather than fooled.
     * Fronting this bucket with CloudFront or Cloudflare means implementing this
     * method and flipping that flag together.
     */
    async purge(paths: string[]): Promise<void> {
      opts.onPurge?.(paths)
    },
  }
}
