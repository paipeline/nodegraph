import { spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gitSpawn, runGit } from './git.js'

/**
 * Builds and tears down the code half of a Node: a git worktree of its own,
 * cut from the parent Node's Workspace.
 */

export type ProvisionRequest = {
  /** The parent Node's Workspace — the state being forked from. */
  from: string
  /** Where the child Node's Workspace goes. */
  workspacePath: string
  /** The branch the child Node gets to itself. */
  branch: string
}

export type ProvisionedWorkspace = {
  workspacePath: string
  branch: string
  /**
   * The commit the child was cut from. Recorded now so a diff of this Node
   * stays stable even after the parent moves on — see ADR-0002.
   */
  forkPointSha: string
}

/**
 * Every variable this file hands git is preceded by `--end-of-options`, so git
 * reads it as the name it is and never as an option. The branch and the path
 * are nodegraph's own today, but a Discard will read both back out of the store
 * — a file in the user's repository — and the door has to be shut before it is
 * walked through, not after.
 */
const applyPatch = (cwd: string, patch: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const hardened = gitSpawn(['apply', '--binary', '-'])
    const applying = spawn('git', hardened.args, { cwd, env: hardened.env })
    let stderr = ''

    applying.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    applying.on('error', reject)
    applying.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git apply failed: ${stderr.trim()}`)),
    )
    applying.stdin.end(patch)
  })

export const provisionWorkspace = async ({
  from,
  workspacePath,
  branch,
}: ProvisionRequest): Promise<ProvisionedWorkspace> => {
  const forkPointSha = (await runGit(from, ['rev-parse', 'HEAD'])).trim()

  // Read the parent's uncommitted state *before* the child exists, so what the
  // child receives is the parent as it was at the instant Fork was pressed.
  // The patch covers every tracked change — edits, deletions and renames — and
  // the untracked list covers everything the parent has added since.
  const patch = await runGit(from, ['diff', 'HEAD', '--binary'])
  const added = (await runGit(from, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((path) => path !== '')

  // Two commands, not `worktree add -b`, because `-b` is the one argument git
  // reads twice: it takes the value and hands it on to be parsed as `git
  // branch`'s own arguments, so a branch named `-m` renames the repository's
  // branch out from under it and `-d` tries to delete one. A separator after
  // `-b` is already too late. Made as a branch first, on its own, git will only
  // read the name as a name — and says so instead of doing it.
  await runGit(from, ['branch', '--end-of-options', branch, forkPointSha])

  // From here on the branch exists, so a failure has to undo it: a Fork that
  // did not finish must leave nothing behind at all.
  try {
    await runGit(from, ['worktree', 'add', '-q', '--end-of-options', workspacePath, branch])
  } catch (cause) {
    await runGit(from, ['branch', '-D', '--end-of-options', branch])
    throw cause
  }

  try {
    if (patch !== '') await applyPatch(workspacePath, patch)

    for (const relativePath of added) {
      const destination = join(workspacePath, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(from, relativePath), destination, { recursive: true, verbatimSymlinks: true })
    }
  } catch (cause) {
    await removeWorkspace({ from, workspacePath, branch })
    throw cause
  }

  return { workspacePath, branch, forkPointSha }
}

/**
 * Erases a Workspace and the branch it owned. Used to undo a half-built Fork,
 * and later by Discard.
 */
export const removeWorkspace = async ({
  from,
  workspacePath,
  branch,
}: {
  from: string
  workspacePath: string
  branch: string
}): Promise<void> => {
  await runGit(from, ['worktree', 'remove', '--force', '--end-of-options', workspacePath])
  await runGit(from, ['branch', '-D', '--end-of-options', branch])
}
