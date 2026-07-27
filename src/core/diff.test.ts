import { describe, expect, it } from 'vitest'
import { describeDiff } from './diff.js'

/**
 * The line a Node card carries. It is the only diff most Nodes ever get looked
 * at through, so it is a rule and lives here, tested, rather than in the shell.
 */
describe('the line a Node shows for what it changed', () => {
  it('gives the number of files and the lines added and removed', () => {
    expect(describeDiff({ files: 3, insertions: 42, deletions: 7 })).toBe('3 files +42 -7')
  })

  it('counts one file as one file', () => {
    expect(describeDiff({ files: 1, insertions: 2, deletions: 0 })).toBe('1 file +2 -0')
  })

  // A Node that has been forked and not yet worked in. Zeroes would read like
  // a measurement that failed; this reads like the Node it describes.
  it('says so plainly when the Node has not changed anything yet', () => {
    expect(describeDiff({ files: 0, insertions: 0, deletions: 0 })).toBe('no changes')
  })
})
