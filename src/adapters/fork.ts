import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { reconcile } from '../core/reconcile.js'
import { readIntent } from '../core/session.js'
import { readWorld } from './git.js'
import {
  prepareHome,
  readForks,
  readSessions,
  recordFork,
  type StoredFork,
} from './store.js'
import { provisionWorkspace, removeWorkspace } from './workspace.js'

/**
 * One Fork, as one transaction: cut a Workspace from the parent Node as it
 * stands right now, name the Context the child will inherit into, then write
 * both down. Either the child Node exists in full or the repository looks like
 * nothing ever happened.
 */

export type ForkRequest = {
  repoPath: string
  parentId: string
  /** The one line the user wrote: what this Node goes off to try. */
  intent?: string | null
}

const WORKSPACES = 'workspaces'

export const fork = async ({ repoPath, parentId, intent }: ForkRequest): Promise<StoredFork> => {
  // Read the line before anything is built, so a line that cannot be used
  // costs the user nothing but the message that says why.
  const reading = readIntent(intent)
  if ('refusal' in reading) throw new Error(reading.refusal)

  const world = await readWorld(repoPath)
  const parent = reconcile(world, await readForks(repoPath)).find((node) => node.id === parentId)
  if (parent === undefined) throw new Error(`No Node ${parentId} to fork from`)

  // The Context the child inherits is the parent's as it stands now. A parent
  // nobody has talked to yet has none, and the child simply starts fresh.
  const sessions = await readSessions(repoPath)
  const parentSessionId = sessions.find((session) => session.nodeId === parentId)?.sessionId ?? null

  const id = randomUUID().slice(0, 8)
  // The home has to exist and ignore itself before the Workspace lands inside
  // it, or the parent would see the child as a pile of untracked files.
  const home = await prepareHome(repoPath)

  const workspace = await provisionWorkspace({
    from: parent.workspacePath,
    workspacePath: join(home, WORKSPACES, id),
    branch: `nodegraph/${id}`,
  })

  const child: StoredFork = {
    id,
    parentId,
    branch: workspace.branch,
    workspacePath: workspace.workspacePath,
    forkPointSha: workspace.forkPointSha,
    createdAt: new Date().toISOString(),
    // Named here rather than at launch: the child's Context has to be findable
    // even if nobody opens its terminal until tomorrow.
    sessionId: randomUUID(),
    parentSessionId,
    intent: reading.intent,
  }

  try {
    await recordFork(repoPath, child)
  } catch (cause) {
    // A Node nobody wrote down is a Workspace nobody will ever find again.
    await removeWorkspace({ from: parent.workspacePath, ...workspace })
    throw cause
  }

  return child
}
