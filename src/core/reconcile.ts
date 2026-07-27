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
 */
export const reconcile = (world: WorldSnapshot, forks: RecordedFork[]): NodeView[] => {
  const primary = world.worktrees.find((worktree) => worktree.isPrimary)
  if (!primary) return []

  return [
    {
      id: TRUNK_ID,
      kind: 'trunk',
      workspacePath: primary.path,
      branch: primary.branch,
      parentId: null,
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
        },
      ]
    }),
  ]
}
