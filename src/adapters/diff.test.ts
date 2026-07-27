import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRUNK_ID } from '../core/reconcile.js'
import { readDiff, readDiffs } from './diff.js'
import { fork } from './fork.js'

/**
 * What a Node changed, measured against the commit it was cut from.
 *
 * Every test here runs against a real temporary repository: the numbers on a
 * Node card are only worth anything if they agree with what git would say.
 */

let repo: string
let forkPoint: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-diff-')))
  git(repo, 'init', '-b', 'main', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  forkPoint = git(repo, 'rev-parse', 'HEAD')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('the diff of a Node against its fork point', () => {
  it('counts what the Workspace has committed since the fork point', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    writeFileSync(join(repo, 'b.txt'), 'brand\nnew\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'work')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 2,
      insertions: 3,
      deletions: 0,
    })
  })

  it('counts changes the Workspace has not committed, staged or not', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'staged.txt'), 'waiting\nin the index\n')
    git(repo, 'add', 'staged.txt')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 2,
      insertions: 2,
      deletions: 1,
    })
  })

  // The whole point of a Node is an agent working in it, and an agent writes
  // files far more often than it commits them. A file git has never been told
  // about is still work this Node did.
  it('counts files the Workspace has added but never told git about', async () => {
    writeFileSync(join(repo, 'fresh.txt'), 'a\nb\nc\n')
    mkdirSync(join(repo, 'deep'), { recursive: true })
    writeFileSync(join(repo, 'deep', 'nested.txt'), 'no trailing newline')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 2,
      insertions: 4,
      deletions: 0,
    })
  })

  it('leaves ignored files out, the way every other git tool does', async () => {
    writeFileSync(join(repo, '.gitignore'), 'noise.log\n')
    writeFileSync(join(repo, 'noise.log'), 'chatter\nchatter\n')

    // The .gitignore itself is a new file, and the only one that counts.
    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 1,
      insertions: 1,
      deletions: 0,
    })
  })

  // Counted the way `git diff --shortstat` counts it: a binary file is one
  // changed file and no lines at all, because it has none.
  it('counts a binary file as a changed file, without inventing lines for it', async () => {
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]))
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'a picture')
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x03, 0x04, 0x00, 0x05]))
    writeFileSync(join(repo, 'untracked.bin'), Buffer.from([0x00, 0x01, 0x0a, 0x00]))

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 2,
      insertions: 0,
      deletions: 0,
    })
  })

  it('counts a deleted file, whether git was told or not', async () => {
    writeFileSync(join(repo, 'staged-doom.txt'), 'x\n')
    writeFileSync(join(repo, 'quiet-doom.txt'), 'y\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'doomed')
    git(repo, 'rm', '-q', 'staged-doom.txt')
    rmSync(join(repo, 'quiet-doom.txt'))

    // Both files arrived and left again since the fork point, so against the
    // fork point the only change left is the one that stayed: a.txt is untouched.
    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  // `git rm --cached` leaves a file that git reports twice: deleted from the
  // index, and sitting there untracked. It is one file however it is spelled.
  it('counts a file dropped from the index but left on disk only once', async () => {
    git(repo, 'rm', '-q', '--cached', 'a.txt')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 1,
      insertions: 0,
      deletions: 3,
    })
  })

  // An agent is writing in this Workspace while we measure it. A file we
  // cannot read is one file we cannot count lines in, not a Node that loses
  // every number it had. Running as root would defeat the unreadable file.
  it.skipIf(process.getuid?.() === 0)(
    'counts a file it is not allowed to read, without giving up on the rest',
    async () => {
      writeFileSync(join(repo, 'secret.txt'), 'you cannot have this\n')
      chmodSync(join(repo, 'secret.txt'), 0o000)
      writeFileSync(join(repo, 'ordinary.txt'), 'a\nb\n')

      await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
        files: 2,
        insertions: 2,
        deletions: 0,
      })
    },
  )

  // This runs on every poll, in a Workspace an agent is writing to. A file it
  // would cost real memory to read is still one changed file — it just does
  // not get its lines counted, exactly as a binary one does not.
  it('counts a file too big to measure without reading the whole of it', async () => {
    const huge = Buffer.alloc(9 * 1024 * 1024, 'x\n')
    writeFileSync(join(repo, 'huge.txt'), huge)
    writeFileSync(join(repo, 'small.txt'), 'a\nb\n')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 2,
      insertions: 2,
      deletions: 0,
    })
  })

  it('counts a rename once, where the file ended up', async () => {
    git(repo, 'mv', 'a.txt', 'renamed.txt')

    await expect(readDiff({ workspacePath: repo, forkPointSha: forkPoint })).resolves.toEqual({
      files: 1,
      insertions: 0,
      deletions: 0,
    })
  })
})

describe('the diffs of the Nodes in a repository', () => {
  it('measures a forked Node against the fork point written down when it was forked', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: child.id, files: 1, insertions: 2, deletions: 0 },
    ])
  })

  // The Trunk is what the others are measured against; it has no fork point of
  // its own, and a number made up for it would be a number that means nothing.
  it('says nothing about the Trunk, which was never forked from anything', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')

    await expect(readDiffs(repo)).resolves.toEqual([])
  })

  // Workspaces get deleted from a terminal, by hand, all the time. One Node
  // nobody can measure any more must cost the graph that one Node's numbers
  // and nobody else's.
  it('still measures the other Nodes when one Workspace has been deleted by hand', async () => {
    const doomed = await fork({ repoPath: repo, parentId: TRUNK_ID })
    const survivor = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(survivor.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    rmSync(doomed.workspacePath, { recursive: true, force: true })

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: survivor.id, files: 1, insertions: 1, deletions: 0 },
    ])
  })

  // Putting three Nodes side by side is only worth doing if the numbers hold
  // still. The parent going on with its life must not move a child's diff.
  it('does not move when the parent Node commits more work of its own', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    writeFileSync(join(child.workspacePath, 'child-only.txt'), 'mine\n')
    const before = await readDiffs(repo)

    writeFileSync(join(repo, 'a.txt'), 'wholly\nrewritten\nby\nthe\nparent\n')
    writeFileSync(join(repo, 'parent-only.txt'), 'theirs\nand\ntheirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'the parent moves on')

    expect(before).toEqual([{ nodeId: child.id, files: 2, insertions: 2, deletions: 0 }])
    await expect(readDiffs(repo)).resolves.toEqual(before)
  })

  // The baseline is the fork point that was written down, not a merge-base
  // worked out now: once a Node takes the parent's newer work in, a merge-base
  // would slide forward and quietly stop counting the very lines it just took.
  it('stays anchored at the fork point even after the Node takes the parent’s newer work in', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'child-only.txt'), 'mine\nalone\n')
    git(child.workspacePath, 'add', '.')
    git(child.workspacePath, 'commit', '-qm', 'the child works')

    writeFileSync(join(repo, 'parent-only.txt'), 'one\ntwo\nthree\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'the parent works')
    git(child.workspacePath, 'merge', '-q', '--no-edit', 'main')

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: child.id, files: 2, insertions: 5, deletions: 0 },
    ])
  })
})
