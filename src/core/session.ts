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
 * We run the real `claude` TUI with no flags of our own. Every flag is a way
 * for the session to stop behaving like the one the user gets in their own
 * terminal, and fidelity is the whole point of using a pty.
 */
export const toLaunch = (node: { workspacePath: string }): Launch => ({
  command: 'claude',
  args: [],
  cwd: node.workspacePath,
})

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
