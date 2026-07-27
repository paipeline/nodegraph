import { join } from 'node:path'
import { TRUNK_ID } from './reconcile.js'
import { readIntent } from './session.js'

/**
 * What nodegraph is willing to believe it wrote down.
 *
 * The store is a single json file inside the repository being viewed, which
 * means what comes out of it is whatever is on that disk: a hand-edit, a merge
 * somebody resolved badly, or a `.nodegraph/graph.json` that was committed to a
 * repository before it was cloned. It is read on the first poll, before any
 * Fork exists, and ADR-0003 is explicit that nothing here is behind a trust
 * boundary.
 *
 * **This file is the boundary.** Every field of a record ends up somewhere
 * real — git's argv, the **directory git is run in**, `claude`'s argv, a
 * filename under claude's home — so the checking happens once, here, before
 * anything downstream can hand one to a process. Adding a check at the call
 * site that happens to use a field next is how the same hole gets opened five
 * times: the sixth call site is unguarded again.
 *
 * The working directory is the field with the longest reach: everything git
 * decides after it starts follows from where it started, including which
 * repository's config it obeys, and git config names commands
 * (`core.fsmonitor`, `diff.external`, `filter.*.clean`). Validating the
 * argument and not the directory would be bolting the door and leaving the
 * frame out.
 *
 * So the rule is not "does this look harmless" but "is this a record nodegraph
 * itself wrote": every field is either generated from the Node's own name by
 * `forkRecord`/`sessionRecord` below — which are the *only* ways a record is
 * made — or is recomputed and compared on the way back. A record that could not
 * have come from nodegraph is dropped **whole** rather than repaired
 * field-by-field: `reconcile` already refuses to draw a Fork git no longer has,
 * and the graph is allowed to forget, never to lie.
 *
 * Dropping is safe precisely because nothing here ever deletes: a record that is
 * not believed stays on disk untouched, and a store that cannot be read at all
 * stops nodegraph writing rather than being replaced. See `readStore`.
 *
 * Pure by design: plain data in, plain data out. `node:path` is string work, not
 * I/O. See CLAUDE.md.
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
 */
export type StoredSession = {
  nodeId: string
  sessionId: string
  startedAt: string
}

/** Everything nodegraph wrote down, and whether it could be read at all. */
export type Store = {
  forks: StoredFork[]
  sessions: StoredSession[]
  /**
   * Why this store could not be read, or null when it could. Not an error and
   * not an empty store: see `readStore`.
   */
  refusal: string | null
}

/**
 * The name nodegraph gives a Node: the first eight characters of a v4 uuid, so
 * eight lowercase hex digits and nothing else. `trunk` is not among them, which
 * matters — the Trunk is on every graph, so its name is the easiest one for a
 * record to wear in the hope of being waved through.
 */
const FORK_ID = /^[0-9a-f]{8}$/

/**
 * A commit, spelled the way git spells one. `git rev-parse HEAD` gives 40 hex
 * digits (64 in a sha256 repository) and git's shortest legal abbreviation is
 * four, so anything outside that is not the commit a Node was cut from.
 *
 * A leading dash cannot survive this, which is the point: git decides what is
 * an option by looking at the first character, and `--output=…` in the place of
 * a commit truncates the file it names.
 */
const OBJECT_NAME = /^[0-9a-f]{4,64}$/i

/**
 * The name of a Context, exactly as `randomUUID()` spells one — which is the
 * only way nodegraph ever names one.
 *
 * This one field reaches two different kinds of interpreter. It is the value of
 * `--resume` / `--session-id` in a real `claude`'s argv, where a leading dash
 * makes it a flag of its own and `--dangerously-skip-permissions` is a flag
 * claude has. And it is a **filename component** under claude's home, where a
 * `..` walks out of the directory nodegraph meant and turns "has this Node a
 * Context?" into "read me that file". A uuid is neither.
 */
const CONTEXT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where the one directory a Node owns lives, under nodegraph's home. */
const WORKSPACES = 'workspaces'

/** The one file nodegraph keeps, named in one place. */
export const STORE_FILE = 'graph.json'

export const storePath = (home: string): string => join(home, STORE_FILE)

/** The branch a Node gets to itself, named after the Node. */
export const branchOf = (id: string): string => `nodegraph/${id}`

/** The Workspace a Node gets to itself, named after the Node. */
export const workspaceOf = (home: string, id: string): string => join(home, WORKSPACES, id)

const isForkId = (value: unknown): value is string =>
  typeof value === 'string' && FORK_ID.test(value)

const isNodeId = (value: unknown): value is string => value === TRUNK_ID || isForkId(value)

const isContextName = (value: unknown): value is string =>
  typeof value === 'string' && CONTEXT_NAME.test(value)

/**
 * A stored line is believed only if it is the line nodegraph would have written
 * down. `readIntent` is the rule for the line the user types; running the
 * stored line back through it and insisting on the same string is what makes
 * the two one rule instead of two that drift.
 *
 * So `--dangerously-skip-permissions` is refused because `readIntent` refuses
 * it, and `  padded  ` is refused because `readIntent` would have stored
 * `padded` — a line nodegraph would have tidied is a line nodegraph did not
 * write, and repairing it here would put words in the user's mouth.
 */
const isStoredIntent = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const reading = readIntent(value)
  return 'intent' in reading && reading.intent === value
}

/** Thrown when nodegraph is asked to write down something it would not believe. */
export class NotARecordNodegraphWrites extends Error {
  constructor(what: string) {
    super(`nodegraph will not write down ${what}`)
    this.name = 'NotARecordNodegraphWrites'
  }
}

/**
 * The record nodegraph writes for a Fork.
 *
 * Everything that is not a fact about the world is derived from the Node's name
 * right here, which is what makes the check on the way back possible at all: a
 * reader can recompute every derived field and compare. Written and believed
 * are one rule, said once, so they cannot drift apart.
 *
 * It refuses rather than writing a record it would not read back. A Fork that
 * cannot be written down is a Fork that does not happen, which the caller
 * already knows how to undo; a Fork written down in a shape nobody believes is
 * a Workspace on disk that no Node will ever point at again.
 */
export const forkRecord = (made: {
  id: string
  parentId: string
  home: string
  forkPointSha: string
  createdAt: string
  sessionId?: string
  parentSessionId?: string | null
  intent?: string | null
}): StoredFork => {
  if (made.sessionId !== undefined && !isContextName(made.sessionId)) {
    throw new NotARecordNodegraphWrites('a Context it did not name')
  }
  if (made.parentSessionId != null && !isContextName(made.parentSessionId)) {
    throw new NotARecordNodegraphWrites('an inherited Context it did not name')
  }
  if (made.intent != null && !isStoredIntent(made.intent)) {
    throw new NotARecordNodegraphWrites('a line claude would read as a flag rather than as words')
  }

  return {
    id: made.id,
    parentId: made.parentId,
    branch: branchOf(made.id),
    workspacePath: workspaceOf(made.home, made.id),
    forkPointSha: made.forkPointSha,
    createdAt: made.createdAt,
    sessionId: made.sessionId,
    // Written as `null` rather than left out, because "this Node started with a
    // blank head" and "nobody has said" are different answers and a reader must
    // not have to tell them apart. `asFork` reads an absent one back the same way.
    parentSessionId: made.parentSessionId ?? null,
    intent: made.intent ?? null,
  }
}

/** The record nodegraph writes for a Node's Context. The only way one is made. */
export const sessionRecord = (made: {
  nodeId: string
  sessionId: string
  startedAt: string
}): StoredSession => {
  if (!isContextName(made.sessionId)) {
    throw new NotARecordNodegraphWrites('a Context it did not name')
  }
  if (!isNodeId(made.nodeId)) {
    throw new NotARecordNodegraphWrites('a Context belonging to a Node it did not name')
  }

  return { nodeId: made.nodeId, sessionId: made.sessionId, startedAt: made.startedAt }
}

const asFork = (candidate: unknown, home: string): StoredFork | null => {
  if (typeof candidate !== 'object' || candidate === null) return null

  const {
    id,
    parentId,
    branch,
    workspacePath,
    forkPointSha,
    createdAt,
    sessionId,
    parentSessionId,
    intent,
  } = candidate as Record<string, unknown>

  if (!isForkId(id)) return null
  if (!isNodeId(parentId)) return null
  if (branch !== branchOf(id)) return null
  if (workspacePath !== workspaceOf(home, id)) return null
  if (typeof forkPointSha !== 'string' || !OBJECT_NAME.test(forkPointSha)) return null
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null

  // The three that reach `claude` rather than git. Absent is a real answer for
  // all three — records written before nodegraph carried Contexts have none —
  // but present-and-wrong is not, and is not quietly dropped to absent either:
  // a record carrying a Context name nobody could have given is a record
  // nodegraph did not write, whatever else it got right.
  if (sessionId !== undefined && !isContextName(sessionId)) return null
  if (parentSessionId !== undefined && parentSessionId !== null && !isContextName(parentSessionId)) {
    return null
  }
  if (intent !== undefined && intent !== null && !isStoredIntent(intent)) return null

  // Rebuilt field by field rather than passed through, so nothing that happens
  // to be sitting in the json travels on with it.
  return {
    id,
    parentId,
    branch,
    workspacePath,
    forkPointSha,
    createdAt,
    sessionId: sessionId as string | undefined,
    parentSessionId: (parentSessionId as string | null | undefined) ?? null,
    intent: (intent as string | null | undefined) ?? null,
  }
}

const asSession = (candidate: unknown): StoredSession | null => {
  if (typeof candidate !== 'object' || candidate === null) return null

  const { nodeId, sessionId, startedAt } = candidate as Record<string, unknown>

  if (!isNodeId(nodeId)) return null
  if (!isContextName(sessionId)) return null
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null

  return { nodeId, sessionId, startedAt }
}

const listIn = (document: unknown, part: 'forks' | 'sessions'): unknown[] => {
  if (typeof document !== 'object' || document === null) return []
  const value = (document as Record<string, unknown>)[part]
  return Array.isArray(value) ? value : []
}

/**
 * The Forks a parsed store is worth believing, and only those.
 *
 * `home` is nodegraph's own directory in the repository being read — the one
 * place a Workspace it made can be. It is passed in rather than looked up
 * because finding it is the adapter's job and comparing against it is this one.
 */
export const usableForks = (document: unknown, home: string): StoredFork[] => {
  // One Node, one record. Two records under one name would be one Node measured
  // twice, and which of the two answered would be whichever was written last.
  const seen = new Set<string>()

  return listIn(document, 'forks').flatMap((candidate) => {
    const fork = asFork(candidate, home)
    if (fork === null || seen.has(fork.id)) return []
    seen.add(fork.id)
    return [fork]
  })
}

/** The Contexts a parsed store is worth believing. One Node, one Context. */
export const usableSessions = (document: unknown): StoredSession[] => {
  const seen = new Set<string>()

  return listIn(document, 'sessions').flatMap((candidate) => {
    const session = asSession(candidate)
    if (session === null || seen.has(session.nodeId)) return []
    seen.add(session.nodeId)
    return [session]
  })
}

/**
 * The whole store, and the one answer that is neither "here it is" nor "there
 * is nothing".
 *
 * A store that will not parse is not an empty store. Reading it as one is how
 * every Node's parentage gets destroyed: the graph draws with no Forks, the
 * next Fork writes a file holding only the new record, and which Node came from
 * which — the one thing git can never say again — is gone, while the Workspaces
 * and branches stay on disk as orphans nothing can reach.
 *
 * So it is answered with a refusal instead. Nothing here deletes and nothing
 * here repairs: the caller shows the sentence and leaves the file exactly where
 * it is, so repairing the json in an editor brings every Node back.
 *
 * `raw` is null when there is no file at all, which is an ordinary thing — it
 * is what a repository looks like before its first Fork.
 */
export const readStore = (raw: string | null, home: string): Store => {
  if (raw === null) return { forks: [], sessions: [], refusal: null }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return { forks: [], sessions: [], refusal: unreadable(home) }
  }

  // Not an object is not a store. A json array, a bare `null`, a quoted string:
  // none of them can be appended to, so writing over one would be replacing a
  // file somebody put there rather than adding to one nodegraph wrote.
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { forks: [], sessions: [], refusal: unreadable(home) }
  }

  return {
    forks: usableForks(document, home),
    sessions: usableSessions(document),
    refusal: null,
  }
}

const unreadable = (home: string): string =>
  `nodegraph cannot read ${storePath(home)}, so it has not written to that file and will not ` +
  'while it stays this way. It is the only record of which Node came from which, and from which ' +
  'commit — git cannot say. Repair the json and every Node comes back; move the file aside to ' +
  'start over.'
