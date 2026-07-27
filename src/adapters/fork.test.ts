import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fork } from './fork.js'
import { readForks } from './store.js'

let repo: string
let firstCommit: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-fork-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  firstCommit = git(repo, 'log', '-1', '--format=%H')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('forking a Node', () => {
  it('gives the child its own Workspace and remembers where it was cut from', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nnot committed yet\n')
    const before = git(repo, 'status', '--porcelain')

    const child = await fork({ repoPath: repo, parentId: 'trunk' })

    expect(child.parentId).toBe('trunk')
    expect(child.forkPointSha).toBe(firstCommit)
    expect(existsSync(child.workspacePath)).toBe(true)
    expect(git(child.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(child.branch)
    await expect(readForks(repo)).resolves.toEqual([child])

    // The whole point of forking is that the parent does not notice.
    expect(git(repo, 'status', '--porcelain')).toBe(before)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('leaves no Workspace, branch or record behind when it cannot be written down', async () => {
    // A store file that cannot be written: the last step of the transaction
    // fails after the Workspace already exists.
    mkdirSync(join(repo, '.nodegraph', 'graph.json'), { recursive: true })

    await expect(fork({ repoPath: repo, parentId: 'trunk' })).rejects.toThrow()

    expect(git(repo, 'branch', '--list')).toBe('* main')
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(readdirSync(join(repo, '.nodegraph', 'workspaces'))).toEqual([])
    await expect(readForks(repo)).resolves.toEqual([])
  })

  it('forks from a Node that was itself forked, carrying that Node’s own edits on', async () => {
    const child = await fork({ repoPath: repo, parentId: 'trunk' })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'hello\nwritten inside the child\n')
    git(child.workspacePath, 'commit', '-qam', 'the child got somewhere')
    const childHead = git(child.workspacePath, 'log', '-1', '--format=%H')

    const grandchild = await fork({ repoPath: repo, parentId: child.id })

    expect(grandchild.parentId).toBe(child.id)
    expect(grandchild.forkPointSha).toBe(childHead)
    expect(readFileSync(join(grandchild.workspacePath, 'a.txt'), 'utf8')).toBe(
      'hello\nwritten inside the child\n',
    )
    await expect(readForks(repo)).resolves.toEqual([child, grandchild])
  })

  it('refuses to fork from a Node that does not exist', async () => {
    await expect(fork({ repoPath: repo, parentId: 'nobody' })).rejects.toThrow(/nobody/)
  })
})
