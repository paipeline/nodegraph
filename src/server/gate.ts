import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { admit, KEY_HEADER, keyFromProtocols, type Attempt, type Verdict } from '../core/guard.js'

/**
 * The one door into a running nodegraph.
 *
 * Everything here is edge work — pulling facts off the wire and turning a
 * refusal into bytes. The decision itself lives in `core/guard`, so http and
 * websocket cannot drift apart on what "allowed" means.
 */

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/**
 * 32 bytes from the system's random source, spelled base64url so it is a legal
 * websocket subprotocol as well as a legal header value. Minted per run and
 * never written down: a key that outlives the process it belongs to is a key
 * that can be stolen from somewhere the process cannot see.
 */
const mintKey = (): string => randomBytes(32).toString('base64url')

export type Gate = {
  /** The key this run handed to the page it served itself. Never log it. */
  key: string
  judge: (request: IncomingMessage, kind: Attempt['kind']) => Verdict
}

/**
 * Our own origins are built from the port we are really listening on, never
 * from the Host header the caller sent. A page at evil.example whose dns has
 * been pointed back at 127.0.0.1 controls Host; it does not control this.
 */
const ownOrigins = (server: Server): string[] => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return LOOPBACK_HOSTS.map((host) => `http://${host}:${port}`)
}

/** An ordinary request carries the key in a header; an upgrade cannot, so it uses a subprotocol. */
const keyOffered = (request: IncomingMessage, kind: Attempt['kind']): string | null => {
  if (kind === 'websocket') {
    return keyFromProtocols(request.headers['sec-websocket-protocol'] ?? null)
  }

  const offered = request.headers[KEY_HEADER]
  return typeof offered === 'string' ? offered : null
}

export const openGate = (server: Server): Gate => {
  const key = mintKey()

  return {
    key,
    judge: (request, kind) =>
      admit(
        {
          kind,
          method: request.method ?? 'GET',
          origin: request.headers.origin ?? null,
          key: keyOffered(request, kind),
        },
        { ownOrigins: ownOrigins(server), key },
      ),
  }
}

/** Say no to an ordinary request, in the shape the rest of the api answers in. */
export const refuseRequest = (response: ServerResponse, reason: string): void => {
  const payload = JSON.stringify({ error: reason })
  response.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * Say no to an upgrade. There is no websocket yet, so the refusal has to be
 * written as http by hand — and it must be http, not a dropped connection, or
 * the caller cannot tell "refused" from "nodegraph is not running".
 */
export const refuseUpgrade = (socket: Duplex, reason: string): void => {
  const body = `403 Forbidden — ${reason}\r\n`
  socket.write(
    'HTTP/1.1 403 Forbidden\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n' +
      '\r\n' +
      body,
  )
  socket.destroy()
}
