/**
 * Copies runtime assets out of node_modules into public/, where the page can
 * load them from its own origin — the CSP names no CDN, and a CDN would be a
 * live dependency we do not control. Both are build output and stay out of git
 * (see .gitignore); they are re-copied whenever missing, which costs nothing
 * after the first run.
 *
 *   - MediaPipe's WebAssembly, for hand tracking.
 *   - The face models the biometric gate uses (src/lib/faceAuth.ts): a
 *     detector, the face mesh, the identity descriptor, and the two models
 *     that tell a live face from a photo of one.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'

const FACE_MODELS = ['blazeface', 'facemesh', 'faceres', 'antispoof', 'liveness']

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

  const models = 'node_modules/@vladmandic/human/models'
  if (!existsSync(models)) return
  mkdirSync('public/human-models', { recursive: true })
  for (const name of FACE_MODELS) {
    for (const ext of ['json', 'bin']) {
      const file = `${name}.${ext}`
      if (existsSync(`public/human-models/${file}`)) continue
      try {
        copyFileSync(`${models}/${file}`, `public/human-models/${file}`)
      } catch (err) {
        console.warn(`  could not vendor the ${file} face model: ${err.message}`)
      }
    }
  }
}
