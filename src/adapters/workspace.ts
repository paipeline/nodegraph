import { execFile, spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Builds and tears down the code half of a Node: a git worktree of its own,
 * cut from the parent Node's Workspace.
 */

const run = promisify(execFile)

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
 * Every variable this file hands git is followed by `--end-of-options`, so git
 * reads it as the name it is and never as an option. The branch and the path
 * are nodegraph's own today, but a Discard will read both back out of the store
 * — a file in the user's repository — and the door has to be shut before it is
 * walked through, not after.
 */
const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const applyPatch = (cwd: string, patch: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const applying = spawn('git', ['apply', '--binary', '-'], { cwd })
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
  const forkPointSha = (await git(from, ['rev-parse', 'HEAD'])).trim()

  // Read the parent's uncommitted state *before* the child exists, so what the
  // child receives is the parent as it was at the instant Fork was pressed.
  // The patch covers every tracked change — edits, deletions and renames — and
  // the untracked list covers everything the parent has added since.
  const patch = await git(from, ['diff', 'HEAD', '--binary'])
  const added = (await git(from, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((path) => path !== '')

  await git(from, [
    'worktree',
    'add',
    '-q',
    '-b',
    branch,
    '--end-of-options',
    workspacePath,
    forkPointSha,
  ])

  // From here on the Workspace exists, so a failure has to undo it: a Fork that
  // did not finish must leave nothing behind at all.
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
  await git(from, ['worktree', 'remove', '--force', '--end-of-options', workspacePath])
  await git(from, ['branch', '-D', '--end-of-options', branch])
}
