import { describe, expect, it } from 'vitest'
import { reconcile, type WorldSnapshot } from './reconcile.js'

const snapshot = (worktrees: WorldSnapshot['worktrees']): WorldSnapshot => ({
  repoPath: '/repo',
  worktrees,
})

describe('reconcile', () => {
  it('projects the primary worktree as a single Trunk', () => {
    const nodes = reconcile(
      snapshot([{ path: '/repo', branch: 'main', isPrimary: true }]),
      [],
    )

    expect(nodes).toEqual([
      {
        id: 'trunk',
        kind: 'trunk',
        workspacePath: '/repo',
        branch: 'main',
        parentId: null,
        environment: 'ready',
      },
    ])
  })

  it('carries the real branch name rather than assuming main', () => {
    const nodes = reconcile(
      snapshot([{ path: '/repo', branch: 'develop', isPrimary: true }]),
      [],
    )

    expect(nodes[0]?.branch).toBe('develop')
  })

  it('still yields a Trunk when HEAD is detached', () => {
    const nodes = reconcile(
      snapshot([{ path: '/repo', branch: null, isPrimary: true }]),
      [],
    )

    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.branch).toBeNull()
  })

  it('ignores a worktree nobody recorded a Fork for — a guess is not a Node', () => {
    const nodes = reconcile(
      snapshot([
        { path: '/repo', branch: 'main', isPrimary: true },
        { path: '/repo/.claude/worktrees/other', branch: 'other', isPrimary: false },
      ]),
      [],
    )

    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.workspacePath).toBe('/repo')
  })

  it('yields nothing when the world contains no worktrees at all', () => {
    expect(reconcile(snapshot([]), [])).toEqual([])
  })

  it('projects a recorded Fork as a child of the Node it was forked from', () => {
    const nodes = reconcile(
      snapshot([
        { path: '/repo', branch: 'main', isPrimary: true },
        { path: '/repo/.nodegraph/workspaces/abc', branch: 'nodegraph/abc', isPrimary: false },
      ]),
      [
        {
          id: 'abc',
          parentId: 'trunk',
          workspacePath: '/repo/.nodegraph/workspaces/abc',
          forkPointSha: '0123456789abcdef0123456789abcdef01234567',
        },
      ],
    )

    expect(nodes).toEqual([
      {
        id: 'trunk',
        kind: 'trunk',
        workspacePath: '/repo',
        branch: 'main',
        parentId: null,
        environment: 'ready',
      },
      {
        id: 'abc',
        kind: 'fork',
        workspacePath: '/repo/.nodegraph/workspaces/abc',
        branch: 'nodegraph/abc',
        parentId: 'trunk',
        environment: 'ready',
      },
    ])
  })

  it('says so on the Node whose environment is still landing', () => {
    const nodes = reconcile(
      snapshot([
        { path: '/repo', branch: 'main', isPrimary: true },
        { path: '/repo/.nodegraph/workspaces/abc', branch: 'nodegraph/abc', isPrimary: false },
      ]),
      [
        {
          id: 'abc',
          parentId: 'trunk',
          workspacePath: '/repo/.nodegraph/workspaces/abc',
          forkPointSha: '0123456789abcdef0123456789abcdef01234567',
        },
      ],
      { '/repo/.nodegraph/workspaces/abc': 'preparing' },
    )

    expect(nodes.map((node) => [node.id, node.environment])).toEqual([
      ['trunk', 'ready'],
      ['abc', 'preparing'],
    ])
  })

  it('admits an environment that went wrong rather than showing the Node as whole', () => {
    const nodes = reconcile(
      snapshot([
        { path: '/repo', branch: 'main', isPrimary: true },
        { path: '/repo/.nodegraph/workspaces/abc', branch: 'nodegraph/abc', isPrimary: false },
      ]),
      [
        {
          id: 'abc',
          parentId: 'trunk',
          workspacePath: '/repo/.nodegraph/workspaces/abc',
          forkPointSha: '0123456789abcdef0123456789abcdef01234567',
        },
      ],
      { '/repo/.nodegraph/workspaces/abc': 'failed' },
    )

    expect(nodes[1]?.environment).toBe('failed')
  })

  it('never says the Trunk is preparing — nodegraph never built it', () => {
    const nodes = reconcile(snapshot([{ path: '/repo', branch: 'main', isPrimary: true }]), [], {
      '/repo': 'preparing',
    })

    expect(nodes[0]?.environment).toBe('ready')
  })

  it('drops a recorded Fork whose Workspace is no longer in the world', () => {
    const nodes = reconcile(snapshot([{ path: '/repo', branch: 'main', isPrimary: true }]), [
      {
        id: 'abc',
        parentId: 'trunk',
        workspacePath: '/repo/.nodegraph/workspaces/abc',
        forkPointSha: '0123456789abcdef0123456789abcdef01234567',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual(['trunk'])
  })
})
