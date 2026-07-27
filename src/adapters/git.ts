import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorldSnapshot, WorldWorktree } from '../core/reconcile.js'

const run = promisify(execFile)

/**
 * The one place nodegraph starts a git.
 *
 * git is not only a program that reads a repository — it is a program that runs
 * whatever the repository it finds itself in has told it to run. `core.fsmonitor`
 * names a command git starts on an ordinary `diff` or `ls-files`. That is the
 * user's own arrangement when the user types `git status`; it is not what they
 * arranged when a background process polls their repository every two seconds
 * without being watched. So nodegraph says, on every git it starts, that it is
 * not here to run anybody's commands.
 *
 * This is the second door, not the first. The first is that the directory git
 * is started in is never a string out of the store — it is one git itself has
 * just listed as a worktree of the repository the user opened. See
 * `core/store` for that one.
 */
const NOT_HERE_TO_RUN_COMMANDS = ['-c', 'core.fsmonitor=']

/**
 * The system-wide config is one more file that can name a command, and it is
 * not one the repository the user opened has anything to do with — so nodegraph's
 * numbers do not come from it either. The user's own `~/.gitconfig` is left
 * alone on purpose: it decides things like `core.excludesFile`, and a diff that
 * disagreed with the one the user sees in their own terminal would be worse
 * than useless.
 */
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1' })

/** How much output one git is allowed to hand back — a numstat of a large Node. */
const MAX_OUTPUT = 64 * 1024 * 1024

export const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', [...NOT_HERE_TO_RUN_COMMANDS, ...args], {
    cwd,
    env: gitEnv(),
    maxBuffer: MAX_OUTPUT,
  })
  return stdout
}

/**
 * The same, for the one git that needs its stdin written to rather than its
 * stdout read. `spawn` cannot go through `runGit`, so the terms it runs on are
 * exported instead of copied.
 */
export const gitSpawn = (args: string[]): { args: string[]; env: NodeJS.ProcessEnv } => ({
  args: [...NOT_HERE_TO_RUN_COMMANDS, ...args],
  env: gitEnv(),
})

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
    stdout = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  } catch (cause) {
    throw new Error(`Not a git repository: ${repoPath}`, { cause })
  }

  return { repoPath, worktrees: parseWorktrees(stdout) }
}
