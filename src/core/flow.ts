import type { NodeView } from './reconcile.js'

/**
 * Turns NodeViews into the shape ReactFlow renders. Pure, so the layout rules
 * stay testable without a browser — the React side is only a shell.
 */

/**
 * What a Node is, beyond what the world can say about it: the line it was
 * Forked to try, and whether it may be Forked from at this moment. Both come
 * from nodegraph rather than from git, and both are decided before the browser
 * ever sees them — the page draws, it does not judge.
 */
export type NodeDetail = {
  /** The one line written at Fork time, or null for a Node that was given none. */
  title?: string | null
  /** Why a Fork from this Node must wait, or null when it may go ahead. */
  forkRefusal?: string | null
}

export type FlowNode = {
  id: string
  type: 'nodegraph'
  position: { x: number; y: number }
  data: {
    label: string
    kind: NodeView['kind']
    branch: string | null
    workspacePath: string
  } & NodeDetail
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

export const toFlowGraph = (
  nodes: NodeView[],
  details: Record<string, NodeDetail> = {},
): FlowGraph => ({
  nodes: nodes.map((node, index) => ({
    id: node.id,
    type: 'nodegraph',
    position: { x: 0, y: index * ROW_HEIGHT },
    data: {
      label: node.branch ?? '(detached)',
      kind: node.kind,
      branch: node.branch,
      workspacePath: node.workspacePath,
      ...details[node.id],
    },
  })),
  edges: nodes.flatMap((node) =>
    node.parentId === null
      ? []
      : [{ id: `${node.parentId}->${node.id}`, source: node.parentId, target: node.id }],
  ),
})
