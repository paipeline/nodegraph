import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forkRecord, type StoredFork } from '../core/store.js'
import { homeOf, readForks, readSessions, readStore, recordFork, recordSession } from './store.js'

let repo: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// The name goes through `forkRecord` rather than over the top of it, so a
// fixture with its own name still carries the branch and Workspace nodegraph
// would have given that name — which is what makes it readable back.
const aFork = ({ id = 'a1b2c3d4', ...overrides }: Partial<StoredFork> = {}): StoredFork => ({
  ...forkRecord({
    id,
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
   * …and reading none of it is still not a licence to replace it. Everything
   * that file holds — which Node came from which, and from which commit — is
   * the one thing git can never tell us again, while the Workspaces and the
   * branches stay on disk as orphans nothing can reach. Refusing to start is
   * recoverable in a text editor; a rewrite is not recoverable at all.
   */
  it('refuses to write over a store it cannot read, and leaves it byte for byte', async () => {
    for (const damaged of [
      '',
      '{"forks": [',
      '<<<<<<< HEAD\n{"forks": []}\n=======\n{"forks": []}\n>>>>>>> theirs\n',
    ]) {
      await mkdir(homeOf(repo), { recursive: true })
      const path = join(homeOf(repo), 'graph.json')
      writeFileSync(path, damaged)

      await expect(recordFork(repo, aFork())).rejects.toThrow(/graph\.json/)
      await expect(
        recordSession(repo, {
          nodeId: 'trunk',
          sessionId: '11111111-2222-3333-4444-555555555555',
          startedAt: '2026-07-27T09:01:00.000Z',
        }),
      ).rejects.toThrow(/graph\.json/)

      expect(readFileSync(path, 'utf8')).toBe(damaged)
    }
  })

  it('says a store it cannot read cannot be read, rather than saying it is empty', async () => {
    await mkdir(homeOf(repo), { recursive: true })
    writeFileSync(join(homeOf(repo), 'graph.json'), '{"forks": [')

    const store = await readStore(repo)

    expect(store.refusal).toContain('graph.json')
    expect(store.forks).toEqual([])
  })

  it('says nothing is wrong with a store that is simply not there yet', async () => {
    await expect(readStore(repo)).resolves.toEqual({ forks: [], sessions: [], refusal: null })
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

describe('two things written down at the same instant', () => {
  it('keeps every Context, however many Nodes are opened together', async () => {
    // Names of the shape nodegraph gives a Node and a Context: `core/store`
    // will not read back a record wearing any other, and will not write one.
    const nodeIds = ['a1a2b3c4', 'a2a2b3c4', 'a3a2b3c4', 'a4a2b3c4', 'a5a2b3c4']

    await Promise.all(
      nodeIds.map((nodeId, index) =>
        recordSession(repo, {
          nodeId,
          sessionId: `1111111${index}-2222-3333-4444-555555555555`,
          startedAt: '2026-07-27T09:00:00.000Z',
        }),
      ),
    )

    // Losing one here means that Node is re-cut from its parent next time the
    // graph is opened, throwing away everything it had worked out.
    expect((await readSessions(repo)).map((session) => session.nodeId).sort()).toEqual(nodeIds)
  })

  it('keeps every Fork, however many are taken together', async () => {
    // Names of the shape nodegraph gives a Node, because `core/store` will not
    // read back a record wearing any other — see `usableForks`.
    const ids = ['f1a2b3c4', 'f2a2b3c4', 'f3a2b3c4', 'f4a2b3c4', 'f5a2b3c4']

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

    await recordFork(repo, aFork({ id: 'af7e4a11' }))
    await expect(readForks(repo)).resolves.toHaveLength(1)
  })
})
