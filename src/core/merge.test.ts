import { describe, expect, it } from 'vitest'
import { mergeGraph } from './merge.js'
import type { FlowEdge, FlowGraph, FlowNode } from './flow.js'

const node = (id: string, over: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type: 'nodegraph',
  position: { x: 0, y: 0 },
  data: { label: id, kind: 'trunk', branch: id, workspacePath: `/repo/${id}` },
  ...over,
})

const graph = (nodes: FlowNode[]): FlowGraph => ({ nodes, edges: [] })

describe('mergeGraph', () => {
  it('keeps where the user dragged a node, ignoring the server position', () => {
    const onScreen = [node('trunk', { position: { x: 400, y: 120 } })]

    const merged = mergeGraph(onScreen, graph([node('trunk')]))

    expect(merged.nodes[0]?.position).toEqual({ x: 400, y: 120 })
  })

  it('still takes fresh data from the server for a node already on screen', () => {
    const onScreen = [node('trunk', { position: { x: 400, y: 120 } })]

    const merged = mergeGraph(
      onScreen,
      graph([node('trunk', { data: { label: 'renamed', kind: 'trunk', branch: 'renamed', workspacePath: '/repo/trunk' } })]),
    )

    expect(merged.nodes[0]?.data.label).toBe('renamed')
    expect(merged.nodes[0]?.position).toEqual({ x: 400, y: 120 })
  })

  it('adds nodes that appeared since the last poll, at the position the server chose', () => {
    const merged = mergeGraph([node('trunk')], graph([node('trunk'), node('child', { position: { x: 0, y: 140 } })]))

    expect(merged.nodes.map((n) => n.id)).toEqual(['trunk', 'child'])
    expect(merged.nodes[1]?.position).toEqual({ x: 0, y: 140 })
  })

  it('drops nodes the world no longer has', () => {
    const merged = mergeGraph([node('trunk'), node('gone')], graph([node('trunk')]))

    expect(merged.nodes.map((n) => n.id)).toEqual(['trunk'])
  })

  it('preserves selection so a poll cannot deselect what the user picked', () => {
    const onScreen = [{ ...node('trunk'), selected: true }]

    const merged = mergeGraph(onScreen, graph([node('trunk')]))

    expect(merged.nodes[0]?.selected).toBe(true)
  })

  it('keeps what the browser measured, so a poll cannot leave a node unclickable', () => {
    // ReactFlow hides — and stops hit-testing — any node whose dimensions it
    // does not know. Those dimensions are the browser's to own, like position
    // and selection, so a poll must not wipe them.
    type Measured = FlowNode & { measured?: { width: number; height: number } }
    const onScreen: Measured[] = [{ ...node('trunk'), measured: { width: 292, height: 88 } }]

    const merged = mergeGraph<Measured, FlowEdge>(onScreen, graph([node('trunk')]))

    expect(merged.nodes[0]?.measured).toEqual({ width: 292, height: 88 })
  })

  it('takes edges from the server as-is', () => {
    const incoming: FlowGraph = {
      nodes: [node('trunk'), node('child')],
      edges: [{ id: 'trunk->child', source: 'trunk', target: 'child' }],
    }

    expect(mergeGraph([], incoming).edges).toEqual(incoming.edges)
  })
})
