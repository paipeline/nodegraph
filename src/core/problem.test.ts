import { describe, expect, it } from 'vitest'
import { describeProblem, describeUnreachable } from './problem.js'

describe('what the user is told when a request did not work', () => {
  it('says what the server said, because only the server knows', () => {
    expect(
      describeProblem(500, '.nodegraph.on-fork is not executable. Run: chmod +x /repo/x'),
    ).toBe('.nodegraph.on-fork is not executable. Run: chmod +x /repo/x')
  })

  it('still says something when the server explained nothing', () => {
    expect(describeProblem(502, undefined)).toBe('nodegraph answered 502')
    expect(describeProblem(500, '   ')).toBe('nodegraph answered 500')
    expect(describeProblem(400, { message: 'not a string' })).toBe('nodegraph answered 400')
  })

  it('says so when nothing answered at all', () => {
    expect(describeUnreachable(new Error('Failed to fetch'))).toContain('Failed to fetch')
    expect(describeUnreachable('socket hang up')).toContain('socket hang up')
  })
})
