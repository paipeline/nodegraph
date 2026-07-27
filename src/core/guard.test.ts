import { describe, expect, it } from 'vitest'
import { admit, keyFromProtocols, toKeyProtocol } from './guard.js'

const OURS = ['http://127.0.0.1:4571', 'http://localhost:4571'] as const
const KEY = 'kAtLA0jVCvpqvIvbCUyDsmZ8u3q0Ym5ROzVfeFAcvXQ'

const trust = { ownOrigins: OURS, key: KEY }

/** A caller doing everything right, so each test can change one thing about it. */
const honest = { kind: 'http', method: 'POST', origin: OURS[0], key: KEY } as const

describe('deciding who may reach a running nodegraph', () => {
  it('lets a caller in when it is this very server and holds this run’s key', () => {
    expect(admit(honest, trust)).toEqual({ allowed: true })
    expect(admit({ ...honest, kind: 'websocket', method: 'GET' }, trust)).toEqual({ allowed: true })
  })

  it('turns away a caller that says it is another website', () => {
    expect(admit({ ...honest, origin: 'https://evil.example' }, trust)).toMatchObject({
      allowed: false,
    })
  })

  it('turns away a caller with no origin of its own', () => {
    // A sandboxed iframe and a `data:` url both send the literal `null`.
    expect(admit({ ...honest, origin: 'null' }, trust)).toMatchObject({ allowed: false })
  })

  it('turns away the rest of localhost — a neighbouring port is a stranger', () => {
    expect(admit({ ...honest, origin: 'http://localhost:5173' }, trust)).toMatchObject({
      allowed: false,
    })
  })

  it('turns away a caller that changes something without this run’s key', () => {
    expect(admit({ ...honest, origin: null, key: null }, trust)).toMatchObject({ allowed: false })
    expect(admit({ ...honest, origin: null, key: 'let-me-in' }, trust)).toMatchObject({
      allowed: false,
    })
    // Right length, one character out — no prefix of the key is worth anything.
    expect(admit({ ...honest, origin: null, key: `${KEY.slice(0, -1)}X` }, trust)).toMatchObject({
      allowed: false,
    })
  })

  it('turns away a caller attaching to an agent without this run’s key', () => {
    // A websocket is never a read, whatever method the upgrade was spelled with.
    expect(
      admit({ kind: 'websocket', method: 'GET', origin: null, key: null }, trust),
    ).toMatchObject({ allowed: false })
  })

  it('lets an ordinary read through without a key, so the page can load at all', () => {
    // The browser's own same-origin policy is what keeps another site from
    // reading these; a key here would only lock the user out of their own page.
    for (const method of ['GET', 'HEAD']) {
      expect(admit({ kind: 'http', method, origin: null, key: null }, trust)).toEqual({
        allowed: true,
      })
    }
  })

  it('never repeats the key back in the reason it gives', () => {
    const refused = [
      admit({ ...honest, origin: 'https://evil.example' }, trust),
      admit({ ...honest, origin: null, key: null }, trust),
      admit({ ...honest, origin: null, key: 'let-me-in' }, trust),
    ]

    for (const verdict of refused) {
      expect(verdict.allowed).toBe(false)
      expect(verdict.allowed === false && verdict.reason).not.toContain(KEY)
    }
  })
})

describe('carrying the key on a websocket handshake', () => {
  it('finds the key among the subprotocols a browser is willing to offer', () => {
    expect(keyFromProtocols(`nodegraph, ${toKeyProtocol(KEY)}`)).toBe(KEY)
  })

  it('finds nothing when no key was offered', () => {
    expect(keyFromProtocols('nodegraph')).toBe(null)
    expect(keyFromProtocols(null)).toBe(null)
  })
})
