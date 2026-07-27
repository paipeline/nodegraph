import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_PROTOCOL, toKeyProtocol } from '../core/guard.js'
import { startServer } from './server.js'

/**
 * The seam the browser actually talks to. Driven by a fake `claude` on PATH,
 * so these tests never reach a model, an account or the network. It answers
 * `size` with what the tty reports, which is how we can see the terminal the
 * agent believes it is running in.
 */
const FAKE_CLAUDE = `#!/bin/sh
printf 'ARGV[%s]\\n' "$*"
printf 'CWD[%s]\\n' "$(pwd -P)"
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 7; fi
  if [ "$line" = "size" ]; then printf 'SIZE[%s]\\n' "$(stty size)"; continue; fi
  printf 'HEARD[%s]\\n' "$line"
done
`

type Frame = { type: string; [key: string]: unknown }

let sandbox: string
let repo: string
let originalPath: string | undefined
let url: string
let key: string
let stop: (() => Promise<void>) | undefined
const opened: WebSocket[] = []

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 4_000, interval: 20 })

/** A viewer, the way a browser tab is a viewer — key and all. */
const view = (nodeId: string) => {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/session?node=${nodeId}`, [
    SESSION_PROTOCOL,
    toKeyProtocol(key),
  ])
  opened.push(socket)

  const frames: Frame[] = []
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame))

  return {
    socket,
    frames,
    /** Everything this viewer was given to put on screen, in order. */
    screen: () =>
      frames
        .map((frame) =>
          frame.type === 'opened' || frame.type === 'output' ? String(frame.data ?? '') : '',
        )
        .join(''),
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  }
}

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-ws-')))

  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')

  const server = await startServer({ repoPath: repo, port: 0 })
  url = server.url
  key = server.key
  stop = server.close
})

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.terminate()
  await stop?.()
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
})

describe('the terminal behind a Node', () => {
  it('runs the agent in that Node’s Workspace and streams it to the viewer', async () => {
    const viewer = view('trunk')

    await settle(() => expect(viewer.frames[0]).toMatchObject({ type: 'opened', nodeId: 'trunk' }))
    await settle(() => expect(viewer.screen()).toContain(`CWD[${repo}]`))
  })

  it('carries what the user types over to the agent', async () => {
    const viewer = view('trunk')
    await settle(() => expect(viewer.screen()).toContain('CWD['))

    viewer.send({ type: 'input', data: 'yes, allow it\r' })

    await settle(() => expect(viewer.screen()).toContain('HEARD[yes, allow it]'))
  })

  it('leaves the agent running when the page goes away, and hands its history back', async () => {
    const before = view('trunk')
    await settle(() => expect(before.screen()).toContain('CWD['))
    before.send({ type: 'input', data: 'said before the reload\r' })
    await settle(() => expect(before.screen()).toContain('HEARD[said before the reload]'))

    before.close()
    await settle(() => expect(before.socket.readyState).toBe(WebSocket.CLOSED))

    const after = view('trunk')

    await settle(() => expect(after.screen()).toContain('HEARD[said before the reload]'))

    // Still the same process on the other end, still listening.
    after.send({ type: 'input', data: 'said after the reload\r' })
    await settle(() => expect(after.screen()).toContain('HEARD[said after the reload]'))
  })

  it('says plainly that the agent has finished, to whoever is watching and to whoever arrives later', async () => {
    const watching = view('trunk')
    await settle(() => expect(watching.screen()).toContain('CWD['))

    watching.send({ type: 'input', data: 'quit\r' })

    await settle(() => expect(watching.frames).toContainEqual({ type: 'exited', exitCode: 7 }))

    const arriving = view('trunk')
    await settle(() =>
      expect(arriving.frames[0]).toMatchObject({
        type: 'opened',
        status: { state: 'exited', exitCode: 7 },
      }),
    )
  })

  it('gives the agent the size of the terminal the user is looking at', async () => {
    const viewer = view('trunk')
    await settle(() => expect(viewer.screen()).toContain('CWD['))

    viewer.send({ type: 'resize', cols: 100, rows: 42 })
    viewer.send({ type: 'input', data: 'size\r' })

    // `stty size` reports rows first, then columns.
    await settle(() => expect(viewer.screen()).toContain('SIZE[42 100]'))
  })

  it('refuses a Node it has never heard of rather than opening a terminal on nothing', async () => {
    const viewer = view('no-such-node')

    await settle(() => expect(viewer.frames[0]).toMatchObject({ type: 'error' }))
    await settle(() => expect(viewer.socket.readyState).toBe(WebSocket.CLOSED))
  })

  it('says so when it cannot work out which Workspace to run in', async () => {
    // The repository the server was started in has been deleted underneath it.
    rmSync(repo, { recursive: true, force: true })

    const viewer = view('trunk')

    await settle(() => expect(viewer.frames[0]).toMatchObject({ type: 'error' }))
    await settle(() => expect(viewer.socket.readyState).toBe(WebSocket.CLOSED))
  })

  /**
   * The other place a Workspace becomes the directory a process is started in.
   * `graph.json` sits in the user's repository, so it can name anywhere; a Node
   * is only ever a directory git listed as a worktree of this repository, so a
   * record naming anywhere else opens no terminal — not even wearing the
   * Trunk's own name, which every graph has and so is the easiest one to wear.
   */
  it('opens an agent only in a Workspace git has, whatever the store says', async () => {
    const elsewhere = join(sandbox, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(repo, '.nodegraph'), { recursive: true })
    const borrowed = {
      parentId: 'trunk',
      workspacePath: elsewhere,
      forkPointSha: git(repo, 'rev-parse', 'HEAD'),
      createdAt: '2026-07-27T09:00:00.000Z',
    }
    writeFileSync(
      join(repo, '.nodegraph', 'graph.json'),
      JSON.stringify({
        forks: [
          { ...borrowed, id: 'trunk', branch: 'nodegraph/trunk' },
          { ...borrowed, id: 'a1b2c3d4', branch: 'nodegraph/a1b2c3d4' },
        ],
      }),
    )

    const stranger = view('a1b2c3d4')
    await settle(() => expect(stranger.frames[0]).toMatchObject({ type: 'error' }))

    const trunk = view('trunk')
    await settle(() => expect(trunk.screen()).toContain(`CWD[${repo}]`))
    expect(trunk.screen()).not.toContain(elsewhere)
  })
})
