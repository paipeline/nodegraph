import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The one thing the world cannot tell us: who forked from whom, and from which
 * commit. git can say a worktree exists, but never that it was cut from that
 * other Node's understanding — so it is written down at the moment it happens.
 *
 * A single JSON file under `.nodegraph/` in the repo being viewed. See CLAUDE.md.
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
 * Which Context a Node's agent is living in, written down the moment it is
 * first started, so that the next nodegraph goes back to that conversation
 * rather than starting the Node over.
 *
 * It says the Context's *name*, never that claude has created it: an agent that
 * was opened and never spoken to leaves nothing on disk, and a Node that was
 * resumed on the strength of this record alone would die on the spot, every
 * time, for good. Existence is read off the disk — see `hasContext`.
 */
export type StoredSession = {
  nodeId: string
  sessionId: string
  startedAt: string
}

type Graph = { forks: StoredFork[]; sessions: StoredSession[] }

const HOME = '.nodegraph'
const FILE = 'graph.json'

export const homeOf = (repoPath: string): string => join(repoPath, HOME)

/**
 * Creates `.nodegraph/` and makes it ignore itself, so nothing nodegraph keeps
 * there — the store, the Workspaces — ever shows up as a change in the user's
 * repository. A tool that dirties your working tree is a tool you stop trusting.
 */
export const prepareHome = async (repoPath: string): Promise<string> => {
  const home = homeOf(repoPath)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitignore'), '*\n')
  return home
}

/**
 * Everything nodegraph knows, as one value. A store file written by an older
 * nodegraph knows about Forks and nothing else, so every part is read as
 * optional — an upgrade must never make a user's existing graph unreadable.
 */
const readGraph = async (repoPath: string): Promise<Graph> => {
  let raw: string
  try {
    raw = await readFile(join(homeOf(repoPath), FILE), 'utf8')
  } catch {
    return { forks: [], sessions: [] }
  }

  const stored = JSON.parse(raw) as Partial<Graph>
  return { forks: stored.forks ?? [], sessions: stored.sessions ?? [] }
}

/**
 * Written beside the real file and then moved onto it, so a nodegraph that dies
 * mid-write leaves the previous graph intact rather than half a graph. There is
 * no partially-written state a reader can see.
 */
const writeGraph = async (repoPath: string, graph: Graph): Promise<void> => {
  const home = await prepareHome(repoPath)
  const settled = join(home, FILE)
  const pending = `${settled}.${process.pid}.writing`

  try {
    await writeFile(pending, `${JSON.stringify(graph, null, 2)}\n`)
    await rename(pending, settled)
  } catch (cause) {
    await rm(pending, { force: true })
    throw cause
  }
}

/**
 * Every change to the graph, one at a time.
 *
 * Recording anything is a read, then a change, then a write; two of those
 * overlapping means the second one writes a graph that never saw the first, and
 * what it silently drops is a Node's Context — the most expensive thing
 * nodegraph holds. Opening two Nodes at once is an ordinary thing for a user to
 * do, so the queue lives at the one place every change has to pass through
 * rather than at each caller.
 */
const changing = new Map<string, Promise<void>>()

const change = async (repoPath: string, apply: (graph: Graph) => Graph): Promise<void> => {
  const key = resolve(repoPath)
  const queue = changing.get(key) ?? Promise.resolve()

  const done = queue.then(async () => {
    await writeGraph(repoPath, apply(await readGraph(repoPath)))
  })

  // The queue must survive a change that failed, or one unwritable moment would
  // wedge the store for the rest of the run. The caller still sees the failure.
  const settled = done.then(
    () => undefined,
    () => undefined,
  )
  changing.set(key, settled)
  void settled.then(() => {
    if (changing.get(key) === settled) changing.delete(key)
  })

  return done
}

export const readForks = async (repoPath: string): Promise<StoredFork[]> =>
  (await readGraph(repoPath)).forks

export const readSessions = async (repoPath: string): Promise<StoredSession[]> =>
  (await readGraph(repoPath)).sessions

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> =>
  change(repoPath, (graph) => ({ ...graph, forks: [...graph.forks, fork] }))

/** One Context per Node: recording a second one replaces the first. */
export const recordSession = async (repoPath: string, session: StoredSession): Promise<void> =>
  change(repoPath, (graph) => ({
    ...graph,
    sessions: [...graph.sessions.filter((kept) => kept.nodeId !== session.nodeId), session],
  }))
