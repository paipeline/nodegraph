import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forkRecord, type StoredFork } from '../core/store.js'
import { homeOf, readForks, recordFork } from './store.js'

let repo: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const aFork = (overrides: Partial<StoredFork> = {}): StoredFork => ({
  ...forkRecord({
    id: 'a1b2c3d4',
    parentId: 'trunk',
    home: homeOf(repo),
    forkPointSha: '0123456789abcdef0123456789abcdef01234567',
    createdAt: '2026-07-27T09:00:00.000Z',
  }),
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

  // graph.json lives in the repository being viewed, so it can be hand-edited,
  // badly merged, or shipped inside a repository somebody cloned. Everything
  // downstream hands these fields to git, so a record nodegraph would never
  // have written is not read back as one.
  it('does not read back a Fork whose fork point is not a commit', async () => {
    const real = aFork()
    await recordFork(
      repo,
      aFork({
        id: 'deadbeef',
        branch: 'nodegraph/deadbeef',
        workspacePath: join(homeOf(repo), 'workspaces', 'deadbeef'),
        forkPointSha: '--output=/tmp/anything',
      }),
    )
    await recordFork(repo, real)

    await expect(readForks(repo)).resolves.toEqual([real])
  })

  /**
   * A Workspace is the directory git gets run in, and git obeys the config of
   * whatever repository it finds there — `core.fsmonitor` names a command. So a
   * record pointing anywhere but at the one place nodegraph puts a Workspace is
   * not a record it wrote, whatever name it is wearing.
   */
  it('does not read back a Fork whose Workspace is somewhere nodegraph never put one', async () => {
    const real = aFork()
    await recordFork(repo, aFork({ id: 'deadbeef', workspacePath: '/elsewhere/vendor/somedep' }))
    await recordFork(repo, real)

    await expect(readForks(repo)).resolves.toEqual([real])
  })

  it('reads no Forks out of a store that has none to give', async () => {
    await mkdir(join(repo, '.nodegraph'), { recursive: true })
    writeFileSync(join(repo, '.nodegraph', 'graph.json'), '{"nodes": []}')

    await expect(readForks(repo)).resolves.toEqual([])
  })

  // A store that is not json at all is the badly-resolved merge the rule exists
  // for. Believing none of it is the answer; taking the whole graph down with a
  // parser error — every Node gone, every route 500 — is not.
  it('reads no Forks out of a store that is not json at all', async () => {
    await mkdir(join(repo, '.nodegraph'), { recursive: true })
    writeFileSync(
      join(repo, '.nodegraph', 'graph.json'),
      '<<<<<<< HEAD\n{"forks": []}\n=======\n{"forks": []}\n>>>>>>> theirs\n',
    )

    await expect(readForks(repo)).resolves.toEqual([])
  })

  /**
   * Refusing to believe a record is not the same as being allowed to destroy
   * it. The next Fork rewrites this file, and a record nodegraph did not write
   * is still somebody's — a hand-edit, a half-resolved merge, a newer nodegraph
   * writing a field this one has never heard of.
   */
  it('leaves a record it does not believe where it found it', async () => {
    const unbelievable = { ...aFork({ id: 'deadbeef' }), workspacePath: '/elsewhere/somedep' }
    await recordFork(repo, unbelievable as StoredFork)

    await recordFork(repo, aFork())

    const onDisk = JSON.parse(
      readFileSync(join(homeOf(repo), 'graph.json'), 'utf8'),
    ) as unknown as { forks: unknown[] }
    expect(onDisk.forks).toContainEqual(unbelievable)
    await expect(readForks(repo)).resolves.toEqual([aFork()])
  })
})
