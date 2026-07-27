import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSupervisor } from './session.js'
import { readSessions, recordFork, recordSession } from './store.js'

const PARENT_SESSION = '99999999-8888-7777-6666-555555555555'
const CHILD_SESSION = '11111111-2222-3333-4444-555555555555'

/**
 * Everything here is driven by a fake `claude` on PATH: it reports the
 * arguments and working directory it was handed, echoes back whatever is typed
 * at it, and exits 7 when told to quit. No model, no account, no network.
 */
const FAKE_CLAUDE = `#!/bin/sh
printf 'ARGV[%s]\\n' "$*"
printf 'CWD[%s]\\n' "$(pwd -P)"
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 7; fi
  printf 'HEARD[%s]\\n' "$line"
done
`

let sandbox: string
let repo: string
let workspace: string
let originalPath: string | undefined
let supervisor: SessionSupervisor

const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 4_000, interval: 20 })

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-session-')))

  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)

  repo = join(sandbox, 'repo')
  mkdirSync(repo)
  workspace = join(sandbox, 'workspace')
  mkdirSync(workspace)

  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  supervisor = new SessionSupervisor(repo)
})

afterEach(() => {
  supervisor.stopAll()
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
})

describe('opening a session on a Node', () => {
  it('runs the claude on PATH inside that Node’s Workspace, in a Context it writes down', async () => {
    const session = await supervisor.open('trunk', workspace)

    await settle(() => expect(session.scrollback()).toContain('CWD['))
    expect(session.scrollback()).toContain(`CWD[${workspace}]`)

    // The Context the agent was actually given is the one the store now names,
    // or nodegraph could never find its way back to this conversation.
    const [recorded] = await readSessions(repo)
    expect(recorded?.nodeId).toBe('trunk')
    expect(session.scrollback()).toContain(`ARGV[--session-id ${recorded?.sessionId ?? ''}]`)
  })

  it('delivers what the user types through to the agent', async () => {
    const session = await supervisor.open('trunk', workspace)
    await settle(() => expect(session.scrollback()).toContain('CWD['))

    session.write('permission granted\r')

    await settle(() => expect(session.scrollback()).toContain('HEARD[permission granted]'))
  })

  it('hands a later opener the agent that is already running, history and all', async () => {
    const first = await supervisor.open('trunk', workspace)
    await settle(() => expect(first.scrollback()).toContain('CWD['))
    first.write('before the reload\r')
    await settle(() => expect(first.scrollback()).toContain('HEARD[before the reload]'))

    const reopened = await supervisor.open('trunk', workspace)

    expect(reopened.scrollback()).toContain('HEARD[before the reload]')

    // Typing into the reopened session must reach the same process, which only
    // holds if nothing was restarted underneath us.
    reopened.write('after the reload\r')
    await settle(() => expect(first.scrollback()).toContain('HEARD[after the reload]'))
  })

  it('reports the agent as finished, with the code it exited on', async () => {
    const session = await supervisor.open('trunk', workspace)
    await settle(() => expect(session.scrollback()).toContain('CWD['))

    expect(session.status()).toEqual({ state: 'running' })

    session.write('quit\r')

    await settle(() => expect(session.status()).toEqual({ state: 'exited', exitCode: 7 }))
  })
})

describe('opening a session on a Node that was Forked from another', () => {
  it('cuts its Context from the parent’s and opens it on the line the Fork was given', async () => {
    await recordSession(repo, {
      nodeId: 'trunk',
      sessionId: PARENT_SESSION,
      startedAt: '2026-07-27T09:00:00.000Z',
    })
    await recordFork(repo, {
      id: 'child',
      parentId: 'trunk',
      branch: 'nodegraph/child',
      workspacePath: workspace,
      forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      createdAt: '2026-07-27T09:01:00.000Z',
      sessionId: CHILD_SESSION,
      parentSessionId: PARENT_SESSION,
      intent: 'try it with a queue instead',
    })

    const session = await supervisor.open('child', workspace)

    await settle(() => expect(session.scrollback()).toContain('CWD['))
    expect(session.scrollback()).toContain(
      `ARGV[--resume ${PARENT_SESSION} --fork-session --session-id ${CHILD_SESSION} try it with a queue instead]`,
    )
  })

  it('resumes the Context that Node has since built up, rather than cutting it from the parent twice', async () => {
    await recordSession(repo, {
      nodeId: 'trunk',
      sessionId: PARENT_SESSION,
      startedAt: '2026-07-27T09:00:00.000Z',
    })
    await recordFork(repo, {
      id: 'child',
      parentId: 'trunk',
      branch: 'nodegraph/child',
      workspacePath: workspace,
      forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      createdAt: '2026-07-27T09:01:00.000Z',
      sessionId: CHILD_SESSION,
      parentSessionId: PARENT_SESSION,
      intent: 'try it with a queue instead',
    })

    const first = await supervisor.open('child', workspace)
    await settle(() => expect(first.scrollback()).toContain('CWD['))
    supervisor.stopAll()

    // A second nodegraph, or the same one tomorrow: the Node's own Context is
    // the one it goes back to, and the parent is not consulted again.
    const later = new SessionSupervisor(repo)
    const reopened = await later.open('child', workspace)
    await settle(() => expect(reopened.scrollback()).toContain('CWD['))
    later.stopAll()

    expect(reopened.scrollback()).toContain(`ARGV[--resume ${CHILD_SESSION}]`)
    expect(reopened.scrollback()).not.toContain('--fork-session')
  })

  it('opens a Fork recorded before nodegraph carried Contexts, in a Context of its own', async () => {
    // Exactly what an older nodegraph wrote: a Fork with no Context named on it.
    await recordFork(repo, {
      id: 'child',
      parentId: 'trunk',
      branch: 'nodegraph/child',
      workspacePath: workspace,
      forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      createdAt: '2026-07-27T09:01:00.000Z',
    })

    const session = await supervisor.open('child', workspace)

    await settle(() => expect(session.scrollback()).toContain('CWD['))
    expect(session.scrollback()).not.toContain('--resume')

    const [recorded] = await readSessions(repo)
    expect(recorded?.nodeId).toBe('child')
    expect(session.scrollback()).toContain(`ARGV[--session-id ${recorded?.sessionId ?? ''}]`)
  })

  it('gives two viewers who arrive together one agent, not one each', async () => {
    const [first, second] = await Promise.all([
      supervisor.open('trunk', workspace),
      supervisor.open('trunk', workspace),
    ])

    await settle(() => expect(first?.scrollback()).toContain('CWD['))
    second?.write('only one of you should hear this\r')

    await settle(() =>
      expect(first?.scrollback()).toContain('HEARD[only one of you should hear this]'),
    )
  })
})

describe('sessions on different Nodes', () => {
  it('run in their own Workspace and never hear each other', async () => {
    const otherWorkspace = join(sandbox, 'other-workspace')
    mkdirSync(otherWorkspace)

    const here = await supervisor.open('trunk', workspace)
    const there = await supervisor.open('fork-of-trunk', otherWorkspace)

    await settle(() => {
      expect(here.scrollback()).toContain(`CWD[${workspace}]`)
      expect(there.scrollback()).toContain(`CWD[${otherWorkspace}]`)
    })

    here.write('meant for the trunk\r')
    await settle(() => expect(here.scrollback()).toContain('HEARD[meant for the trunk]'))

    expect(there.scrollback()).not.toContain('meant for the trunk')
    expect(there.scrollback()).not.toContain(workspace)
  })

  it('end one at a time — a finished agent leaves the others running', async () => {
    const otherWorkspace = join(sandbox, 'other-workspace')
    mkdirSync(otherWorkspace)

    const here = await supervisor.open('trunk', workspace)
    const there = await supervisor.open('fork-of-trunk', otherWorkspace)
    await settle(() => {
      expect(here.scrollback()).toContain('CWD[')
      expect(there.scrollback()).toContain('CWD[')
    })

    there.write('quit\r')
    await settle(() => expect(there.status()).toEqual({ state: 'exited', exitCode: 7 }))

    expect(here.status()).toEqual({ state: 'running' })
    here.write('still talking\r')
    await settle(() => expect(here.scrollback()).toContain('HEARD[still talking]'))
  })
})
