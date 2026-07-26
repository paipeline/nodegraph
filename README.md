# nodegraph

**Save-scumming for AI coding agents.**

Fork an agent's context *and* its code at any point. Run three approaches in parallel. Keep one, throw the rest away — worktree, branch, and poisoned context gone together.

> **Status: not built yet.** This repo is the design, in the open. The spec lives in [issue #1](https://github.com/paipeline/nodegraph/issues/1). Code starts next. Star it if you want to watch it happen.

---

## The problem

You spend 40 minutes getting an agent to understand your codebase. It reads the right files, you argue about the approach, it finally gets it.

**That understanding is the most expensive thing you own.** It isn't in the code. It isn't in git. It exists only inside that one session.

Then you hit a decision, and you don't dare try anything:

- **Let it start writing** → the context is now colored by that attempt. Ask for a different approach and it argues with its own past self. Both attempts are tangled in one working tree, so you can't compare them anyway.
- **Open a fresh session** → those 40 minutes are gone.

So you try the first approach only, knowing it might not be the best one. And afterwards you don't clean up, because you're no longer sure which branches were experiments and which were real.

In a game you'd save before the boss, die, reload, try a different build.

**Writing code with an agent, there is no save.**

## What it does

A **Node** is a save point. It has two halves:

- **Context** — everything the agent has figured out, copied verbatim
- **Workspace** — its own checkout, isolated from every other node

The loop is three steps:

1. **Fork** any node. The child inherits the full understanding and gets its own ground to stand on.
2. **Let it run.** Fork three times and three agents try three approaches, none of them aware the others exist.
3. **Discard** the losers. Workspace, branch and the polluted context vanish together. Trunk stays clean.

```
              ┌── refactor middleware ──── auth via JWT
 trunk ── understand the codebase ── auth via session cookie
              └── auth via OAuth ─────── (discarded)
```

Left pane: the graph. Right pane: the real terminal of whichever node you clicked.

## Why a graph and not a list

Three save points are a list. Thirty are a map.

An edge does not mean ordering, dependency or task breakdown. **An edge means: this node inherited that node's understanding.** That is the only relationship worth drawing, and it's the one no kanban board can show you.

## How it works

Nothing exotic — the primitives already exist:

| | |
|---|---|
| Fork the context | `claude --resume <id> --fork-session --session-id <new>` |
| Fork the code | `git worktree`, plus carrying over uncommitted changes |
| Fork the environment | APFS copy-on-write in the background. Measured: **830 MB cloned in 22 s, 38 MB of actual disk** |
| Live agent state | `claude agents --json` |
| The pane on the right | a real pty — the actual Claude Code TUI, permission prompts and slash commands included |

Runs locally. `npx nodegraph` inside your repo, opens in a browser. No account, no server, nothing leaves your machine.

## Design decisions

Read these before proposing anything — most obvious ideas were already considered and rejected on purpose:

- [CONTEXT.md](CONTEXT.md) — the vocabulary. Node, Fork, Context, Workspace, Trunk, Discard.
- [ADR-0001](docs/adr/0001-node-is-a-fork.md) — a node is a fork, not a task. Why node-as-worktree, node-as-PR and node-as-subtask were all rejected.
- [ADR-0002](docs/adr/0002-fork-captures-a-moment.md) — a fork captures *this instant*, including uncommitted changes — not a commit.
- [PRD](docs/PRD.md) — 45 user stories, module boundaries, testing plan.

## Deliberately not building

Team collaboration. Containers. Task management. PR workflow. Merging two forks back together. A prettier custom-rendered agent UI.

If a feature doesn't make you braver about trying a second approach, it isn't in v1.

## The numbers behind this

Measured on one working developer machine, not hypotheticals:

- **12** background agents sitting blocked, waiting for a human. The oldest had been waiting **58 days**.
- **189** branches across its repos. **97** of them created by agents that aren't Claude Code (71 codex, 26 vibe-kanban).
- **830 MB** of `node_modules` cloned in **22 s**, costing **38 MB** of real disk.

The first number is why this exists. The third is why it can feel instant.

---

Early days. Design feedback in the issues is worth more than code right now.
