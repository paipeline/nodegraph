import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
   * The Context this Node's agent will live in, named at the moment of the
   * Fork so that the first launch can cut it from the parent's.
   */
  sessionId?: string
  /**
   * The parent's Context as it stood at that moment. Null when the parent had
   * never been talked to — there is nothing to inherit from silence.
   */
  parentSessionId?: string | null
  /** The one line written at Fork time: this Node's first instruction and its title. */
  intent?: string | null
}

/**
 * Which Context a Node's agent is actually living in, written down the moment
 * it is first started. Its presence is also the answer to "has this Node's own
 * Context been cut yet" — without it a reopened Node would be forked from its
 * parent all over again, throwing away everything it had since worked out.
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

const writeGraph = async (repoPath: string, graph: Graph): Promise<void> => {
  const home = await prepareHome(repoPath)
  await writeFile(join(home, FILE), `${JSON.stringify(graph, null, 2)}\n`)
}

export const readForks = async (repoPath: string): Promise<StoredFork[]> =>
  (await readGraph(repoPath)).forks

export const readSessions = async (repoPath: string): Promise<StoredSession[]> =>
  (await readGraph(repoPath)).sessions

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> => {
  const graph = await readGraph(repoPath)
  await writeGraph(repoPath, { ...graph, forks: [...graph.forks, fork] })
}

/** One Context per Node: recording a second one replaces the first. */
export const recordSession = async (repoPath: string, session: StoredSession): Promise<void> => {
  const graph = await readGraph(repoPath)
  await writeGraph(repoPath, {
    ...graph,
    sessions: [...graph.sessions.filter((kept) => kept.nodeId !== session.nodeId), session],
  })
}
