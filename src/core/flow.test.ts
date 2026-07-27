import { describe, expect, it } from 'vitest'
import { toFlowGraph } from './flow.js'
import type { NodeView } from './reconcile.js'

const trunk: NodeView = {
  id: 'trunk',
  kind: 'trunk',
  workspacePath: '/repo',
  branch: 'main',
  parentId: null,
}

describe('toFlowGraph', () => {
  it('renders a Trunk as a single positioned node with no edges', () => {
    const graph = toFlowGraph([trunk])

    expect(graph.edges).toEqual([])
    expect(graph.nodes).toEqual([
      {
        id: 'trunk',
        type: 'nodegraph',
        position: { x: 0, y: 0 },
        data: {
          label: 'main',
          kind: 'trunk',
          branch: 'main',
          workspacePath: '/repo',
        },
      },
    ])
  })

  it('labels a detached Trunk without pretending it has a branch', () => {
    const graph = toFlowGraph([{ ...trunk, branch: null }])

    expect(graph.nodes[0]?.data.label).toBe('(detached)')
    expect(graph.nodes[0]?.data.branch).toBeNull()
  })

  it('produces an empty graph when there is nothing to show', () => {
    expect(toFlowGraph([])).toEqual({ nodes: [], edges: [] })
  })
})
