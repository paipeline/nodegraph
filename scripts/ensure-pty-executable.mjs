/**
 * node-pty ships a prebuilt `spawn-helper` binary and execs it to hand the
 * child its pty. pnpm's content-addressable store restores that file without
 * its executable bit, so every spawn dies with "posix_spawnp failed" until it
 * is put back. Repair it here so a fresh `pnpm install` leaves a working pty.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')

if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
