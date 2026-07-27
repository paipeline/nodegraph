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
   * Whether that Context has actually been created yet. This is a fact about
   * the disk, gathered by an adapter, never an inference from having written
   * the name down: an agent that was started and never spoken to leaves no
   * Context behind, and resuming one that was never made kills the session on
   * the spot — which is how a Node becomes permanently unopenable.
   */
  exists: boolean
  /** The one line written at Fork time: this Node's first instruction. */
  intent?: string | null
}

/**
 * We run the real `claude` TUI, and the only flags we add are the ones that
 * say *which* Context it is running in. Everything else is left alone: every
 * further flag is a way for the session to stop behaving like the one the user
 * gets in their own terminal, and fidelity is the whole point of using a pty.
 *
 * There is no forking here. A Fork copies the parent's Context at the moment it
 * is taken, so by the time anybody opens a child Node its Context is already
 * its own and is simply resumed. Asking claude to fork at launch could not work
 * anyway: it only ever looks for a Context in the directory it is run from, and
 * a child Node runs in a Workspace of its own. See ADR-0004.
 */
export const toLaunch = (node: NodeContext): Launch => {
  const args = node.exists
    ? ['--resume', node.sessionId]
    : ['--session-id', node.sessionId]

  // Last, and only ever as the trailing prompt — `claude` reads a leading dash
  // as a flag of its own, which is why an intent may not start with one.
  if (node.intent) args.push(node.intent)

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
