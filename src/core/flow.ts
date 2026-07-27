import type { NodeView } from './reconcile.js'

/**
 * Turns NodeViews into the shape ReactFlow renders. Pure, so the layout rules
 * stay testable without a browser — the React side is only a shell.
 */

export type FlowNode = {
  id: string
  type: 'nodegraph'
  position: { x: number; y: number }
  data: {
    label: string
    kind: NodeView['kind']
    branch: string | null
    workspacePath: string
  }
  /** Owned by the browser, never by the server. */
  selected?: boolean
}

export type FlowEdge = {
  id: string
  source: string
  target: string
}

export type FlowGraph = {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

const ROW_HEIGHT = 140

export const toFlowGraph = (nodes: NodeView[]): FlowGraph => ({
  nodes: nodes.map((node, index) => ({
    id: node.id,
    type: 'nodegraph',
    position: { x: 0, y: index * ROW_HEIGHT },
    data: {
      label: node.branch ?? '(detached)',
      kind: node.kind,
      branch: node.branch,
      workspacePath: node.workspacePath,
    },
  })),
  edges: nodes.flatMap((node) =>
    node.parentId === null
      ? []
      : [{ id: `${node.parentId}->${node.id}`, source: node.parentId, target: node.id }],
  ),
})
