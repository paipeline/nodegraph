import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { readWorld } from '../adapters/git.js'
import { toFlowGraph } from '../core/flow.js'
import { reconcile } from '../core/reconcile.js'

export type RunningServer = {
  url: string
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

const serveWeb = async (
  webRoot: string,
  pathname: string,
  response: ServerResponse,
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

  if (await isFile(candidate)) {
    sendFile(response, candidate)
    return
  }

  // Unknown paths belong to the client-side router.
  const index = join(root, 'index.html')
  if (await isFile(index)) {
    sendFile(response, index)
    return
  }

  json(response, 404, { error: `No route for ${pathname}` })
}

const handle = async (
  options: { repoPath: string; webRoot?: string },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (pathname === '/api/nodes') {
    const nodes = reconcile(await readWorld(options.repoPath))
    json(response, 200, { nodes })
    return
  }

  // Layout is a rule, not a rendering concern, so it stays here where it is
  // tested. The browser only draws what it is given.
  if (pathname === '/api/graph') {
    json(response, 200, toFlowGraph(reconcile(await readWorld(options.repoPath))))
    return
  }

  // The api never falls through to the web app — a wrong endpoint must look
  // wrong, not return HTML.
  if (pathname.startsWith('/api/') || options.webRoot === undefined) {
    json(response, 404, { error: `No route for ${pathname}` })
    return
  }

  await serveWeb(options.webRoot, pathname, response)
}

export const startServer = async (options: {
  repoPath: string
  port?: number
  webRoot?: string
}): Promise<RunningServer> => {
  const server = createServer((request, response) => {
    handle(options, request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolveClose()))
      }),
  }
}
