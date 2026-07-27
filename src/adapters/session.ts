import { spawn, type IPty } from 'node-pty'
import { appendScrollback, toLaunch } from '../core/session.js'

/**
 * Owns the real pty processes behind the Nodes.
 *
 * The supervisor outlives any browser: a page is only ever a viewer that
 * attaches to a session already running here, so closing or reloading the page
 * cannot disturb the agent.
 */

export type SessionStatus = { state: 'running' } | { state: 'exited'; exitCode: number }

export type Session = {
  nodeId: string
  scrollback: () => string
  status: () => SessionStatus
  /** Raw keystrokes, straight to the pty — that is what keeps the TUI native. */
  write: (data: string) => void
  /** A TUI draws itself to fit; tell it the size the user is actually looking at. */
  resize: (cols: number, rows: number) => void
  /** Watch the live output. Returns the function that stops watching. */
  onOutput: (listener: (chunk: string) => void) => () => void
  /** Learn when the agent finishes. Returns the function that stops watching. */
  onExit: (listener: (exitCode: number) => void) => () => void
}

const TERM_NAME = 'xterm-256color'
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

type LiveSession = Session & { pty: IPty }

export class SessionSupervisor {
  readonly #sessions = new Map<string, LiveSession>()

  /**
   * Idempotent on purpose. Opening a Node means "show me this Node's agent",
   * never "start another one" — otherwise a page reload would silently strand
   * the process the user was talking to.
   */
  open(nodeId: string, workspacePath: string): Session {
    const existing = this.#sessions.get(nodeId)
    if (existing) return existing

    const launch = toLaunch({ workspacePath })

    const pty = spawn(launch.command, launch.args, {
      name: TERM_NAME,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: launch.cwd,
      env: { ...process.env } as Record<string, string>,
    })

    let history = ''
    const watchers = new Set<(chunk: string) => void>()
    pty.onData((chunk) => {
      history = appendScrollback(history, chunk)
      for (const watcher of watchers) watcher(chunk)
    })

    let status: SessionStatus = { state: 'running' }
    const mourners = new Set<(exitCode: number) => void>()
    pty.onExit(({ exitCode }) => {
      status = { state: 'exited', exitCode }
      for (const mourner of mourners) mourner(exitCode)
    })

    const session: LiveSession = {
      nodeId,
      pty,
      scrollback: () => history,
      status: () => status,
      write: (data) => pty.write(data),
      resize: (cols, rows) => {
        if (status.state === 'running') pty.resize(cols, rows)
      },
      onOutput: (listener) => {
        watchers.add(listener)
        return () => watchers.delete(listener)
      },
      onExit: (listener) => {
        mourners.add(listener)
        return () => mourners.delete(listener)
      },
    }
    this.#sessions.set(nodeId, session)
    return session
  }

  stopAll(): void {
    for (const session of this.#sessions.values()) session.pty.kill()
    this.#sessions.clear()
  }
}
