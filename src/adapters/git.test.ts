import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorld } from './git.js'

let repo: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-git-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('readWorld', () => {
  it('reports the repository itself as the primary worktree', async () => {
    const world = await readWorld(repo)

    expect(world.worktrees).toEqual([
      { path: repo, branch: 'main', isPrimary: true },
    ])
  })

  it('reports the branch actually checked out', async () => {
    git(repo, 'checkout', '-qb', 'develop')

    const world = await readWorld(repo)

    expect(world.worktrees[0]?.branch).toBe('develop')
  })

  it('reports a null branch when HEAD is detached', async () => {
    git(repo, 'checkout', '-q', '--detach')

    const world = await readWorld(repo)

    expect(world.worktrees[0]?.branch).toBeNull()
  })

  it('includes additional worktrees, none of them primary', async () => {
    const extra = join(repo, 'wt-extra')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', extra)

    const world = await readWorld(repo)

    expect(world.worktrees).toHaveLength(2)
    expect(world.worktrees[0]).toEqual({ path: repo, branch: 'main', isPrimary: true })
    expect(world.worktrees[1]).toEqual({
      path: realpathSync(extra),
      branch: 'side',
      isPrimary: false,
    })
  })

  it('rejects a directory that is not a git repository', async () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-bare-')))
    try {
      await expect(readWorld(notARepo)).rejects.toThrow(/not a git repository/i)
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})
