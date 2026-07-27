import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
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
const SESSION_PROTOCOL = 'nodegraph'
const KEY_HEADER = 'x-nodegraph-key'
const KEY_META = 'nodegraph-key'

type Frame = { type: string; [key: string]: unknown }

let sandbox: string
let repo: string
let webRoot: string
let originalPath: string | undefined
let url: string
let boundTo: string
let stop: (() => Promise<void>) | undefined
const opened: WebSocket[] = []
const rawSockets: Socket[] = []

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 8_000, interval: 20 })

/**
 * Attach to a Node's agent, with whatever the caller wants on the wire.
 *
 * `key` goes up the way the page sends it, as a subprotocol. `keyInUrl` puts it
 * in the query string instead — the carrier ADR-0003 turned down — and offers
 * only the plain subprotocol, so the key in the url is the sole thing the
 * server could possibly let it in on. `path` upgrades somewhere other than the
 * one path that is a session.
 */
const attach = (
  nodeId: string,
  sent: { origin?: string; key?: string; keyInUrl?: string; path?: string } = {},
) => {
  const protocols =
    sent.key !== undefined
      ? [SESSION_PROTOCOL, keyProtocol(sent.key)]
      : sent.keyInUrl !== undefined
        ? [SESSION_PROTOCOL]
        : []

  const socket = new WebSocket(
    `${url.replace(/^http/, 'ws')}${sent.path ?? '/session'}?node=${nodeId}` +
      (sent.keyInUrl === undefined ? '' : `&key=${sent.keyInUrl}`),
    protocols,
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

/**
 * Whether the key is in there — asked as a yes/no on purpose. `toContain`
 * would print the haystack when it fails, which for these tests is the very
 * secret under test, straight into the log the failure gets pasted into.
 */
const carries = (text: string, key: string): boolean => text.includes(key)

/**
 * The names of the headers on a response, lowercased — and only the names. A
 * failing assertion prints what it was given, and a header *value* is exactly
 * where this run's key would be if it ever leaked into one.
 *
 * `rawHeaders` alternates name, value, name, value.
 */
const namesOf = (rawHeaders: string[]): string[] =>
  rawHeaders.filter((_, at) => at % 2 === 0).map((name) => name.toLowerCase())

/** The same, off a response we read as bytes rather than let node parse. */
const namesIn = (head: string): string[] =>
  head
    .split('\r\n')
    .slice(1)
    .filter((line) => line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')).trim().toLowerCase())

/** The port we are really listening on, which is the one thing a forged Host cannot change. */
const port = (): number => Number(new URL(url).port)

/**
 * A request made the way an attacker makes one: with whatever it pleases in
 * the Host header, and a body on whatever method it likes. `fetch` refuses to
 * send a forged Host — the fetch spec forbids it — and Host is precisely the
 * header a rebound name controls, so this has to go out over raw http.
 *
 * The body is framed with an explicit content-length because node's own client
 * quietly drops one written on a GET otherwise, which would make a test of "a
 * GET carrying a fork request" a test of an empty request instead. Nothing on
 * the wire stops a GET from having a body; only this client does.
 */
const raw = (sent: {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; head: string; headerNames: string[]; body: string }> =>
  new Promise((done, fail) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: port(),
        method: sent.method,
        path: sent.path,
        headers:
          sent.body === undefined
            ? (sent.headers ?? {})
            : { 'content-length': String(Buffer.byteLength(sent.body)), ...sent.headers },
      },
      (incoming) => {
        let body = ''
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => {
          body += chunk
        })
        incoming.on('end', () =>
          done({
            status: incoming.statusCode ?? 0,
            head: incoming.rawHeaders.join('\n'),
            headerNames: namesOf(incoming.rawHeaders),
            body,
          }),
        )
      },
    )
    outgoing.on('error', fail)
    if (sent.body !== undefined) outgoing.write(sent.body)
    outgoing.end()
  })

/**
 * A websocket handshake spelled out by hand, so the response can be read the
 * way everything between here and the page reads it: as bytes. A ws client
 * would hand back a tidy object; what is at stake is what the server actually
 * wrote on the wire. Resolves with the response head, up to the blank line.
 */
const rawHandshake = (nodeId: string, offered: string[]): Promise<string> =>
  new Promise((done, fail) => {
    const socket = connect(port(), '127.0.0.1')
    rawSockets.push(socket)

    socket.on('error', fail)
    socket.on('connect', () =>
      socket.write(
        `GET /session?node=${nodeId} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port()}\r\n` +
          `Origin: ${url}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Protocol: ${offered.join(', ')}\r\n` +
          '\r\n',
      ),
    )

    let seen = ''
    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1')
      const blankLine = seen.indexOf('\r\n\r\n')
      if (blankLine !== -1) done(seen.slice(0, blankLine))
    })
    socket.on('close', () => done(seen))
  })

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
  writeFileSync(join(webRoot, 'app.js'), 'console.log("nodegraph")')

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
  boundTo = server.address
  stop = server.close
})

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.terminate()
  for (const socket of rawSockets.splice(0)) socket.destroy()
  await stop?.()
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * The outermost door, and the only one that keeps other machines out at all.
 *
 * Everything else in this file is about pages in the user's own browser,
 * because that is the threat that survives a loopback bind. Bind the wildcard
 * instead and there is a whole new one: `claude`, running in the user's
 * repository with the user's credentials, is now reachable from the café wifi,
 * the conference network, the flatmate's laptop — and the two doors below are
 * all that stand in the way, on a network where nothing is same-origin and
 * nobody has to be a browser.
 *
 * The interface asked for and the interface bound are not the same fact, so
 * this reads the second one, off the listening socket.
 */
describe('the interface nodegraph listens on', () => {
  it('is loopback, and never every interface on the machine', () => {
    // `::` and `0.0.0.0` are the wildcard — the failure this is here to catch —
    // and neither is in this list.
    expect(['127.0.0.1', '::1']).toContain(boundTo)
  })
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
 * DNS rebinding, which is how a foreign page stops looking foreign.
 *
 * The attacker serves a page from a name they own, then repoints that name at
 * 127.0.0.1. The browser now believes evil.example *is* this server: it sends
 * `Host: evil.example:<our port>`, calls the request same-origin, and hands
 * the response body to the attacker's script. Every header in that request is
 * the attacker's to write. The port we are really listening on is not — which
 * is the whole reason "ourselves" is built from the listening port and never
 * from Host.
 */
describe('a page whose dns has been rebound onto this server', () => {
  const rebound = () => ({ host: `evil.example:${port()}`, origin: `http://evil.example:${port()}` })

  it('cannot read this run’s key off the page by forging Host', async () => {
    const key = await keyFromPage()
    const { host, origin } = rebound()

    const honest = await raw({ method: 'GET', path: '/' })
    const attacker = await raw({ method: 'GET', path: '/', headers: { host, origin } })

    // The page really does carry the key, so the assertion below has teeth.
    expect(carries(honest.body, key)).toBe(true)

    // And the rebound name gets none of it, in the body or anywhere else.
    expect(carries(attacker.body, key)).toBe(false)
    expect(carries(attacker.head, key)).toBe(false)
  })

  it('cannot fork a Node by forging Host, even holding this run’s key', async () => {
    const before = await nodeIds()
    const { host, origin } = rebound()

    const response = await raw({
      method: 'POST',
      path: '/api/fork',
      headers: {
        host,
        origin,
        'content-type': 'application/json',
        [KEY_HEADER]: await keyFromPage(),
      },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
    expect(git(repo, 'worktree', 'list')).not.toContain('.nodegraph')
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

  /**
   * Reads go unlocked on purpose — the same-origin policy is what guards them,
   * and a key on GET would only lock the user out of their own page. That makes
   * the method the thing deciding whether the key is asked for at all, so an
   * endpoint that changes the world and does not check its own method is not
   * behind the key: a caller simply spells the request GET and walks past it.
   *
   * The body is the interesting case. A GET may carry one — nothing stops it on
   * the wire — so "it would crash on the empty body anyway" is not a door.
   */
  it('cannot fork a Node by asking for one as a read, which takes no key', async () => {
    const before = await nodeIds()
    const forkRequest = { 'content-type': 'application/json' }
    const body = JSON.stringify({ parentId: 'trunk' })

    const asked = [
      await raw({ method: 'GET', path: '/api/fork' }),
      await raw({ method: 'GET', path: '/api/fork', headers: forkRequest, body }),
      await raw({ method: 'HEAD', path: '/api/fork', headers: forkRequest, body }),
    ]

    // Forking is something you POST. Read it and there is nothing there — not a
    // fork, and not a 500 from a handler that got as far as parsing the body.
    expect(asked.map((response) => response.status)).toEqual([404, 404, 404])
    await expect(nodeIds()).resolves.toEqual(before)
    expect(git(repo, 'worktree', 'list')).not.toContain('.nodegraph')
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

/**
 * The key is the entire second door, and the only thing that makes it a door
 * is that it cannot be worked out. Randomness is not something a test can look
 * at directly — so pin the two things a key anybody could derive gives up
 * instead. Anything read off the clock, or off a counter, is short enough to
 * walk through and comes out the same for two nodegraphs started together;
 * being *different from the last one* is a bar a wall clock clears easily.
 */
describe('the key this run mints', () => {
  /**
   * Keys from `count` runs, started together and shut straight back down. One
   * run mints one key, so standing several up at once is the only way to see
   * more than one of them.
   */
  const mintMany = async (count: number): Promise<string[]> => {
    const started = await Promise.all(
      Array.from({ length: count }, () => startServer({ repoPath: repo, port: 0, webRoot })),
    )
    const keys = started.map((server) => server.key)
    await Promise.all(started.map((server) => server.close()))
    return keys
  }

  it('is too long to guess, and no two runs share one however close together they start', async () => {
    const keys = await mintMany(32)

    // Only the length, never the key itself — a failure here is printed.
    for (const key of keys) expect(key.length).toBeGreaterThanOrEqual(32)

    // Thirty-two of them minted inside the same handful of milliseconds. A key
    // that is the time of day would hand most of them the very same one.
    expect(new Set(keys).size).toBe(keys.length)
  })

  /**
   * Long and all different is a bar a counter clears.
   *
   * `key-1`, `key-2`, `key-3` padded out to any length you like is distinct
   * every time and as long as you please, and it is also worth nothing: a
   * caller who has seen one key has seen them all. The test above would not
   * notice, and neither would a reviewer reading it. So what is pinned here is
   * the property a counter cannot fake — not how long the keys are or whether
   * they repeat, but the *shape* of a pile of them.
   *
   * Anything derived by counting, or read off the clock, gives itself away
   * twice over. It agrees with its neighbours on a long opening — `key-` and
   * whatever the era of the timestamp is — and it varies in only the last
   * position or two, leaving every other position with a single value in it.
   * Both are visible in ninety-six keys without knowing the first thing about
   * how they were made.
   *
   * The thresholds are set where real randomness is never anywhere near them. A
   * base64url key draws each character from 64, so two keys agreeing on ten
   * characters has probability 64**-10, and across all 4,560 pairs the odds of
   * this failing on honest keys are under 4e-15 — one run in 250 million
   * million. The positional bar is looser still: getting fewer than 12 distinct
   * characters into 96 draws over a 64-symbol alphabet sits around 1e-60. A
   * security test that fails now and then gets deleted by whoever is unlucky
   * enough to hit it, so neither of these may ever be a coin toss.
   */
  it('cannot be worked out from another one, however many of them are laid side by side', async () => {
    const keys = await mintMany(96)
    const shortest = Math.min(...keys.map((key) => key.length))

    const shared = (one: string, other: string): number => {
      let at = 0
      while (at < one.length && at < other.length && one[at] === other[at]) at += 1
      return at
    }

    let longestShared = 0
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        longestShared = Math.max(longestShared, shared(keys[i] ?? '', keys[j] ?? ''))
      }
    }

    // How many characters two keys agreed on — never which ones.
    expect(longestShared).toBeLessThan(10)

    // The last character is left out. base64url spends 6 bits per character
    // and 32 bytes do not divide by 6, so the final one carries what is left
    // over — 4 bits, a sixteenth of the alphabet the others draw from. It is
    // the one position where this bar would not mean the same thing, so it is
    // not asked to clear it.
    const thin = []
    for (let at = 0; at < shortest - 1; at += 1) {
      const distinct = new Set(keys.map((key) => key[at])).size
      if (distinct < 12) thin.push({ at, distinct })
    }

    // Positions and counts, so a failure prints numbers and no key material.
    expect(thin).toEqual([])
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

/**
 * One path is a session, and it is the only one.
 *
 * An upgrade does not go past the request handler at all — it is its own event
 * on the server, and whatever answers it answers every path at once. So the
 * path is not routing here, it is the surface: leave it unread and every url
 * nodegraph has, and every url it does not have, is a second door onto the same
 * pty. The api routes, the app shell, a path that never existed — attach to any
 * of them and you are in front of `claude` in the user's repository.
 *
 * Handing over this run's key and our own origin is the point: both doors are
 * wide open here, so what is left being tested is only the path.
 */
describe('an upgrade to some path that is not the session', () => {
  it('never becomes a session, however good the caller’s credentials are', async () => {
    const key = await keyFromPage()

    // An api route, the shell, a client-side route, a path that is nearly the
    // session, and one that never existed.
    for (const path of ['/api/nodes', '/', '/node/trunk', '/session/extra', '/nowhere']) {
      const attacker = attach('trunk', { origin: url, key, path })

      await expect(attacker.handshake).resolves.toBe('refused')
      expect(attacker.frames).toEqual([])
      expect(attacker.screen()).not.toContain('CWD[')
    }
  })
})

/**
 * The key travels in a header and in a websocket subprotocol, and is refused
 * anywhere else — ADR-0003.
 *
 * A url is the one part of a request that everything writes down: this
 * server's own log, the Referer carried to the next link the user follows, the
 * browser's history, the shoulder of anyone reading the address bar. The key is
 * minted to die with the process; a url outlives it, somewhere the process can
 * never reach to take it back.
 *
 * Serving no url with the key in it is only half of that, and the half already
 * guarded. This is the other half: refusing to *accept* one. Leave the door
 * open and the day someone finds `?key=` easier the page starts using it, and
 * the key starts getting written down everywhere — with every existing test
 * still passing. So the key is handed over here in full, correct and current,
 * in the wrong place, and that alone has to be disqualifying.
 */
describe('a caller that puts this run’s key in the url instead', () => {
  it('cannot attach to the agent with it', async () => {
    // Origin is our own, so the carrier is the only thing being judged.
    const attacker = attach('trunk', { origin: url, keyInUrl: await keyFromPage() })

    await expect(attacker.handshake).resolves.toBe('refused')
    expect(attacker.screen()).not.toContain('CWD[')
  })

  it('cannot fork a Node with it', async () => {
    const before = await nodeIds()

    const response = await fetch(`${url}/api/fork?key=${await keyFromPage()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(response.status).toBe(403)
    await expect(nodeIds()).resolves.toEqual(before)
    expect(git(repo, 'worktree', 'list')).not.toContain('.nodegraph')
  })
})

/**
 * A browser cannot put a header on a handshake, so the key goes up as one of
 * the subprotocols the page says it speaks — and a handshake replies by naming
 * the one it picked. Name the key-bearing one and the key comes straight back
 * down in a plaintext response header, on a request that predates any
 * encryption of the frames: into proxy logs, devtools exports, har files,
 * every hop between here and the page. So the reply is always the plain one.
 */
describe('the handshake that puts a viewer in front of an agent', () => {
  /**
   * The token the key rides in is the key's own, and the key is the whole of
   * what follows the prefix — not whatever follows the prefix wherever it
   * happens to appear. Hunt for it anywhere in the token and every string with
   * `nodegraph.key.` buried in it becomes a way to spell the key, which is a
   * set of accepted handshakes far larger than the one the page ever sends.
   */
  it('does not take the key out of a subprotocol that merely has the prefix in it', async () => {
    const key = await keyFromPage()

    // The plain subprotocol, and a token the page would never offer: the
    // key-bearing one with something in front of it.
    const head = await rawHandshake('trunk', [SESSION_PROTOCOL, `x${keyProtocol(key)}`])

    // Only the status line, which cannot hold the key — the body of the head
    // is not printed.
    expect(head.split('\r\n')[0]).toContain('403')
  })

  it('never repeats this run’s key back in the 101 it answers with', async () => {
    const key = await keyFromPage()

    // Offered exactly the way the page offers it: the plain one, and the key.
    const head = await rawHandshake('trunk', [SESSION_PROTOCOL, keyProtocol(key)])

    // It really did upgrade, so this is a 101 and not a refusal in disguise.
    expect(head.split('\r\n')[0]).toContain('101')

    expect(carries(head, key)).toBe(false)
  })
})

/**
 * The key is minted per run and never written down, so the page carrying it is
 * good for exactly one run. Let a browser or a proxy keep a copy and the key
 * lands in a cache directory on disk, where it outlives the process that made
 * it and where that process can never reach it to take it back. The user's own
 * half of the bargain is the same header: a cached page comes back holding
 * last run's key, which does not work, which reads as nodegraph being broken.
 */
describe('the page this run’s key is handed out in', () => {
  it('is served so that nothing along the way may keep a copy of it', async () => {
    const key = await keyFromPage()

    // Both the root and a client-side route, because both are that same page
    // with that same key in them.
    for (const path of ['/', '/node/trunk']) {
      const response = await fetch(`${url}${path}`)

      // Only worth asserting on because this really is the page with the key.
      expect(carries(await response.text(), key)).toBe(true)
      // A missing header is the same failure as a permissive one, so read it
      // as the empty string rather than letting `null` blow up the assertion.
      expect(response.headers.get('cache-control') ?? '').toContain('no-store')
    }
  })

  /**
   * The shell exists on disk as a file, so it can be asked for the way any
   * other file is — and the file on disk is the one thing that does not have
   * the key in it. Serve it as a file and the page comes back a shell with no
   * key, no `no-store`, and no sign that anything is wrong: it loads, it
   * renders, and every attempt it makes to attach to an agent is refused. Which
   * looks like nodegraph being broken, not like a door being left open — the
   * failure that never gets reported as a security bug.
   */
  it('is still that page, key and all, when it is asked for by its own filename', async () => {
    const key = await keyFromPage()
    const response = await fetch(`${url}/index.html`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type') ?? '').toContain('text/html')
    // Asked as a yes/no: a failing `toContain` would print the key.
    expect(carries(await response.text(), key)).toBe(true)
    expect(response.headers.get('cache-control') ?? '').toContain('no-store')
  })
})

/**
 * Not one `Access-Control-Allow-Origin`, from any endpoint, ever — ADR-0003.
 *
 * The same-origin policy is the only reason it is safe to write this run's key
 * into the page: another website may open a request to 127.0.0.1, but it cannot
 * read what comes back. A CORS header is this server volunteering to switch
 * that off. Added once for the convenience of a dev proxy it hands every site
 * the user visits the key and the api together, and every other test in here
 * would go on passing — which is why the assertion is on the absence itself,
 * across every shape of response, and not on any one exploit.
 */
describe('every response nodegraph writes', () => {
  it('never invites another website to read it', async () => {
    // One of each writer: the page the key is in, a static file, an api read,
    // an api refusal, and the upgrade refusal, which is spelled out by hand
    // and so has its own headers and its own chance to drift.
    const written = [
      await raw({ method: 'GET', path: '/' }),
      await raw({ method: 'GET', path: '/app.js' }),
      await raw({ method: 'GET', path: '/api/nodes' }),
      await raw({ method: 'POST', path: '/api/fork', headers: { origin: EVIL }, body: '{}' }),
    ]
    const upgrade = await rawHandshake('trunk', [SESSION_PROTOCOL])

    // Each really is the response it is meant to stand for, so the assertion
    // below is about a header that was missing and not a reply that never came.
    expect(written.map((response) => response.status)).toEqual([200, 200, 200, 403])
    expect(upgrade.split('\r\n')[0]).toContain('403')

    for (const names of [...written.map((response) => response.headerNames), namesIn(upgrade)]) {
      expect(names.filter((name) => name.startsWith('access-control'))).toEqual([])
    }
  })
})
