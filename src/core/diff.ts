/**
 * What a Node changed, as numbers.
 *
 * Reading a repository is the adapter's job; deciding what the reading *means*
 * is this file's, so the arithmetic can be tested without a repository at all.
 * See CLAUDE.md.
 */

export type FileChange = {
  path: string
  /** null for a file whose change is not counted in lines — a binary one, say. */
  insertions: number | null
  deletions: number | null
}

export type DiffSummary = {
  files: number
  insertions: number
  deletions: number
}

/**
 * Parses `git diff --numstat -z`.
 *
 * One record per file: counts, then the path. A rename leaves the path empty
 * and follows it with the old name and the new one, so the record is three
 * pieces long instead of one.
 */
export const parseNumstat = (output: string): FileChange[] => {
  const records = output.split('\0')
  const changes: FileChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record === '') continue

    // Split on the first two tabs only — a path is allowed to contain one.
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue

    const insertions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)

    if (path === '') {
      // A rename or a copy: the path is empty and the old and new names
      // follow as records of their own. Count the file where it ended up.
      path = records[index + 2] ?? ''
      index += 2
      if (path === '') continue
    }

    changes.push({
      path,
      // git writes a dash for a file it will not count in lines.
      insertions: insertions === '-' ? null : Number(insertions),
      deletions: deletions === '-' ? null : Number(deletions),
    })
  }

  return changes
}

/**
 * What a Node card says about what this Node changed. Short enough to sit on a
 * card at a glance, which is the whole job: knowing which of three Nodes is
 * worth opening without opening any of them.
 */
export const describeDiff = ({ files, insertions, deletions }: DiffSummary): string =>
  files === 0
    ? 'no changes'
    : `${files} ${files === 1 ? 'file' : 'files'} +${insertions} -${deletions}`

/**
 * A file that changed by an amount nobody counted — binary, or too big to be
 * worth reading. It is still a changed file; it just has no lines to show.
 */
export const changedUnmeasured = (path: string): FileChange => ({
  path,
  insertions: null,
  deletions: null,
})

/** How much of a file git reads before deciding it is binary. */
const BINARY_SNIFF = 8000

/**
 * What a file git has never seen contributes: the whole of it, added.
 *
 * Counted git's way, checked against git's own numstat: a NUL byte near the
 * start means binary and so means no line count at all, a file with no final
 * newline still ends in a line, and an empty file adds nothing.
 */
export const addedWhole = (path: string, content: Uint8Array): FileChange => {
  if (content.subarray(0, BINARY_SNIFF).includes(0)) return changedUnmeasured(path)

  let lines = 0
  for (const byte of content) if (byte === 0x0a) lines += 1
  if (content.length > 0 && content[content.length - 1] !== 0x0a) lines += 1

  return { path, insertions: lines, deletions: 0 }
}

/**
 * Adds the changes up the way `git diff --shortstat` does: a file whose change
 * is not counted in lines is still counted as a changed file.
 *
 * A path may be reported twice — a file dropped from the index is both a
 * deletion and an untracked file — and it is one changed file either way.
 */
export const summarize = (changes: FileChange[]): DiffSummary => {
  const seen = new Set<string>()
  const summary = { files: 0, insertions: 0, deletions: 0 }

  for (const change of changes) {
    // The first word on a path wins, and git's own diff comes first.
    if (seen.has(change.path)) continue
    seen.add(change.path)

    summary.files += 1
    summary.insertions += change.insertions ?? 0
    summary.deletions += change.deletions ?? 0
  }

  return summary
}
