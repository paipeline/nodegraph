import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from './server.js'

let repo: string
let stop: (() => Promise<void>) | undefined
let url: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-server-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')

  const server = await startServer({ repoPath: repo, port: 0 })
  url = server.url
  stop = server.close
})

afterEach(async () => {
  await stop?.()
  rmSync(repo, { recursive: true, force: true })
})

describe('the local server', () => {
  it('listens on a real port and reports its own url', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('serves the Trunk of the repository it was started in', async () => {
    const response = await fetch(`${url}/api/nodes`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      nodes: [
        {
          id: 'trunk',
          kind: 'trunk',
          workspacePath: repo,
          branch: 'main',
          parentId: null,
        },
      ],
    })
  })

  it('reflects the branch that is actually checked out', async () => {
    git(repo, 'checkout', '-qb', 'develop')

    const response = await fetch(`${url}/api/nodes`)
    const body = (await response.json()) as { nodes: { branch: string }[] }

    expect(body.nodes[0]?.branch).toBe('develop')
  })

  it('answers 404 for an unknown api route', async () => {
    const response = await fetch(`${url}/api/nonsense`)

    expect(response.status).toBe(404)
  })

  it('serves a graph the browser can render without doing any layout itself', async () => {
    const response = await fetch(`${url}/api/graph`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      nodes: [
        {
          id: 'trunk',
          type: 'nodegraph',
          position: { x: 0, y: 0 },
          data: {
            label: 'main',
            kind: 'trunk',
            branch: 'main',
            workspacePath: repo,
          },
        },
      ],
      edges: [],
    })
  })

  it('forks a Node, and the graph shows the child and the edge to it straight away', async () => {
    const forked = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'trunk' }),
    })

    expect(forked.status).toBe(201)
    const { node } = (await forked.json()) as { node: { id: string; forkPointSha: string } }
    expect(node.forkPointSha).toBe(git(repo, 'rev-parse', 'HEAD'))

    const graph = (await (await fetch(`${url}/api/graph`)).json()) as {
      nodes: { id: string; data: { kind: string } }[]
      edges: unknown[]
    }

    expect(graph.nodes.map((each) => each.id)).toEqual(['trunk', node.id])
    expect(graph.nodes[1]?.data.kind).toBe('fork')
    expect(graph.edges).toEqual([{ id: `trunk->${node.id}`, source: 'trunk', target: node.id }])
  })

  it('still knows where a Fork came from after nodegraph is shut down and started again', async () => {
    const forked = await fetch(`${url}/api/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'trunk' }),
    })
    const { node } = (await forked.json()) as { node: { id: string; forkPointSha: string } }

    await stop?.()
    const restarted = await startServer({ repoPath: repo, port: 0 })
    stop = restarted.close

    const body = (await (await fetch(`${restarted.url}/api/nodes`)).json()) as {
      nodes: { id: string; parentId: string | null }[]
    }

    expect(body.nodes).toContainEqual(expect.objectContaining({ id: node.id, parentId: 'trunk' }))
    expect(git(repo, 'log', '-1', '--format=%H')).toBe(node.forkPointSha)
  })
})
