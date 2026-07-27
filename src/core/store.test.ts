import { describe, expect, it } from 'vitest'
import { usableForks, type StoredFork } from './store.js'

/**
 * What nodegraph is willing to believe about the Nodes it wrote down.
 *
 * Plain data in, plain data out: the store is a file in somebody's repository,
 * so the rule for reading it back has to be testable without one.
 */

const aFork = (overrides: Partial<StoredFork> = {}): StoredFork => ({
  id: 'a1b2c3d4',
  parentId: 'trunk',
  branch: 'nodegraph/a1b2c3d4',
  workspacePath: '/repo/.nodegraph/workspaces/a1b2c3d4',
  forkPointSha: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-07-27T09:00:00.000Z',
  ...overrides,
})

const document = (...forks: unknown[]) => ({ forks })

describe('the Forks a store is worth believing', () => {
  it('keeps a record of the shape nodegraph itself writes', () => {
    const fork = aFork()

    expect(usableForks(document(fork))).toEqual([fork])
  })

  it('keeps an abbreviated fork point, which is still a commit', () => {
    const fork = aFork({ forkPointSha: '0123abc' })

    expect(usableForks(document(fork))).toEqual([fork])
  })

  // The fork point is handed to git as the thing to measure against. A value
  // that git would read as an option is not a commit, and a Node cut from
  // something that is not a commit is not a Node nodegraph ever made.
  it('drops a Fork whose fork point is an option rather than a commit', () => {
    const kept = aFork({ id: 'real' })
    const invented = aFork({ id: 'evil', forkPointSha: '--output=/tmp/x' })

    expect(usableForks(document(invented, kept))).toEqual([kept])
  })

  it('drops a Fork whose fork point is not a commit at all', () => {
    for (const forkPointSha of ['HEAD', 'main', '', 'z'.repeat(40), '../etc/passwd', 'abc']) {
      expect(usableForks(document(aFork({ forkPointSha })))).toEqual([])
    }
  })

  // The branch is handed to git when a Workspace is taken away, and the path is
  // both an argument and a working directory. Either one spelled as an option
  // is a record nodegraph did not write.
  it('drops a Fork whose branch or Workspace reads as an option', () => {
    expect(usableForks(document(aFork({ branch: '--all' })))).toEqual([])
    expect(usableForks(document(aFork({ workspacePath: '--force' })))).toEqual([])
  })

  it('drops a Fork with a field missing, or one that is not text at all', () => {
    expect(usableForks(document({ ...aFork(), forkPointSha: undefined }))).toEqual([])
    expect(usableForks(document({ ...aFork(), id: 42 }))).toEqual([])
    expect(usableForks(document({ ...aFork(), workspacePath: null }))).toEqual([])
    expect(usableForks(document('not a record at all'))).toEqual([])
    expect(usableForks(document(null))).toEqual([])
  })

  it('reads no Forks out of a document that has none to give', () => {
    expect(usableForks({})).toEqual([])
    expect(usableForks({ forks: 'plenty' })).toEqual([])
    expect(usableForks(null)).toEqual([])
    expect(usableForks([])).toEqual([])
  })

  // A record carrying more than nodegraph writes is still a record nodegraph
  // can use — the extra is simply not part of the Node.
  it('takes only the fields a Node is made of', () => {
    const fork = aFork()

    expect(usableForks(document({ ...fork, mischief: '--output=/tmp/x' }))).toEqual([fork])
  })
})
