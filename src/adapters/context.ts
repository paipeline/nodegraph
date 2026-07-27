import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { retarget, contextPath } from '../core/context.js'

/**
 * The Context half of a Fork: nodegraph copies the parent Node's understanding
 * into the child's, itself, at the moment the Fork is taken.
 *
 * It has to be nodegraph that does this. claude can fork a Context of its own
 * (`--resume … --fork-session`), but that lookup only ever searches the
 * directory it is run from, and a child Node runs in a Workspace of its own —
 * a different directory — so it would never find the parent's Context at all.
 * Doing the copy here also means the Context is frozen at the instant of the
 * Fork rather than re-read whenever somebody first opens the child, which is
 * what ADR-0002 asks for. ADR-0004 records the trade this makes.
 */

/**
 * Where claude keeps its Contexts on this machine. `CLAUDE_CONFIG_DIR` is
 * claude's own way of being told, so asking the same question the CLI asks is
 * what keeps the two looking in one place.
 */
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

/** The Context a Node's agent lives in, as a path on this machine. */
export const contextPathOf = (workspacePath: string, sessionId: string): string =>
  contextPath(claudeHome(), workspacePath, sessionId)

/**
 * Whether that Context has actually been created yet. The store can say which
 * Context a Node was promised; only the disk can say whether claude ever made
 * it — an agent that was started and never spoken to leaves nothing behind.
 */
export const hasContext = async (workspacePath: string, sessionId: string): Promise<boolean> => {
  try {
    return (await stat(contextPathOf(workspacePath, sessionId))).isFile()
  } catch {
    return false
  }
}

/**
 * Thrown when a Context nodegraph itself put on disk is no longer where claude
 * would look for it. That means the layout ADR-0004 depends on has moved under
 * us, and the only honest thing to do is say so, by name, rather than hand the
 * user a Node that has quietly forgotten everything.
 */
export class ContextNotWhereClaudeKeepsIt extends Error {
  readonly lookedIn: string

  constructor(lookedIn: string) {
    super(
      `nodegraph could not find this Node’s Context where claude keeps them: ${lookedIn}. ` +
        'The Fork was not taken. Set CLAUDE_CONFIG_DIR if claude keeps its Contexts elsewhere.',
    )
    this.name = 'ContextNotWhereClaudeKeepsIt'
    this.lookedIn = lookedIn
  }
}

export type ContextAt = { workspacePath: string; sessionId: string }

/**
 * Hands the parent's Context to the child, under the child's own name and in
 * the child's own Workspace. Answers whether there was anything to hand over.
 *
 * `required` says that nodegraph laid this Context down itself, so its absence
 * is a broken assumption rather than a Node nobody has talked to; that case is
 * refused loudly. Everything else — a Trunk nobody has opened, an agent started
 * and never spoken to — genuinely has nothing to give, and the child simply
 * begins with a Context of its own.
 */
export const inheritContext = async (
  from: ContextAt,
  to: ContextAt,
  { required }: { required: boolean },
): Promise<boolean> => {
  const source = contextPathOf(from.workspacePath, from.sessionId)

  let understanding: string
  try {
    understanding = await readFile(source, 'utf8')
  } catch {
    if (required) throw new ContextNotWhereClaudeKeepsIt(source)
    return false
  }

  // A file with nothing in it is not an understanding, and inheriting it would
  // look exactly like inheriting something.
  if (understanding.trim() === '') {
    if (required) throw new ContextNotWhereClaudeKeepsIt(source)
    return false
  }

  const target = contextPathOf(to.workspacePath, to.sessionId)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    target,
    retarget(understanding, { sessionId: to.sessionId, cwd: to.workspacePath }),
  )

  return true
}

/** Undoes an inheritance, for a Fork that could not be finished. */
export const discardContext = async ({ workspacePath, sessionId }: ContextAt): Promise<void> => {
  await rm(contextPathOf(workspacePath, sessionId), { force: true })
}
