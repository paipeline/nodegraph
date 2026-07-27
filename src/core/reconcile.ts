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
  kind: 'trunk'
  workspacePath: string
  branch: string | null
  parentId: string | null
}

export const TRUNK_ID = 'trunk'

export const reconcile = (world: WorldSnapshot): NodeView[] => {
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
  ]
}
