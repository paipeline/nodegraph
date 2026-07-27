import { join } from 'node:path'

/**
 * Where claude keeps a Context, and how a Context is handed to the Node that
 * inherited it.
 *
 * This is nodegraph's one assumption about somebody else's private layout, and
 * ADR-0004 explains why we take it. It is written as pure functions so the
 * assumption is stated once, in a place that can be read and tested, instead of
 * being spread through the adapters as string arithmetic.
 */

/**
 * The directory claude files a Workspace's Contexts under. Every separator in
 * the path — slash, dot and underscore alike — is flattened to a dash, which is
 * what makes the directory name unambiguous per Workspace and is exactly what
 * was observed on disk.
 */
export const projectDirName = (workspacePath: string): string =>
  workspacePath.replace(/[/._]/gu, '-')

/** The file one Context lives in, for an agent run in that Workspace. */
export const contextPath = (
  claudeHome: string,
  workspacePath: string,
  sessionId: string,
): string => join(claudeHome, 'projects', projectDirName(workspacePath), `${sessionId}.jsonl`)

/**
 * The parent's Context, re-addressed to the Node that has just inherited it:
 * the Context now belongs to the child, and it is had in the child's Workspace.
 *
 * Only the two fields that say *whose* it is are rewritten — never the words.
 * A line that is not a record we recognise is passed through exactly as it came,
 * because dropping a line we do not understand would be dropping understanding.
 */
export const retarget = (context: string, to: { sessionId: string; cwd: string }): string =>
  context
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line

      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        return line
      }
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return line

      const entry = record as Record<string, unknown>
      return JSON.stringify({
        ...entry,
        ...('sessionId' in entry ? { sessionId: to.sessionId } : {}),
        ...('cwd' in entry ? { cwd: to.cwd } : {}),
      })
    })
    .join('\n')
