import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fork } from '../adapters/fork.js'
import { readWorld } from '../adapters/git.js'
import { readForks } from '../adapters/store.js'
import { toFlowGraph } from '../core/flow.js'
import { KEY_META } from '../core/guard.js'
import { reconcile } from '../core/reconcile.js'
import { openGate, refuseRequest, type Gate } from './gate.js'
import { attachSessions } from './session.js'

export type RunningServer = {
  url: string
  /**
   * The interface this is really bound to, as the socket reports it — not the
   * one we asked for. Loopback keeps the agent off the network the user is
   * sitting on, and that is a fact about the listening socket, so it is read
   * back off the socket rather than assumed from the url.
   */
  address: string
  /**
   * The key this run minted. The page gets it by being served it; anyone else
   * holding it — the test suite, say — got it from here. Never print it.
   */
  key: string
  close: () => Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

const sendFile = (response: ServerResponse, filePath: string): void => {
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
  })
  createReadStream(filePath).pipe(response)
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The app shell, with this run's key waiting in it.
 *
 * Handing the key over by serving it is the whole trick: the same-origin
 * policy means only a script from this very server can read it back out of the
 * document, which is exactly the set of scripts we mean to trust. A base64url
 * key needs no escaping — it has no quote, no angle bracket and no ampersand
 * in it — and the page is never cached, so the key does not outlive the run on
 * anybody's disk.
 */
const sendPage = async (response: ServerResponse, indexPath: string, key: string): Promise<void> => {
  const html = await readFile(indexPath, 'utf8')
  const meta = `<meta name="${KEY_META}" content="${key}">`

  // Inside <head> if there is one, otherwise after the doctype so we do not
  // push it out of the document. A page with neither gets it at the front.
  const opening = /<head[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  const at = opening === null ? 0 : opening.index + opening[0].length
  const payload = html.slice(0, at) + meta + html.slice(at)

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

const serveWeb = async (
  webRoot: string,
  pathname: string,
  response: ServerResponse,
  key: string,
): Promise<void> => {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    json(response, 400, { error: 'Malformed path' })
    return
  }

  const root = resolve(webRoot)
  const candidate = resolve(join(root, decoded))

  // Anything that resolves outside the web root is an attack, not a typo.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    json(response, 400, { error: 'Path escapes the web root' })
    return
  }

  // Unknown paths belong to the client-side router, and so does `/index.html`
  // asked for by name — the shell is never served as a plain file, or it would
  // go out without the key in it.
  const index = join(root, 'index.html')

  if (candidate !== index && (await isFile(candidate))) {
    sendFile(response, candidate)
    return
  }

  if (await isFile(index)) {
    await sendPage(response, index, key)
    return
  }

  json(response, 404, { error: `No route for ${pathname}` })
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })

/** The Nodes as they stand right now: what git has, crossed with what we wrote down. */
const currentNodes = async (repoPath: string) =>
  reconcile(await readWorld(repoPath), await readForks(repoPath))

const handle = async (
  options: { repoPath: string; webRoot?: string; gate: Gate },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const verdict = options.gate.judge(request, 'http')
  if (!verdict.allowed) {
    refuseRequest(response, verdict.reason)
    return
  }

  const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (pathname === '/api/nodes') {
    json(response, 200, { nodes: await currentNodes(options.repoPath) })
    return
  }

  // Layout is a rule, not a rendering concern, so it stays here where it is
  // tested. The browser only draws what it is given.
  if (pathname === '/api/graph') {
    json(response, 200, toFlowGraph(await currentNodes(options.repoPath)))
    return
  }

  if (pathname === '/api/fork' && request.method === 'POST') {
    const { parentId } = JSON.parse(await readBody(request)) as { parentId?: string }
    if (typeof parentId !== 'string') {
      json(response, 400, { error: 'Which Node should this fork from?' })
      return
    }

    json(response, 201, { node: await fork({ repoPath: options.repoPath, parentId }) })
    return
  }

  // The api never falls through to the web app — a wrong endpoint must look
  // wrong, not return HTML.
  if (pathname.startsWith('/api/') || options.webRoot === undefined) {
    json(response, 404, { error: `No route for ${pathname}` })
    return
  }

  await serveWeb(options.webRoot, pathname, response, options.gate.key)
}

export const startServer = async (options: {
  repoPath: string
  port?: number
  webRoot?: string
}): Promise<RunningServer> => {
  const server = createServer((request, response) => {
    handle({ ...options, gate }, request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  // The gate reads the port off the server, so it can only be consulted once
  // something is listening — which is exactly when the first request arrives.
  const gate = openGate(server)

  const sessions = attachSessions(server, options.repoPath, gate)

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address : { address: '', port: 0 }

  return {
    url: `http://127.0.0.1:${bound.port}`,
    address: bound.address,
    key: gate.key,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        sessions.close()
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolveClose()))
      }),
  }
}
