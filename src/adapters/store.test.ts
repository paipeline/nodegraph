import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readForks, readSessions, recordFork, recordSession, type StoredFork } from './store.js'

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

  it('remembers which Context a Node’s agent is living in, without disturbing the Forks', async () => {
    const fork = aFork()
    await recordFork(repo, fork)

    await recordSession(repo, {
      nodeId: 'trunk',
      sessionId: '11111111-2222-3333-4444-555555555555',
      startedAt: '2026-07-27T09:01:00.000Z',
    })

    await expect(readSessions(repo)).resolves.toEqual([
      {
        nodeId: 'trunk',
        sessionId: '11111111-2222-3333-4444-555555555555',
        startedAt: '2026-07-27T09:01:00.000Z',
      },
    ])
    await expect(readForks(repo)).resolves.toEqual([fork])
  })

  it('keeps its own bookkeeping out of the repository it is watching', async () => {
    await recordFork(repo, aFork())

    expect(git(repo, 'status', '--porcelain')).toBe('')
  })
})

describe('two things written down at the same instant', () => {
  it('keeps every Context, however many Nodes are opened together', async () => {
    const nodeIds = ['n1', 'n2', 'n3', 'n4', 'n5']

    await Promise.all(
      nodeIds.map((nodeId) =>
        recordSession(repo, {
          nodeId,
          sessionId: `${nodeId}-11111111-2222-3333-4444-555555555555`,
          startedAt: '2026-07-27T09:00:00.000Z',
        }),
      ),
    )

    // Losing one here means that Node is re-cut from its parent next time the
    // graph is opened, throwing away everything it had worked out.
    expect((await readSessions(repo)).map((session) => session.nodeId).sort()).toEqual(nodeIds)
  })

  it('keeps every Fork, however many are taken together', async () => {
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5']

    await Promise.all(ids.map((id) => recordFork(repo, aFork({ id }))))

    expect((await readForks(repo)).map((fork) => fork.id).sort()).toEqual(ids)
  })

  it('keeps a Fork and a Context written at the same instant, both of them', async () => {
    await Promise.all([
      recordFork(repo, aFork()),
      recordSession(repo, {
        nodeId: 'trunk',
        sessionId: '11111111-2222-3333-4444-555555555555',
        startedAt: '2026-07-27T09:00:00.000Z',
      }),
    ])

    await expect(readForks(repo)).resolves.toHaveLength(1)
    await expect(readSessions(repo)).resolves.toHaveLength(1)
  })

  it('carries on writing after one write fails, rather than wedging the store', async () => {
    // A store file that cannot be written at all: the first write fails.
    mkdirSync(join(repo, '.nodegraph', 'graph.json'), { recursive: true })
    await expect(recordFork(repo, aFork())).rejects.toThrow()

    rmSync(join(repo, '.nodegraph', 'graph.json'), { recursive: true })

    await recordFork(repo, aFork({ id: 'after' }))
    await expect(readForks(repo)).resolves.toHaveLength(1)
  })
})
