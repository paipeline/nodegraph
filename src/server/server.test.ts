import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_HEADER } from '../core/guard.js'
import { startServer } from './server.js'

let repo: string
let stop: (() => Promise<void>) | undefined
let url: string
let key: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Forking changes the world, so it takes the key — as it does from the page. */
const forkFrom = (parentId: string) =>
  fetch(`${url}/api/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
    body: JSON.stringify({ parentId }),
  })

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
  key = server.key
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
          environment: 'ready',
          forkRefusal: null,
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
            environment: 'ready',
            forkRefusal: null,
          },
        },
      ],
      edges: [],
    })
  })

  it('tells the page why a Fork cannot start, before anyone presses the button', async () => {
    // The `chmod +x` everybody forgets the first time. A Fork attempted now is
    // refused, and a refusal the user cannot read is a broken button.
    writeFileSync(join(repo, '.nodegraph.on-fork'), '#!/bin/sh\necho built > built-by-hook\n')
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o644)

    const graph = (await (await fetch(`${url}/api/graph`)).json()) as {
      nodes: { id: string; data: { forkRefusal: string | null } }[]
    }

    const refusal = graph.nodes.find((each) => each.id === 'trunk')?.data.forkRefusal
    expect(refusal).toContain('.nodegraph.on-fork')
    expect(refusal).toContain(`chmod +x ${join(repo, '.nodegraph.on-fork')}`)

    // And it goes away by doing what it says, without restarting anything.
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)
    const fixed = (await (await fetch(`${url}/api/graph`)).json()) as {
      nodes: { id: string; data: { forkRefusal: string | null } }[]
    }
    expect(fixed.nodes.find((each) => each.id === 'trunk')?.data.forkRefusal).toBeNull()
  })

  it('forks a Node, and the graph shows the child and the edge to it straight away', async () => {
    const forked = await forkFrom('trunk')

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

  it('shows a Node whose environment is still landing, and shows it ready once it has', async () => {
    // A project whose environment takes as long to build as this test says.
    const release = join(repo, 'go-ahead')
    writeFileSync(
      join(repo, '.nodegraph.on-fork'),
      `#!/bin/sh\nn=0\nwhile [ ! -f "${release}" ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done\n`,
    )
    chmodSync(join(repo, '.nodegraph.on-fork'), 0o755)

    const { node } = (await (await forkFrom('trunk')).json()) as { node: { id: string } }

    // Fork came back at once, so the Node is on the graph before its
    // environment is — and it has to say so, or the user is looking at a
    // Workspace that is quietly half-built.
    const environmentOf = async (id: string) => {
      const graph = (await (await fetch(`${url}/api/graph`)).json()) as {
        nodes: { id: string; data: { environment: string } }[]
      }
      return graph.nodes.find((each) => each.id === id)?.data.environment
    }

    await expect(environmentOf(node.id)).resolves.toBe('preparing')

    writeFileSync(release, '')
    while ((await environmentOf(node.id)) === 'preparing') {
      await new Promise((wake) => setTimeout(wake, 20))
    }

    await expect(environmentOf(node.id)).resolves.toBe('ready')
    const nodes = (await (await fetch(`${url}/api/nodes`)).json()) as {
      nodes: { id: string; environment: string }[]
    }
    expect(nodes.nodes.find((each) => each.id === node.id)?.environment).toBe('ready')
  })

  it('still draws the graph when a recorded Workspace has been taken away behind its back', async () => {
    const { node } = (await (await forkFrom('trunk')).json()) as {
      node: { id: string; workspacePath: string }
    }
    // Asking each Workspace what its environment is doing must not turn a Node
    // that is merely gone into a graph nobody can load.
    rmSync(node.workspacePath, { recursive: true, force: true })

    const response = await fetch(`${url}/api/nodes`)
    const body = (await response.json()) as { nodes: { id: string; environment: string }[] }

    expect(response.status).toBe(200)
    expect(body.nodes.map((each) => each.id)).toContain('trunk')
    // Nothing is landing in a Workspace that is not there.
    expect(body.nodes.find((each) => each.id === node.id)?.environment).not.toBe('preparing')
  })

  it('still knows where a Fork came from after nodegraph is shut down and started again', async () => {
    const forked = await forkFrom('trunk')
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
