# nodegraph — working agreement

Read [CONTEXT.md](CONTEXT.md) before writing anything. Use its words exactly: **Node, Fork, Context, Workspace, Trunk, Discard**. Never say "task", "lane" or "ticket" for a Node.

Decisions already made — do not relitigate:

- [ADR-0001](docs/adr/0001-node-is-a-fork.md) — a Node is a fork, not a task.
- [ADR-0002](docs/adr/0002-fork-captures-a-moment.md) — a Fork captures *this instant*, including uncommitted changes.
- [ADR-0003](docs/adr/0003-localhost-is-not-a-trust-boundary.md) — localhost is not a trust boundary. Every state-changing endpoint takes this run's key *and* refuses a foreign Origin.
- [ADR-0004](docs/adr/0004-reading-your-files-is-not-a-free-read.md) — a GET that goes and reads the user's own files takes the key too. Reads of nodegraph's own bookkeeping stay open so the page can load.
- [ADR-0005](docs/adr/0005-nodegraph-forks-the-context-itself.md) — nodegraph copies the Context itself, at Fork time. `claude --resume` only ever looks in the directory it is run from, so it cannot do this for us. The price is a coupling to claude's on-disk layout, which must fail loudly.
- [ADR-0006](docs/adr/0006-the-store-is-input-not-memory.md) — the store is a trust boundary with exactly one gate.

## The store is input, not memory

`.nodegraph/graph.json` is written to disk in the user's repository. Anything can edit it, a bad merge can mangle it, and a repository can ship one that is read on the very first poll. So what comes back out of it is **not** what nodegraph put in — it is whatever is on that disk now.

**The invariant, in one sentence: every value entering or leaving `.nodegraph/graph.json` passes through `src/core/store.ts`, which builds what nodegraph writes and rebuilds-and-compares what it reads — and a record that is not one nodegraph would have written is not believed, whole.**

What that means in practice:

- **One way in.** `forkRecord` and `sessionRecord` are the only constructors. They derive every field they can from the Node's name, and they *throw* rather than write a record they would refuse to read back. Never hand-build a record literal.
- **One way out.** `readStore` / `readForks` / `readSessions` return only believed records. Nothing else parses that file.
- **Believed means recomputed.** A field nodegraph derives (`branch`, `workspacePath`) is recomputed from the Node's name and compared. A field it cannot derive (`forkPointSha`, `sessionId`, `intent`) must have the exact shape nodegraph writes — a commit, a uuid, or a line `readIntent` gives back unchanged.
- **Whole, not field-by-field.** One bad field drops the record. Repairing it would invent a Node nodegraph never made.
- **Refusing is not deleting.** An unbelieved record stays on disk untouched. A store that will not parse is **not an empty store**: nodegraph refuses to write, says so on every Node's card, and leaves the file exactly as it found it. Losing a user's Node parentage is worse than refusing to start — git can never say who forked from whom again.

**If you are about to hand a value to a process — argv, a working directory, an environment variable, or a path a tool will interpret — and that value came out of the store or from the user, it must already have passed `src/core/store.ts`. Adding a check at your call site instead is the bug: the next call site will be unguarded again.** Five separate blockers across four tickets had this one root.

Two doors are still worth knowing about, because a shape check alone is not enough for git:

- Every git nodegraph starts goes through `runGit`/`gitSpawn` in `src/adapters/git.ts`, which says `-c core.fsmonitor=` and `GIT_CONFIG_NOSYSTEM=1`: git runs whatever the repository it is pointed at told it to run, and nodegraph is not here to run anybody's commands.
- Every variable handed to git is preceded by `--end-of-options`, and a branch is created with `git branch` before `git worktree add` — never `worktree add -b`, which re-parses the name as `git branch`'s own arguments, so a branch called `-m` renames the repository's main.

## Stack

- TypeScript, ESM only, Node ≥ 20.
- **pnpm** for packages. Never commit a `package-lock.json`.
- **vitest** for tests.
- Persistence is a **single JSON file** under `.nodegraph/` in the repo being viewed. No database, no native modules. `node-pty` is the only native dependency we are willing to take on — do not add a second.

## Layering

```
src/core/     pure functions, zero I/O — the only place logic belongs
src/adapters/ talks to git, the filesystem, the claude CLI
src/server/   HTTP + websocket, thin
src/cli.ts    entry point
web/          React + ReactFlow
```

The rule: **if it can be a pure function in `core/`, it must be.** Adapters gather facts and hand them to `core/` as plain data. That is what makes the interesting parts testable without a repo, a process, or a network.

## Testing

TDD, no exceptions: write the failing test first, watch it fail, then make it pass.

- Test **external behavior only**. Never assert on call order, private state, or the shape of an intermediate value.
- `core/` tests take plain data in and assert on plain data out.
- Adapter tests build a real temporary git repository and assert on real disk state. No mocking of git.
- Anything touching the `claude` CLI is tested by putting a **fake `claude` executable on PATH** and asserting on the arguments it received. Tests never call a real model, never need auth, and must pass offline.
- A test that needs the network or a logged-in account does not belong in `pnpm test`.

## Git

- One branch per issue: `ticket/<issue-number>-<slug>`.
- Merge into `m1` with `--no-ff` so each ticket stays a visible unit.
- Never commit to `main` directly. `main` is Trunk.
- Reference the issue in the commit body.
