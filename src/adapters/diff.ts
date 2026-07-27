import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addedWhole,
  changedUnmeasured,
  parseNumstat,
  summarize,
  type FileChange,
  type DiffSummary,
} from '../core/diff.js'
import { reconcile } from '../core/reconcile.js'
import { readWorld, runGit } from './git.js'
import { readForks } from './store.js'

/**
 * Measures a Node against the commit it was cut from.
 *
 * The baseline is always the fork point SHA written down when the Fork
 * happened, never a merge-base worked out now — see ADR-0002. That is what
 * lets you put two Nodes side by side and trust the comparison: the parent
 * committing something new must not move either number.
 */

/**
 * How much untracked content one Node's diff will read to count lines in.
 * Generous for source, and a hard stop for the dataset somebody forgot to
 * ignore — a Node card is not worth a gigabyte of reading every two seconds.
 */
const MEASURE_BUDGET = 4 * 1024 * 1024

export type DiffRequest = {
  /**
   * The Workspace to measure — a directory git has itself just named as a
   * worktree of this repository, never a string that came out of the store.
   * See `readDiffs` below, and `core/store` for why the difference matters.
   */
  workspacePath: string
  forkPointSha: string
}

/**
 * Files git has never been told about are not in any diff, so they are
 * gathered separately and measured as additions. `--exclude-standard` keeps
 * ignored files out, which is also what keeps nodegraph's own `.nodegraph/`
 * — Workspaces and all — from being counted as somebody's work.
 */
const readAdded = async (workspacePath: string): Promise<FileChange[]> => {
  const listing = await runGit(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z'])
  const paths = listing.split('\0').filter((path) => path !== '')

  const added: FileChange[] = []
  let budget = MEASURE_BUDGET

  for (const path of paths) {
    const full = join(workspacePath, path)

    try {
      // Counting lines means reading the file, and this runs on every poll of
      // every Node. Past the budget the file still counts — its lines do not.
      const size = (await stat(full)).size
      if (size > budget) {
        added.push(changedUnmeasured(path))
        continue
      }

      budget -= size
      added.push(addedWhole(path, await readFile(full)))
    } catch {
      // An agent is writing in here while we read. A file we may not read, or
      // one that was gone by the time we reached it, is a file we cannot
      // count — and not a reason to have no numbers for this Node at all.
      added.push(changedUnmeasured(path))
    }
  }

  return added
}

export type NodeDiff = DiffSummary & { nodeId: string }

export const readDiff = async ({
  workspacePath,
  forkPointSha,
}: DiffRequest): Promise<DiffSummary> => {
  // Two dots, not three: the fork point against the working tree exactly as it
  // stands, so committed and uncommitted work count the same.
  //
  // `--end-of-options` is what keeps this a read. The fork point comes off
  // disk, and git reads a leading dash as an option wherever it appears — a
  // fork point of `--output=…` would make `git diff` truncate that file and
  // report nothing wrong. The separator says: whatever follows is a commit,
  // even if it is spelled like an instruction. `--` closes the same door on
  // the paths side.
  //
  // `--no-ext-diff` and `--no-textconv` are the diff-shaped half of what
  // `runGit` says globally: `diff.external` and a textconv filter are both
  // commands the repository can ask git to run, and counting lines is not a
  // thing that needs anybody's program run to do it.
  const numstat = await runGit(workspacePath, [
    'diff',
    '--numstat',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--end-of-options',
    forkPointSha,
    '--',
  ])

  return summarize([...parseNumstat(numstat), ...(await readAdded(workspacePath))])
}

/**
 * Every Node the graph is showing that has a fork point, measured against it.
 *
 * The baseline comes out of the store, where it was written at the instant the
 * Fork happened. The Trunk was never forked from anything, so it has no fork
 * point and no diff — it is the thing the others are compared against.
 *
 * The *directory* does not come out of the store. It comes off the Nodes the
 * graph is actually showing, which `reconcile` builds from git's own list of
 * this repository's worktrees — so the only place git is ever started is a
 * Workspace of the repository the user opened. A filter that asked instead
 * "is this record's Node on the graph?" and then used the record's own path
 * would be no filter at all: a record only has to wear a drawn Node's name to
 * be waved through, and `trunk` is a name every graph has.
 */
export const readDiffs = async (repoPath: string): Promise<NodeDiff[]> => {
  const forks = await readForks(repoPath)
  const forkPoints = new Map(forks.map((fork) => [fork.id, fork.forkPointSha]))

  const measured = await Promise.all(
    reconcile(await readWorld(repoPath), forks).map(async (node): Promise<NodeDiff | null> => {
      const forkPointSha = forkPoints.get(node.id)
      if (forkPointSha === undefined) return null

      try {
        return {
          nodeId: node.id,
          ...(await readDiff({ workspacePath: node.workspacePath, forkPointSha })),
        }
      } catch {
        // A Workspace deleted from a terminal, a fork point that has been
        // gc'd away: one Node nobody can measure is one Node with no
        // numbers, not a graph where every Node loses its numbers.
        return null
      }
    }),
  )

  return measured.filter((diff): diff is NodeDiff => diff !== null)
}
