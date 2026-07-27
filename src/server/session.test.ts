import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_HEADER, SESSION_PROTOCOL, toKeyProtocol } from '../core/guard.js'
import { startServer } from './server.js'

/**
 * The seam the browser actually talks to. Driven by a fake `claude` on PATH,
 * so these tests never reach a model, an account or the network. It answers
 * `size` with what the tty reports, which is how we can see the terminal the
 * agent believes it is running in.
 *
 * It also keeps its Contexts where the real one does — a file per session under
 * the claude home, filed by the directory it was run in (ADR-0004) — and it
 * refuses to resume one that was never made, exactly as the real one does. That
 * is what lets a Fork's inheritance be watched through the socket the browser
 * uses, rather than only asserted underneath it.
 */
const FAKE_CLAUDE = `#!/bin/sh
argv="$*"
here=$(pwd -P)
home="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
dir="$home/projects/$(printf '%s' "$here" | tr '/._' '---')"
id=''
resume=no
prompt=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) id="$2"; shift 2 ;;
    --resume) id="$2"; resume=yes; shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done
file="$dir/$id.jsonl"
if [ "$resume" = yes ] && [ ! -f "$file" ]; then
  printf 'No conversation found with session ID: %s\\n' "$id"
  exit 1
fi
say() {
  printf '{"sessionId":"%s","cwd":"%s","said":"%s"}\\n' "$id" "$here" "$1" >> "$file"
}
printf 'ARGV[%s]\\n' "$argv"
printf 'CWD[%s]\\n' "$here"
mkdir -p "$dir"
if [ -n "$prompt" ]; then say "$prompt"; fi
if [ -f "$file" ]; then printf 'CTX[%s]\\n' "$(tr '\\n' '|' < "$file")"; else printf 'CTX[]\\n'; fi
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 7; fi
  if [ "$line" = "size" ]; then printf 'SIZE[%s]\\n' "$(stty size)"; continue; fi
  if [ "$line" = "work" ]; then
    i=0
    while [ $i -lt 30 ]; do printf '.'; sleep 0.05; i=$((i+1)); done
    printf 'DONE\\n'
    continue
  fi
  say "$line"
  printf 'HEARD[%s]\\n' "$line"
done
`

type Frame = { type: string; [key: string]: unknown }

let sandbox: string
let repo: string
let claudeHome: string
let originalPath: string | undefined
let originalClaudeHome: string | undefined
let url: string
let key: string
let stop: (() => Promise<void>) | undefined
const opened: WebSocket[] = []

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * Waits for something to become true. The ceiling is generous because every
 * file in this suite runs at once, each with real ptys and real git in it — a
 * short ceiling here does not catch bugs, it just fails under load.
 */
const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 15_000, interval: 20 })

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

/** Forking changes the world, so it takes the key — as it does from the page. */
const forkFrom = (parentId: string, intent?: string) =>
  fetch(`${url}/api/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
    body: JSON.stringify({ parentId, intent }),
  })

const graph = async (): Promise<{
  nodes: { id: string; data: { title?: string | null; forkRefusal?: string | null } }[]
}> => (await fetch(`${url}/api/graph`)).json() as never

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-ws-')))

  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  // Contexts land here rather than in the person's own claude home.
  claudeHome = join(sandbox, 'claude-home')
  mkdirSync(claudeHome)
  originalClaudeHome = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeHome

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
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome
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
})

describe('the line written when a Node is Forked', () => {
  it('becomes that Node’s title on the graph', async () => {
    const forked = await forkFrom('trunk', '  try it with a   queue instead ')
    expect(forked.status).toBe(201)
    const { node } = (await forked.json()) as { node: { id: string } }

    const drawn = await graph()

    expect(drawn.nodes.find((candidate) => candidate.id === node.id)?.data.title).toBe(
      'try it with a queue instead',
    )
    expect(drawn.nodes.find((candidate) => candidate.id === 'trunk')?.data.title).toBeNull()
  })

  it('is refused when claude would read it as a flag rather than as words', async () => {
    const refused = await forkFrom('trunk', '--dangerously-skip-permissions')

    expect(refused.status).toBe(400)
    expect((await refused.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('flag'),
    })
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })
})

describe('the understanding a Forked Node opens with', () => {
  it('is everything the parent had worked out, and none of what it said afterwards', async () => {
    const parent = view('trunk')
    await settle(() => expect(parent.screen()).toContain('CWD['))
    parent.send({ type: 'input', data: 'the-api-key-lives-in-vault\r' })
    await settle(() => expect(parent.screen()).toContain('HEARD[the-api-key-lives-in-vault]'))

    // ADR-0002: the Fork waits until the agent has stopped for the user, so
    // this is the click the user gets to make, not one we sneak in early.
    const forked = await vi.waitFor(
      async () => {
        const response = await forkFrom('trunk', 'try a queue instead')
        expect(response.status).toBe(201)
        return response
      },
      { timeout: 20_000, interval: 100 },
    )
    const { node } = (await forked.json()) as { node: { id: string } }

    // The parent goes on thinking. None of this is the child's.
    parent.send({ type: 'input', data: 'SAID-AFTER-THE-FORK\r' })
    await settle(() => expect(parent.screen()).toContain('HEARD[SAID-AFTER-THE-FORK]'))

    const child = view(node.id)
    await settle(() => expect(child.screen()).toContain('CTX['))

    expect(child.screen()).toContain('the-api-key-lives-in-vault')
    expect(child.screen()).not.toContain('SAID-AFTER-THE-FORK')
    expect(child.screen()).toContain('try a queue instead')

    // And what the child works out never travels back up.
    child.send({ type: 'input', data: 'THE-CHILD-WORKED-THIS-OUT\r' })
    await settle(() => expect(child.screen()).toContain('HEARD[THE-CHILD-WORKED-THIS-OUT]'))
    expect(parent.screen()).not.toContain('THE-CHILD-WORKED-THIS-OUT')
  })
})

describe('Forking a Node whose agent is at work', () => {
  it('holds the Fork back with a reason, and lets it through once the agent stops', async () => {
    const viewer = view('trunk')
    await settle(() => expect(viewer.screen()).toContain('CWD['))

    viewer.send({ type: 'input', data: 'work\r' })
    // The fake claude paints while it works, the way the real one does.
    await settle(() => expect(viewer.screen()).toContain('....'))

    const refused = await forkFrom('trunk')
    expect(refused.status).toBe(409)
    expect((await refused.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('still working'),
    })

    // Refused means nothing happened at all — no half-built Workspace.
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)

    // The page is told the same thing, so the entry can be disabled with the
    // reason on it rather than failing under the user's hand.
    const busy = await graph()
    expect(busy.nodes[0]?.data.forkRefusal).toContain('still working')

    // And once the agent stops for the user, the very same Fork goes through.
    const allowed = await vi.waitFor(
      async () => {
        const response = await forkFrom('trunk')
        expect(response.status).toBe(201)
        return response
      },
      { timeout: 20_000, interval: 100 },
    )
    expect(allowed.status).toBe(201)
  })
})
