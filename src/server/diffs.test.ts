import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_HEADER } from '../core/guard.js'
import { startServer } from './server.js'

/**
 * What the graph is told about how far each Node has come.
 *
 * A separate file from the fork of the api it belongs to, so the two can be
 * read on their own.
 */

let repo: string
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

const diffs = async (headers: Record<string, string> = {}) =>
  fetch(`${url}/api/diffs`, { headers })

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-diffs-')))
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
})
