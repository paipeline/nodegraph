import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from './server.js'

let sandbox: string
let webRoot: string
let repo: string
let url: string
let stop: (() => Promise<void>) | undefined

/**
 * A file one directory above the web root — which is where the interesting
 * ones live: the repo being viewed, `.git`, `.nodegraph`, the user's home.
 * Nothing the server writes may ever contain this.
 */
const SECRET = 'nobody-outside-the-web-root-may-read-this'

/**
 * A GET whose path leaves exactly as written.
 *
 * `fetch` collapses `..` before the bytes ever leave the client, so a traversal
 * sent through it is not the request an attacker makes — it is a different,
 * already-harmless one, and asserting on the answer to it proves nothing. The
 * escapes below survive the url parser too, so what the handler is handed is
 * what was typed.
 */
const rawGet = (path: string): Promise<{ status: number; body: string }> =>
  new Promise((done, fail) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: Number(new URL(url).port), method: 'GET', path },
      (incoming) => {
        let body = ''
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => {
          body += chunk
        })
        incoming.on('end', () => done({ status: incoming.statusCode ?? 0, body }))
      },
    )
    outgoing.on('error', fail)
    outgoing.end()
  })

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-static-')))

  repo = join(sandbox, 'repo')
  mkdirSync(repo)

  webRoot = join(sandbox, 'web')
  mkdirSync(webRoot)
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>nodegraph</title>')
  mkdirSync(join(webRoot, 'assets'))
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("hi")')

  writeFileSync(join(sandbox, 'SECRET.txt'), SECRET)

  const server = await startServer({ repoPath: repo, port: 0, webRoot })
  url = server.url
  stop = server.close
})

afterEach(async () => {
  await stop?.()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('serving the web app', () => {
  it('serves index.html at the root', async () => {
    const response = await fetch(`${url}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toContain('<title>nodegraph</title>')
  })

  it('serves assets with a sensible content type', async () => {
    const response = await fetch(`${url}/assets/app.js`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  it('falls back to index.html for client-side routes', async () => {
    const response = await fetch(`${url}/some/deep/route`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('<title>nodegraph</title>')
  })

  it('never falls back for api routes', async () => {
    const response = await fetch(`${url}/api/nonsense`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('json')
  })

  it('never serves a file from outside the web root', async () => {
    const response = await fetch(`${url}/%2e%2e/%2e%2e/etc/hosts`, { redirect: 'manual' })
    const body = await response.text()

    // What matters is that no file outside the root comes back. Whether the
    // attempt is rejected or lands on the app shell is an implementation
    // detail of path normalisation.
    expect(body).not.toContain('localhost')
    expect(body).toContain('<title>nodegraph</title>')
  })

  /**
   * The escapes an attacker actually reaches for. A `/` written `%2f` is not a
   * separator to any url parser, so `..%2fSECRET.txt` is one innocent-looking
   * segment on the way in and a directory above the root by the time the path
   * has been decoded. The server is the last thing standing between that and
   * the file, so it has to be the server that says no.
   */
  it('never serves a file from outside the web root, however the path is escaped', async () => {
    for (const path of ['/..%2fSECRET.txt', '/%2e%2e%2fSECRET.txt', '/x/..%2f..%2fSECRET.txt']) {
      const response = await rawGet(path)

      // Asked as a yes/no on purpose: a failing `toContain` would print the
      // very file the server is supposed to be keeping to itself.
      expect(response.body.includes(SECRET)).toBe(false)
      expect(response.status).toBe(400)
    }
  })
})
