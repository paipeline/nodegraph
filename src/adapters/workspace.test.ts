import { execFileSync } from 'node:child_process'
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provisionWorkspace } from './workspace.js'

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
