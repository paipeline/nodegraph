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

describe('launching an agent for a Node whose Context has still to be made', () => {
  it('runs the claude TUI in that Node’s Workspace, under a Context of its own', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/workspace',
        sessionId: '11111111-2222-3333-4444-555555555555',
        exists: false,
      }),
    ).toEqual({
      command: 'claude',
      args: ['--session-id', '11111111-2222-3333-4444-555555555555'],
      cwd: '/somewhere/workspace',
    })
  })

  it('starts it rather than resuming it, however sure we were that it was there', () => {
    // A Context that was named but never created — an agent opened and never
    // spoken to. Resuming it would kill the session the moment it started, and
    // the Node would never open again.
    expect(
      toLaunch({
        workspacePath: '/somewhere/workspace',
        sessionId: '11111111-2222-3333-4444-555555555555',
        exists: false,
      }).args,
    ).not.toContain('--resume')
  })
})

describe('launching an agent on a Context that already exists', () => {
  it('resumes that Context, and opens it on the line the Fork was given', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/child',
        sessionId: '11111111-2222-3333-4444-555555555555',
        exists: true,
        intent: 'try it with a queue instead',
      }),
    ).toEqual({
      command: 'claude',
      args: [
        '--resume',
        '11111111-2222-3333-4444-555555555555',
        'try it with a queue instead',
      ],
      cwd: '/somewhere/child',
    })
  })

  it('never asks claude to fork a Context — a Fork has already done that, in a directory claude cannot see', () => {
    const launch = toLaunch({
      workspacePath: '/somewhere/child',
      sessionId: '11111111-2222-3333-4444-555555555555',
      exists: true,
      intent: 'try it with a queue instead',
    })

    expect(launch.args).not.toContain('--fork-session')
    expect(launch.args).not.toContain('--session-id')
  })

  it('resumes it and nothing more once the Node has been opened before', () => {
    expect(
      toLaunch({
        workspacePath: '/somewhere/child',
        sessionId: '11111111-2222-3333-4444-555555555555',
        exists: true,
        intent: null,
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
