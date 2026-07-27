import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useState } from 'react'

export type NodeData = {
  label: string
  kind: 'trunk'
  branch: string | null
  workspacePath: string
}

type Graph = {
  nodes: Node<NodeData>[]
  edges: Edge[]
}

const POLL_MS = 2000

const NodeCard = ({ data }: NodeProps<Node<NodeData>>) => (
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
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const response = await fetch('/api/graph')
        if (!response.ok) throw new Error(`Server answered ${response.status}`)
        const next = (await response.json()) as Graph
        if (!cancelled) {
          setGraph(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="app">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {error !== null && <p className="banner banner--error">{error}</p>}

      {error === null && graph.nodes.length <= 1 && (
        <p className="banner">
          This is your <strong>Trunk</strong>. Fork from it to try something without
          touching it — and throw the fork away if it doesn&rsquo;t work out.
        </p>
      )}
    </div>
  )
}
