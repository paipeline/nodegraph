import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

/**
 * Nothing in this suite may reach the Contexts on the machine it runs on.
 *
 * nodegraph now reads and writes real Context files under the claude home (see
 * ADR-0004), and `CLAUDE_CONFIG_DIR` is what says where that is. Test files
 * that care point it at a sandbox of their own; this is the floor under the
 * ones that do not think about it, so a mistake costs a temporary directory
 * rather than somebody's conversations.
 */

let fallbackHome: string

beforeAll(() => {
  fallbackHome = mkdtempSync(join(tmpdir(), 'nodegraph-claude-home-'))
  process.env.CLAUDE_CONFIG_DIR = fallbackHome
})

afterAll(() => {
  rmSync(fallbackHome, { recursive: true, force: true })
})
