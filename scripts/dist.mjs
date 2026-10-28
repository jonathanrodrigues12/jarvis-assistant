/**
 * Builds the Windows installer: `npm run dist`.
 *
 *   1. vendors the hand-tracking WebAssembly into public/, so the build has
 *      it (the dev server copies it on start; a build has no such step);
 *   2. builds the face into dist/;
 *   3. packages everything with electron-builder into release/ — and with
 *      `--publish`, uploads it as a GitHub release the installed apps update
 *      from (the release workflow does this; see .github/workflows);
 *   4. copies this machine's .env.local and preferencias.md into
 *      %APPDATA%\JARVIS, where the installed app reads them.
 *
 * Step 4 is why the installer itself carries no keys. The ElevenLabs and Tuya
 * secrets stay on the machine they were typed into; installing elsewhere means
 * putting a .env.local in that machine's %APPDATA%\JARVIS by hand.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import { vendorAssets } from './vendor.mjs'

function step(label, command, args) {
  console.log(`\n▸ ${label}`)
  const r = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`\n✗ ${label} failed (${r.status ?? r.signal}).`)
    process.exit(r.status ?? 1)
  }
}

const publish = process.argv.includes('--publish') ? 'always' : 'never'

vendorAssets()
step('building the interface', 'npm', ['run', 'build'])
step('packaging the app', 'npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', publish])

const appData = process.env.APPDATA
if (appData) {
  const target = join(appData, 'JARVIS')
  mkdirSync(target, { recursive: true })
  for (const file of ['.env.local', 'preferencias.md']) {
    if (!existsSync(file)) continue
    // Never over an existing copy: once installed, the one in %APPDATA% is the
    // one the user edits, and a rebuild must not quietly undo that.
    if (existsSync(join(target, file))) {
      console.log(`  kept the existing ${file} in ${target}`)
      continue
    }
    copyFileSync(file, join(target, file))
    console.log(`  copied ${file} to ${target}`)
  }
}

console.log('\n✓ Installer written to release/. Run the JARVIS Setup .exe in there to install.\n')
