// A deploy target backed by a local directory.
//
// Same call the project already made for the CMS: build against a mock behind
// the adapter interface, and let `capabilities` be data the driver branches on
// rather than something each adapter quietly works around. That deferral cost
// nothing there -- everything downstream was built against the mock and picking
// a real CMS became an adapter to write rather than a design to revisit -- and
// it buys more here, because this is the first component in the project that
// acts on a live site rather than on a local directory.
//
// What a real target will surface that this one cannot: auth, rate limiting,
// listing pagination caps, per-request latency, and partial-upload behaviour.
// `failAfter` models only the last of those, and only crudely.
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { DeployCapabilities, DeployTarget, RemoteObject } from './deploy.ts'

export type MockTargetOptions = {
  /** Directory standing in for the live site. */
  dir: string
  capabilities?: Partial<DeployCapabilities>
  digestAlgorithm?: string
  /**
   * Throw once this many mutating operations have run, to exercise a deploy
   * that dies halfway. The operations before it stay applied, because that is
   * what a real half-finished deploy leaves behind.
   */
  failAfter?: number
}

export type MockDeployTarget = DeployTarget & {
  /** Every mutating operation in order, as `put <path>` / `remove <path>`. */
  ops: string[]
  /** Paths passed to purge(), accumulated across deploys. */
  purged: string[]
  /** Current live paths, for assertions that do not care about digests. */
  paths(): string[]
}

export function directoryTarget(opts: MockTargetOptions): MockDeployTarget {
  const root = opts.dir
  const algorithm = opts.digestAlgorithm ?? 'sha256'
  const capabilities: DeployCapabilities = {
    digestListing: opts.capabilities?.digestListing ?? true,
    pathPurge: opts.capabilities?.pathPurge ?? true,
  }
  const ops: string[] = []
  const purged: string[] = []

  const walk = (): string[] => {
    const out: string[] = []
    if (!existsSync(root)) return out
    const rec = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) rec(p)
        else out.push(relative(root, p).split(sep).join('/'))
      }
    }
    rec(root)
    return out
  }

  const step = () => {
    if (opts.failAfter !== undefined && ops.length > opts.failAfter) {
      throw new Error(`mock deploy target failed after ${opts.failAfter} operations`)
    }
  }

  return {
    name: `directory:${root}`,
    capabilities,
    digestAlgorithm: algorithm,

    async list(): Promise<RemoteObject[]> {
      return walk().map((path) => {
        // A target without digest listing still knows what exists -- it just
        // cannot say whether the bytes differ. Omitting the digest rather than
        // faking one is what makes the driver's degraded branch reachable.
        if (!capabilities.digestListing) return { path }
        const body = readFileSync(join(root, path))
        return { path, digest: createHash(algorithm).update(body).digest('hex') }
      })
    },

    async put(path: string, body: Buffer) {
      ops.push(`put ${path}`)
      step()
      const abs = join(root, path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body)
    },

    async remove(paths: string[]) {
      for (const path of paths) {
        ops.push(`remove ${path}`)
        step()
        rmSync(join(root, path), { force: true })
      }
    },

    async purge(paths: string[]) {
      purged.push(...paths)
    },

    ops,
    purged,
    paths: walk,
  }
}
