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
  },
})
