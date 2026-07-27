import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { readWorld } from '../adapters/git.js'
import { SessionSupervisor } from '../adapters/session.js'
import { reconcile } from '../core/reconcile.js'

/**
 * Puts a browser tab in front of a Node's agent.
 *
 * Thin by design: the pty lives in the supervisor, which outlives every socket
 * that ever looks at it. A viewer arriving is handed the screen so far and then
 * the live stream; a viewer leaving is forgotten and nothing else happens.
 */

const SESSION_PATH = '/session'

type Viewer = { close: () => void }

const send = (socket: WebSocket, message: unknown): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

/** Nothing left to show, so say why and go — never leave a viewer waiting. */
const refuse = (socket: WebSocket, message: string): Viewer => {
  send(socket, { type: 'error', message })
  socket.close()
  return { close: () => {} }
}

type Incoming = { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }

const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** A viewer is not trusted to send well-formed json; nonsense is simply ignored. */
const parse = (raw: string): Incoming | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Incoming) : undefined
  } catch {
    return undefined
  }
}

export const attachSessions = (
  server: Server,
  repoPath: string,
): { close: () => void } => {
  const supervisor = new SessionSupervisor()
  const websockets = new WebSocketServer({ noServer: true })

  const welcome = async (socket: WebSocket, nodeId: string | null): Promise<Viewer> => {
    if (nodeId === null) return refuse(socket, 'Ask for a Node by id')

    const nodes = reconcile(await readWorld(repoPath))
    const node = nodes.find((candidate) => candidate.id === nodeId)

    if (node === undefined) return refuse(socket, `No Node named ${nodeId}`)

    const session = supervisor.open(node.id, node.workspacePath)

    send(socket, {
      type: 'opened',
      nodeId: node.id,
      workspacePath: node.workspacePath,
      status: session.status(),
      data: session.scrollback(),
    })

    const stopWatching = session.onOutput((chunk) => send(socket, { type: 'output', data: chunk }))
    const stopMourning = session.onExit((exitCode) => send(socket, { type: 'exited', exitCode }))

    socket.on('message', (raw) => {
      const message = parse(String(raw))
      if (message?.type === 'input' && typeof message.data === 'string') session.write(message.data)
      if (message?.type === 'resize' && isSize(message.cols) && isSize(message.rows)) {
        session.resize(message.cols, message.rows)
      }
    })

    return {
      close: () => {
        stopWatching()
        stopMourning()
      },
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (pathname !== SESSION_PATH) {
      socket.destroy()
      return
    }

    websockets.handleUpgrade(request, socket, head, (websocket) => {
      // Resolving the Node reads the world, so the viewer can give up before we
      // are ready for it. Claim the close event first and there is no window in
      // which a departed viewer stays subscribed to a running agent.
      let gone = false
      let stopViewing = (): void => {
        gone = true
      }
      websocket.on('close', () => stopViewing())

      void welcome(websocket, searchParams.get('node'))
        .catch((error: unknown) =>
          refuse(websocket, error instanceof Error ? error.message : String(error)),
        )
        .then((viewer) => {
          stopViewing = viewer.close
          if (gone) viewer.close()
        })
    })
  })

  return {
    close: () => {
      for (const socket of websockets.clients) socket.terminate()
      websockets.close()
      supervisor.stopAll()
    },
  }
}
