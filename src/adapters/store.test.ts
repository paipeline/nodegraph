import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readForks, recordFork, type StoredFork } from './store.js'

let repo: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const aFork = (overrides: Partial<StoredFork> = {}): StoredFork => ({
  id: 'a1b2c3d4',
  parentId: 'trunk',
  branch: 'nodegraph/a1b2c3d4',
  workspacePath: '/somewhere/a1b2c3d4',
  forkPointSha: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-07-27T09:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-store-')))
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

describe('the store of what only nodegraph knows', () => {
  it('remembers a Fork — its parent and its fork point — for the next time it starts', async () => {
    const fork = aFork()

    await recordFork(repo, fork)

    await expect(readForks(repo)).resolves.toEqual([fork])
  })

  it('keeps its own bookkeeping out of the repository it is watching', async () => {
    await recordFork(repo, aFork())

    expect(git(repo, 'status', '--porcelain')).toBe('')
  })
})
