import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The rules that decide what a Fork carries into a new Workspace, what it
 * refuses to guess at, and what a Workspace's environment is doing.
 *
 * Pure by design: an adapter runs `git`, stats a file or reads a marker, and
 * hands the answers here as plain data. See CLAUDE.md — every one of these is a
 * rule about paths and strings, and none of them needs a repository to be told
 * whether it is right.
 */

/**
 * Where a Workspace's environment has got to. A Node whose environment is still
 * `preparing` is one the agent can already read and edit code in — only the
 * heavy directories are still landing.
 */
export type EnvironmentStatus = 'preparing' | 'ready' | 'failed'

/** The ignored paths of a Workspace, split by what they cost to carry. */
export type Environment = { files: string[]; directories: string[] }

export const NO_ENVIRONMENT: Environment = { files: [], directories: [] }

/**
 * Workspaces live inside the repository they were cut from — nodegraph's own
 * under `.nodegraph/`, and other tools keep theirs in directories of their own —
 * and those directories are ignored, which is exactly what makes them look like
 * environment. They are not: each is a whole checkout of another Node, and
 * carrying one would copy every sibling Node into this one, then their copies
 * into the next Fork.
 */
export const holdsAWorktree = (candidate: string, worktrees: string[]): boolean =>
  worktrees.some((worktree) => worktree === candidate || worktree.startsWith(candidate + sep))

const withoutTrailingSlash = (entry: string): string =>
  entry.endsWith('/') ? entry.slice(0, -1) : entry

/**
 * The environment: everything the parent Workspace needs in order to run that
 * git deliberately does not track — `.env`, `node_modules`, `target`, `.venv`.
 * A child Node that inherits the code but not these cannot be worked in, so its
 * agent's first act would be to build them all over again.
 *
 * `git ls-files --directory` collapses a wholly ignored directory into one
 * entry, which is also the line drawn here: an ignored *file* is small and
 * copied before Fork returns; an ignored *directory* is an environment and goes
 * to the background.
 */
export const splitEnvironment = ({
  from,
  entries,
  home,
  worktrees,
}: {
  /** The parent Workspace the entries were listed in. */
  from: string
  /** What git reported, directories still wearing their trailing slash. */
  entries: string[]
  /** nodegraph's own home in the parent, absolute. */
  home: string
  /** Every worktree of this repository, absolute. */
  worktrees: string[]
}): Environment => {
  const directories = entries.filter((entry) => entry.endsWith('/'))

  return {
    // git reports a wholly ignored directory *and* the ignored files inside it.
    // Copying both would land the directory inside its own copy.
    files: entries.filter(
      (entry) =>
        !entry.endsWith('/') && !directories.some((directory) => entry.startsWith(directory)),
    ),
    directories: directories
      .map((entry) => resolve(from, withoutTrailingSlash(entry)))
      // nodegraph's home is ignored like any environment directory and is
      // nothing of the sort: on the first Fork it holds only the graph, which a
      // child must not carry a stale second copy of, and on every Fork after
      // that it holds the other Nodes' Workspaces.
      .filter((entry) => entry !== home && !holdsAWorktree(entry, worktrees))
      .map((entry) => relative(from, entry)),
  }
}

/**
 * The untracked files a Fork takes with it. A Workspace need not be ignored to
 * be sitting in the parent's tree: git reports another worktree as one untracked
 * entry, and copying it would carry a whole Node in as a pile of files.
 */
export const carriedAdditions = ({
  from,
  entries,
  worktrees,
}: {
  from: string
  entries: string[]
  worktrees: string[]
}): string[] =>
  entries.filter(
    (entry) => !holdsAWorktree(resolve(from, withoutTrailingSlash(entry)), worktrees),
  )

/** What to do about the file — or the absence of one — at the hook's path. */
export type HookVerdict = 'run' | 'no-hook' | 'not-executable'

/**
 * The one place a project gets to say "my environment is not a pile of files"
 * is an *executable* at the hook's path. A file there that nobody can execute
 * is the `chmod +x` everyone forgets the first time, and guessing at it either
 * way is worse than saying so: skip it silently and the Node arrives with no
 * hook run *and* no environment carried, which is the one outcome nothing
 * asked for.
 */
export const readHookVerdict = (
  found: { isFile: boolean; mode: number } | undefined,
): HookVerdict => {
  if (found === undefined || !found.isFile) return 'no-hook'

  return (found.mode & 0o111) === 0 ? 'not-executable' : 'run'
}

const isStatus = (value: unknown): value is EnvironmentStatus =>
  value === 'preparing' || value === 'ready' || value === 'failed'

/**
 * What a Workspace's environment marker means, given the marker as it was found
 * on disk and a way to ask whether a process is still alive.
 *
 * Nothing here trusts the file: a marker is written by another process, and a
 * marker nobody can make sense of must not leave a Node stuck saying its
 * environment is coming.
 */
export const statusFromMarker = (
  marker: unknown,
  ownerIsRunning: (pid: number) => boolean,
): EnvironmentStatus => {
  if (typeof marker !== 'object' || marker === null) return 'ready'

  const { status, owner } = marker as { status?: unknown; owner?: unknown }
  if (!isStatus(status)) return 'ready'
  if (status !== 'preparing') return status

  // A Node that says "preparing" for ever, because the nodegraph doing the
  // preparing was killed, is worse than one that admits it went wrong: the
  // first is waited on, the second is Discarded and forked again.
  return typeof owner === 'number' && !ownerIsRunning(owner) ? 'failed' : 'preparing'
}

const GITDIR = 'gitdir: '

/**
 * Where a Workspace keeps its own git state, read out of the `.git` link git
 * leaves in every linked worktree. Undefined when the file is anything else —
 * the caller then has to ask git itself.
 */
export const gitDirOf = (workspacePath: string, dotGit: string): string | undefined => {
  const line = dotGit.split('\n')[0]?.trim() ?? ''
  if (!line.startsWith(GITDIR)) return undefined

  const target = line.slice(GITDIR.length).trim()
  if (target === '') return undefined

  return isAbsolute(target) ? target : resolve(workspacePath, target)
}
