#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './cli/run.js'

const here = dirname(fileURLToPath(import.meta.url))

const webRoot = [join(here, '..', 'dist-web'), join(here, '..', '..', 'dist-web')].find(
  existsSync,
)

const openBrowser = (url: string): void => {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref()
}

try {
  await run({
    cwd: process.cwd(),
    webRoot,
    open: openBrowser,
    log: (line) => console.log(line),
  })
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
