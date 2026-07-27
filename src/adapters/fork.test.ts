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
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contextPath } from '../core/context.js'
import { fork } from './fork.js'
import { readForks, recordSession } from './store.js'

const PARENT_SESSION = '99999999-8888-7777-6666-555555555555'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let sandbox: string
let repo: string
let claudeHome: string
let originalClaudeHome: string | undefined
let firstCommit: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** The Trunk's Context, exactly where claude keeps one — see ADR-0004. */
const givenTrunkHasSaid = (said: string): void => {
  const path = contextPath(claudeHome, repo, PARENT_SESSION)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ type: 'user', sessionId: PARENT_SESSION, said })}\n`)
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-fork-')))

  // Contexts are looked for here, never in the person's own claude home.
  claudeHome = join(sandbox, 'claude-home')
  mkdirSync(claudeHome)
  originalClaudeHome = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeHome

  repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  firstCommit = git(repo, 'log', '-1', '--format=%H')
})

afterEach(() => {
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome
  rmSync(sandbox, { recursive: true, force: true })
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

  it('writes down the Context it was cut from, the Context it gets, and the line it was given', async () => {
    await recordSession(repo, {
      nodeId: 'trunk',
      sessionId: PARENT_SESSION,
      startedAt: '2026-07-27T09:00:00.000Z',
    })
    givenTrunkHasSaid('the-api-key-lives-in-vault')

    const child = await fork({ repoPath: repo, parentId: 'trunk', intent: 'try it with a queue' })

    expect(child.parentSessionId).toBe(PARENT_SESSION)
    expect(child.sessionId).toMatch(UUID)
    expect(child.sessionId).not.toBe(PARENT_SESSION)
    expect(child.intent).toBe('try it with a queue')

    // Both halves survive a restart, or the child could never be launched.
    await expect(readForks(repo)).resolves.toEqual([child])
  })

  it('says plainly that no understanding came across, when the parent had none to give', async () => {
    // A Node whose agent was started and never spoken to: the store names a
    // Context, but claude never made one.
    await recordSession(repo, {
      nodeId: 'trunk',
      sessionId: PARENT_SESSION,
      startedAt: '2026-07-27T09:00:00.000Z',
    })

    const child = await fork({ repoPath: repo, parentId: 'trunk' })

    expect(child.parentSessionId).toBeNull()
    expect(child.sessionId).toMatch(UUID)
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

  it('refuses a line that claude would read as a flag, before anything is built', async () => {
    await expect(
      fork({ repoPath: repo, parentId: 'trunk', intent: '--dangerously-skip-permissions' }),
    ).rejects.toThrow(/flag/)

    expect(git(repo, 'branch', '--list')).toBe('* main')
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    await expect(readForks(repo)).resolves.toEqual([])
  })

  it('refuses to fork from a Node that does not exist', async () => {
    await expect(fork({ repoPath: repo, parentId: 'nobody' })).rejects.toThrow(/nobody/)
  })
})
