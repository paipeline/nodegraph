import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { usableForks, type StoredFork } from '../core/store.js'

/**
 * The one thing the world cannot tell us: who forked from whom, and from which
 * commit. git can say a worktree exists, but never that it was cut from that
 * other Node's understanding — so it is written down at the moment it happens.
 *
 * A single JSON file under `.nodegraph/` in the repo being viewed. See CLAUDE.md.
 *
 * Getting a record back is a separate question from having written one: the
 * file sits in the user's repository where anything can reach it, and what it
 * says goes on to become git's arguments. Which records are believable is a
 * rule, so it lives in `core/store`; this file only fetches the bytes.
 */

export type { StoredFork }

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
 * Whatever is in the file, as json, or nothing.
 *
 * A store that will not parse is the badly-resolved merge `core/store` was
 * written for, so it is answered the same way a hostile record is: believe none
 * of it. Letting the parser throw would take the whole graph down — every Node
 * gone and a parser error in the body of every route — over a file whose only
 * job is to say which Node came from which.
 */
const readDocument = async (repoPath: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(join(homeOf(repoPath), FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/** The records already in the file, believable or not, in the order they sit in. */
const writtenList = (document: unknown, part: 'forks' | 'sessions'): unknown[] => {
  if (typeof document !== 'object' || document === null) return []
  const value = (document as Record<string, unknown>)[part]
  return Array.isArray(value) ? value : []
}

/**
 * Written beside the real file and then moved onto it, so a nodegraph that dies
 * mid-write leaves the previous graph intact rather than half a graph. There is
 * no partially-written state a reader can see.
 */
const writeDocument = async (repoPath: string, document: unknown): Promise<void> => {
  const home = await prepareHome(repoPath)
  const settled = join(home, FILE)
  const pending = `${settled}.${process.pid}.writing`

  try {
    await writeFile(pending, `${JSON.stringify(document, null, 2)}\n`)
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
 *
 * The change is applied to the *document* rather than to what nodegraph
 * believes of it. Refusing to believe a record is not a licence to delete it:
 * a record nodegraph did not write is still somebody's — a hand-edit, a
 * half-resolved merge, a newer nodegraph writing a field this one has never
 * heard of. It stays on disk and stays unbelieved.
 */
const changing = new Map<string, Promise<void>>()

const change = async (repoPath: string, apply: (document: unknown) => unknown): Promise<void> => {
  const key = resolve(repoPath)
  const queue = changing.get(key) ?? Promise.resolve()

  const done = queue.then(async () => {
    await writeDocument(repoPath, apply(await readDocument(repoPath)))
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

/** Everything else the file said, kept so an upgrade never eats a user's graph. */
const alongside = (document: unknown): Record<string, unknown> =>
  typeof document === 'object' && document !== null ? { ...(document as Record<string, unknown>) } : {}

export const readForks = async (repoPath: string): Promise<StoredFork[]> =>
  usableForks(await readDocument(repoPath), homeOf(repoPath))

export const readSessions = async (repoPath: string): Promise<StoredSession[]> =>
  writtenList(await readDocument(repoPath), 'sessions') as StoredSession[]

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> =>
  change(repoPath, (document) => ({
    ...alongside(document),
    forks: [...writtenList(document, 'forks'), fork],
  }))

/** One Context per Node: recording a second one replaces the first. */
export const recordSession = async (repoPath: string, session: StoredSession): Promise<void> =>
  change(repoPath, (document) => ({
    ...alongside(document),
    sessions: [
      ...writtenList(document, 'sessions').filter(
        (kept) => (kept as StoredSession | null)?.nodeId !== session.nodeId,
      ),
      session,
    ],
  }))
