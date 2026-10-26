/**
 * Starts the desktop app: `npm run app` (or `npm run app:writes`).
 *
 * Not `electron .` directly, because of one variable. Terminals inside VS Code
 * — itself an Electron app — inherit ELECTRON_RUN_AS_NODE=1, and with it set
 * the Electron binary behaves as plain Node: `require('electron').app` is
 * undefined and the window never opens. It is removed here before launching.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron') // the path to the binary, from Node's side

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill())
