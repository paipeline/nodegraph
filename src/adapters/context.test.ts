import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contextPath } from '../core/context.js'
import { fork } from './fork.js'
import { SessionSupervisor } from './session.js'

/**
 * A Fork carries the parent Node's understanding over, and freezes it at the
 * instant of the Fork. That is the one thing this product is for, so it is
 * tested end to end against a `claude` that keeps its Contexts on disk the way
 * the real one does — see ADR-0004.
 *
 * The fake models exactly what was measured of the real CLI: a Context is a
 * file under `$CLAUDE_CONFIG_DIR/projects/<Workspace flattened>/<id>.jsonl`;
 * resuming an id that has no such file prints "No conversation found" and exits
 * 1; and a session that is started but never spoken to leaves no file at all.
 * No model, no account, no network.
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
  printf '{"type":"user","sessionId":"%s","cwd":"%s","said":"%s"}\\n' "$id" "$here" "$1" >> "$file"
}
show() {
  if [ -f "$file" ]; then printf 'CTX[%s]\\n' "$(tr '\\n' '|' < "$file")"; else printf 'CTX[]\\n'; fi
}
printf 'ARGV[%s]\\n' "$argv"
printf 'CWD[%s]\\n' "$here"
mkdir -p "$dir"
if [ -n "$prompt" ]; then say "$prompt"; fi
show
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then exit 7; fi
  say "$line"
  printf 'HEARD[%s]\\n' "$line"
  show
done
`

let sandbox: string
let repo: string
let claudeHome: string
let originalPath: string | undefined
let originalHome: string | undefined
let supervisor: SessionSupervisor

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const settle = async (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 15_000, interval: 20 })

/** Say something to a Node's agent and wait until it has taken it in. */
const tell = async (nodeId: string, workspacePath: string, line: string): Promise<void> => {
  const session = await supervisor.open(nodeId, workspacePath)
  await settle(() => expect(session.scrollback()).toContain('CWD['))
  session.write(`${line}\r`)
  await settle(() => expect(session.scrollback()).toContain(`HEARD[${line}]`))
}

/** What a Node's agent shows of the understanding it opened with. */
const contextOf = async (nodeId: string, workspacePath: string): Promise<string> => {
  const session = await supervisor.open(nodeId, workspacePath)
  await settle(() => expect(session.scrollback()).toContain('CTX['))
  return session.scrollback()
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-context-')))

  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`

  // Contexts land here rather than in the person's own claude home. Nothing in
  // this suite may touch the real one.
  claudeHome = join(sandbox, 'claude-home')
  mkdirSync(claudeHome)
  originalHome = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeHome

  repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')

  supervisor = new SessionSupervisor(repo)
})

afterEach(() => {
  supervisor.stopAll()
  process.env.PATH = originalPath
  if (originalHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalHome
  rmSync(sandbox, { recursive: true, force: true })
})

describe('the understanding a Fork carries over', () => {
  it('is the parent’s as it stood at the instant of the Fork, and not a word it said after', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')

    const child = await fork({ repoPath: repo, parentId: 'trunk', intent: 'try a queue instead' })

    // The parent goes on thinking. None of this belongs to the child.
    await tell('trunk', repo, 'SAID-AFTER-THE-FORK')

    const inherited = await contextOf(child.id, child.workspacePath)

    expect(inherited).toContain('the-api-key-lives-in-vault')
    expect(inherited).not.toContain('SAID-AFTER-THE-FORK')
    // And the line the Fork was given is the child's first instruction.
    expect(inherited).toContain('try a queue instead')
  })

  it('is the child’s alone from then on — nothing it works out reaches the parent', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')
    const child = await fork({ repoPath: repo, parentId: 'trunk' })

    await tell(child.id, child.workspacePath, 'THE-CHILD-WORKED-THIS-OUT')

    supervisor.stopAll()
    const later = new SessionSupervisor(repo)
    const trunk = await later.open('trunk', repo)
    await settle(() => expect(trunk.scrollback()).toContain('CTX['))
    later.stopAll()

    expect(trunk.scrollback()).toContain('the-api-key-lives-in-vault')
    expect(trunk.scrollback()).not.toContain('THE-CHILD-WORKED-THIS-OUT')
  })

  it('runs in the child’s own Workspace, which is a different directory from the parent’s', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')
    const child = await fork({ repoPath: repo, parentId: 'trunk' })

    const inherited = await contextOf(child.id, child.workspacePath)

    expect(inherited).toContain(`CWD[${child.workspacePath}]`)
    expect(child.workspacePath).not.toBe(repo)
    expect(inherited).toContain('the-api-key-lives-in-vault')
  })

  it('carries the whole chain on through a Node nobody has opened', async () => {
    await tell('trunk', repo, 'THE-EXPENSIVE-UNDERSTANDING')

    const child = await fork({ repoPath: repo, parentId: 'trunk', intent: 'first idea' })
    // Nobody opens the child. Forking twice in a row is two clicks.
    const grandchild = await fork({ repoPath: repo, parentId: child.id, intent: 'second idea' })

    expect(grandchild.parentSessionId).toBe(child.sessionId)

    const inherited = await contextOf(grandchild.id, grandchild.workspacePath)

    expect(inherited).toContain('THE-EXPENSIVE-UNDERSTANDING')
    expect(inherited).toContain('second idea')

    // But not the middle Node's line. A Context is what an agent has actually
    // been through, and nobody ever opened that Node to say it — its line is
    // still waiting there for whoever does. Forking a Node that has not started
    // means branching from before it started, which is what the graph shows.
    expect(inherited).not.toContain('first idea')

    // And that line is still the middle Node's own to give.
    const waiting = await contextOf(child.id, child.workspacePath)
    expect(waiting).toContain('first idea')
    expect(waiting).toContain('THE-EXPENSIVE-UNDERSTANDING')
  })

  it('is nothing at all when the parent has never said a word, and that is not an error', async () => {
    const child = await fork({ repoPath: repo, parentId: 'trunk', intent: 'go on then' })

    expect(child.parentSessionId).toBeNull()

    const inherited = await contextOf(child.id, child.workspacePath)
    expect(inherited).toContain('CWD[')
    expect(inherited).toContain('go on then')
  })
})

describe('a Node whose agent was opened but never spoken to', () => {
  it('opens again tomorrow, rather than resuming a Context that was never made', async () => {
    const first = await supervisor.open('trunk', repo)
    await settle(() => expect(first.scrollback()).toContain('CWD['))
    // Not a word said, so claude has written nothing down.
    supervisor.stopAll()

    // A second nodegraph, or the same one tomorrow.
    const later = new SessionSupervisor(repo)
    const reopened = await later.open('trunk', repo)
    await settle(() => expect(reopened.scrollback()).toContain('CWD['))

    expect(reopened.scrollback()).not.toContain('No conversation found')
    expect(reopened.status()).toEqual({ state: 'running' })

    reopened.write('now we can talk\r')
    await settle(() => expect(reopened.scrollback()).toContain('HEARD[now we can talk]'))
    later.stopAll()
  })

  it('keeps the Context it was promised, so a Forked Node does not lose what it inherited', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')
    const child = await fork({ repoPath: repo, parentId: 'trunk', intent: 'try a queue instead' })

    const opened = await supervisor.open(child.id, child.workspacePath)
    await settle(() => expect(opened.scrollback()).toContain('CTX['))
    supervisor.stopAll()

    const later = new SessionSupervisor(repo)
    const reopened = await later.open(child.id, child.workspacePath)
    await settle(() => expect(reopened.scrollback()).toContain('CTX['))
    later.stopAll()

    // Exactly this argv, so the line the Fork was given is not said a second
    // time — it was the *first* instruction, not a standing one.
    expect(reopened.scrollback()).toContain(`ARGV[--resume ${child.sessionId ?? ''}]`)
    expect(reopened.scrollback()).toContain('the-api-key-lives-in-vault')

    const placed = contextPath(claudeHome, child.workspacePath, child.sessionId ?? '')
    const said = readFileSync(placed, 'utf8').split('try a queue instead').length - 1
    expect(said).toBe(1)
  })
})

describe('the place claude keeps a Context', () => {
  it('is where a Fork puts the child’s, so the child can open it in its own Workspace', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')

    const child = await fork({ repoPath: repo, parentId: 'trunk' })

    const expected = contextPath(claudeHome, child.workspacePath, child.sessionId ?? '')
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, 'utf8')).toContain('the-api-key-lives-in-vault')
  })

  it('is checked, not assumed — a Fork refuses and names the place it looked when the Context is not there', async () => {
    await tell('trunk', repo, 'the-api-key-lives-in-vault')
    const child = await fork({ repoPath: repo, parentId: 'trunk' })
    supervisor.stopAll()

    const placed = contextPath(claudeHome, child.workspacePath, child.sessionId ?? '')
    rmSync(placed)

    await expect(fork({ repoPath: repo, parentId: child.id })).rejects.toThrow(placed)

    // Refused means nothing happened: no half-built Workspace left behind.
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
    expect(readdirSync(join(repo, '.nodegraph', 'workspaces'))).toEqual([child.id])
  })
})
