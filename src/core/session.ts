/**
 * The rules for an agent session, kept away from the pty that runs it.
 *
 * Pure by design: what to launch and what history to keep are decisions, and
 * decisions belong here where they can be tested without a process. See
 * CLAUDE.md.
 */

export type Launch = {
  command: string
  args: string[]
  cwd: string
}

/**
 * What became of the one line the user wrote at Fork time: either the line as
 * the Node will keep it, or the reason it cannot be used.
 */
export type IntentReading = { intent: string | null } | { refusal: string }

/**
 * The line is handed to `claude` as its trailing prompt, so a line that begins
 * with a dash would be read as a flag instead of as words — and the flags on
 * offer include ones that switch off permission prompts entirely. Refused
 * rather than quietly rewritten: nodegraph must not put words in the user's
 * mouth, and it must not launch an agent under options they did not choose.
 */
export const readIntent = (raw: string | null | undefined): IntentReading => {
  // Control characters would travel into the terminal title and the card, and
  // a line break is not part of a one-line intent anyway.
  const line = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  if (line === '') return { intent: null }
  if (line.startsWith('-')) {
    return {
      refusal: 'A Fork’s line cannot start with “-” — claude would read it as a flag.',
    }
  }
  return { intent: line }
}

/** Everything about a Node that decides how its agent is started. */
export type NodeContext = {
  workspacePath: string
  /** The session this Node's Context lives in — nodegraph names it, so it can find it again. */
  sessionId: string
  /**
   * The parent's session, when this Node's Context has still to be cut from
   * it. Null for the Trunk, and for a Node forked from one that had never been
   * talked to — there is no understanding to inherit.
   */
  forkedFrom?: string | null
  /** The one line written at Fork time: this Node's first instruction. */
  intent?: string | null
}

/**
 * We run the real `claude` TUI, and the only flags we add are the ones that
 * say *which* Context it is running in. Everything else is left alone: every
 * further flag is a way for the session to stop behaving like the one the user
 * gets in their own terminal, and fidelity is the whole point of using a pty.
 *
 * A Node whose session already exists is resumed and nothing more. Cutting it
 * from the parent a second time would throw away everything the Node itself
 * has since worked out — see `toLaunch`'s callers, which say so with `started`.
 */
export const toLaunch = (node: NodeContext & { started?: boolean }): Launch => {
  const args =
    node.started === true
      ? ['--resume', node.sessionId]
      : node.forkedFrom
        ? // The child's Context starts as a copy of the parent's, under a name
          // of its own, so that neither one can write on the other again.
          ['--resume', node.forkedFrom, '--fork-session', '--session-id', node.sessionId]
        : ['--session-id', node.sessionId]

  // Last, and only ever as the trailing prompt — `claude` reads a leading dash
  // as a flag of its own, which is why an intent may not start with one.
  if (node.started !== true && node.intent) args.push(node.intent)

  return { command: 'claude', args, cwd: node.workspacePath }
}

/**
 * What nodegraph can actually see of an agent from outside it: whether its
 * process is still there, and how long it has been since it last printed
 * anything.
 */
export type AgentActivity = {
  alive: boolean
  /** Milliseconds since the agent last put something on the screen. */
  quietFor: number
}

/**
 * How long an agent has to stay silent before we believe it has stopped for
 * the user. A working claude paints its screen continuously; one waiting at a
 * prompt — or on a permission question — says nothing at all.
 */
export const SETTLE_MS = 500

/**
 * ADR-0002: a Fork copies the parent Node *at this instant*, so it may only be
 * taken when the agent has stopped and is waiting. Forking mid-thought would
 * hand the child a memory that breaks off in the middle of a sentence, and the
 * Workspace it copies would be a moving target.
 *
 * Returns the reason a Fork must wait, or null when it may go ahead. A Node
 * with no agent at all has nothing to interrupt.
 */
export const forkRefusal = (agent: AgentActivity | null): string | null =>
  agent !== null && agent.alive && agent.quietFor < SETTLE_MS
    ? 'This Node’s agent is still working — Fork it once it stops for you.'
    : null

/**
 * How much of an agent's output we keep so a reopened page can be handed the
 * screen it left behind. A day-long session must not grow without bound, and
 * what matters is the tail — the oldest output has already scrolled away.
 */
export const SCROLLBACK_LIMIT = 200_000

export const appendScrollback = (
  history: string,
  chunk: string,
  limit: number = SCROLLBACK_LIMIT,
): string => {
  const grown = history + chunk
  return grown.length <= limit ? grown : grown.slice(grown.length - limit)
}
