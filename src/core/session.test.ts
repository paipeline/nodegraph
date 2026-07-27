import { describe, expect, it } from 'vitest'
import { appendScrollback, toLaunch } from './session.js'

describe('launching an agent for a Node', () => {
  it('runs the claude TUI, unflagged, in that Node’s Workspace', () => {
    expect(toLaunch({ workspacePath: '/somewhere/workspace' })).toEqual({
      command: 'claude',
      args: [],
      cwd: '/somewhere/workspace',
    })
  })
})

describe('the output history a reopened page gets back', () => {
  it('drops the oldest output once the history outgrows its limit', () => {
    expect(appendScrollback('abcdef', 'ghij', 5)).toBe('fghij')
  })
})
