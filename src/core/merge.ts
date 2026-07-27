/**
 * Folds a freshly polled graph into what is already on screen.
 *
 * The server owns *what exists* and *what it says*; the browser owns everything
 * else it has worked out about a node — where it sits, whether it is selected,
 * and how big it measured. Without this, every poll would throw all of that
 * away two seconds after the user did it.
 *
 * Generic over the node type so the browser can hand it ReactFlow's own nodes
 * without a cast at the boundary.
 */

export type Positioned = {
  id: string
  position: { x: number; y: number }
  selected?: boolean
}

export const mergeGraph = <N extends Positioned, E>(
  onScreen: N[],
  incoming: { nodes: N[]; edges: E[] },
): { nodes: N[]; edges: E[] } => {
  const existing = new Map(onScreen.map((node) => [node.id, node]))

  return {
    nodes: incoming.nodes.map((node) => {
      const previous = existing.get(node.id)
      if (previous === undefined) return node

      // Start from what is on screen so that everything the browser has
      // attached to the node survives, then let the server's fields win.
      return {
        ...previous,
        ...node,
        position: previous.position,
        ...(previous.selected === undefined ? {} : { selected: previous.selected }),
      }
    }),
    edges: incoming.edges,
  }
}
