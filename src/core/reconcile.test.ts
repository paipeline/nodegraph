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
    )

    expect(nodes).toEqual([
      {
        id: 'trunk',
        kind: 'trunk',
        workspacePath: '/repo',
        branch: 'main',
        parentId: null,
      },
    ])
  })

  it('carries the real branch name rather than assuming main', () => {
    const nodes = reconcile(
      snapshot([{ path: '/repo', branch: 'develop', isPrimary: true }]),
    )

    expect(nodes[0]?.branch).toBe('develop')
  })

  it('still yields a Trunk when HEAD is detached', () => {
    const nodes = reconcile(
      snapshot([{ path: '/repo', branch: null, isPrimary: true }]),
    )

    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.branch).toBeNull()
  })

  it('ignores non-primary worktrees for now — they arrive with the Fork slice', () => {
    const nodes = reconcile(
      snapshot([
        { path: '/repo', branch: 'main', isPrimary: true },
        { path: '/repo/.claude/worktrees/other', branch: 'other', isPrimary: false },
      ]),
    )

    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.workspacePath).toBe('/repo')
  })

  it('yields nothing when the world contains no worktrees at all', () => {
    expect(reconcile(snapshot([]))).toEqual([])
  })
})
