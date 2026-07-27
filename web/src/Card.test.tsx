import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Card, type NodeData } from './Card.js'

/**
 * What the user actually sees on a Node, rendered by the very component the
 * browser mounts. A rule that only ever reaches an HTTP response body is not a
 * rule the user can read.
 */
const render = (data: Partial<NodeData>) =>
  renderToStaticMarkup(
    <Card
      data={{
        label: 'main',
        kind: 'trunk',
        branch: 'main',
        workspacePath: '/repo',
        environment: 'ready',
        forkRefusal: null,
        ...data,
      }}
      onFork={() => {}}
    />,
  )

describe('a Node card', () => {
  it('offers a Fork when there is nothing in the way', () => {
    const html = render({})

    expect(html).toContain('main')
    expect(html).toMatch(/<button[^>]*>Fork<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })

  it('says why a Fork cannot start, and does not offer a button that would do nothing', () => {
    const html = render({
      forkRefusal:
        '.nodegraph.on-fork is not executable, so this Fork would arrive with no environment ' +
        'at all. Run: chmod +x /repo/.nodegraph.on-fork',
    })

    // The reason is *written on the card*, next to the button it explains — a
    // refusal the user cannot see is indistinguishable from a broken button, and
    // a reason hidden in an attribute is a refusal the user cannot see.
    expect(html).toMatch(/>[^<]*chmod \+x \/repo\/\.nodegraph\.on-fork[^<]*</)
    expect(html).toMatch(/<button[^>]*disabled/)
  })

  it('shows an environment that is still landing, and one that went wrong', () => {
    expect(render({ environment: 'preparing' })).toContain('environment landing')
    expect(render({ environment: 'failed' })).toContain('environment failed')
    expect(render({ environment: 'ready' })).not.toContain('environment')
  })
})
