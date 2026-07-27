import { readWorld } from '../adapters/git.js'
import { startServer, type RunningServer } from '../server/server.js'

export type RunOptions = {
  cwd: string
  port?: number
  webRoot?: string
  open?: (url: string) => void
  log?: (line: string) => void
}

export const DEFAULT_PORT = 4571

/**
 * Everything `nodegraph` does when you run it, minus the process plumbing.
 * The browser and the console are injected so this is testable as behavior.
 */
export const run = async ({
  cwd,
  port = DEFAULT_PORT,
  webRoot,
  open,
  log,
}: RunOptions): Promise<RunningServer> => {
  // Fail before we listen or open anything: a wrong directory should cost the
  // user nothing but an error message.
  await readWorld(cwd)

  const server = await startServer({ repoPath: cwd, port, webRoot })

  log?.(`nodegraph — watching ${cwd}`)
  log?.(`  ${server.url}`)
  open?.(server.url)

  return server
}
