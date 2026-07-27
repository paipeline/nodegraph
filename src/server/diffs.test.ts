import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_HEADER } from '../core/guard.js'
import { TRUNK_ID } from '../core/reconcile.js'
import { startServer } from './server.js'

/**
 * What the graph is told about how far each Node has come.
 *
 * A separate file from the fork of the api it belongs to, so the two can be
 * read on their own.
 */

let repo: string
let elsewhere: string
let stop: (() => Promise<void>) | undefined
let url: string
let key: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const forkFrom = async (parentId: string): Promise<{ id: string; workspacePath: string }> => {
  const response = await fetch(`${url}/api/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
    body: JSON.stringify({ parentId }),
  })
  const { node } = (await response.json()) as { node: { id: string; workspacePath: string } }
  return node
}

/** The page's own poll: this run's key, and nothing else out of the ordinary. */
const diffs = async (headers: Record<string, string> = {}) =>
  fetch(`${url}/api/diffs`, { headers: { [KEY_HEADER]: key, ...headers } })

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-diffs-')))
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-diffs-elsewhere-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')

  const server = await startServer({ repoPath: repo, port: 0 })
  url = server.url
  key = server.key
  stop = server.close
})

afterEach(async () => {
  await stop?.()
  rmSync(repo, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

describe('what each Node has changed since it was forked', () => {
  it('reports the files and the lines for a Node, against its own fork point', async () => {
    const child = await forkFrom('trunk')
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(child.workspacePath, 'new.txt'), 'a\nb\nc\n')

    const response = await diffs()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      diffs: [{ nodeId: child.id, files: 2, insertions: 3, deletions: 1 }],
    })
  })

  it('goes on saying the same thing after the Trunk has committed more of its own work', async () => {
    const child = await forkFrom('trunk')
    writeFileSync(join(child.workspacePath, 'new.txt'), 'a\nb\nc\n')
    const before = await (await diffs()).json()

    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'the Trunk moves on')

    expect(before).toEqual({ diffs: [{ nodeId: child.id, files: 1, insertions: 3, deletions: 0 }] })
    await expect((await diffs()).json()).resolves.toEqual(before)
  })

  // ADR-0003: a read is a read, but it is still only for this nodegraph's own
  // page. What a Node has changed is a fact about the user's private work.
  it('is not readable by a page on another website', async () => {
    await forkFrom('trunk')

    const response = await diffs({ origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  /**
   * ADR-0004: reading this walks the user's working tree and reads the contents
   * of files git has never been told about, so it takes this run's key — unlike
   * `/api/nodes` and `/api/graph`, which only say what nodegraph already knows
   * about itself and stay open so the page can draw at all.
   *
   * Origin alone would not do it: a `<script src>` or an `<img src>` from any
   * page reaches this handler with no Origin header at all.
   */
  it('is not read at all without this run’s key', async () => {
    await forkFrom('trunk')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    const response = await fetch(`${url}/api/diffs`)

    expect(response.status).toBe(403)
    expect(JSON.stringify(await response.json())).not.toContain(key)
  })

  it('still lets the page draw the graph without one, which is what a read is for', async () => {
    await forkFrom('trunk')

    for (const path of ['/api/nodes', '/api/graph']) {
      expect((await fetch(`${url}${path}`)).status).toBe(200)
    }
  })

  // ADR-0003 leaves reads unlocked on purpose, which is only safe while a read
  // really is one. The page polls this route every two seconds, so nothing it
  // finds in the store may become an instruction to git.
  it('changes nothing on disk, whatever the store on disk claims a fork point is', async () => {
    await forkFrom('trunk')
    const precious = join(repo, 'precious.txt')
    writeFileSync(precious, 'IRREPLACEABLE\n')

    const store = join(repo, '.nodegraph', 'graph.json')
    const { forks } = JSON.parse(readFileSync(store, 'utf8')) as {
      forks: Record<string, unknown>[]
    }
    writeFileSync(
      store,
      JSON.stringify({
        forks: forks.map((each) => ({ ...each, forkPointSha: `--output=${precious}` })),
      }),
    )

    const response = await diffs()
    const body = await response.json()

    expect(readFileSync(precious, 'utf8')).toBe('IRREPLACEABLE\n')
    expect(response.status).toBe(200)
    expect(body).toEqual({ diffs: [] })
  })

  /**
   * The other half of the same rule, and the worse half: a record's Workspace
   * is where git is *run*, and git obeys the config of whatever repository it
   * finds there. `core.fsmonitor` names a command. One request must not be able
   * to pick the directory, and so the command, git starts in.
   *
   * The request here carries the key, so this is not the lock doing the work —
   * it is the store no longer being able to say where git goes.
   */
  it('runs git nowhere but in a Workspace of this repository, whatever the store says', async () => {
    const child = await forkFrom('trunk')
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    const vendored = join(elsewhere, 'vendor', 'somedep')
    mkdirSync(vendored, { recursive: true })
    git(vendored, 'init', '-b', 'main', '-q')
    git(vendored, 'config', 'user.email', 'test@example.com')
    git(vendored, 'config', 'user.name', 'Test')
    writeFileSync(join(vendored, 'vendored.txt'), 'x\n')
    git(vendored, 'add', '.')
    git(vendored, 'commit', '-qm', 'vendored')
    writeFileSync(join(vendored, 'notes.txt'), 'a\nb\nc\nd\ne\n')

    const ran = join(elsewhere, 'it-ran')
    const payload = join(elsewhere, 'payload.sh')
    writeFileSync(payload, `#!/bin/sh\nprintf 'ran\\n' >> "${ran}"\n`)
    chmodSync(payload, 0o755)
    git(vendored, 'config', 'core.fsmonitor', payload)

    const store = join(repo, '.nodegraph', 'graph.json')
    const { forks } = JSON.parse(readFileSync(store, 'utf8')) as {
      forks: Record<string, unknown>[]
    }
    const borrowed = {
      parentId: TRUNK_ID,
      workspacePath: vendored,
      forkPointSha: git(vendored, 'rev-parse', 'HEAD'),
      createdAt: '2026-07-27T09:00:00.000Z',
    }
    writeFileSync(
      store,
      JSON.stringify({
        forks: [
          ...forks,
          { ...borrowed, id: TRUNK_ID, branch: `nodegraph/${TRUNK_ID}` },
          { ...borrowed, id: child.id, branch: `nodegraph/${child.id}` },
        ],
      }),
    )

    const response = await diffs()

    await expect(response.json()).resolves.toEqual({
      diffs: [{ nodeId: child.id, files: 1, insertions: 1, deletions: 0 }],
    })
    expect(existsSync(ran)).toBe(false)
  })
})
