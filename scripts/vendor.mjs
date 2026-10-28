/**
 * Copies runtime assets out of node_modules into public/, where the page can
 * load them from its own origin — the CSP names no CDN, and a CDN would be a
 * live dependency we do not control. It is build output and stays out of git
 * (see .gitignore); it is re-copied whenever missing, which costs nothing
 * after the first run.
 *
 *   - MediaPipe's WebAssembly, for hand tracking.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'

export function vendorAssets() {
  const wasm = 'node_modules/@mediapipe/tasks-vision/wasm'
  if (existsSync(wasm) && !existsSync('public/mediapipe/vision_wasm_internal.wasm')) {
    try {
      mkdirSync('public/mediapipe', { recursive: true })
      cpSync(wasm, 'public/mediapipe', { recursive: true })
      console.log('  vendored the hand-tracking runtime into public/mediapipe.')
    } catch (err) {
      console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
    }
  }
}
