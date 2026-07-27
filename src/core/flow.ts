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
  /**
   * Why a Fork from this Node must wait, or null when it may go ahead.
   *
   * Two things can say so and they are joined here, in that order: what the
   * Workspace already knows before anyone presses the button (an on-fork hook
   * that cannot be run), and what only this instant can say (the agent is
   * mid-thought — ADR-0002). Whichever refuses, the user reads one sentence.
   */
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
    environment: NodeView['environment']
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
  nodes: nodes.map((node, index) => {
    const detail = details[node.id] ?? {}

    return {
      id: node.id,
      type: 'nodegraph' as const,
      position: { x: 0, y: index * ROW_HEIGHT },
      data: {
        label: node.branch ?? '(detached)',
        kind: node.kind,
        branch: node.branch,
        workspacePath: node.workspacePath,
        environment: node.environment,
        ...detail,
        // Two things can refuse a Fork and neither may hide behind the other.
        // The Workspace's own refusal is put first because it is true whatever
        // the agent happens to be doing this second.
        forkRefusal: node.forkRefusal ?? detail.forkRefusal ?? null,
      },
    }
  }),
  edges: nodes.flatMap((node) =>
    node.parentId === null
      ? []
      : [{ id: `${node.parentId}->${node.id}`, source: node.parentId, target: node.id }],
  ),
})
