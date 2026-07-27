import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Worktrees live inside the repository — nodegraph's own Workspaces under
    // .nodegraph/, and Claude Code's under .claude/worktrees/. Each one is a
    // full checkout, so without this the suite runs itself once per Workspace
    // against whatever code that Workspace happens to hold.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-web/**',
      '**/.nodegraph/**',
      '**/.claude/worktrees/**',
    ],

    // These tests do real work — `git worktree add` against a real repository,
    // a real pty running a real executable — and they all run at once. The 5s
    // default is comfortable for one file and marginal for thirteen, which
    // shows up as a test that passes alone and times out in the suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
