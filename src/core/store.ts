import { join } from 'node:path'
import { TRUNK_ID } from './reconcile.js'

/**
 * What nodegraph is willing to believe it wrote down.
 *
 * The store is a single json file inside the repository being viewed, which
 * means what comes out of it is whatever is on that disk: a hand-edit, a merge
 * somebody resolved badly, or a `.nodegraph/graph.json` that was committed to a
 * repository before it was cloned. It is read on the first poll, before any
 * Fork exists, and ADR-0003 is explicit that nothing here is behind a trust
 * boundary.
 *
 * Every field of a record ends up somewhere real — git's argv, the **directory
 * git is run in**, the branch a Discard deletes — so the checking happens once,
 * here, before anything downstream can hand one to a process. The working
 * directory is the field with the longest reach: everything git decides after
 * it starts follows from where it started, including which repository's config
 * it obeys, and git config names commands (`core.fsmonitor`, `diff.external`,
 * `filter.*.clean`). Validating the argument and not the directory would be
 * bolting the door and leaving the frame out.
 *
 * So the rule is not "does this look harmless" but "is this a record nodegraph
 * itself wrote": every field is either generated from the Node's own name by
 * `forkRecord` below — which is the *only* way a record is made — or is a
 * commit git could name. A record that could not have come from nodegraph is
 * dropped rather than repaired: `reconcile` already refuses to draw a Fork git
 * no longer has, and the graph is allowed to forget, never to lie.
 *
 * Pure by design: plain data in, plain data out. `node:path` is string work, not
 * I/O. See CLAUDE.md.
 */

export type StoredFork = {
  id: string
  parentId: string
  branch: string
  workspacePath: string
  forkPointSha: string
  createdAt: string
  /**
   * The Context this Node's agent lives in, named at the moment of the Fork —
   * which is also when the parent's understanding was copied into it, so it is
   * findable even if nobody opens this Node's terminal until tomorrow.
   */
  sessionId?: string
  /**
   * The parent's Context, as it stood at that moment, when the understanding
   * actually came across. Null when the parent had none to give — there is
   * nothing to inherit from silence — and that is the plain answer to "did this
   * Node start with a blank head", which nothing downstream then has to guess.
   */
  parentSessionId?: string | null
  /** The one line written at Fork time: this Node's first instruction and its title. */
  intent?: string | null
}

/**
 * The name nodegraph gives a Node: the first eight characters of a v4 uuid, so
 * eight lowercase hex digits and nothing else. `trunk` is not among them, which
 * matters — the Trunk is on every graph, so its name is the easiest one for a
 * record to wear in the hope of being waved through.
 */
const FORK_ID = /^[0-9a-f]{8}$/

/**
 * A commit, spelled the way git spells one. `git rev-parse HEAD` gives 40 hex
 * digits (64 in a sha256 repository) and git's shortest legal abbreviation is
 * four, so anything outside that is not the commit a Node was cut from.
 *
 * A leading dash cannot survive this, which is the point: git decides what is
 * an option by looking at the first character, and `--output=…` in the place of
 * a commit truncates the file it names.
 */
const OBJECT_NAME = /^[0-9a-f]{4,64}$/i

/** Where the one directory a Node owns lives, under nodegraph's home. */
const WORKSPACES = 'workspaces'

/** The branch a Node gets to itself, named after the Node. */
export const branchOf = (id: string): string => `nodegraph/${id}`

/** The Workspace a Node gets to itself, named after the Node. */
export const workspaceOf = (home: string, id: string): string => join(home, WORKSPACES, id)

/**
 * The record nodegraph writes for a Fork.
 *
 * Everything that is not a fact about the world is derived from the Node's name
 * right here, which is what makes the check on the way back possible at all: a
 * reader can recompute every derived field and compare. Written and believed
 * are one rule, said once, so they cannot drift apart.
 */
export const forkRecord = (made: {
  id: string
  parentId: string
  home: string
  forkPointSha: string
  createdAt: string
  sessionId?: string
  parentSessionId?: string | null
  intent?: string | null
}): StoredFork => ({
  id: made.id,
  parentId: made.parentId,
  branch: branchOf(made.id),
  workspacePath: workspaceOf(made.home, made.id),
  forkPointSha: made.forkPointSha,
  createdAt: made.createdAt,
  sessionId: made.sessionId,
  // Written as `null` rather than left out, because "this Node started with a
  // blank head" and "nobody has said" are different answers and a reader must
  // not have to tell them apart. `asFork` reads an absent one back the same way.
  parentSessionId: made.parentSessionId ?? null,
  intent: made.intent ?? null,
})

const isForkId = (value: unknown): value is string =>
  typeof value === 'string' && FORK_ID.test(value)

const asFork = (candidate: unknown, home: string): StoredFork | null => {
  if (typeof candidate !== 'object' || candidate === null) return null

  const {
    id,
    parentId,
    branch,
    workspacePath,
    forkPointSha,
    createdAt,
    sessionId,
    parentSessionId,
    intent,
  } = candidate as Record<string, unknown>

  if (!isForkId(id)) return null
  if (parentId !== TRUNK_ID && !isForkId(parentId)) return null
  if (branch !== branchOf(id)) return null
  if (workspacePath !== workspaceOf(home, id)) return null
  if (typeof forkPointSha !== 'string' || !OBJECT_NAME.test(forkPointSha)) return null
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null

  // Rebuilt field by field rather than passed through, so nothing that happens
  // to be sitting in the json travels on with it.
  return {
    id,
    parentId,
    branch,
    workspacePath,
    forkPointSha,
    createdAt,
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
    intent: typeof intent === 'string' ? intent : null,
  }
}

/**
 * The Forks a parsed store is worth believing, and only those.
 *
 * `home` is nodegraph's own directory in the repository being read — the one
 * place a Workspace it made can be. It is passed in rather than looked up
 * because finding it is the adapter's job and comparing against it is this one.
 */
export const usableForks = (document: unknown, home: string): StoredFork[] => {
  if (typeof document !== 'object' || document === null) return []

  const { forks } = document as { forks?: unknown }
  if (!Array.isArray(forks)) return []

  // One Node, one record. Two records under one name would be one Node measured
  // twice, and which of the two answered would be whichever was written last.
  const seen = new Set<string>()

  return forks.flatMap((candidate) => {
    const fork = asFork(candidate, home)
    if (fork === null || seen.has(fork.id)) return []
    seen.add(fork.id)
    return [fork]
  })
}
