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

export const readForks = async (repoPath: string): Promise<StoredFork[]> => {
  let raw: string
  try {
    raw = await readFile(join(homeOf(repoPath), FILE), 'utf8')
  } catch {
    return []
  }

  return (JSON.parse(raw) as { forks: StoredFork[] }).forks
}

export const recordFork = async (repoPath: string, fork: StoredFork): Promise<void> => {
  const forks = [...(await readForks(repoPath)), fork]

  const home = await prepareHome(repoPath)
  await writeFile(join(home, FILE), `${JSON.stringify({ forks }, null, 2)}\n`)
}
