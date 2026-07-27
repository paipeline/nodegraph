import type { EnvironmentStatus } from './environment.js'

/**
 * Projects a snapshot of the world into the Nodes the graph should show.
 *
 * Pure by design: the world is gathered by adapters and handed here as plain
 * data, so every interesting rule can be tested without a repository, a
 * process or a network. See CLAUDE.md.
 */

export type WorldWorktree = {
  path: string
  branch: string | null
  isPrimary: boolean
}

export type WorldSnapshot = {
  repoPath: string
  worktrees: WorldWorktree[]
}

export type NodeView = {
  id: string
  kind: 'trunk' | 'fork'
  workspacePath: string
  branch: string | null
  parentId: string | null
  /**
   * Whether the environment this Node was forked with has finished landing.
   * A Node the agent can already work in, whose `node_modules` is still being
   * cloned behind it, has to say so — otherwise the user is looking at a
   * Workspace that is quietly half-built.
   */
  environment: EnvironmentStatus
}

/** What only nodegraph knows about a Node: where it came from, and from when. */
export type RecordedFork = {
  id: string
  parentId: string
  workspacePath: string
  forkPointSha: string
}

export const TRUNK_ID = 'trunk'

/**
 * The store says which Node came from which; the world says which of them still
 * exist. A Fork we remember but git no longer has is not drawn — the graph is
 * allowed to forget, never to lie.
 *
 * `environments` is what each Workspace's environment is doing, keyed by path,
 * as an adapter read it off disk. A Workspace nobody reported on has nothing
 * still landing: the Trunk is nobody's Fork, and a Node whose environment
 * settled long ago leaves no trace of ever having been busy.
 */
export const reconcile = (
  world: WorldSnapshot,
  forks: RecordedFork[],
  environments: Record<string, EnvironmentStatus> = {},
): NodeView[] => {
  const primary = world.worktrees.find((worktree) => worktree.isPrimary)
  if (!primary) return []

  return [
    {
      id: TRUNK_ID,
      kind: 'trunk',
      workspacePath: primary.path,
      branch: primary.branch,
      parentId: null,
      // Trunk is the one Node nodegraph never built, so there is nothing it
      // could be in the middle of building.
      environment: 'ready',
    },
    ...forks.flatMap((fork) => {
      const worktree = world.worktrees.find((candidate) => candidate.path === fork.workspacePath)
      if (worktree === undefined) return []

      return [
        {
          id: fork.id,
          kind: 'fork' as const,
          workspacePath: worktree.path,
          branch: worktree.branch,
          parentId: fork.parentId,
          environment: environments[worktree.path] ?? 'ready',
        },
      ]
    }),
  ]
}
