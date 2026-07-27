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
import type { DiffSummary } from '../../src/core/diff.js'
import { KEY_HEADER } from '../../src/core/guard.js'
import { mergeGraph } from '../../src/core/merge.js'
import { describeProblem, describeUnreachable } from '../../src/core/problem.js'
import { Card, type NodeData } from './Card.js'
import { runKey } from './key.js'
import { Session } from './Session.js'

export type { NodeData }

type GraphNode = Node<NodeData>

/** Whatever the server refused, in its own words. */
const refusalIn = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown }
  return describeProblem(response.status, body.error)
}

const POLL_MS = 2000

/** Node cards are rendered by ReactFlow, so the Fork action reaches them here. */
const ForkContext = createContext<(parentId: string) => void>(() => {})

const NodeCard = ({ id, data }: NodeProps<GraphNode>) => {
  const onFork = useContext(ForkContext)

  return <Card data={data} onFork={() => onFork(id)} />
}

const nodeTypes = { nodegraph: NodeCard }

export const App = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  /**
   * The last thing that went wrong, kept on screen until the user tries again.
   * Not cleared by a poll going well: a Fork that was refused two seconds ago
   * is still the thing the user needs to read.
   */
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // The graph itself is nodegraph's own bookkeeping and goes unlocked so the
      // page can draw at all; the diffs are read out of the user's own files, so
      // that poll carries this run's key. ADR-0004.
      const [response, measured] = await Promise.all([
        fetch('/api/graph'),
        fetch('/api/diffs', { headers: { [KEY_HEADER]: runKey() } }),
      ])
      if (!response.ok) {
        setProblem(await refusalIn(response))
        return
      }
      const incoming = (await response.json()) as { nodes: GraphNode[]; edges: Edge[] }

      // A refused diff poll costs the numbers, not the graph — so say so, and
      // still draw. Swallowing it would leave every card silently unmeasured.
      if (!measured.ok) setProblem(await refusalIn(measured))
      const { diffs } = measured.ok
        ? ((await measured.json()) as { diffs: (DiffSummary & { nodeId: string })[] })
        : { diffs: [] }
      const byNode = new Map(diffs.map(({ nodeId, ...summary }) => [nodeId, summary]))

      // The server says what exists; the browser keeps where it sits.
      setNodes((current) =>
        mergeGraph(current, incoming).nodes.map((node) => ({
          ...node,
          data: { ...node.data, diff: byNode.get(node.id) },
        })),
      )
      setEdges(incoming.edges)
    } catch (cause) {
      setProblem(describeUnreachable(cause))
    }
  }, [setNodes, setEdges])

  const onFork = useCallback(
    (parentId: string) => {
      void (async () => {
        setProblem(null)
        try {
          const response = await fetch('/api/fork', {
            method: 'POST',
            headers: { 'content-type': 'application/json', [KEY_HEADER]: runKey() },
            body: JSON.stringify({ parentId }),
          })
          // A Fork that did not happen has to say so where the user is looking.
          // Silence here is the whole difference between "nodegraph refused,
          // and here is the command that fixes it" and "the button is broken".
          if (!response.ok) setProblem(await refusalIn(response))
        } catch (cause) {
          setProblem(describeUnreachable(cause))
        }
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

        {problem !== null ? (
          <p className="banner banner--error" role="alert">
            {problem}
          </p>
        ) : (
          nodes.length <= 1 && (
            <p className="banner">
              This is your <strong>Trunk</strong>. Fork from it to try something without
              touching it — and throw the fork away if it doesn&rsquo;t work out.
            </p>
          )
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
