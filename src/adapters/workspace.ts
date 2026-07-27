import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { homeOf } from './store.js'

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

/**
 * Where a Workspace's environment has got to. A Node whose environment is still
 * `preparing` is one the agent can already read and edit code in — only the
 * heavy directories are still landing.
 */
export type EnvironmentStatus = 'preparing' | 'ready' | 'failed'

/** The ignored paths of a Workspace, split by what they cost to carry. */
type Environment = { files: string[]; directories: string[] }

const NOTHING: Environment = { files: [], directories: [] }

export type ProvisionedWorkspace = {
  workspacePath: string
  branch: string
  /**
   * The commit the child was cut from. Recorded now so a diff of this Node
   * stays stable even after the parent moves on — see ADR-0002.
   */
  forkPointSha: string
}

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const zeroSeparated = (stdout: string): string[] =>
  stdout.split('\0').filter((entry) => entry !== '')

/**
 * Every worktree of this repository, as absolute paths. Workspaces live inside
 * the repository they were cut from — nodegraph's own under `.nodegraph/`, and
 * other tools keep theirs in directories of their own — and those directories
 * are ignored, which is exactly what makes them look like environment. They are
 * not: each is a whole checkout of another Node, and carrying one would copy
 * every sibling Node into this one, then their copies into the next Fork.
 */
const worktreePaths = async (from: string): Promise<string[]> =>
  (await git(from, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))

const holdsAWorktree = (candidate: string, worktrees: string[]): boolean =>
  worktrees.some((worktree) => worktree === candidate || worktree.startsWith(candidate + sep))

/**
 * The environment: everything the parent Workspace needs in order to run that
 * git deliberately does not track — `.env`, `node_modules`, `target`, `.venv`.
 * A child Node that inherits the code but not these cannot be worked in, so its
 * agent's first act would be to build them all over again.
 *
 * `--directory` collapses a wholly ignored directory into one entry, which is
 * also the line drawn here: an ignored *file* is small and copied before Fork
 * returns; an ignored *directory* is an environment and goes to the background.
 * Listing it any other way would walk every file in `node_modules` first.
 */
const readIgnoredEntries = async (from: string): Promise<Environment> => {
  const worktrees = await worktreePaths(from)
  const entries = zeroSeparated(
    await git(from, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ]),
  )

  const directories = entries.filter((entry) => entry.endsWith('/'))

  return {
    // git reports a wholly ignored directory *and* the ignored files inside it.
    // Copying both would land the directory inside its own copy.
    files: entries.filter(
      (entry) =>
        !entry.endsWith('/') && !directories.some((directory) => entry.startsWith(directory)),
    ),
    directories: directories
      .map((entry) => resolve(from, entry.slice(0, -1)))
      // nodegraph's home is ignored like any environment directory and is
      // nothing of the sort: on the first Fork it holds only the graph, which
      // a child must not carry a stale second copy of, and on every Fork after
      // that it holds the other Nodes' Workspaces.
      .filter((entry) => entry !== homeOf(from) && !holdsAWorktree(entry, worktrees))
      .map((entry) => relative(from, entry)),
  }
}

/**
 * An environment directory, copied the cheapest way the filesystem allows.
 *
 * On APFS and on btrfs/xfs this is copy-on-write: a second `node_modules` costs
 * almost no time and almost no disk until one of the two Nodes changes it.
 * Everywhere else it degrades to a plain recursive copy — slower and fatter,
 * but the Node ends up with exactly the same directory either way, which is the
 * only thing anyone outside here is allowed to notice.
 */
const cloneDirectory = async (source: string, destination: string): Promise<void> => {
  const copyOnWrite = process.platform === 'darwin' ? ['-Rc'] : ['-a', '--reflink=auto']

  try {
    await run('cp', [...copyOnWrite, source, destination])
    return
  } catch {
    // No clonefile on this filesystem, or no `cp` worth the name. Fall back —
    // but first clear whatever half a directory the attempt left, or the copy
    // would land *inside* it.
    await rm(destination, { recursive: true, force: true })
  }

  await cp(source, destination, { recursive: true, verbatimSymlinks: true })
}

/**
 * The one place a project gets to say "my environment is not a pile of files".
 * An executable at this path in the parent Workspace replaces everything above:
 * no ignored file is copied, no directory is cloned, the hook is simply run
 * inside the new Workspace and the environment is whatever it leaves behind.
 * Half-doing both would be the worst of it — a project that knows how to build
 * its own environment does not want ours underneath.
 *
 * It runs with the same reach as the agent that is about to be started in the
 * same Workspace, so it grants nobody anything they did not already have.
 */
const ON_FORK = '.nodegraph.on-fork'

const onForkHook = async (from: string): Promise<string | undefined> => {
  const hook = join(from, ON_FORK)
  const found = await stat(hook).catch(() => undefined)

  return found?.isFile() === true ? hook : undefined
}

const runHook = async (hook: string, from: string, workspacePath: string): Promise<void> => {
  await run(hook, [], {
    cwd: workspacePath,
    env: {
      ...process.env,
      NODEGRAPH_WORKSPACE: workspacePath,
      NODEGRAPH_PARENT_WORKSPACE: from,
    },
  })
}

const copyInto = async (from: string, workspacePath: string, relativePath: string) => {
  const destination = join(workspacePath, relativePath)
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(from, relativePath), destination, { recursive: true, verbatimSymlinks: true })
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

/**
 * The environment work this process still owes each Workspace it provisioned.
 * Fork walks away from that work on purpose, so somebody has to keep the handle
 * — otherwise tearing a Workspace down could race a clone still writing to it.
 */
const preparing = new Map<string, Promise<EnvironmentStatus>>()

/**
 * A Workspace's environment status has to survive the process that started the
 * work: the graph is redrawn by whoever is running now, which may be a second
 * nodegraph, or this one after a restart. So it is written down where the
 * Workspace itself keeps its state — git's own per-worktree directory, which
 * nothing walks, `git status` never reports, and `git worktree remove` takes
 * away with the Workspace. A marker inside the Workspace would instead show up
 * as a change the user did not make, and be carried into the next Fork.
 */
const MARKER = 'nodegraph-environment.json'

const markerPath = async (workspacePath: string): Promise<string> =>
  join((await git(workspacePath, ['rev-parse', '--absolute-git-dir'])).trim(), MARKER)

const recordEnvironment = async (
  workspacePath: string,
  status: EnvironmentStatus,
): Promise<void> => {
  const marker = await markerPath(workspacePath)

  // No marker is the resting state, so `ready` is written by taking it away.
  if (status === 'ready') {
    await rm(marker, { force: true })
    return
  }

  // Whose promise this is. Only the nodegraph that started the work can finish
  // it, so if that process is gone the promise died with it.
  await writeFile(marker, `${JSON.stringify({ status, owner: process.pid })}\n`)
}

const stillRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Someone else's process: running, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What a Workspace's environment is doing, as anyone can read it off disk. */
export const readEnvironmentStatus = async (workspacePath: string): Promise<EnvironmentStatus> => {
  let marker: { status?: EnvironmentStatus; owner?: number }
  try {
    marker = JSON.parse(await readFile(await markerPath(workspacePath), 'utf8')) as typeof marker
  } catch {
    // No marker is how a settled Workspace looks, and the only way a Workspace
    // nodegraph never touched can look.
    return 'ready'
  }

  if (marker.status !== 'preparing') return marker.status ?? 'ready'

  // A Node that says "preparing" for ever, because the nodegraph doing the
  // preparing was killed, is worse than one that admits it went wrong: the
  // first is waited on, the second is Discarded and forked again.
  return marker.owner !== undefined && !stillRunning(marker.owner) ? 'failed' : 'preparing'
}

const prepareInBackground = (
  workspacePath: string,
  work: () => Promise<void>,
): Promise<EnvironmentStatus> => {
  const settled = work()
    .then(
      (): EnvironmentStatus => 'ready',
      (): EnvironmentStatus => 'failed',
    )
    .then(async (status) => {
      await recordEnvironment(workspacePath, status).catch(() => undefined)
      return status
    })

  preparing.set(workspacePath, settled)
  return settled
}

/**
 * Waits for whatever this process is still doing to a Workspace's environment.
 * A Workspace nobody here is preparing has already settled, so this answers at
 * once — from disk, since the work may have been another nodegraph's.
 */
export const whenEnvironmentSettles = async (workspacePath: string): Promise<EnvironmentStatus> =>
  (await preparing.get(workspacePath)) ?? readEnvironmentStatus(workspacePath)

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
  const worktrees = await worktreePaths(from)
  // A Workspace need not be ignored to be sitting in the parent's tree: git
  // reports another worktree as one untracked entry, and copying it would carry
  // a whole Node in as a pile of files.
  const added = zeroSeparated(
    await git(from, ['ls-files', '--others', '--exclude-standard', '-z']),
  ).filter((entry) => !holdsAWorktree(resolve(from, entry), worktrees))
  const hook = await onForkHook(from)
  const ignored = hook === undefined ? await readIgnoredEntries(from) : NOTHING

  await git(from, ['worktree', 'add', '-q', '-b', branch, workspacePath, forkPointSha])

  // From here on the Workspace exists, so a failure has to undo it: a Fork that
  // did not finish must leave nothing behind at all.
  try {
    if (patch !== '') await applyPatch(workspacePath, patch)

    for (const relativePath of added) {
      await copyInto(from, workspacePath, relativePath)
    }

    for (const relativePath of ignored.files) {
      await copyInto(from, workspacePath, relativePath)
    }

    // Everything above was cheap enough to keep Fork waiting for. The heavy
    // directories are not, and an agent's first minute goes on reading code it
    // already has — so say the environment is coming, hand the Workspace over,
    // and let the rest land behind the agent's back.
    if (hook !== undefined || ignored.directories.length > 0) {
      await recordEnvironment(workspacePath, 'preparing')

      prepareInBackground(workspacePath, async () => {
        if (hook !== undefined) {
          await runHook(hook, from, workspacePath)
          return
        }

        for (const relativePath of ignored.directories) {
          const destination = join(workspacePath, relativePath)
          await mkdir(dirname(destination), { recursive: true })
          await cloneDirectory(join(from, relativePath), destination)
        }
      })
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
  // Nothing may still be writing into a Workspace that is being taken away, or
  // it reappears a second later, half a Workspace, owned by nobody.
  await whenEnvironmentSettles(workspacePath)
  preparing.delete(workspacePath)

  await git(from, ['worktree', 'remove', '--force', workspacePath])
  await git(from, ['branch', '-D', branch])
}
