import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startServer } from './server.js'

/**
 * Who is allowed to reach a running nodegraph.
 *
 * nodegraph listens on 127.0.0.1, which is not a wall: every page in the
 * user's browser can reach it, and a page from any website may open a
 * websocket to it or POST to it. On the other end of that websocket is a real
 * `claude` in the user's repository. These are the attacks, written the way
 * they were actually demonstrated.
 */

const FAKE_CLAUDE = `#!/bin/sh
printf 'CWD[%s]\\n' "$(pwd -P)"
while IFS= read -r line; do
  printf 'HEARD[%s]\\n' "$line"
done
`

const EVIL = 'https://evil.example'

/**
 * The wire format, pinned here on purpose. The key rides as a websocket
 * subprotocol and as a request header — never in the url, where it would end
 * up in logs, in Referer and in the user's history.
 */
const keyProtocol = (key: string) => `nodegraph.key.${key}`
const KEY_HEADER = 'x-nodegraph-key'
const KEY_META = 'nodegraph-key'

type Frame = { type: string; [key: string]: unknown }

let sandbox: string
let repo: string
let webRoot: string
let originalPath: string | undefined
let url: string
let stop: (() => Promise<void>) | undefined
const opened: WebSocket[] = []

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 8_000, interval: 20 })

/** Attach to a Node's agent, with whatever the caller wants on the wire. */
const attach = (nodeId: string, sent: { origin?: string; key?: string } = {}) => {
  const socket = new WebSocket(
    `${url.replace(/^http/, 'ws')}/session?node=${nodeId}`,
    sent.key === undefined ? [] : ['nodegraph', keyProtocol(sent.key)],
    sent.origin === undefined ? {} : { origin: sent.origin },
  )
  opened.push(socket)

  const frames: Frame[] = []
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame))

  // Whether the handshake was ever completed at all — an upgrade the server
  // turns away never becomes a websocket, so `open` never fires.
  const handshake = new Promise<'attached' | 'refused'>((resolveHandshake) => {
    socket.on('open', () => resolveHandshake('attached'))
    socket.on('error', () => resolveHandshake('refused'))
    socket.on('close', () => resolveHandshake('refused'))
  })

  return {
    socket,
    frames,
    handshake,
    /** Everything this viewer was given to put on screen, in order. */
    screen: () =>
      frames
        .map((frame) =>
          frame.type === 'opened' || frame.type === 'output' ? String(frame.data ?? '') : '',
        )
        .join(''),
    send: (message: unknown) => socket.send(JSON.stringify(message)),
  }
}

const nodeIds = async (): Promise<string[]> => {
  const body = (await (await fetch(`${url}/api/nodes`)).json()) as { nodes: { id: string }[] }
  return body.nodes.map((node) => node.id)
}

/** The key exactly the way the browser comes by it: off the page it was served. */
const keyFromPage = async (): Promise<string> => {
  const html = await (await fetch(`${url}/`)).text()
  const found = new RegExp(`<meta name="${KEY_META}" content="([^"]+)"`).exec(html)
  if (found?.[1] === undefined) throw new Error(`nodegraph served a page with no key:\n${html}`)
  return found[1]
}

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-access-')))

  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  webRoot = join(sandbox, 'web')
  mkdirSync(webRoot)
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><title>nodegraph</title></head><body><div id="root"></div></body></html>',
  )

  repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')

  const server = await startServer({ repoPath: repo, port: 0, webRoot })
  url = server.url
  stop = server.close
})

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.terminate()
  await stop?.()
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
})

describe('a page on another website', () => {
  it('cannot attach to the agent running in the user’s repository', async () => {
    const attacker = attach('trunk', { origin: EVIL })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot type into the agent running in the user’s repository', async () => {
    const attacker = attach('trunk', { origin: EVIL })
    await expect(attacker.handshake).resolves.toBe('refused')

    // Push the keystrokes anyway, the way the exploit did.
    try {
      attacker.send({ type: 'input', data: 'touch /tmp/PWNED-BY-A-WEB-PAGE\r' })
    } catch {
      // No socket to send them down, which is the whole point.
    }

    // Look over the agent's shoulder as someone who is allowed to. It answers,
    // so it was listening all along — and it never heard the attacker.
    const honest = attach('trunk', { key: await keyFromPage() })
    await settle(() => expect(honest.screen()).toContain('CWD['))
    honest.send({ type: 'input', data: 'anybody there\r' })

    await settle(() => expect(honest.screen()).toContain('HEARD[anybody there]'))
    expect(honest.screen()).not.toContain('PWNED')
  })

  it('cannot attach from a sandboxed frame, which has no origin of its own', async () => {
    // A `data:` url or a sandboxed iframe sends the literal string `null`.
    const attacker = attach('trunk', { origin: 'null' })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot attach just by being some other thing on localhost', async () => {
    // Another dev server on the same machine is a different origin, and the
    // user visits plenty of them. Loopback is not the trust boundary.
    const attacker = attach('trunk', { origin: 'http://localhost:5173' })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot fork a Node behind the user’s back', async () => {
    const before = await nodeIds()

    const response = await fetch(`${url}/api/fork`, {
      method: 'POST',
      // A cross-origin POST needs no preflight when it looks like a form, so
      // it lands whether or not the page can read what comes back.
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: EVIL },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
    expect(git(repo, 'worktree', 'list')).not.toContain('.nodegraph')
  })

  // The two below hand the attacker the key outright — the day it leaks, by a
  // paste into a bug report or a script injected into the page that holds it,
  // being a foreign page has to be disqualifying all by itself.

  it('cannot attach to the agent even holding this run’s key', async () => {
    const attacker = attach('trunk', { origin: EVIL, key: await keyFromPage() })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot fork a Node even holding this run’s key', async () => {
    const before = await nodeIds()

    const response = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: EVIL,
        [KEY_HEADER]: await keyFromPage(),
      },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
  })
})

/**
 * Checking Origin only works on something that tells the truth about where it
 * came from. Anything that is not a browser just leaves the header off, so on
 * its own that check would be a doorman who only stops people wearing badges.
 */
describe('a caller that sends no origin at all', () => {
  it('cannot attach to the agent without the key this run handed out', async () => {
    const attacker = attach('trunk')

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot attach to the agent by making a key up', async () => {
    const real = await keyFromPage()
    const attacker = attach('trunk', { key: `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}` })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot fork a Node without the key this run handed out', async () => {
    const before = await nodeIds()

    const response = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
    expect(git(repo, 'worktree', 'list')).not.toContain('.nodegraph')
  })

  it('cannot fork a Node by making a key up', async () => {
    const before = await nodeIds()

    const response = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [KEY_HEADER]: 'let-me-in' },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
  })

  it('gets a different key every run, so yesterday’s key is worth nothing', async () => {
    const first = await keyFromPage()

    await stop?.()
    const restarted = await startServer({ repoPath: repo, port: 0, webRoot })
    url = restarted.url
    stop = restarted.close

    expect(await keyFromPage()).not.toBe(first)
  })
})

describe('the page nodegraph itself serves', () => {
  it('is given the key, and can attach to the agent and drive it', async () => {
    const key = await keyFromPage()
    const viewer = attach('trunk', { origin: url, key })

    await expect(viewer.handshake).resolves.toBe('attached')
    await settle(() => expect(viewer.screen()).toContain(`CWD[${repo}]`))

    viewer.send({ type: 'input', data: 'hello from the real page\r' })

    await settle(() => expect(viewer.screen()).toContain('HEARD[hello from the real page]'))
  })

  it('is given the key, and can fork a Node with it', async () => {
    const key = await keyFromPage()

    const response = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, [KEY_HEADER]: key },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(201)
    const { node } = (await response.json()) as { node: { id: string } }
    await expect(nodeIds()).resolves.toEqual(['trunk', node.id])
  })

  it('never carries the key in a url, where it would outlive the page', async () => {
    const key = await keyFromPage()
    const html = await (await fetch(`${url}/`)).text()

    // A key in a query string ends up in server logs, in Referer on the way to
    // any link the user follows, and in the browser's own history.
    for (const found of html.matchAll(/(?:href|src|action)="([^"]*)"/g)) {
      expect(found[1]).not.toContain(key)
    }
  })
})
