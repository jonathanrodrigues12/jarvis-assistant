import { Human, type Config } from '@vladmandic/human'
import { openCameraMax } from './camera'

/**
 * Face recognition for the biometric gate (src/ui/AuthGate.tsx).
 *
 * Everything runs in the page: the models are served from public/human-models
 * (scripts/vendor.mjs puts them there) and nothing about the face leaves the
 * machine. What is kept is not a picture but a few face descriptors — vectors
 * of 1024 numbers from the `faceres` model — in localStorage.
 *
 * Two extra models answer "is this a live face at all": `antispoof` scores how
 * much the image looks like a real face rather than a screen or a print, and
 * `liveness` how much it moves like one. Both are required before a match
 * counts. That raises the bar above holding up a phone, but a webcam is not a
 * security device: this is a lock on the front of the interface, not on the
 * machine behind it.
 */

const STORE_KEY = 'jarvis.face.v1'
const MODELS = '/human-models/'
const FILES = ['blazeface', 'facemesh', 'faceres', 'antispoof', 'liveness'].flatMap((m) => [
  `${m}.json`,
  `${m}.bin`,
])

/** How alike two descriptors must be to be the same person, 0..1. */
const MATCH = Number(import.meta.env.VITE_FACE_MATCH) || 0.55
/** How sure the anti-spoof and liveness models must be, 0..1. */
const ALIVE = 0.5

const config: Partial<Config> = {
  modelBasePath: MODELS,
  backend: 'webgl',
  debug: false,
  // Every frame is a fresh look; skipping "unchanged" frames would let a
  // still photo coast through on an earlier, live result.
  cacheSensitivity: 0,
  // The camera opens at its full resolution for the picture on screen; the
  // models get a 1280-wide copy. A 4K frame would only make every look slower,
  // and the face detector works on a 256-pixel crop either way.
  filter: { enabled: true, width: 1280 },
  face: {
    enabled: true,
    detector: { rotation: false, maxDetected: 1, minConfidence: 0.6 },
    mesh: { enabled: true },
    iris: { enabled: false },
    attention: { enabled: false },
    description: { enabled: true },
    emotion: { enabled: false },
    antispoof: { enabled: true },
    liveness: { enabled: true },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
} as Partial<Config>

let human: Human | null = null

export type Progress = (fraction: number, label: string) => void

/**
 * Downloads the models with a byte count, so the bar reports what is actually
 * happening. The browser keeps them, and Human's own load right after is
 * served from that cache.
 */
async function fetchModels(progress: Progress) {
  const sizes = await Promise.all(
    FILES.map(async (f) => {
      try {
        const head = await fetch(MODELS + f, { method: 'HEAD' })
        return Number(head.headers.get('content-length')) || 0
      } catch {
        return 0
      }
    }),
  )
  const total = sizes.reduce((a, b) => a + b, 0) || FILES.length
  let done = 0
  for (const [i, f] of FILES.entries()) {
    const res = await fetch(MODELS + f)
    if (!res.ok || !res.body) throw new Error(`modelo ${f} indisponível (${res.status})`)
    const reader = res.body.getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      done += sizes[i] ? value.length : 0
      progress(done / total, `BAIXANDO MODELO ${f.split('.')[0].toUpperCase()}`)
    }
    if (!sizes[i]) done += 1
  }
}

/**
 * Brings everything up, reporting real progress:
 * downloads 0–0.6, model load 0.6–0.75, GPU warm-up 0.75–0.85, camera 0.85–1.
 */
export async function prepare(video: HTMLVideoElement, progress: Progress) {
  await fetchModels((f, label) => progress(f * 0.6, label))

  progress(0.6, 'CARREGANDO REDES NEURAIS')
  human ??= new Human(config)
  await human.load()

  progress(0.75, 'COMPILANDO NA GPU')
  await human.warmup()

  progress(0.85, 'ATIVANDO CÂMERA')
  const stream = await openCameraMax()
  video.srcObject = stream
  await video.play()
  progress(1, 'SISTEMAS PRONTOS')
}

export function stopCamera(video: HTMLVideoElement) {
  const stream = video.srcObject as MediaStream | null
  stream?.getTracks().forEach((t) => t.stop())
  video.srcObject = null
}

export type Look = {
  /** The face descriptor, or null when no single clear face was seen. */
  embedding: number[] | null
  /** min(antispoof, liveness) — how sure the models are this is a live face. */
  alive: number
}

/** One frame through the models. */
export async function look(video: HTMLVideoElement): Promise<Look> {
  if (!human) throw new Error('modelos não carregados')
  const result = await human.detect(video)
  const face = result.face[0]
  if (!face?.embedding?.length) return { embedding: null, alive: 0 }
  return {
    embedding: Array.from(face.embedding),
    alive: Math.min(face.real ?? 0, face.live ?? 0),
  }
}

export const isAlive = (l: Look) => l.alive >= ALIVE

// ---------------------------------------------------------------------------
// The enrolled face
// ---------------------------------------------------------------------------

type Enrolled = { descriptors: number[][]; at: string }

function stored(): Enrolled | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const data = raw ? (JSON.parse(raw) as Enrolled) : null
    return data?.descriptors?.length ? data : null
  } catch {
    return null
  }
}

export const isEnrolled = () => stored() !== null

export function enroll(descriptors: number[][]) {
  localStorage.setItem(STORE_KEY, JSON.stringify({ descriptors, at: new Date().toISOString() }))
}

export function forget() {
  localStorage.removeItem(STORE_KEY)
}

/** Best similarity of this face to any enrolled descriptor, 0..1. */
export function similarity(embedding: number[]): number {
  const data = stored()
  if (!data || !human) return 0
  return Math.max(...data.descriptors.map((d) => human!.match.similarity(embedding, d)))
}

export const isMatch = (score: number) => score >= MATCH
