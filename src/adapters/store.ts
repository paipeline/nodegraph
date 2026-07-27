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

export const readForks = async (repoPath: string): Promise<StoredFork[]> => {
  let raw: string
  try {
    raw = await readFile(join(homeOf(repoPath), FILE), 'utf8')
  } catch {
    return []
  }

  return usableForks(JSON.parse(raw))
}

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> => {
  const forks = [...(await readForks(repoPath)), fork]

  const home = await prepareHome(repoPath)
  await writeFile(join(home, FILE), `${JSON.stringify({ forks }, null, 2)}\n`)
}
