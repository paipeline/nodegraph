import { describe, expect, it } from 'vitest'
import {
  forkRecord,
  readStore,
  sessionRecord,
  usableForks,
  usableSessions,
  workspaceOf,
  type StoredFork,
  type StoredSession,
} from './store.js'

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
 * The three fields a Fork carries about its Context. Every one of them leaves
 * the store for somewhere real: the line becomes claude's trailing argument,
 * and either Context name becomes both a flag's value in claude's argv and a
 * filename under claude's home. So each is checked here, on the way back,
 * rather than at the call site that happens to use it next.
 */
describe('the Context a stored Fork claims', () => {
  const CONTEXT = '11111111-2222-3333-4444-555555555555'
  const PARENT_CONTEXT = '99999999-8888-7777-6666-555555555555'

  it('keeps a Fork carrying a line, a Context of its own and the one it came from', () => {
    const fork = aFork({
      sessionId: CONTEXT,
      parentSessionId: PARENT_CONTEXT,
      intent: 'try it with a queue instead',
    })

    expect(usableForks(document(fork), HOME)).toEqual([fork])
  })

  /**
   * The line is handed to claude as its trailing prompt, and claude reads a
   * leading dash as a flag — `--dangerously-skip-permissions` among them. The
   * rule that says so already exists for the line the user types; this is the
   * same line coming back off a disk anybody can write to.
   */
  it('drops a Fork whose first instruction claude would read as a flag', () => {
    for (const intent of ['--dangerously-skip-permissions', '-p', '--', '-']) {
      expect(usableForks(document(aFork({ intent })), HOME)).toEqual([])
    }
  })

  // A line nodegraph would have tidied before writing it down is a line
  // nodegraph did not write down: believing it would put words in the user's
  // mouth that they never typed and nodegraph never stored.
  it('drops a Fork whose line is not the line nodegraph would have kept', () => {
    for (const intent of ['  padded  ', 'two\nlines', 'bell\u0007ing', '']) {
      expect(usableForks(document(aFork({ intent })), HOME)).toEqual([])
    }
  })

  it('drops a Fork whose Context is not a name nodegraph could have given one', () => {
    for (const sessionId of [
      '--dangerously-skip-permissions',
      '../../../../etc/passwd',
      'not-a-uuid',
      '',
      `${CONTEXT}/..`,
    ]) {
      expect(usableForks(document(aFork({ sessionId })), HOME)).toEqual([])
    }
  })

  /**
   * The inherited Context names a file nodegraph opens and reads the whole of
   * into the child Node's memory. A name that walks out of claude's home is a
   * way to have an agent read a file it was never pointed at.
   */
  it('drops a Fork whose inherited Context is not a name nodegraph could have given one', () => {
    for (const parentSessionId of ['../../../secrets', 'trunk', '-']) {
      expect(usableForks(document(aFork({ parentSessionId })), HOME)).toEqual([])
    }
  })

  it('believes a Fork that plainly inherited nothing, and one written before Contexts existed', () => {
    expect(usableForks(document(aFork({ parentSessionId: null })), HOME)).toEqual([
      aFork({ parentSessionId: null }),
    ])

    const older = { ...aFork() }
    delete older.sessionId
    expect(usableForks(document(older), HOME)).toEqual([{ ...older, sessionId: undefined }])
  })
})

/**
 * A Context record says which conversation a Node's agent is living in. Its
 * name reaches claude's argv and claude's filesystem exactly as a Fork's does,
 * so it is read back under the same rule rather than trusted for being smaller.
 */
describe('the Contexts a store is worth believing', () => {
  const aSession = (overrides: Partial<StoredSession> = {}): StoredSession => ({
    ...sessionRecord({
      nodeId: 'a1b2c3d4',
      sessionId: '11111111-2222-3333-4444-555555555555',
      startedAt: '2026-07-27T09:00:00.000Z',
    }),
    ...overrides,
  })

  it('keeps a record of the shape nodegraph itself writes, for a Fork and for the Trunk', () => {
    expect(usableSessions({ sessions: [aSession()] })).toEqual([aSession()])
    expect(usableSessions({ sessions: [aSession({ nodeId: 'trunk' })] })).toEqual([
      aSession({ nodeId: 'trunk' }),
    ])
  })

  it('drops a Context whose name is not one nodegraph could have given', () => {
    for (const sessionId of ['--dangerously-skip-permissions', '../../../../etc/passwd', 'x']) {
      expect(usableSessions({ sessions: [aSession({ sessionId })] })).toEqual([])
    }
  })

  it('drops a Context belonging to a Node nodegraph could not have named', () => {
    for (const nodeId of ['--all', '../trunk', 'nodegraph/a1b2c3d4', '']) {
      expect(usableSessions({ sessions: [aSession({ nodeId })] })).toEqual([])
    }
  })

  it('believes one Context per Node, however many the file offers', () => {
    const first = aSession()
    const second = aSession({ sessionId: '22222222-2222-3333-4444-555555555555' })

    expect(usableSessions({ sessions: [first, second] })).toEqual([first])
  })

  it('reads no Contexts out of a document that has none to give', () => {
    expect(usableSessions({})).toEqual([])
    expect(usableSessions({ sessions: 'plenty' })).toEqual([])
    expect(usableSessions(null)).toEqual([])
  })
})

/**
 * A store nodegraph cannot read is the one case where being helpful is the
 * damage. Reading it as "no Forks" and carrying on means the next thing written
 * replaces it, and what goes with it — which Node came from which, and from
 * which commit — is the one thing git can never give back.
 */
describe('a store that cannot be read', () => {
  const believable = JSON.stringify({ forks: [aFork()] })

  it('is not the same thing as a store that is not there yet', () => {
    const fresh = readStore(null, HOME)

    expect(fresh.refusal).toBeNull()
    expect(fresh.forks).toEqual([])
    expect(fresh.sessions).toEqual([])
  })

  it('reads back what it says when it says anything at all', () => {
    const store = readStore(believable, HOME)

    expect(store.refusal).toBeNull()
    expect(store.forks).toEqual([aFork()])
  })

  it('refuses, by name, rather than reading as empty', () => {
    for (const raw of [
      '',
      '{"forks": [',
      '<<<<<<< HEAD\n{"forks": []}\n=======\n{"forks": []}\n>>>>>>> theirs\n',
      'null',
      '[]',
      '"a graph"',
    ]) {
      const store = readStore(raw, HOME)

      expect(store.refusal).toContain('graph.json')
      expect(store.forks).toEqual([])
      expect(store.sessions).toEqual([])
    }
  })

  // The sentence has to be the one the user reads, so it says what to do about
  // it and where — a refusal nobody can act on is a refusal that gets ignored.
  it('says where the file is and that it has been left alone', () => {
    const { refusal } = readStore('{', HOME)

    expect(refusal).toContain(`${HOME}/graph.json`)
    expect(refusal).toMatch(/left|untouched|not (been )?(changed|written)/i)
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

  it('is a record nodegraph believes, Context and line and all', () => {
    const written = forkRecord({
      id: 'deadbeef',
      parentId: 'a1b2c3d4',
      home: HOME,
      forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      createdAt: '2026-07-27T09:00:00.000Z',
      sessionId: '11111111-2222-3333-4444-555555555555',
      parentSessionId: '99999999-8888-7777-6666-555555555555',
      intent: 'try it with a queue instead',
    })

    expect(usableForks(document(written), HOME)).toEqual([written])
  })

  it('refuses to make a record out of a line claude would read as a flag', () => {
    expect(() =>
      forkRecord({
        id: 'deadbeef',
        parentId: 'a1b2c3d4',
        home: HOME,
        forkPointSha: '0123456789abcdef0123456789abcdef01234567',
        createdAt: '2026-07-27T09:00:00.000Z',
        intent: '--dangerously-skip-permissions',
      }),
    ).toThrow(/flag/i)
  })
})

describe('the record nodegraph writes for a Context', () => {
  it('is a record nodegraph believes', () => {
    const written = sessionRecord({
      nodeId: 'a1b2c3d4',
      sessionId: '11111111-2222-3333-4444-555555555555',
      startedAt: '2026-07-27T09:00:00.000Z',
    })

    expect(usableSessions({ sessions: [written] })).toEqual([written])
  })

  it('refuses to make a record naming a Context nodegraph could not have named', () => {
    expect(() =>
      sessionRecord({
        nodeId: 'a1b2c3d4',
        sessionId: '../../../../etc/passwd',
        startedAt: '2026-07-27T09:00:00.000Z',
      }),
    ).toThrow(/Context/i)
  })
})
