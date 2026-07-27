/**
 * What the user is told when something the page asked for did not happen.
 *
 * The page is a viewer: everything it does goes through the server, and a
 * request that comes back refused has to end up on the screen rather than in a
 * discarded promise. A button whose failure is invisible is a broken button —
 * so the server's own sentence is preferred whenever it wrote one, because it
 * is the only party that knows what actually went wrong.
 *
 * Pure by design, and free of any browser type, so the rule is decided here and
 * the page only renders it. See CLAUDE.md.
 */
export const describeProblem = (status: number, error: unknown): string =>
  typeof error === 'string' && error.trim() !== ''
    ? error.trim()
    : `nodegraph answered ${status}`

/** The same, for a request that never reached a server at all. */
export const describeUnreachable = (cause: unknown): string =>
  `nodegraph is not answering: ${cause instanceof Error ? cause.message : String(cause)}`
