import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from './server.js'

let webRoot: string
let repo: string
let url: string
let stop: (() => Promise<void>) | undefined

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-static-repo-')))
  webRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-static-web-')))
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>nodegraph</title>')
  mkdirSync(join(webRoot, 'assets'))
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("hi")')

  const server = await startServer({ repoPath: repo, port: 0, webRoot })
  url = server.url
  stop = server.close
})

afterEach(async () => {
  await stop?.()
  rmSync(repo, { recursive: true, force: true })
  rmSync(webRoot, { recursive: true, force: true })
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
})
