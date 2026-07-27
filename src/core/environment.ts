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

/**
 * Everything a Node has to say about its own Workspace that only disk knows:
 * whether its environment has landed, and whether a Fork from it can start at
 * all. Gathered per Workspace by an adapter and handed to `reconcile`.
 */
export type WorkspaceReport = {
  environment: EnvironmentStatus
  /** Why a Fork from this Node would be refused, or null when it would not. */
  forkRefusal: string | null
}

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

/**
 * The one place a project gets to say "my environment is not a pile of files":
 * an executable of this name in the Workspace being forked from.
 */
export const ON_FORK = '.nodegraph.on-fork'

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

/**
 * Why a Fork from a Workspace cannot start, in the words the user gets to read.
 *
 * The same sentence is what the Node shows before anyone presses Fork and what
 * the server answers if one is attempted anyway, because they are the same
 * refusal — and it carries the command that lifts it, so nobody has to go and
 * find out what nodegraph meant.
 */
export const hookRefusal = (verdict: HookVerdict, hookPath: string): string | null =>
  verdict === 'not-executable'
    ? `${ON_FORK} is not executable, so this Fork would arrive with no environment at all. ` +
      `Run: chmod +x ${hookPath}`
    : null

const isStatus = (value: unknown): value is EnvironmentStatus =>
  value === 'preparing' || value === 'ready' || value === 'failed'

const isPid = (value: unknown): value is number => typeof value === 'number'

/**
 * What a Workspace's environment marker means, given the marker as it was found
 * on disk and a way to ask whether a process is still alive.
 *
 * Two different processes can be filling a Workspace: the `owner`, the
 * nodegraph that promised the environment and will write down how it ended, and
 * the `writer`, the child actually putting bytes there — a project's on-fork
 * hook, or the `cp` cloning `node_modules`. They do not die together. Killing
 * nodegraph leaves its `npm install` running, so a marker read as "the parent
 * is gone, therefore nothing is happening" is how a Workspace gets torn down
 * under a live writer and reappears seconds later.
 *
 * So `preparing` holds while *either* is alive, and only when neither is does it
 * become `failed` — which is both true (nobody is left to finish it) and the
 * thing that makes waiting for it terminate.
 *
 * Nothing here trusts the file: a marker is written by another process, and a
 * marker nobody can make sense of must not leave a Node stuck saying its
 * environment is coming.
 */
export const statusFromMarker = (
  marker: unknown,
  isRunning: (pid: number) => boolean,
): EnvironmentStatus => {
  if (typeof marker !== 'object' || marker === null) return 'ready'

  const { status, owner, writer } = marker as {
    status?: unknown
    owner?: unknown
    writer?: unknown
  }
  if (!isStatus(status)) return 'ready'
  if (status !== 'preparing') return status

  // A Node that says "preparing" for ever, because everyone who was preparing it
  // was killed, is worse than one that admits it went wrong: the first is waited
  // on, the second is Discarded and forked again.
  const named = [owner, writer].filter(isPid)
  if (named.length === 0) return 'preparing'

  return named.some(isRunning) ? 'preparing' : 'failed'
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
