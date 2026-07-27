import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { reconcile } from '../core/reconcile.js'
import { readIntent } from '../core/session.js'
import { discardContext, inheritContext } from './context.js'
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
 * One Fork, as one transaction: take the parent Node's understanding as it
 * stands right this second, cut a Workspace from the parent as it stands right
 * this second, then write both down. Either the child Node exists in full or
 * the repository looks like nothing ever happened.
 *
 * Both halves are copied *here*, at the moment of the Fork, rather than left to
 * be worked out when somebody first opens the child — that is what ADR-0002
 * means by capturing an instant, and it is the difference between a child that
 * inherits the conversation the user was looking at and one that inherits
 * everything the parent went on to say afterwards.
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
  const forks = await readForks(repoPath)
  const parent = reconcile(world, forks).find((node) => node.id === parentId)
  if (parent === undefined) throw new Error(`No Node ${parentId} to fork from`)

  // The Context the child inherits is the parent's as it stands now: the one
  // the parent's agent is living in, or — for a Node nobody has opened yet —
  // the one nodegraph laid down for it when *it* was Forked. Without that
  // second case, forking twice in a row would hand the second child nothing.
  const sessions = await readSessions(repoPath)
  const parentRecord = forks.find((fork) => fork.id === parentId)
  const parentSessionId =
    sessions.find((session) => session.nodeId === parentId)?.sessionId ??
    parentRecord?.sessionId ??
    null

  // A Node that inherited a Context has one that nodegraph itself wrote to
  // disk, so its absence is not "nothing to inherit" — it is our assumption
  // about where claude keeps Contexts having broken, and it is refused aloud.
  const inheritanceIsOwed = parentRecord?.parentSessionId != null

  const id = randomUUID().slice(0, 8)
  const sessionId = randomUUID()
  // The home has to exist and ignore itself before the Workspace lands inside
  // it, or the parent would see the child as a pile of untracked files.
  const home = await prepareHome(repoPath)
  const workspacePath = join(home, WORKSPACES, id)

  // The understanding first — it is the expensive half, and freezing it before
  // the Workspace is built keeps "this instant" as true as it can be.
  const inherited =
    parentSessionId === null
      ? false
      : await inheritContext(
          { workspacePath: parent.workspacePath, sessionId: parentSessionId },
          { workspacePath, sessionId },
          { required: inheritanceIsOwed },
        )

  const undoContext = async (): Promise<void> => {
    if (inherited) await discardContext({ workspacePath, sessionId })
  }

  let workspace
  try {
    workspace = await provisionWorkspace({
      from: parent.workspacePath,
      workspacePath,
      branch: `nodegraph/${id}`,
    })
  } catch (cause) {
    await undoContext()
    throw cause
  }

  const child: StoredFork = {
    id,
    parentId,
    branch: workspace.branch,
    workspacePath: workspace.workspacePath,
    forkPointSha: workspace.forkPointSha,
    createdAt: new Date().toISOString(),
    // Named here rather than at launch: the child's Context has to be findable
    // even if nobody opens its terminal until tomorrow.
    sessionId,
    // Only when the understanding actually came across. Null says plainly that
    // this Node started with a blank head, and nothing downstream has to guess.
    parentSessionId: inherited ? parentSessionId : null,
    intent: reading.intent,
  }

  try {
    await recordFork(repoPath, child)
  } catch (cause) {
    // A Node nobody wrote down is a Workspace nobody will ever find again.
    await removeWorkspace({ from: parent.workspacePath, ...workspace })
    await undoContext()
    throw cause
  }

  return child
}
