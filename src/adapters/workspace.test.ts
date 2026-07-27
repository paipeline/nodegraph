import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  provisionWorkspace,
  readEnvironmentStatus,
  removeWorkspace,
  whenEnvironmentSettles,
} from './workspace.js'

let repo: string
let firstCommit: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-workspace-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  writeFileSync(join(repo, 'doomed.txt'), 'delete me\n')
  writeFileSync(join(repo, 'staged-doomed.txt'), 'delete me too\n')
  writeFileSync(join(repo, 'old-name.txt'), 'travelling under a new name\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  firstCommit = git(repo, 'log', '-1', '--format=%H')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

/**
 * A real second nodegraph, forking in a process of its own. Nothing it does is
 * in this process's memory, so what one of them can know about the other is
 * exactly what was written down — which is the whole point of the tests that
 * use it.
 */
const forkInAnotherNodegraph = (workspacePath: string) => {
  const script = join(repo, '.nodegraph', 'prepare.mts')
  // tsx runs the script in a process of its own, so the pid that does the work
  // — and that a marker would name — is not the one spawn hands back here.
  const pidFile = join(repo, '.nodegraph', 'other.pid')
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'\n` +
      `import { provisionWorkspace } from ${JSON.stringify(fileURLToPath(new URL('./workspace.js', import.meta.url)))}\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
      `await provisionWorkspace({ from: ${JSON.stringify(repo)}, workspacePath: ${JSON.stringify(workspacePath)}, branch: 'nodegraph/child' })\n` +
      `setTimeout(() => process.exit(0), 60_000)\n`,
  )
  const other = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), [script], {
    stdio: 'ignore',
    detached: true,
  })

  // The whole group has to go — a crash that leaves the real worker alive is
  // not the crash under test.
  const kill = () => {
    try {
      process.kill(-(other.pid ?? 0), 'SIGKILL')
    } catch {
      /* already gone */
    }
  }

  /** Waits until a process is not merely signalled but reaped. */
  const whenReaped = async (pid: number) => {
    for (;;) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((wake) => setTimeout(wake, 20))
    }
  }

  return {
    kill,
    /**
     * Waits until that nodegraph is really gone. A killed process goes on
     * answering `kill(pid, 0)` until it has been reaped, so a test that means
     * "once the nodegraph preparing it is gone" has to wait for that too.
     */
    whenGone: async () => {
      const worker = Number(readFileSync(pidFile, 'utf8'))

      if (other.exitCode === null && other.signalCode === null) {
        await new Promise((exited) => other.on('exit', exited))
      }

      await whenReaped(worker)
    },
    /**
     * Kills the nodegraph and nothing else. The hook it started is a process of
     * its own, so it goes on writing into the Workspace with nobody left to
     * finish the job — which is what an ordinary `kill`, a crash or a supervisor
     * restart does to a Fork whose `npm install` is still running.
     */
    killTheNodegraphOnly: async () => {
      const worker = Number(readFileSync(pidFile, 'utf8'))
      process.kill(worker, 'SIGKILL')
      await whenReaped(worker)
    },
  }
}

const waitFor = async (path: string): Promise<void> => {
  while (!existsSync(path)) await new Promise((wake) => setTimeout(wake, 20))
}

describe('provisioning a Workspace', () => {
  it('checks out an independent worktree of the parent repository on a new branch', async () => {
    const workspacePath = join(repo, 'child')

    const workspace = await provisionWorkspace({
      from: repo,
      workspacePath,
      branch: 'nodegraph/child',
    })

    expect(workspace).toEqual({
      workspacePath,
      branch: 'nodegraph/child',
      forkPointSha: firstCommit,
    })
    expect(git(workspacePath, 'rev-parse', 'HEAD')).toBe(firstCommit)
    expect(git(workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('nodegraph/child')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(workspacePath)
  })

  it('carries the uncommitted edits of the parent Workspace, leaving the parent alone', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nedited but not committed\n')
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(readFileSync(join(workspacePath, 'a.txt'), 'utf8')).toBe(
      'hello\nedited but not committed\n',
    )
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\nedited but not committed\n')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(firstCommit)
  })

  it('carries files the parent added but never committed, however deeply nested', async () => {
    writeFileSync(join(repo, 'added.txt'), 'brand new\n')
    mkdirSync(join(repo, 'deep', 'deeper'), { recursive: true })
    writeFileSync(join(repo, 'deep', 'deeper', 'nested.txt'), 'way down here\n')
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(readFileSync(join(workspacePath, 'added.txt'), 'utf8')).toBe('brand new\n')
    expect(readFileSync(join(workspacePath, 'deep', 'deeper', 'nested.txt'), 'utf8')).toBe(
      'way down here\n',
    )
  })

  it('carries deletions the parent has not committed, whether staged or not', async () => {
    rmSync(join(repo, 'doomed.txt'))
    git(repo, 'rm', '-q', '--cached', 'staged-doomed.txt')
    rmSync(join(repo, 'staged-doomed.txt'))
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(existsSync(join(workspacePath, 'doomed.txt'))).toBe(false)
    expect(existsSync(join(workspacePath, 'staged-doomed.txt'))).toBe(false)
    expect(existsSync(join(workspacePath, 'a.txt'))).toBe(true)
  })

  it('carries renames, whether git was told about them or not', async () => {
    git(repo, 'mv', 'old-name.txt', 'told-git.txt')
    renameSync(join(repo, 'doomed.txt'), join(repo, 'behind-gits-back.txt'))
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(existsSync(join(workspacePath, 'old-name.txt'))).toBe(false)
    expect(readFileSync(join(workspacePath, 'told-git.txt'), 'utf8')).toBe(
      'travelling under a new name\n',
    )
    expect(existsSync(join(workspacePath, 'doomed.txt'))).toBe(false)
    expect(readFileSync(join(workspacePath, 'behind-gits-back.txt'), 'utf8')).toBe('delete me\n')
  })

  it('carries the gitignored files the parent needs to run, before it returns', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
    writeFileSync(join(repo, '.env'), 'OPENAI_KEY=parent\n')
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(readFileSync(join(workspacePath, '.env'), 'utf8')).toBe('OPENAI_KEY=parent\n')
  })

  it('clones the gitignored environment directories the parent runs on', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')
    expect(readFileSync(join(workspacePath, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
      'module.exports = 1\n',
    )
  })

  it('never carries a directory that holds another Workspace', async () => {
    writeFileSync(join(repo, '.gitignore'), '.nodegraph/\n.agent-worktrees/\nnode_modules/\n')

    // A repository that has been forked before, and that some other tool keeps
    // worktrees in. Both hide inside ignored directories, and both are whole
    // checkouts: carrying them would copy every other Node into this one.
    await provisionWorkspace({
      from: repo,
      workspacePath: join(repo, '.nodegraph', 'workspaces', 'older'),
      branch: 'nodegraph/older',
    })
    git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', join(repo, '.agent-worktrees', 'one'))
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad.js'), 'module.exports = 1\n')

    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')
    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })
    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')

    expect(existsSync(join(workspacePath, '.nodegraph'))).toBe(false)
    expect(existsSync(join(workspacePath, '.agent-worktrees'))).toBe(false)
    // The environment it is actually there to carry still arrives.
    expect(readFileSync(join(workspacePath, 'node_modules', 'left-pad.js'), 'utf8')).toBe(
      'module.exports = 1\n',
    )
  })

  it('never carries a Workspace that is not even gitignored', async () => {
    // Plenty of repositories keep their agents' worktrees in a committed
    // directory, so a Workspace can just as easily turn up among the untracked
    // files the parent has added.
    git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', join(repo, '.agents', 'one'))
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })
    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')

    expect(existsSync(join(workspacePath, '.agents'))).toBe(false)
  })

  it('never carries nodegraph’s own home, empty of Workspaces though it is at first', async () => {
    // The home as it really is: ignored from the inside, by itself.
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    writeFileSync(join(repo, '.nodegraph', '.gitignore'), '*\n')
    writeFileSync(join(repo, '.nodegraph', 'graph.json'), '{"forks":[]}\n')
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })
    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')

    // A child holding a copy of the graph is a second, stale answer to the
    // question of which Nodes exist.
    expect(existsSync(join(workspacePath, '.nodegraph'))).toBe(false)
  })

  it('hands the environment to the project’s on-fork hook and does nothing else itself', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
    writeFileSync(join(repo, '.env'), 'OPENAI_KEY=parent\n')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad.js'), 'module.exports = 1\n')
    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      '#!/bin/sh\npwd > ran-in\nprintenv NODEGRAPH_PARENT_WORKSPACE > came-from\n',
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const workspacePath = join(repo, 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })
    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')

    // The hook is run inside the new Workspace and told which one it came from.
    expect(readFileSync(join(workspacePath, 'ran-in'), 'utf8').trim()).toBe(workspacePath)
    expect(readFileSync(join(workspacePath, 'came-from'), 'utf8').trim()).toBe(repo)

    // A project that says how to build its environment is not second-guessed.
    expect(existsSync(join(workspacePath, '.env'))).toBe(false)
    expect(existsSync(join(workspacePath, 'node_modules'))).toBe(false)
  })

  it('refuses to Fork at all when the on-fork hook the project wrote cannot be run', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
    writeFileSync(join(repo, '.env'), 'OPENAI_KEY=parent\n')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad.js'), 'module.exports = 1\n')

    // The `chmod +x` everybody forgets the first time. Skipping the hook and
    // quietly carrying the environment instead would ignore what the project
    // asked for; skipping both — which is what a hook detected by its mere
    // existence does — hands over a Workspace with no environment at all and
    // nothing to say why.
    writeFileSync(join(repo, '.nodegraph.on-fork'), '#!/bin/sh\necho built > built-by-hook\n')
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o644)
    const workspacePath = join(repo, 'child')

    await expect(
      provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' }),
    ).rejects.toThrow(/\.nodegraph\.on-fork.*executable/s)

    // Refused before anything was built, so there is nothing to clean up.
    expect(existsSync(workspacePath)).toBe(false)
    expect(git(repo, 'branch', '--list', 'nodegraph/child')).toBe('')
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspacePath)
  })

  it('hands the Workspace over while the environment is still coming', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.nodegraph/\n')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad.js'), 'module.exports = 1\n')

    // An environment that takes as long to build as the test says it does.
    const release = join(repo, '.nodegraph', 'go-ahead')
    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      `#!/bin/sh\nn=0\nwhile [ ! -f "${release}" ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done\necho built > built-by-hook\n`,
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)

    const parentBefore = git(repo, 'status', '--porcelain')
    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')

    // Were Fork to wait on the environment, this line would sit here for ten
    // seconds and the assertions below would all be about a finished clone.
    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    // The agent has everything it needs to start reading and editing code ...
    expect(readFileSync(join(workspacePath, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(git(workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('nodegraph/child')
    // ... and the Node is honest that the environment is not there yet.
    await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('preparing')

    // Meanwhile the parent Node is exactly where its own agent left it.
    expect(git(repo, 'status', '--porcelain')).toBe(parentBefore)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(firstCommit)
    expect(readFileSync(join(repo, 'node_modules', 'left-pad.js'), 'utf8')).toBe(
      'module.exports = 1\n',
    )

    writeFileSync(release, '')
    await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('ready')
    await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('ready')
    expect(existsSync(join(workspacePath, 'built-by-hook'))).toBe(true)
  })

  // Running as root would defeat the unreadable file this leans on.
  it.skipIf(process.getuid?.() === 0)(
    'hands over a Workspace that works even when the environment cannot be cloned',
    async () => {
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(repo, 'node_modules'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'locked.js'), 'you cannot have this\n')
      chmodSync(join(repo, 'node_modules', 'locked.js'), 0o000)
      const workspacePath = join(repo, 'child')

      // A Fork that could not carry node_modules is still a Fork: the code is
      // there, the agent can work, and the Node says the environment is not.
      await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

      expect(readFileSync(join(workspacePath, 'a.txt'), 'utf8')).toBe('hello\n')
      await expect(whenEnvironmentSettles(workspacePath)).resolves.toBe('failed')
      await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('failed')
    },
  )

  it('takes a Workspace away whole, even with its environment still landing', async () => {
    writeFileSync(join(repo, '.gitignore'), '.nodegraph/\n')
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    const started = join(repo, '.nodegraph', 'hook-started')
    const finished = join(repo, '.nodegraph', 'hook-finished')

    // A hook that is still writing into the Workspace, by absolute path, when
    // it is taken away. Discard has to be believable: a directory that reappears
    // behind it is the one thing that would stop anyone daring to Discard again.
    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      `#!/bin/sh\ntouch "${started}"\nsleep 1\nmkdir -p "$NODEGRAPH_WORKSPACE/node_modules"\necho late > "$NODEGRAPH_WORKSPACE/node_modules/index.js"\ntouch "${finished}"\n`,
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')

    await provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })
    while (!existsSync(started)) await new Promise((wake) => setTimeout(wake, 10))

    await removeWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

    expect(existsSync(finished)).toBe(true)
    expect(existsSync(workspacePath)).toBe(false)
    expect(git(repo, 'branch', '--list', 'nodegraph/child')).toBe('')
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspacePath)
  })

  it('stops promising an environment once the nodegraph preparing it is gone', async () => {
    writeFileSync(join(repo, '.gitignore'), '.nodegraph/\n')
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    const started = join(repo, '.nodegraph', 'hook-started')
    writeFileSync(join(repo, '.nodegraph.on-fork'), `#!/bin/sh\ntouch "${started}"\nsleep 5\n`)
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')

    // A real second nodegraph, forking and then dying mid-preparation, read by
    // this one.
    const other = forkInAnotherNodegraph(workspacePath)

    try {
      await waitFor(started)
      await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('preparing')

      other.kill()
      await other.whenGone()

      // Nobody is coming back to finish it, so it must stop looking imminent.
      await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('failed')
    } finally {
      other.kill()
    }
  })

  it('takes a Workspace away whole even when another nodegraph is the one still filling it', async () => {
    writeFileSync(join(repo, '.gitignore'), '.nodegraph/\n')
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    const started = join(repo, '.nodegraph', 'hook-started')
    const finished = join(repo, '.nodegraph', 'hook-finished')

    // The same hook as the single-process case: still writing into the
    // Workspace, by absolute path, when it is taken away.
    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      `#!/bin/sh\ntouch "${started}"\nsleep 2\nmkdir -p "$NODEGRAPH_WORKSPACE/node_modules"\necho late > "$NODEGRAPH_WORKSPACE/node_modules/index.js"\ntouch "${finished}"\n`,
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')

    // This time the work belongs to a different process, so waiting for it
    // cannot mean waiting on a promise this one is holding.
    const other = forkInAnotherNodegraph(workspacePath)

    try {
      await waitFor(started)
      await expect(readEnvironmentStatus(workspacePath)).resolves.toBe('preparing')

      await removeWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

      // Discard has to be believable: a Workspace that reappears seconds later,
      // half-built and owned by nobody, is the one thing that would stop anyone
      // daring to Discard again.
      expect(existsSync(finished)).toBe(true)
      expect(existsSync(workspacePath)).toBe(false)
      expect(git(repo, 'branch', '--list', 'nodegraph/child')).toBe('')

      await new Promise((wake) => setTimeout(wake, 500))
      expect(existsSync(workspacePath)).toBe(false)
    } finally {
      other.kill()
    }
  })

  it('takes a Workspace away whole when the nodegraph filling it died and its hook did not', async () => {
    writeFileSync(join(repo, '.gitignore'), '.nodegraph/\n')
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    const started = join(repo, '.nodegraph', 'hook-started')
    const finished = join(repo, '.nodegraph', 'hook-finished')

    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      `#!/bin/sh\ntouch "${started}"\nsleep 2\nmkdir -p "$NODEGRAPH_WORKSPACE/node_modules"\necho late > "$NODEGRAPH_WORKSPACE/node_modules/index.js"\ntouch "${finished}"\n`,
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const workspacePath = join(repo, '.nodegraph', 'workspaces', 'child')

    const other = forkInAnotherNodegraph(workspacePath)

    try {
      await waitFor(started)

      // The user quits nodegraph — or it crashes — while a Fork's environment is
      // still being built. The hook outlives it and keeps writing.
      await other.killTheNodegraphOnly()

      // Nobody is coming back to finish this environment, so the Node is right
      // to say it failed and the user is right to Discard it. Doing so must
      // still take the Workspace away for good.
      await removeWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' })

      expect(existsSync(finished)).toBe(true)
      expect(existsSync(workspacePath)).toBe(false)
      expect(git(repo, 'branch', '--list', 'nodegraph/child')).toBe('')

      await new Promise((wake) => setTimeout(wake, 500))
      expect(existsSync(workspacePath)).toBe(false)
    } finally {
      other.kill()
    }
  })

  // Running as root would defeat the unreadable file this leans on.
  it.skipIf(process.getuid?.() === 0)(
    'leaves no branch and no directory behind when it fails partway',
    async () => {
      writeFileSync(join(repo, 'unreadable.txt'), 'you cannot have this\n')
      chmodSync(join(repo, 'unreadable.txt'), 0o000)
      const workspacePath = join(repo, 'child')

      await expect(
        provisionWorkspace({ from: repo, workspacePath, branch: 'nodegraph/child' }),
      ).rejects.toThrow()

      expect(existsSync(workspacePath)).toBe(false)
      expect(git(repo, 'branch', '--list', 'nodegraph/child')).toBe('')
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspacePath)
    },
  )

  /**
   * `-b <branch>` is the one argument git reads twice: `git worktree add` takes
   * the value and hands it on to be parsed as `git branch`'s own arguments, so
   * a branch named `-m` renames the repository's branch out from under it and a
   * `-d` tries to delete one. Nothing before it stops that — `--end-of-options`
   * placed after `-b` is already too late.
   *
   * The branch is nodegraph's own name for a Node today, but Discard will read
   * it back out of the store, which is a file in the user's repository. So the
   * name is made a branch first, on its own, where git will only read it as a
   * name — and the Fork stops rather than doing whatever the name says.
   */
  it('refuses a branch name git would read as an instruction, and touches nothing', async () => {
    const workspacePath = join(repo, 'child')

    for (const branch of ['-m', '-d', '--all', '-D']) {
      await expect(provisionWorkspace({ from: repo, workspacePath, branch })).rejects.toThrow()
    }

    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(firstCommit)
    expect(existsSync(workspacePath)).toBe(false)
  })
})
