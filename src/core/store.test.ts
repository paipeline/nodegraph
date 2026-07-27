import { describe, expect, it } from 'vitest'
import { forkRecord, usableForks, workspaceOf, type StoredFork } from './store.js'

/**
 * What nodegraph is willing to believe about the Nodes it wrote down.
 *
 * Plain data in, plain data out: the store is a file in somebody's repository,
 * so the rule for reading it back has to be testable without one.
 */

const HOME = '/repo/.nodegraph'

const aFork = (overrides: Partial<StoredFork> = {}): StoredFork => ({
  ...forkRecord({
    id: 'a1b2c3d4',
    parentId: 'trunk',
    home: HOME,
    forkPointSha: '0123456789abcdef0123456789abcdef01234567',
    createdAt: '2026-07-27T09:00:00.000Z',
  }),
  ...overrides,
})

const document = (...forks: unknown[]) => ({ forks })

describe('the Forks a store is worth believing', () => {
  it('keeps a record of the shape nodegraph itself writes', () => {
    const fork = aFork()

    expect(usableForks(document(fork), HOME)).toEqual([fork])
  })

  it('keeps an abbreviated fork point, which is still a commit', () => {
    const fork = aFork({ forkPointSha: '0123abc' })

    expect(usableForks(document(fork), HOME)).toEqual([fork])
  })

  // The fork point is handed to git as the thing to measure against. A value
  // that git would read as an option is not a commit, and a Node cut from
  // something that is not a commit is not a Node nodegraph ever made.
  it('drops a Fork whose fork point is an option rather than a commit', () => {
    const kept = aFork()
    const invented = aFork({ id: 'ffffffff', forkPointSha: '--output=/tmp/x' })

    expect(usableForks(document(invented, kept), HOME)).toEqual([kept])
  })

  it('drops a Fork whose fork point is not a commit at all', () => {
    for (const forkPointSha of ['HEAD', 'main', '', 'z'.repeat(40), '../etc/passwd', 'abc']) {
      expect(usableForks(document(aFork({ forkPointSha })), HOME)).toEqual([])
    }
  })

  // The branch is handed to git when a Workspace is taken away, and the path is
  // both an argument and a working directory. Either one spelled as an option
  // is a record nodegraph did not write.
  it('drops a Fork whose branch or Workspace reads as an option', () => {
    expect(usableForks(document(aFork({ branch: '--all' })), HOME)).toEqual([])
    expect(usableForks(document(aFork({ workspacePath: '--force' })), HOME)).toEqual([])
  })

  /**
   * A Workspace is the directory git gets run in, so it is the field with the
   * longest reach: everything git decides afterwards — which repository it is
   * in, whose config it obeys, which `core.fsmonitor` command it starts — it
   * decides from there. nodegraph puts every Workspace it makes in one place
   * under one name, so a record naming anywhere else is a record it never wrote.
   */
  it('drops a Fork whose Workspace is a directory nodegraph would never have made', () => {
    for (const workspacePath of [
      '/elsewhere/vendor/somedep',
      '/repo/.nodegraph/workspaces/somebody-else',
      '/repo/.nodegraph/workspaces/a1b2c3d4/..',
      '/repo/.nodegraph/workspaces',
      '/repo',
      workspaceOf('/another-repo/.nodegraph', 'a1b2c3d4'),
    ]) {
      expect(usableForks(document(aFork({ workspacePath })), HOME)).toEqual([])
    }
  })

  it('drops a Fork whose branch is not the branch nodegraph names for it', () => {
    for (const branch of ['nodegraph/somebody-else', 'main', 'nodegraph/a1b2c3d4/extra']) {
      expect(usableForks(document(aFork({ branch })), HOME)).toEqual([])
    }
  })

  /**
   * Borrowing the name of a Node the graph really draws is how a record gets
   * past a filter that asks "is this Node on the graph?" and then goes on to
   * use the record's own fields. The Trunk is the easiest name to borrow — it
   * is on every graph — and it is not a name nodegraph gives a Fork.
   */
  it('drops a Fork wearing a name nodegraph does not give one', () => {
    for (const id of ['trunk', 'real', 'A1B2C3D4', 'a1b2c3d', 'a1b2c3d4e', '../../a1b2c3d4']) {
      expect(usableForks(document(aFork({ id })), HOME)).toEqual([])
    }
  })

  it('drops a Fork whose parent is not a Node nodegraph could have named', () => {
    expect(usableForks(document(aFork({ parentId: 'nodegraph/a1b2c3d4' })), HOME)).toEqual([])
    expect(usableForks(document(aFork({ parentId: '--all' })), HOME)).toEqual([])
    expect(usableForks(document(aFork({ parentId: 'deadbeef' })), HOME)).toEqual([
      aFork({ parentId: 'deadbeef' }),
    ])
  })

  // One Node, one record. Two records under one name would be one Node measured
  // twice, and which of the two answered would be whichever came last.
  it('believes one record per Node, however many the file offers', () => {
    const fork = aFork()

    expect(usableForks(document(fork, { ...fork, forkPointSha: 'deadbeef' }), HOME)).toEqual([fork])
  })

  it('drops a Fork with a field missing, or one that is not text at all', () => {
    expect(usableForks(document({ ...aFork(), forkPointSha: undefined }), HOME)).toEqual([])
    expect(usableForks(document({ ...aFork(), id: 42 }), HOME)).toEqual([])
    expect(usableForks(document({ ...aFork(), workspacePath: null }), HOME)).toEqual([])
    expect(usableForks(document('not a record at all'), HOME)).toEqual([])
    expect(usableForks(document(null), HOME)).toEqual([])
  })

  it('reads no Forks out of a document that has none to give', () => {
    expect(usableForks({}, HOME)).toEqual([])
    expect(usableForks({ forks: 'plenty' }, HOME)).toEqual([])
    expect(usableForks(null, HOME)).toEqual([])
    expect(usableForks([], HOME)).toEqual([])
  })

  // A record carrying more than nodegraph writes is still a record nodegraph
  // can use — the extra is simply not part of the Node.
  it('takes only the fields a Node is made of', () => {
    const fork = aFork()

    expect(usableForks(document({ ...fork, mischief: '--output=/tmp/x' }), HOME)).toEqual([fork])
  })
})

/**
 * The record and the rule are one thing said once. What nodegraph writes down
 * for a Fork is built here, and what it believes on the way back is checked
 * here, so the two cannot drift apart and leave a Node nodegraph made looking
 * like one it did not.
 */
describe('the record nodegraph writes for a Fork', () => {
  it('is a record nodegraph believes', () => {
    const written = forkRecord({
      id: 'deadbeef',
      parentId: 'a1b2c3d4',
      home: HOME,
      forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      createdAt: '2026-07-27T09:00:00.000Z',
    })

    expect(usableForks(document(written), HOME)).toEqual([written])
  })
})
