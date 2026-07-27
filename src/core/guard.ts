/**
 * Who may reach a running nodegraph.
 *
 * Listening on 127.0.0.1 keeps other machines out and nothing else: every page
 * in the user's browser can reach loopback, and on the other end of `/session`
 * is a real `claude` in a real repository. So each attempt is judged here, on
 * plain facts gathered at the edge, and the answer is the same whether it
 * arrived as an http request or as a websocket upgrade.
 *
 * Two things have to be true, and neither one is enough on its own. A browser
 * cannot be talked out of telling us which page it is acting for, so a foreign
 * Origin is a foreign page. Anything that is not a browser just leaves the
 * header off — so we also hand this run's key to the one page we serve
 * ourselves, and ask for it back.
 */

/** The header an ordinary request carries the key in. */
export const KEY_HEADER = 'x-nodegraph-key'

/** Where the page we serve finds the key waiting for it. */
export const KEY_META = 'nodegraph-key'

/** The subprotocol the server picks, so it never echoes the key back. */
export const SESSION_PROTOCOL = 'nodegraph'

const KEY_PROTOCOL_PREFIX = 'nodegraph.key.'

export type Attempt = {
  /** A websocket upgrade is never a read, however it is spelled. */
  kind: 'websocket' | 'http'
  method: string
  /** The Origin header exactly as sent, or null when the caller sent none. */
  origin: string | null
  /** The key the caller presented, or null when it presented none. */
  key: string | null
}

export type Trust = {
  /** Every spelling of "this very server", and nothing else. */
  ownOrigins: readonly string[]
  /** The key this run minted, and handed only to the page it served itself. */
  key: string
}

export type Verdict = { allowed: true } | { allowed: false; reason: string }

/** Reads are left alone: locking them would only lock the user out of their own page. */
const READ_METHODS = new Set(['GET', 'HEAD'])

/** Changing something — or attaching to an agent — takes the key. */
const needsKey = (attempt: Attempt): boolean =>
  attempt.kind === 'websocket' || !READ_METHODS.has(attempt.method.toUpperCase())

/**
 * Compared to the end even once it is hopeless, so how long we take says
 * nothing about how much of the key a caller guessed right.
 */
const isKey = (offered: string, expected: string): boolean => {
  if (offered.length !== expected.length) return false

  let differences = 0
  for (let index = 0; index < offered.length; index += 1) {
    differences |= offered.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return differences === 0
}

export const admit = (attempt: Attempt, trust: Trust): Verdict => {
  if (attempt.origin !== null) {
    const origin = attempt.origin.trim().toLowerCase()
    if (!trust.ownOrigins.includes(origin)) {
      return { allowed: false, reason: `${attempt.origin} is not this nodegraph` }
    }
  }

  if (needsKey(attempt) && (attempt.key === null || !isKey(attempt.key, trust.key))) {
    return { allowed: false, reason: 'this nodegraph did not hand out that key' }
  }

  return { allowed: true }
}

/** How the key is spelled when it rides along with a websocket handshake. */
export const toKeyProtocol = (key: string): string => `${KEY_PROTOCOL_PREFIX}${key}`

/**
 * A browser cannot put a header on a websocket handshake, but it can name the
 * subprotocols it speaks — so that is where the key goes. Not the query
 * string: urls end up in logs, in Referer, and in the user's own history.
 */
export const keyFromProtocols = (offered: string | null): string | null => {
  if (offered === null) return null

  for (const raw of offered.split(',')) {
    const one = raw.trim()
    if (one.startsWith(KEY_PROTOCOL_PREFIX)) return one.slice(KEY_PROTOCOL_PREFIX.length)
  }
  return null
}
