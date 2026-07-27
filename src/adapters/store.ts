import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

export const readForks = async (repoPath: string): Promise<StoredFork[]> =>
  usableForks(await readDocument(repoPath), homeOf(repoPath))

/** The records already in the file, believable or not, in the order they sit in. */
const written = (document: unknown): unknown[] => {
  if (typeof document !== 'object' || document === null) return []
  const { forks } = document as { forks?: unknown }
  return Array.isArray(forks) ? forks : []
}

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> => {
  // Appended to what is already written, not to what is already believed.
  // Refusing to believe a record is not a licence to delete it: the next Fork
  // rewrites this file, and a record nodegraph did not write is still
  // somebody's — a hand-edit, a half-resolved merge, a newer nodegraph writing
  // a field this one has never heard of. It stays on disk and stays unbelieved.
  const forks = [...written(await readDocument(repoPath)), fork]

  const home = await prepareHome(repoPath)
  await writeFile(join(home, FILE), `${JSON.stringify({ forks }, null, 2)}\n`)
}
