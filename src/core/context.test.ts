import { describe, expect, it } from 'vitest'
import { retarget, contextPath } from './context.js'

/**
 * These tests are the written-down form of an assumption nodegraph makes about
 * somebody else's private layout — see ADR-0004. If claude ever moves its
 * Contexts, this is the file that goes red and says so.
 */

const HOME = '/Users/someone/.claude'

describe('where a Context lives on disk', () => {
  it('is under the claude home, in a directory named after the Workspace it was had in', () => {
    expect(
      contextPath(
        HOME,
        '/Users/pai/projects/demo/.nodegraph/workspaces/ab12cd34',
        '11111111-2222-3333-4444-555555555555',
      ),
    ).toBe(
      `${HOME}/projects/-Users-pai-projects-demo--nodegraph-workspaces-ab12cd34/11111111-2222-3333-4444-555555555555.jsonl`,
    )
  })

  it('flattens every separator claude flattens — the slash, the dot and the underscore alike', () => {
    expect(contextPath(HOME, '/tmp/wf_12ab-3/a.b', 'S')).toBe(
      `${HOME}/projects/-tmp-wf-12ab-3-a-b/S.jsonl`,
    )
  })

  it('tells two Workspaces apart, which is the whole reason a Fork can be inherited across them', () => {
    const parent = contextPath(HOME, '/repo/.nodegraph/workspaces/parent', 'S')
    const child = contextPath(HOME, '/repo/.nodegraph/workspaces/child', 'S')

    expect(parent).not.toBe(child)
  })
})

describe('a Context handed on to the Node that inherited it', () => {
  it('says it belongs to the new Node, in the new Node’s Workspace', () => {
    const parent = [
      JSON.stringify({
        type: 'user',
        sessionId: 'parent-session',
        cwd: '/repo',
        message: { role: 'user', content: 'the api key lives in the vault' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'parent-session',
        cwd: '/repo',
        message: { role: 'assistant', content: 'noted' },
      }),
    ].join('\n')

    const child = retarget(parent, {
      sessionId: 'child-session',
      cwd: '/repo/.nodegraph/workspaces/child',
    })

    const lines = child.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.sessionId === 'child-session')).toBe(true)
    expect(lines.every((line) => line.cwd === '/repo/.nodegraph/workspaces/child')).toBe(true)

    // Everything the parent worked out comes across untouched — that is the
    // only reason a Fork exists at all.
    expect(child).toContain('the api key lives in the vault')
    expect(child).toContain('noted')
  })

  it('leaves alone anything it cannot read, rather than dropping understanding it does not understand', () => {
    const odd = 'not json at all\n\n{"type":"user","sessionId":"parent"}\n'

    const child = retarget(odd, { sessionId: 'child', cwd: '/child' })

    expect(child).toContain('not json at all')
    expect(child).toContain('"sessionId":"child"')
  })

  it('never rewrites a mention of the parent that lives inside what was said', () => {
    const parent = JSON.stringify({
      type: 'user',
      sessionId: 'parent-session',
      cwd: '/repo',
      message: { role: 'user', content: 'look at /repo/README.md and at parent-session' },
    })

    const child = retarget(parent, { sessionId: 'child-session', cwd: '/child' })

    expect(child).toContain('look at /repo/README.md and at parent-session')
  })
})
