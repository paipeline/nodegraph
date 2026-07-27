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
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { KEY_HEADER } from '../../src/core/guard.js'
import { mergeGraph } from '../../src/core/merge.js'
import { runKey } from './key.js'
import { Session } from './Session.js'

export type NodeData = {
  label: string
  kind: 'trunk' | 'fork'
  branch: string | null
  workspacePath: string
  /** The line this Node was Forked to try. */
  title?: string | null
  /** Why this Node cannot be Forked right now, decided by the server. */
  forkRefusal?: string | null
}

type GraphNode = Node<NodeData>

const POLL_MS = 2000

/** Node cards are rendered by ReactFlow, so the Fork action reaches them here. */
const ForkContext = createContext<(parentId: string, intent: string) => Promise<string | null>>(
  async () => null,
)

const NodeCard = ({ id, data }: NodeProps<GraphNode>) => {
  const onFork = useContext(ForkContext)
  const [intent, setIntent] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  const refusal = data.forkRefusal ?? null

  const submit = () => {
    void (async () => {
      const problem = await onFork(id, intent ?? '')
      setRefused(problem)
      if (problem === null) setIntent(null)
    })()
  }

  return (
    <div className={`card card--${data.kind}`}>
      <span className="card__kind">{data.kind}</span>
      <span className="card__label">{data.label}</span>
      {data.title != null && <span className="card__title">{data.title}</span>}
      <span className="card__path" title={data.workspacePath}>
        {data.workspacePath}
      </span>

      {intent === null ? (
        <button
          className="card__fork nodrag"
          type="button"
          // ADR-0002: a Fork copies this instant, so it is offered only when
          // the agent has stopped — and the reason is on the button itself,
          // because a control that is dead for no stated reason reads as broken.
          disabled={refusal !== null}
          title={refusal ?? 'Fork this Node'}
          onClick={() => {
            setRefused(null)
            setIntent('')
          }}
        >
          {refusal === null ? 'Fork' : 'Fork — agent is working'}
        </button>
      ) : (
        <div className="card__compose nodrag">
          <input
            className="card__intent"
            autoFocus
            value={intent}
            placeholder="What does this one go off to try?"
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') setIntent(null)
            }}
          />
          <button className="card__fork nodrag" type="button" onClick={submit}>
            Fork
          </button>
        </div>
      )}

      {refused !== null && <span className="card__refused">{refused}</span>}
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

  /** Returns the reason the Fork did not happen, or null when it did. */
  const onFork = useCallback(
    async (parentId: string, intent: string): Promise<string | null> => {
      const response = await fetch('/api/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [KEY_HEADER]: runKey() },
        body: JSON.stringify({ parentId, intent }),
      })

      if (!response.ok) {
        const { error } = (await response.json()) as { error?: string }
        return error ?? `Server answered ${response.status}`
      }

      // Don't make the user wait out a poll to see what they just did.
      await load()
      return null
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
