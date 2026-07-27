import { describe, expect, it } from 'vitest'
import {
  carriedAdditions,
  gitDirOf,
  hookRefusal,
  holdsAWorktree,
  readHookVerdict,
  splitEnvironment,
  statusFromMarker,
} from './environment.js'

const alive = () => true
const dead = () => false

describe('what a Fork carries', () => {
  it('sends ignored files across at once and ignored directories to the background', () => {
    expect(
      splitEnvironment({
        from: '/repo',
        entries: ['.env', 'node_modules/', '.venv/'],
        home: '/repo/.nodegraph',
        worktrees: ['/repo'],
      }),
    ).toEqual({ files: ['.env'], directories: ['node_modules', '.venv'] })
  })

  it('never carries a file that is already inside a directory it is carrying', () => {
    // git reports a wholly ignored directory *and* the ignored files in it.
    const carried = splitEnvironment({
      from: '/repo',
      entries: ['node_modules/', 'node_modules/left-pad/index.js', '.env'],
      home: '/repo/.nodegraph',
      worktrees: ['/repo'],
    })

    expect(carried.files).toEqual(['.env'])
    expect(carried.directories).toEqual(['node_modules'])
  })

  it('never carries nodegraph’s own home', () => {
    expect(
      splitEnvironment({
        from: '/repo',
        entries: ['.nodegraph/', 'node_modules/'],
        home: '/repo/.nodegraph',
        worktrees: ['/repo'],
      }).directories,
    ).toEqual(['node_modules'])
  })

  it('never carries a directory that holds another Node’s Workspace', () => {
    expect(
      splitEnvironment({
        from: '/repo',
        entries: ['.agent-worktrees/', 'node_modules/'],
        home: '/repo/.nodegraph',
        worktrees: ['/repo', '/repo/.agent-worktrees/one'],
      }).directories,
    ).toEqual(['node_modules'])
  })

  it('keeps a nested environment directory as the path it was reported at', () => {
    expect(
      splitEnvironment({
        from: '/repo',
        entries: ['packages/api/node_modules/'],
        home: '/repo/.nodegraph',
        worktrees: ['/repo'],
      }).directories,
    ).toEqual(['packages/api/node_modules'])
  })

  it('carries the files the parent added but never committed', () => {
    expect(
      carriedAdditions({
        from: '/repo',
        entries: ['added.txt', 'deep/deeper/nested.txt'],
        worktrees: ['/repo'],
      }),
    ).toEqual(['added.txt', 'deep/deeper/nested.txt'])
  })

  it('never carries an untracked directory that is really another Workspace', () => {
    expect(
      carriedAdditions({
        from: '/repo',
        entries: ['added.txt', '.agents/one/'],
        worktrees: ['/repo', '/repo/.agents/one'],
      }),
    ).toEqual(['added.txt'])
  })

  it('knows a directory holding a Workspace from one that merely looks like it', () => {
    expect(holdsAWorktree('/repo/.agents', ['/repo', '/repo/.agents/one'])).toBe(true)
    expect(holdsAWorktree('/repo/.agents/one', ['/repo/.agents/one'])).toBe(true)
    expect(holdsAWorktree('/repo/.agents-elsewhere', ['/repo/.agents/one'])).toBe(false)
  })
})

describe('reading the project’s on-fork hook', () => {
  it('runs an executable one', () => {
    expect(readHookVerdict({ isFile: true, mode: 0o755 })).toBe('run')
  })

  it('refuses a hook the project forgot to make executable, rather than quietly skipping it', () => {
    // Silently falling back would hand the Node the worst of both: the hook the
    // project wrote never ran, and the default carry it replaced never happened.
    expect(readHookVerdict({ isFile: true, mode: 0o644 })).toBe('not-executable')
  })

  it('carries the environment itself when there is no hook at all', () => {
    expect(readHookVerdict(undefined)).toBe('no-hook')
  })

  it('is not fooled by a directory of the same name', () => {
    expect(readHookVerdict({ isFile: false, mode: 0o755 })).toBe('no-hook')
  })
})

describe('what the user is told when a Fork cannot start', () => {
  it('says what is wrong and the command that fixes it', () => {
    const refusal = hookRefusal('not-executable', '/repo/.nodegraph.on-fork')

    // Not a diagnosis to be looked up: the sentence contains the fix.
    expect(refusal).toContain('.nodegraph.on-fork')
    expect(refusal).toContain('chmod +x /repo/.nodegraph.on-fork')
  })

  it('refuses nothing when the hook is runnable, or absent altogether', () => {
    expect(hookRefusal('run', '/repo/.nodegraph.on-fork')).toBeNull()
    expect(hookRefusal('no-hook', '/repo/.nodegraph.on-fork')).toBeNull()
  })
})

describe('what a Workspace’s environment marker means', () => {
  it('reads a Workspace with no marker as settled', () => {
    expect(statusFromMarker(undefined, alive)).toBe('ready')
  })

  it('reads a live owner’s marker as still coming', () => {
    expect(statusFromMarker({ status: 'preparing', owner: 42 }, alive)).toBe('preparing')
  })

  it('stops promising an environment whose owner is gone', () => {
    expect(statusFromMarker({ status: 'preparing', owner: 42 }, dead)).toBe('failed')
  })

  it('keeps promising an environment whose owner it cannot name', () => {
    expect(statusFromMarker({ status: 'preparing' }, dead)).toBe('preparing')
  })

  it('keeps promising while the process doing the writing is alive, owner or not', () => {
    // A hook is a process of its own: killing nodegraph leaves the `npm install`
    // it started writing into the Workspace. Reading that as "nothing is
    // happening here" is how a Discard is followed by the Workspace coming back.
    const onlyTheWriter = (pid: number) => pid === 99

    expect(statusFromMarker({ status: 'preparing', owner: 42, writer: 99 }, onlyTheWriter)).toBe(
      'preparing',
    )
  })

  it('stops promising once neither the nodegraph nor its writer is left', () => {
    expect(statusFromMarker({ status: 'preparing', owner: 42, writer: 99 }, dead)).toBe('failed')
  })

  it('reports a failure whoever wrote it', () => {
    expect(statusFromMarker({ status: 'failed', owner: 42 }, dead)).toBe('failed')
  })

  it('treats a marker it cannot make sense of as settled', () => {
    expect(statusFromMarker({ status: 'nonsense', owner: 'not a pid' }, alive)).toBe('ready')
    expect(statusFromMarker('not even an object', alive)).toBe('ready')
    expect(statusFromMarker(null, alive)).toBe('ready')
  })
})

describe('finding where a Workspace keeps its own git state', () => {
  it('follows the link git leaves in a Workspace', () => {
    expect(gitDirOf('/repo/.nodegraph/workspaces/abc', 'gitdir: /repo/.git/worktrees/abc\n')).toBe(
      '/repo/.git/worktrees/abc',
    )
  })

  it('resolves a link git wrote relative to the Workspace', () => {
    expect(gitDirOf('/repo/.nodegraph/workspaces/abc', 'gitdir: ../../../.git/worktrees/abc')).toBe(
      '/repo/.git/worktrees/abc',
    )
  })

  it('admits it does not know when the file is not a link at all', () => {
    expect(gitDirOf('/repo', 'ref: refs/heads/main\n')).toBeUndefined()
    expect(gitDirOf('/repo', '')).toBeUndefined()
  })
})
