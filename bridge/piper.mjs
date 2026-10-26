/**
 * Piper — local neural speech, served by the bridge.
 *
 * Kokoro runs in the browser and measured over twice slower than realtime here;
 * ElevenLabs sounds best but needs a key and a round trip. Piper sits between
 * them: a small VITS model in native ONNX Runtime, on the CPU, with proper
 * Brazilian Portuguese voices. A sentence comes back in a fraction of its own
 * spoken length, and nothing leaves the machine.
 *
 * Install layout (gitignored, see piper/ at the repo root):
 *   piper/piper/piper.exe            — the release binary and its DLLs
 *   piper/voices/<voice>.onnx(.json) — one or more voice models
 *
 * The process is started once and kept alive. Loading a model costs over a
 * second, which would land on every sentence if piper were spawned per request.
 * In --json-input mode it reads one JSON object per line, writes the WAV to the
 * `output_file` it names, and prints that path when done — in order, so a FIFO
 * of pending requests is enough to match replies to callers.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = process.env.JARVIS_PIPER_DIR ?? join(ROOT, 'piper')
const EXE = join(DIR, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper')

/** pt_BR-faber-medium is the Brazilian male voice; others drop into voices/. */
export const PIPER_VOICE = process.env.JARVIS_PIPER_VOICE ?? 'pt_BR-faber-medium'
const MODEL = join(DIR, 'voices', `${PIPER_VOICE}.onnx`)

/**
 * Above 1 is slower. The character is never hurried — the same reasoning as
 * the 0.92 rate on the system voice.
 */
const LENGTH_SCALE = process.env.JARVIS_PIPER_LENGTH_SCALE ?? '1.08'

const OUT_DIR = join(tmpdir(), 'jarvis-piper')

/** A sentence that has not come back in this long is not going to. */
const TIMEOUT_MS = 15000

export function piperAvailable() {
  return existsSync(EXE) && existsSync(MODEL)
}

let proc = null
/** @type {Array<{ resolve: () => void, reject: (e: Error) => void }>} */
let pending = []
let seq = 0

function failAll(err) {
  const waiting = pending
  pending = []
  for (const p of waiting) p.reject(err)
}

function start() {
  if (proc) return proc
  const child = spawn(
    EXE,
    ['-m', MODEL, '--json-input', '--length_scale', LENGTH_SCALE, '-q'],
    { cwd: dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    pending.shift()?.resolve()
  })
  child.stderr.on('data', (d) => {
    const msg = String(d).trim()
    if (msg) console.warn('[piper]', msg)
  })
  // A dead process is restarted by the next request rather than here, so a
  // model that crashes on load does not spin in a respawn loop.
  const gone = (why) => {
    if (proc === child) proc = null
    failAll(new Error(`piper exited (${why})`))
  }
  child.on('error', (err) => gone(err.message))
  child.on('exit', (code) => gone(`code ${code}`))
  proc = child
  return child
}

/**
 * Non-ASCII as \u escapes. piper.exe reads stdin through the C runtime, and
 * keeping the line pure ASCII sidesteps any question of the console codepage
 * mangling "não" on its way in.
 */
function asciiJson(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Synthesise one line of text. Resolves to a WAV buffer. */
export async function piperSpeak(text) {
  await mkdir(OUT_DIR, { recursive: true })
  const file = join(OUT_DIR, `${process.pid}-${++seq}.wav`)
  // Piper splits on newlines itself, which would produce two files' worth of
  // replies for one request and desynchronise the queue.
  const line = asciiJson({ text: String(text).replace(/\s+/g, ' ').trim(), output_file: file })

  const child = start()
  try {
    await new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => {
        // Its reply would now be matched to the wrong caller, so the only safe
        // recovery is a fresh process.
        child.kill()
        reject(new Error('piper timed out'))
      }, TIMEOUT_MS)
      pending.push({
        resolve: () => {
          clearTimeout(timer)
          resolveDone()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      child.stdin.write(line + '\n')
    })
    return await readFile(file)
  } finally {
    unlink(file).catch(() => {})
  }
}

/** Load the model during bridge start-up so the first sentence is not the slow one. */
export function warmPiper() {
  if (!piperAvailable()) return
  piperSpeak('ok').catch((err) => console.warn('[piper] warm-up failed:', err.message))
}
