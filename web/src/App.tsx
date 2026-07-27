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
import { createContext, useCallback, useContext, useEffect } from 'react'
import { KEY_HEADER } from '../../src/core/guard.js'
import { mergeGraph } from '../../src/core/merge.js'
import { runKey } from './key.js'
import { Session } from './Session.js'

export type NodeData = {
  label: string
  kind: 'trunk' | 'fork'
  branch: string | null
  workspacePath: string
  environment: 'preparing' | 'ready' | 'failed'
}

type GraphNode = Node<NodeData>

/**
 * A Node is handed over the moment its code is there, with the heavy part of
 * the environment still landing behind it. Saying so is the difference between
 * an agent that is about to be able to run the tests and a Workspace that is
 * quietly broken.
 */
const ENVIRONMENT: Record<NodeData['environment'], string | null> = {
  ready: null,
  preparing: 'environment landing…',
  failed: 'environment failed',
}

const POLL_MS = 2000

/** Node cards are rendered by ReactFlow, so the Fork action reaches them here. */
const ForkContext = createContext<(parentId: string) => void>(() => {})

const NodeCard = ({ id, data }: NodeProps<GraphNode>) => {
  const onFork = useContext(ForkContext)

  return (
    <div className={`card card--${data.kind}`}>
      <span className="card__kind">{data.kind}</span>
      <span className="card__label">{data.label}</span>
      <span className="card__path" title={data.workspacePath}>
        {data.workspacePath}
      </span>
      {ENVIRONMENT[data.environment] !== null && (
        <span className={`card__environment card__environment--${data.environment}`}>
          {ENVIRONMENT[data.environment]}
        </span>
      )}
      <button className="card__fork nodrag" type="button" onClick={() => onFork(id)}>
        Fork
      </button>
    </div>
  )
}

const nodeTypes = { nodegraph: NodeCard }

export const App = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const load = useCallback(async () => {
    const response = await fetch('/api/graph')
    if (!response.ok) throw new Error(`Server answered ${response.status}`)
    const incoming = (await response.json()) as { nodes: GraphNode[]; edges: Edge[] }

    // The server says what exists; the browser keeps where it sits.
    setNodes((current) => mergeGraph(current, incoming).nodes)
    setEdges(incoming.edges)
  }, [setNodes, setEdges])

  const onFork = useCallback(
    (parentId: string) => {
      void (async () => {
        await fetch('/api/fork', {
          method: 'POST',
          headers: { 'content-type': 'application/json', [KEY_HEADER]: runKey() },
          body: JSON.stringify({ parentId }),
        })
        // Don't make the user wait out a poll to see what they just did.
        await load()
      })()
    },
    [load],
  )

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // Picking a Node on the graph is the whole gesture for "talk to this agent".
  const selected = nodes.find((node) => node.selected)

  return (
    <div className="app">
      <div className="app__graph">
        <ForkContext.Provider value={onFork}>
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
        </ForkContext.Provider>

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
