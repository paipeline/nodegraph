import { describe, expect, it } from 'vitest'
import { appendScrollback, forkRefusal, readIntent, SETTLE_MS, toLaunch } from './session.js'

describe('whether a Node may be Forked right now', () => {
  it('holds a Fork back while the agent is still working, and says why', () => {
    expect(forkRefusal({ alive: true, quietFor: 0 })).toMatch(/still working/)
  })

  it('lets it through once the agent has stopped for the user, or has nothing to interrupt', () => {
    expect(forkRefusal({ alive: true, quietFor: SETTLE_MS })).toBeNull()
    expect(forkRefusal({ alive: false, quietFor: 0 })).toBeNull()
    expect(forkRefusal(null)).toBeNull()
  })
})

describe('the line the user writes when they Fork', () => {
  it('is kept as one tidy line, and is simply absent when nothing was written', () => {
    expect(readIntent('  try it   with a queue\ninstead  ')).toEqual({
      intent: 'try it with a queue instead',
    })
    expect(readIntent('   ')).toEqual({ intent: null })
    expect(readIntent(undefined)).toEqual({ intent: null })
  })

  it('is refused when it would reach claude as a flag rather than as words', () => {
    expect(readIntent('--dangerously-skip-permissions')).toEqual({
      refusal: expect.stringContaining('flag'),
    })
  })
})

describe('launching an agent for a Node', () => {
  it('runs the claude TUI in that Node’s Workspace, under a Context of its own', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/workspace',
        sessionId: '11111111-2222-3333-4444-555555555555',
      }),
    ).toEqual({
      command: 'claude',
      args: ['--session-id', '11111111-2222-3333-4444-555555555555'],
      cwd: '/somewhere/workspace',
    })
  })
})

describe('launching an agent that inherits a Node’s Context', () => {
  it('cuts the child’s own session from the parent’s, and opens it on the line the user wrote', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/child',
        sessionId: '11111111-2222-3333-4444-555555555555',
        forkedFrom: '99999999-8888-7777-6666-555555555555',
        intent: 'try it with a queue instead',
      }),
    ).toEqual({
      command: 'claude',
      args: [
        '--resume',
        '99999999-8888-7777-6666-555555555555',
        '--fork-session',
        '--session-id',
        '11111111-2222-3333-4444-555555555555',
        'try it with a queue instead',
      ],
      cwd: '/somewhere/child',
    })
  })
})

describe('launching an agent whose Node already has a Context of its own', () => {
  it('resumes that Context rather than cutting it from the parent again', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/child',
        sessionId: '11111111-2222-3333-4444-555555555555',
        forkedFrom: '99999999-8888-7777-6666-555555555555',
        intent: 'try it with a queue instead',
        started: true,
      }),
    ).toEqual({
      command: 'claude',
      args: ['--resume', '11111111-2222-3333-4444-555555555555'],
      cwd: '/somewhere/child',
    })
  })
})

describe('the output history a reopened page gets back', () => {
  it('drops the oldest output once the history outgrows its limit', () => {
    expect(appendScrollback('abcdef', 'ghij', 5)).toBe('fghij')
  })
})
