import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './run.js'

let repo: string
let stop: (() => Promise<void>) | undefined

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-cli-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(repo, { recursive: true, force: true })
})

describe('running nodegraph in a directory', () => {
  it('starts a server that answers for that repository', async () => {
    const server = await run({ cwd: repo, port: 0, open: () => {}, log: () => {} })
    stop = server.close

    const response = await fetch(`${server.url}/api/nodes`)
    const body = (await response.json()) as { nodes: { workspacePath: string }[] }

    expect(body.nodes[0]?.workspacePath).toBe(repo)
  })

  it('opens the browser at the url it is listening on', async () => {
    const opened: string[] = []
    const server = await run({ cwd: repo, port: 0, open: (url) => opened.push(url), log: () => {} })
    stop = server.close

    expect(opened).toEqual([server.url])
  })

  it('tells the user where it is listening', async () => {
    const lines: string[] = []
    const server = await run({ cwd: repo, port: 0, open: () => {}, log: (line) => lines.push(line) })
    stop = server.close

    expect(lines.join('\n')).toContain(server.url)
  })

  it('refuses to start outside a git repository, and starts nothing', async () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-cli-bare-')))
    const opened: string[] = []

    try {
      await expect(
        run({ cwd: notARepo, port: 0, open: (url) => opened.push(url), log: () => {} }),
      ).rejects.toThrow(/not a git repository/i)
      expect(opened).toEqual([])
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})
