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

  /**
   * An origin is one string and it either is ours or it is not — matched whole,
   * never by how it begins. Ports are written without padding, so our own
   * 4571 is the opening of 45710 through 45719 as well; a page served from any
   * of those is a stranger who happens to have moved in next door, and a check
   * that read origins as prefixes would hold the door for all ten of them.
   */
  it('turns away a neighbour whose port merely begins with ours', () => {
    for (const origin of ['http://127.0.0.1:45710', 'http://localhost:45719']) {
      expect(admit({ ...honest, origin }, trust)).toMatchObject({ allowed: false })
    }
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

  /**
   * The key is compared all the way to the end, every time, so how long the
   * answer takes says nothing about how much of it a caller guessed right.
   * Timing is not a thing a test can pin down without flaking — but a
   * comparison that gives up early gives itself away in what it lets through,
   * and that is observable: it stops looking, so anything after the point it
   * stopped at is free. Both ends of the key have to matter.
   */
  it('turns away a key that only starts like this run’s, or that runs on past it', () => {
    const almost = { ...honest, origin: null }

    // One character short: everything it does offer is right.
    expect(admit({ ...almost, key: KEY.slice(0, -1) }, trust)).toMatchObject({ allowed: false })
    // The whole key, and then some — a comparison that stops at the end of the
    // real one never sees the tail.
    expect(admit({ ...almost, key: `${KEY}-and-then-some` }, trust)).toMatchObject({
      allowed: false,
    })
    // Nothing but a first character in common.
    expect(admit({ ...almost, key: KEY.slice(0, 1) }, trust)).toMatchObject({ allowed: false })
    // The empty string, which is a prefix of everything.
    expect(admit({ ...almost, key: '' }, trust)).toMatchObject({ allowed: false })
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
