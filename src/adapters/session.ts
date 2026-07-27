import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'
import {
  appendScrollback,
  toLaunch,
  type AgentActivity,
  type NodeContext,
} from '../core/session.js'
import { hasContext } from './context.js'
import { readForks, readSessions, recordSession } from './store.js'

/**
 * Owns the real pty processes behind the Nodes, and the Context each one runs in.
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

type LiveSession = Session & { pty: IPty; lastOutputAt: () => number }

export class SessionSupervisor {
  readonly #sessions = new Map<string, LiveSession>()
  /** Openings in flight, so two viewers arriving at once share one agent. */
  readonly #opening = new Map<string, Promise<Session>>()
  readonly #repoPath: string

  constructor(repoPath: string) {
    this.#repoPath = repoPath
  }

  /**
   * Idempotent on purpose. Opening a Node means "show me this Node's agent",
   * never "start another one" — otherwise a page reload would silently strand
   * the process the user was talking to. Working out which Context to run in
   * reads the store, so two viewers can now arrive inside that gap: they are
   * given the same opening rather than an agent each, because two agents on
   * one Context would write over each other's memory.
   */
  open(nodeId: string, workspacePath: string): Promise<Session> {
    const existing = this.#sessions.get(nodeId)
    if (existing) return Promise.resolve(existing)


    const opening = this.#opening.get(nodeId)
    if (opening) return opening

    const started = this.#start(nodeId, workspacePath)
    this.#opening.set(nodeId, started)
    return started.finally(() => this.#opening.delete(nodeId))
  }

  /**
   * Which Context this Node's agent belongs in.
   *
   * The name comes from what was written down — the Node's own Context once it
   * has been opened, otherwise the one reserved for it at the moment it was
   * Forked, otherwise a fresh one. Whether that Context *exists* is a separate
   * question, and only the disk may answer it: a Context that was named but
   * never created has to be started, not resumed.
   *
   * The line written at Fork time is the Node's *first* instruction, so it is
   * carried only while the Node has never been opened.
   */
  async #contextOf(nodeId: string, workspacePath: string): Promise<NodeContext> {
    const own = (await readSessions(this.#repoPath)).find((session) => session.nodeId === nodeId)
    const record = (await readForks(this.#repoPath)).find((fork) => fork.id === nodeId)

    const sessionId = own?.sessionId ?? record?.sessionId ?? randomUUID()
    const intent = own === undefined ? (record?.intent ?? null) : null

    return {
      workspacePath,
      sessionId,
      exists: await hasContext(workspacePath, sessionId),
      intent,
    }
  }

  async #start(nodeId: string, workspacePath: string): Promise<Session> {
    const context = await this.#contextOf(nodeId, workspacePath)
    const launch = toLaunch(context)

    const pty = spawn(launch.command, launch.args, {
      name: TERM_NAME,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: launch.cwd,
      env: { ...process.env } as Record<string, string>,
    })

    let history = ''
    // A claude that is working paints its screen the whole time it thinks, and
    // one waiting for the user says nothing — so the last time it spoke is the
    // one honest clue we have, from outside, about whether it has stopped.
    let lastOutputAt = Date.now()
    const watchers = new Set<(chunk: string) => void>()
    pty.onData((chunk) => {
      history = appendScrollback(history, chunk)
      lastOutputAt = Date.now()
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
      lastOutputAt: () => lastOutputAt,
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

    try {
      // Which Context this Node is living in, written down so that the next
      // nodegraph goes back to it rather than starting the Node over. It says
      // the Context's *name*, not that claude has created it — that is read off
      // the disk every time, in `#contextOf`.
      await recordSession(this.#repoPath, {
        nodeId,
        sessionId: context.sessionId,
        startedAt: new Date().toISOString(),
      })
    } catch (cause) {
      this.#sessions.delete(nodeId)
      pty.kill()
      throw cause
    }

    return session
  }

  /**
   * What can be seen of this Node's agent from outside it, or null when there
   * is no agent here at all. The rules that read this live in `core/`.
   */
  activityOf(nodeId: string, now: number = Date.now()): AgentActivity | null {
    const session = this.#sessions.get(nodeId)
    if (session === undefined) return null

    return {
      alive: session.status().state === 'running',
      quietFor: now - session.lastOutputAt(),
    }
  }

  stopAll(): void {
    for (const session of this.#sessions.values()) session.pty.kill()
    this.#sessions.clear()
  }
}
