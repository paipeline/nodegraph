import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
let elsewhere: string
let forkPoint: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-diff-')))
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'nodegraph-elsewhere-')))
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
  rmSync(elsewhere, { recursive: true, force: true })
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

  // Measuring a Node reads a repository and does nothing else. git decides
  // what is an option by looking at the first character, so a fork point that
  // starts with a dash is an instruction unless it is spelled as one that
  // cannot be: `--output=…` truncates whatever it names.
  it('refuses a fork point that reads as an option, rather than obeying it', async () => {
    const precious = join(repo, 'precious.txt')
    writeFileSync(precious, 'IRREPLACEABLE\n')

    await expect(
      readDiff({ workspacePath: repo, forkPointSha: `--output=${precious}` }),
    ).rejects.toThrow()

    expect(readFileSync(precious, 'utf8')).toBe('IRREPLACEABLE\n')
  })

  it('creates nothing on disk for a fork point that names a file git does not have', async () => {
    const conjured = join(repo, 'conjured.txt')

    await expect(
      readDiff({ workspacePath: repo, forkPointSha: `--output=${conjured}` }),
    ).rejects.toThrow()

    expect(existsSync(conjured)).toBe(false)
  })
})

/**
 * The store is a json file inside the repository being viewed, so what comes
 * out of it is whatever is on disk — a hand-edit, a bad merge, or a graph.json
 * committed to a repository somebody cloned. Its fields become git's argv and
 * git's working directory.
 */
describe('a store that says something nodegraph never wrote', () => {
  const rewriteStore = (forks: unknown[]): void => {
    writeFileSync(join(repo, '.nodegraph', 'graph.json'), `${JSON.stringify({ forks }, null, 2)}\n`)
  }

  const storedForks = (): Record<string, unknown>[] =>
    (
      JSON.parse(readFileSync(join(repo, '.nodegraph', 'graph.json'), 'utf8')) as {
        forks: Record<string, unknown>[]
      }
    ).forks

  /** Somebody else's repository, sitting where the user's repository can name it. */
  const anotherRepository = (at: string): string => {
    mkdirSync(at, { recursive: true })
    git(at, 'init', '-b', 'main', '-q')
    git(at, 'config', 'user.email', 'test@example.com')
    git(at, 'config', 'user.name', 'Test')
    writeFileSync(join(at, 'vendored.txt'), 'x\n')
    git(at, 'add', '.')
    git(at, 'commit', '-qm', 'vendored')
    return git(at, 'rev-parse', 'HEAD')
  }

  /**
   * A record wearing the name of a Node the graph really draws, so a filter that
   * asks only "is this Node on the graph?" waves it through.
   */
  const borrowing = (id: string, workspacePath: string, forkPointSha: string) => ({
    id,
    parentId: TRUNK_ID,
    branch: `nodegraph/${id}`,
    workspacePath,
    forkPointSha,
    createdAt: '2026-07-27T09:00:00.000Z',
  })

  it('cannot make measuring a Node write over a file in the repository', async () => {
    // A real Fork, so git really has the Workspace and the graph really draws it.
    await fork({ repoPath: repo, parentId: TRUNK_ID })
    const precious = join(repo, 'precious.txt')
    writeFileSync(precious, 'IRREPLACEABLE\n')

    rewriteStore(storedForks().map((each) => ({ ...each, forkPointSha: `--output=${precious}` })))
    const measured = await readDiffs(repo)

    expect(readFileSync(precious, 'utf8')).toBe('IRREPLACEABLE\n')
    expect(measured).toEqual([])
  })

  // One record nobody should believe costs that Node its numbers, and nobody
  // else's — the same as a Workspace somebody deleted by hand.
  it('still measures the Nodes it does believe', async () => {
    const doubted = await fork({ repoPath: repo, parentId: TRUNK_ID })
    const believed = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(believed.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    rewriteStore(
      storedForks().map((each) =>
        each.id === doubted.id ? { ...each, forkPointSha: '--exit-code' } : each,
      ),
    )

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: believed.id, files: 1, insertions: 1, deletions: 0 },
    ])
  })

  // A Workspace is where git is *run*, which is a bigger thing to be handed than
  // an argument: everything git decides from then on — which repository it is
  // in, which config it obeys — it decides from there. So the directory has to
  // be one git itself listed as a Workspace of this repository, never a string
  // the store happened to carry. Borrowing the name of a Node that is drawn is
  // the way past a filter that asks about the name and then uses the string.
  it('measures the Workspace git has, never a directory the store points at', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    const vendored = join(elsewhere, 'vendor', 'somedep')
    const head = anotherRepository(vendored)
    writeFileSync(join(vendored, 'notes.txt'), 'a\nb\nc\nd\ne\n')

    rewriteStore([
      ...storedForks(),
      borrowing(TRUNK_ID, vendored, head),
      borrowing(child.id, vendored, head),
    ])

    // Only the real Node, and only its own numbers: nothing of the other
    // repository's five untracked lines reaches the graph.
    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: child.id, files: 1, insertions: 1, deletions: 0 },
    ])
  })

  /**
   * `core.fsmonitor` names a command git runs, and git takes it from the config
   * of whatever repository it finds where it was started. So a Workspace path
   * out of the store is not a leak of numbers — it is a command, run by the one
   * route the page polls every two seconds.
   */
  it('never runs the command the config of a directory the store points at names', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })

    const vendored = join(elsewhere, 'vendor', 'somedep')
    const head = anotherRepository(vendored)
    const ran = join(elsewhere, 'it-ran')
    const payload = join(elsewhere, 'payload.sh')
    writeFileSync(payload, `#!/bin/sh\nprintf 'ran\\n' >> "${ran}"\n`)
    chmodSync(payload, 0o755)
    git(vendored, 'config', 'core.fsmonitor', payload)

    rewriteStore([
      ...storedForks(),
      borrowing(TRUNK_ID, vendored, head),
      borrowing(child.id, vendored, head),
    ])

    await readDiffs(repo)

    expect(existsSync(ran)).toBe(false)
  })

  /**
   * The store's rule and git's list are two doors, and this is the one only git
   * can shut. `.nodegraph/` is where nodegraph puts Workspaces, so a record
   * naming a directory in there is a record it could have written — but a
   * directory being *there* is not the same as git having a Workspace there.
   * A repository shipped as a tarball rather than cloned brings whatever
   * `.nodegraph/workspaces/<name>/` its author put in it, `.git` and all.
   */
  it('measures no Node in a directory git never listed, even where its own Workspaces live', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    // Exactly where nodegraph would have put a Workspace for this name, and
    // spelled exactly as nodegraph spells one — but git has never heard of it.
    const planted = join(repo, '.nodegraph', 'workspaces', 'deadbeef')
    const head = anotherRepository(planted)
    writeFileSync(join(planted, 'notes.txt'), 'a\nb\nc\nd\ne\n')
    const ran = join(elsewhere, 'it-ran')
    const payload = join(elsewhere, 'payload.sh')
    writeFileSync(payload, `#!/bin/sh\nprintf 'ran\\n' >> "${ran}"\n`)
    chmodSync(payload, 0o755)
    git(planted, 'config', 'core.fsmonitor', payload)

    rewriteStore([
      ...storedForks(),
      {
        id: 'deadbeef',
        parentId: TRUNK_ID,
        branch: 'nodegraph/deadbeef',
        workspacePath: planted,
        forkPointSha: head,
        createdAt: '2026-07-27T09:00:00.000Z',
      },
    ])

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: child.id, files: 1, insertions: 1, deletions: 0 },
    ])
    expect(existsSync(ran)).toBe(false)
  })

  /**
   * The same knob, in the one repository nodegraph is entitled to run git in.
   * The user chose to open this repository, so its config is theirs — but a
   * command run on a two-second poll, by a background process the user is not
   * watching, is not what they chose. Every git nodegraph runs says so.
   */
  it('runs no command the repository it was pointed at names for git either', async () => {
    const child = await fork({ repoPath: repo, parentId: TRUNK_ID })
    writeFileSync(join(child.workspacePath, 'a.txt'), 'one\ntwo\nthree\nfour\n')

    const ran = join(elsewhere, 'it-ran')
    const payload = join(elsewhere, 'payload.sh')
    writeFileSync(payload, `#!/bin/sh\nprintf 'ran\\n' >> "${ran}"\n`)
    chmodSync(payload, 0o755)
    git(repo, 'config', 'core.fsmonitor', payload)

    await expect(readDiffs(repo)).resolves.toEqual([
      { nodeId: child.id, files: 1, insertions: 1, deletions: 0 },
    ])
    expect(existsSync(ran)).toBe(false)
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
