import { KEY_META } from '../../src/core/guard.js'

/**
 * This run's key, left in the document by the server that served it.
 *
 * The same-origin policy is what makes this safe to put in the page: a script
 * from any other site can open a socket to 127.0.0.1, but it cannot read this
 * document, so it cannot pick the key up. Read it fresh each time rather than
 * caching it in a module variable — there is nothing to gain by holding it.
 */
export const runKey = (): string =>
  document.querySelector(`meta[name="${KEY_META}"]`)?.getAttribute('content') ?? ''
