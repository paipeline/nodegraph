import { useState } from 'react'
import { describeDiff, type DiffSummary } from '../../src/core/diff.js'

/**
 * One Node, as the user sees it.
 *
 * Kept apart from the graph it is drawn on: everything a card says is decided
 * on the server and arrives as plain data, so this is the whole of what the
 * browser does with it, and it can be rendered — and read back — without a
 * canvas, a layout engine or a running nodegraph.
 */

export type NodeData = {
  label: string
  kind: 'trunk' | 'fork'
  branch: string | null
  workspacePath: string
  environment: 'preparing' | 'ready' | 'failed'
  /** Why a Fork from this Node would be refused, or null when it would not. */
  forkRefusal: string | null
  /** The line this Node was Forked to try, or null for a Node given none. */
  title?: string | null
  /** What this Node changed since its fork point. The Trunk has no fork point. */
  diff?: DiffSummary
}

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

/**
 * A Fork that would be refused is not offered, and the reason sits on the card
 * next to the button it explains. ADR-0002 already decided this for the Node
 * whose agent is mid-thought — "否则用户会以为坏了" — and it is the same
 * mistake either way: a refusal the user cannot see is indistinguishable from a
 * button that does not work.
 *
 * `onFork` answers with the reason the Fork did not happen, or null when it
 * did, so a Fork refused on arrival is written here too rather than swallowed.
 */
export const Card = ({
  data,
  onFork,
}: {
  data: NodeData
  onFork: (intent: string) => Promise<string | null>
}) => {
  /** The line being composed, or null when the button has not been pressed. */
  const [intent, setIntent] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  const refusal = data.forkRefusal

  const submit = () => {
    void (async () => {
      const problem = await onFork(intent ?? '')
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
      {data.diff !== undefined && <span className="card__diff">{describeDiff(data.diff)}</span>}
      {ENVIRONMENT[data.environment] !== null && (
        <span className={`card__environment card__environment--${data.environment}`}>
          {ENVIRONMENT[data.environment]}
        </span>
      )}
      {refusal !== null && <span className="card__refusal">{refusal}</span>}

      {intent === null ? (
        <button
          className="card__fork nodrag"
          type="button"
          disabled={refusal !== null}
          title={refusal ?? 'Fork this Node'}
          onClick={() => {
            setRefused(null)
            setIntent('')
          }}
        >
          Fork
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
