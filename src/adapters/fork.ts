import { randomUUID } from 'node:crypto'
import { branchOf, forkRecord, workspaceOf } from '../core/store.js'
import { reconcile } from '../core/reconcile.js'
import { readWorld } from './git.js'
import { prepareHome, readForks, recordFork, type StoredFork } from './store.js'
import { provisionWorkspace, removeWorkspace } from './workspace.js'

/**
 * One Fork, as one transaction: cut a Workspace from the parent Node as it
 * stands right now, then write down where it came from. Either the child Node
 * exists in full or the repository looks like nothing ever happened.
 */

export type ForkRequest = {
  repoPath: string
  parentId: string
}

export const fork = async ({ repoPath, parentId }: ForkRequest): Promise<StoredFork> => {
  const world = await readWorld(repoPath)
  const parent = reconcile(world, await readForks(repoPath)).find((node) => node.id === parentId)
  if (parent === undefined) throw new Error(`No Node ${parentId} to fork from`)

  // Eight hex digits, which is the name `core/store` will insist on when this
  // record is read back — the branch and the Workspace are named after it there
  // too, so a Node's name is the only thing that has to be invented here.
  const id = randomUUID().slice(0, 8)
  // The home has to exist and ignore itself before the Workspace lands inside
  // it, or the parent would see the child as a pile of untracked files.
  const home = await prepareHome(repoPath)

  const workspace = await provisionWorkspace({
    from: parent.workspacePath,
    workspacePath: workspaceOf(home, id),
    branch: branchOf(id),
  })

  const child = forkRecord({
    id,
    parentId,
    home,
    forkPointSha: workspace.forkPointSha,
    createdAt: new Date().toISOString(),
  })

  try {
    await recordFork(repoPath, child)
  } catch (cause) {
    // A Node nobody wrote down is a Workspace nobody will ever find again.
    await removeWorkspace({ from: parent.workspacePath, ...workspace })
    throw cause
  }

  return child
}
