import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorldSnapshot, WorldWorktree } from '../core/reconcile.js'

const run = promisify(execFile)

const BRANCH_PREFIX = 'refs/heads/'

const parseWorktrees = (porcelain: string): WorldWorktree[] =>
  porcelain
    .trim()
    .split(/\n\s*\n/)
    .map((block, index) => {
      const lines = block.split('\n')
      const path = lines
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length)
      const ref = lines
        .find((line) => line.startsWith('branch '))
        ?.slice('branch '.length)

      return {
        path: path ?? '',
        branch: ref?.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : null,
        isPrimary: index === 0,
      }
    })
    .filter((worktree) => worktree.path !== '')

/**
 * Gathers the git side of the world. The first worktree git reports is always
 * the repository itself, which is what makes it the Trunk.
 */
export const readWorld = async (repoPath: string): Promise<WorldSnapshot> => {
  let stdout: string
  try {
    ;({ stdout } = await run('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    }))
  } catch (cause) {
    throw new Error(`Not a git repository: ${repoPath}`, { cause })
  }

  return { repoPath, worktrees: parseWorktrees(stdout) }
}
