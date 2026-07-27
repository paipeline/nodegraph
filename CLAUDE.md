# nodegraph — working agreement

Read [CONTEXT.md](CONTEXT.md) before writing anything. Use its words exactly: **Node, Fork, Context, Workspace, Trunk, Discard**. Never say "task", "lane" or "ticket" for a Node.

Decisions already made — do not relitigate:

- [ADR-0001](docs/adr/0001-node-is-a-fork.md) — a Node is a fork, not a task.
- [ADR-0002](docs/adr/0002-fork-captures-a-moment.md) — a Fork captures *this instant*, including uncommitted changes.
- [ADR-0003](docs/adr/0003-localhost-is-not-a-trust-boundary.md) — localhost is not a trust boundary. Every state-changing endpoint takes this run's key *and* refuses a foreign Origin.
- [ADR-0004](docs/adr/0004-nodegraph-forks-the-context-itself.md) — nodegraph copies the Context itself, at Fork time. `claude --resume` only ever looks in the directory it is run from, so it cannot do this for us. The price is a coupling to claude's on-disk layout, which must fail loudly.

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
