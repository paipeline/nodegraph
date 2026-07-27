import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  carriedAdditions,
  gitDirOf,
  hookRefusal,
  NO_ENVIRONMENT,
  ON_FORK,
  readHookVerdict,
  splitEnvironment,
  statusFromMarker,
  type Environment,
  type EnvironmentStatus,
  type WorkspaceReport,
} from '../core/environment.js'
import { homeOf } from './store.js'

/**
 * Builds and tears down the code half of a Node: a git worktree of its own,
 * cut from the parent Node's Workspace.
 *
 * Everything here is I/O — git, the filesystem, the project's own hook. The
 * rules about what any of it means live in `core/environment.ts`.
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

export type { EnvironmentStatus }

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

/** Every worktree of this repository, as absolute paths. */
const worktreePaths = async (from: string): Promise<string[]> =>
  (await git(from, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))

/**
 * What the parent Workspace needs in order to run that git does not track,
 * asked of git and sorted by `splitEnvironment`. `--directory` collapses a
 * wholly ignored directory into one entry — listing it any other way would walk
 * every file in `node_modules` first.
 */
const readIgnoredEntries = async (from: string): Promise<Environment> =>
  splitEnvironment({
    from,
    entries: zeroSeparated(
      await git(from, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ]),
    ),
    home: homeOf(from),
    worktrees: await worktreePaths(from),
  })

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

const markerPath = async (workspacePath: string): Promise<string> => {
  // Every linked worktree keeps a `.git` file pointing at its own admin
  // directory, and reading it beats spawning a git for every Node on every
  // poll. Anything else — a real `.git` directory, a file we do not recognise
  // — and git is asked properly.
  const link = await readFile(join(workspacePath, '.git'), 'utf8').catch(() => undefined)
  const gitDir = link === undefined ? undefined : gitDirOf(workspacePath, link)
  const asked = gitDir ?? (await git(workspacePath, ['rev-parse', '--absolute-git-dir'])).trim()

  return join(asked, MARKER)
}

/**
 * Says that this Workspace is still being filled, and by whom.
 *
 * `owner` is the nodegraph that promised the environment and will write down
 * how it ended; `writer` is the child process actually putting bytes in the
 * Workspace right now, if there is one. Both are named because they do not die
 * together — see `statusFromMarker`.
 *
 * Written synchronously on purpose: it is called the instant a child process
 * exists, and an `await` between the two would be a window in which something
 * is writing into a Workspace that says nothing is.
 */
const claimWorkspace = (marker: string, writer?: number): void => {
  try {
    writeFileSync(marker, `${JSON.stringify({ status: 'preparing', owner: process.pid, writer })}\n`)
  } catch {
    // The Workspace — or the git directory its marker lives in — has been taken
    // away already. There is nothing left to claim, and nobody left to tell.
  }
}

const settleEnvironment = async (marker: string, status: EnvironmentStatus): Promise<void> => {
  // No marker is the resting state, so `ready` is written by taking it away.
  if (status === 'ready') {
    await rm(marker, { force: true })
    return
  }

  await writeFile(marker, `${JSON.stringify({ status, owner: process.pid })}\n`)
}

const STDERR_KEPT = 4096

/**
 * Runs a child process that writes into a Workspace, with the marker naming it
 * for as long as it runs.
 *
 * A hook — or the `cp` cloning `node_modules` — is a process of its own, and
 * killing nodegraph does not kill it. Naming only the nodegraph would answer
 * the wrong question: what a Discard needs to know is whether anything is still
 * writing here, not whether whoever asked for it is still around to hear.
 */
const spawnIntoWorkspace = (
  marker: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> =>
  new Promise((settle, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] })

    claimWorkspace(marker, child.pid)

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, STDERR_KEPT)
    })

    // The Workspace goes back to being claimed by this nodegraph alone before
    // anyone is told the child is done, so no reader ever sees it named after a
    // process that has already gone.
    const done = (finish: () => void) => {
      claimWorkspace(marker)
      finish()
    }

    child.on('error', (error) => done(() => fail(error)))
    child.on('close', (code, signal) =>
      done(() =>
        code === 0
          ? settle()
          : fail(new Error(`${command} exited ${signal ?? code}: ${stderr.trim()}`)),
      ),
    )
  })

/**
 * An environment directory, copied the cheapest way the filesystem allows.
 *
 * On APFS and on btrfs/xfs this is copy-on-write: a second `node_modules` costs
 * almost no time and almost no disk until one of the two Nodes changes it.
 * Everywhere else it degrades to a plain recursive copy — slower and fatter,
 * but the Node ends up with exactly the same directory either way, which is the
 * only thing anyone outside here is allowed to notice.
 */
const cloneDirectory = async (
  source: string,
  destination: string,
  marker: string,
): Promise<void> => {
  const copyOnWrite = process.platform === 'darwin' ? ['-Rc'] : ['-a', '--reflink=auto']

  try {
    await spawnIntoWorkspace(marker, 'cp', [...copyOnWrite, source, destination])
    return
  } catch {
    // No clonefile on this filesystem, or no `cp` worth the name. Fall back —
    // but first clear whatever half a directory the attempt left, or the copy
    // would land *inside* it. This copy runs in this process, so it cannot
    // outlive it and needs no naming in the marker.
    await rm(destination, { recursive: true, force: true })
  }

  await cp(source, destination, { recursive: true, verbatimSymlinks: true })
}

/**
 * The one place a project gets to say "my environment is not a pile of files".
 * An executable at this path in the parent Workspace replaces everything else:
 * no ignored file is copied, no directory is cloned, the hook is simply run
 * inside the new Workspace and the environment is whatever it leaves behind.
 *
 * It runs with the same reach as the agent that is about to be started in the
 * same Workspace, so it grants nobody anything they did not already have — but
 * only if it can be run at all. A file there that cannot is refused rather than
 * handed to a process or quietly stepped around: see `readHookVerdict`.
 */
const readHook = async (workspacePath: string) => {
  const hook = join(workspacePath, ON_FORK)
  const found = await stat(hook).catch(() => undefined)

  return {
    hook,
    verdict: readHookVerdict(
      found === undefined ? undefined : { isFile: found.isFile(), mode: found.mode },
    ),
  }
}

const onForkHook = async (from: string): Promise<string | undefined> => {
  const { hook, verdict } = await readHook(from)

  // The same sentence the Node has been showing on its card all along, so the
  // refusal the user reads and the refusal that stops the Fork cannot drift.
  const refusal = hookRefusal(verdict, hook)
  if (refusal !== null) throw new Error(refusal)

  return verdict === 'run' ? hook : undefined
}

const runHook = (
  hook: string,
  from: string,
  workspacePath: string,
  marker: string,
): Promise<void> =>
  spawnIntoWorkspace(marker, hook, [], {
    cwd: workspacePath,
    env: {
      ...process.env,
      NODEGRAPH_WORKSPACE: workspacePath,
      NODEGRAPH_PARENT_WORKSPACE: from,
    },
  })

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
  let marker: unknown
  try {
    marker = JSON.parse(await readFile(await markerPath(workspacePath), 'utf8'))
  } catch {
    // No marker is how a settled Workspace looks, and the only way a Workspace
    // nodegraph never touched can look.
    return 'ready'
  }

  return statusFromMarker(marker, stillRunning)
}

/**
 * Everything a Node has to say about its own Workspace, keyed by path.
 *
 * The refusal is read on every poll rather than remembered, because the fix for
 * it is a `chmod` in another terminal: a Node that went on refusing until
 * nodegraph was restarted would be worse than one that never explained itself.
 */
export const readWorkspaceReports = async (
  workspacePaths: string[],
): Promise<Record<string, WorkspaceReport>> =>
  Object.fromEntries(
    await Promise.all(
      workspacePaths.map(async (path) => {
        const { hook, verdict } = await readHook(path)

        return [
          path,
          {
            environment: await readEnvironmentStatus(path),
            forkRefusal: hookRefusal(verdict, hook),
          },
        ] as const
      }),
    ),
  )

const prepareInBackground = (
  workspacePath: string,
  marker: string,
  work: () => Promise<void>,
): Promise<EnvironmentStatus> => {
  const settled = work()
    .then(
      (): EnvironmentStatus => 'ready',
      (): EnvironmentStatus => 'failed',
    )
    .then(async (status) => {
      await settleEnvironment(marker, status).catch(() => undefined)
      return status
    })

  preparing.set(workspacePath, settled)
  return settled
}

const SETTLING_POLL_MS = 50

const pause = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms))

/**
 * Waits until nothing is still filling a Workspace's environment.
 *
 * The work is usually this process's own, and then the promise is right here.
 * When it is not — a second nodegraph, or this one before a restart, or a hook
 * left running by a nodegraph that has since died — the only handle anybody has
 * on it is the marker, so this waits for that to stop saying `preparing`.
 * Reading it once and carrying on regardless is exactly how a Workspace gets
 * torn down under a live writer and reappears a second later. The wait always
 * ends: a marker whose owner and whose writer are both gone reads as `failed`.
 */
export const whenEnvironmentSettles = async (workspacePath: string): Promise<EnvironmentStatus> => {
  const ours = preparing.get(workspacePath)
  if (ours !== undefined) return ours

  for (;;) {
    const status = await readEnvironmentStatus(workspacePath)
    if (status !== 'preparing') return status
    await pause(SETTLING_POLL_MS)
  }
}

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
  const added = carriedAdditions({
    from,
    entries: zeroSeparated(await git(from, ['ls-files', '--others', '--exclude-standard', '-z'])),
    worktrees: await worktreePaths(from),
  })
  // Asked before the Workspace exists: a hook that cannot be run stops the Fork
  // here, where there is nothing yet to leave behind.
  const hook = await onForkHook(from)
  const ignored = hook === undefined ? await readIgnoredEntries(from) : NO_ENVIRONMENT

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
      const marker = await markerPath(workspacePath)
      claimWorkspace(marker)

      prepareInBackground(workspacePath, marker, async () => {
        if (hook !== undefined) {
          await runHook(hook, from, workspacePath, marker)
          return
        }

        for (const relativePath of ignored.directories) {
          const destination = join(workspacePath, relativePath)
          await mkdir(dirname(destination), { recursive: true })
          await cloneDirectory(join(from, relativePath), destination, marker)
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
  // it reappears a second later, half a Workspace, owned by nobody — whether
  // the writer is this nodegraph, another one, or a hook whose nodegraph is
  // already dead.
  await whenEnvironmentSettles(workspacePath)
  preparing.delete(workspacePath)

  await git(from, ['worktree', 'remove', '--force', workspacePath])
  await git(from, ['branch', '-D', branch])
}
