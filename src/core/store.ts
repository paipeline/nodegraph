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
 * Every field of a record ends up somewhere real — git's argv, git's working
 * directory, the branch a Discard deletes — so the checking happens once, here,
 * before anything downstream can hand one to a process. A record that could not
 * have come from nodegraph is dropped rather than repaired: `reconcile` already
 * refuses to draw a Fork git no longer has, and the graph is allowed to forget,
 * never to lie.
 *
 * Pure by design: plain data in, plain data out. See CLAUDE.md.
 */

export type StoredFork = {
  id: string
  parentId: string
  branch: string
  workspacePath: string
  forkPointSha: string
  createdAt: string
}

/**
 * A commit, spelled the way git spells one. `git rev-parse HEAD` gives 40 hex
 * digits (64 in a sha256 repository) and git's shortest legal abbreviation is
 * four, so anything outside that is not the commit a Node was cut from.
 */
const OBJECT_NAME = /^[0-9a-f]{4,64}$/i

/**
 * git decides what is an option by looking at the first character, and so does
 * every other program we hand a value to. A leading dash is therefore not a
 * name at all — `--output=…` in the place of a commit truncates the file it
 * names — so a record spelling one is a record we did not write.
 */
const isName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.startsWith('-')

const asFork = (candidate: unknown): StoredFork | null => {
  if (typeof candidate !== 'object' || candidate === null) return null

  const { id, parentId, branch, workspacePath, forkPointSha, createdAt } = candidate as Record<
    string,
    unknown
  >

  if (!isName(id) || !isName(parentId) || !isName(branch) || !isName(workspacePath)) return null
  if (typeof forkPointSha !== 'string' || !OBJECT_NAME.test(forkPointSha)) return null
  if (typeof createdAt !== 'string') return null

  // Rebuilt field by field rather than passed through, so nothing that happens
  // to be sitting in the json travels on with it.
  return { id, parentId, branch, workspacePath, forkPointSha, createdAt }
}

/** The Forks a parsed store is worth believing, and only those. */
export const usableForks = (document: unknown): StoredFork[] => {
  if (typeof document !== 'object' || document === null) return []

  const { forks } = document as { forks?: unknown }
  if (!Array.isArray(forks)) return []

  return forks.flatMap((candidate) => {
    const fork = asFork(candidate)
    return fork === null ? [] : [fork]
  })
}
