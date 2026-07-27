import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSupervisor } from './session.js'

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

  workspace = join(sandbox, 'workspace')
  mkdirSync(workspace)

  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  supervisor = new SessionSupervisor()
})

afterEach(() => {
  supervisor.stopAll()
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
})

describe('opening a session on a Node', () => {
  it('runs the claude on PATH inside that Node’s Workspace, adding no arguments of its own', async () => {
    const session = supervisor.open('trunk', workspace)

    await settle(() => expect(session.scrollback()).toContain('CWD['))
    expect(session.scrollback()).toContain('ARGV[]')
    expect(session.scrollback()).toContain(`CWD[${workspace}]`)
  })

  it('delivers what the user types through to the agent', async () => {
    const session = supervisor.open('trunk', workspace)
    await settle(() => expect(session.scrollback()).toContain('CWD['))

    session.write('permission granted\r')

    await settle(() => expect(session.scrollback()).toContain('HEARD[permission granted]'))
  })

  it('hands a later opener the agent that is already running, history and all', async () => {
    const first = supervisor.open('trunk', workspace)
    await settle(() => expect(first.scrollback()).toContain('CWD['))
    first.write('before the reload\r')
    await settle(() => expect(first.scrollback()).toContain('HEARD[before the reload]'))

    const reopened = supervisor.open('trunk', workspace)

    expect(reopened.scrollback()).toContain('HEARD[before the reload]')

    // Typing into the reopened session must reach the same process, which only
    // holds if nothing was restarted underneath us.
    reopened.write('after the reload\r')
    await settle(() => expect(first.scrollback()).toContain('HEARD[after the reload]'))
  })

  it('reports the agent as finished, with the code it exited on', async () => {
    const session = supervisor.open('trunk', workspace)
    await settle(() => expect(session.scrollback()).toContain('CWD['))

    expect(session.status()).toEqual({ state: 'running' })

    session.write('quit\r')

    await settle(() => expect(session.status()).toEqual({ state: 'exited', exitCode: 7 }))
  })
})

describe('sessions on different Nodes', () => {
  it('run in their own Workspace and never hear each other', async () => {
    const otherWorkspace = join(sandbox, 'other-workspace')
    mkdirSync(otherWorkspace)

    const here = supervisor.open('trunk', workspace)
    const there = supervisor.open('fork-of-trunk', otherWorkspace)

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

    const here = supervisor.open('trunk', workspace)
    const there = supervisor.open('fork-of-trunk', otherWorkspace)
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
