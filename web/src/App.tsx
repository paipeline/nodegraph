import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect } from 'react'
import { mergeGraph } from '../../src/core/merge.js'
import { Session } from './Session.js'

export type NodeData = {
  label: string
  kind: 'trunk'
  branch: string | null
  workspacePath: string
}

type GraphNode = Node<NodeData>

const POLL_MS = 2000

const NodeCard = ({ data }: NodeProps<GraphNode>) => (
  <div className={`card card--${data.kind}`}>
    <span className="card__kind">{data.kind}</span>
    <span className="card__label">{data.label}</span>
    <span className="card__path" title={data.workspacePath}>
      {data.workspacePath}
    </span>
  </div>
)

const nodeTypes = { nodegraph: NodeCard }

export const App = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const response = await fetch('/api/graph')
      if (!response.ok) throw new Error(`Server answered ${response.status}`)
      const incoming = (await response.json()) as { nodes: GraphNode[]; edges: Edge[] }
      if (cancelled) return

      // The server says what exists; the browser keeps where it sits.
      setNodes((current) => mergeGraph(current, incoming).nodes)
      setEdges(incoming.edges)
    }

    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [setNodes, setEdges])

  // Picking a Node on the graph is the whole gesture for "talk to this agent".
  const selected = nodes.find((node) => node.selected)

  return (
    <div className="app">
      <div className="app__graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {nodes.length <= 1 && (
          <p className="banner">
            This is your <strong>Trunk</strong>. Fork from it to try something without
            touching it — and throw the fork away if it doesn&rsquo;t work out.
          </p>
        )}
      </div>

      <aside className="app__session">
        {selected === undefined ? (
          <p className="session__empty">Pick a Node to talk to its agent.</p>
        ) : (
          // Remounting per Node is deliberate: each Node gets its own terminal,
          // and the one being left behind keeps running on the server.
          <Session key={selected.id} nodeId={selected.id} label={selected.data.label} />
        )}
      </aside>
    </div>
  )
}
