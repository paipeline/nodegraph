import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  readStore as believe,
  storePath,
  type Store,
  type StoredFork,
  type StoredSession,
} from '../core/store.js'

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

export type { Store, StoredFork, StoredSession }

const HOME = '.nodegraph'

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


/** The bytes of the store, or null when there is no store yet. */
const readRaw = async (repoPath: string): Promise<string | null> => {
  try {
    return await readFile(storePath(homeOf(repoPath)), 'utf8')
  } catch {
    // Not there is not the same as not readable. A repository before its first
    // Fork has no store, and that is an ordinary, silent, writable state.
    return null
  }
}

/**
 * Whatever is in the file as plain data, believable or not.
 *
 * Kept apart from `readStore` on purpose: what nodegraph *believes* is what
 * every reader gets, and what is *written down* is what a change is appended
 * to. Refusing to believe a record is not a licence to delete it — a record
 * nodegraph did not write is still somebody's: a hand-edit, a half-resolved
 * merge, a newer nodegraph writing a field this one has never heard of.
 */
const readDocument = (raw: string | null): unknown => {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
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

/** Everything else the file said, kept so an upgrade never eats a user's graph. */
const alongside = (document: unknown): Record<string, unknown> =>
  typeof document === 'object' && document !== null
    ? { ...(document as Record<string, unknown>) }
    : {}

/**
 * Written beside the real file and then moved onto it, so a nodegraph that dies
 * mid-write leaves the previous graph intact rather than half a graph. There is
 * no partially-written state a reader can see.
 */
const writeDocument = async (repoPath: string, document: unknown): Promise<void> => {
  const home = await prepareHome(repoPath)
  const settled = storePath(home)
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
 * Thrown when something would have been written to a store nodegraph cannot
 * read. Carries the sentence the user is shown, so the refusal that stops the
 * write and the refusal on the Node's card are the same words.
 */
export class StoreCannotBeRead extends Error {
  constructor(refusal: string) {
    super(refusal)
    this.name = 'StoreCannotBeRead'
  }
}

/**
 * Every change to the graph, one at a time — and never over a store nodegraph
 * cannot read.
 *
 * Recording anything is a read, then a change, then a write; two of those
 * overlapping means the second one writes a graph that never saw the first, and
 * what it silently drops is a Node's Context — the most expensive thing
 * nodegraph holds. Opening two Nodes at once is an ordinary thing for a user to
 * do, so the queue lives at the one place every change has to pass through
 * rather than at each caller.
 *
 * The readability check lives here for the same reason. A store that will not
 * parse reads as no Forks; appending to no Forks writes a file with only the
 * new record in it, and every earlier Node's parentage goes with it. So the one
 * place that writes is the one place that refuses, rather than each caller
 * remembering to ask.
 */
const changing = new Map<string, Promise<void>>()

const change = async (repoPath: string, apply: (document: unknown) => unknown): Promise<void> => {
  const key = resolve(repoPath)
  const queue = changing.get(key) ?? Promise.resolve()

  const done = queue.then(async () => {
    // Read inside the queued turn, so the refusal is decided against the file
    // as it stands at the moment of writing rather than some earlier moment.
    const raw = await readRaw(repoPath)
    const { refusal } = believe(raw, homeOf(repoPath))
    if (refusal !== null) throw new StoreCannotBeRead(refusal)

    await writeDocument(repoPath, apply(readDocument(raw)))
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

/** Everything nodegraph wrote down and still believes, plus why, if it cannot. */
export const readStore = async (repoPath: string): Promise<Store> =>
  believe(await readRaw(repoPath), homeOf(repoPath))

export const readForks = async (repoPath: string): Promise<StoredFork[]> =>
  (await readStore(repoPath)).forks

export const readSessions = async (repoPath: string): Promise<StoredSession[]> =>
  (await readStore(repoPath)).sessions

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
