import { useEffect, useRef, useState } from 'react'
import * as sfx from '../lib/sfx'
import * as music from '../lib/music'
import * as face from '../lib/faceAuth'
import { USER_NAME, USER_TITLE } from '../config'

/**
 * The biometric gate — the first thing on screen.
 *
 * A bracketed headline over a wide bar. The bar is real: its fill is actual
 * progress (bytes of the models, then the GPU warm-up and the camera; during
 * the scan, confirmed matches) and the words inside it say what is happening
 * right now rather than a generic "loading".
 *
 * First run enrols: several live samples of the user's face are kept as
 * descriptors. Every run after that scans and compares. Three consecutive
 * frames have to be both the right face and a live one; nine seconds without
 * that is a denial, and the scan simply starts again. The camera circle is
 * only on screen while a face is actually being looked at, and the user's name
 * only once it has been recognised.
 *
 * Ctrl+Shift+E forgets the enrolled face and enrols again — see the note in
 * faceAuth.ts about what kind of lock this is.
 */

type Stage = 'loading' | 'scan' | 'enroll' | 'granted' | 'denied' | 'error'

/** How the app reports its own start-up to the bar: 0..1 and what is happening. */
export type SystemProgress = (fraction: number, step: string) => void

/** Share of the bar given to the assistant's systems; the rest is biometrics. */
const SYSTEMS_SHARE = 0.5

const NEEDED_MATCHES = 3
const ENROLL_SAMPLES = 6
const SCAN_WINDOW_MS = 9000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const HEAD: Record<Stage, { user: string; title: string }> = {
  loading: { user: 'INICIALIZANDO', title: 'J.A.R.V.I.S' },
  scan: { user: 'IDENTIFICANDO', title: 'J.A.R.V.I.S' },
  enroll: { user: 'NOVO USUÁRIO', title: 'CADASTRO' },
  granted: { user: USER_NAME, title: 'ACESSO AUTORIZADO' },
  denied: { user: 'NÃO RECONHECIDO', title: 'ACESSO NEGADO' },
  error: { user: 'FALHA NO SCANNER', title: 'BLOQUEADO' },
}

export function AuthGate({
  systems,
  onGranted,
}: {
  /** Brings the assistant's own systems up — bridge, voice, microphone. */
  systems: (progress: SystemProgress) => Promise<void>
  onGranted: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [stage, setStage] = useState<Stage>('loading')
  const [progress, setProgress] = useState(0)
  /** What is happening right now — written inside the bar. */
  const [label, setLabel] = useState('INICIANDO')
  /** A figure or a hint, under the bar. */
  const [sub, setSub] = useState('')
  const [run, setRun] = useState(0)
  const done = useRef(onGranted)
  done.current = onGranted
  const systemsRef = useRef(systems)
  systemsRef.current = systems

  useEffect(() => {
    let cancelled = false
    const el = video.current!
    let lastTick = 0
    const tick = (p: number) => {
      // One blip per few percent of real progress, not one per frame.
      if (p - lastTick >= 0.04) {
        lastTick = p
        sfx.play('auth-tick')
      }
    }

    const loading = new Audio('/audio/auth-loading.mp3')
    loading.volume = 0.8

    const verify = async (): Promise<boolean> => {
      setStage('scan')
      setProgress(0)
      setLabel('ANALISANDO BIOMETRIA')
      let matches = 0
      const until = Date.now() + SCAN_WINDOW_MS
      while (!cancelled && Date.now() < until) {
        const l = await face.look(el)
        if (!l.embedding) {
          matches = 0
          setLabel('PROCURANDO ROSTO')
          setSub('POSICIONE O ROSTO NA FRENTE DA CÂMERA')
        } else {
          const score = face.similarity(l.embedding)
          const pct = `${Math.round(score * 100)}%`
          setSub('')
          if (face.isMatch(score) && face.isAlive(l)) {
            matches++
            setLabel(`CONFIRMANDO IDENTIDADE · ${pct}`)
            sfx.play('auth-tick')
          } else if (face.isMatch(score)) {
            matches = 0
            setLabel(`VERIFICANDO PROVA DE VIDA · ${pct}`)
          } else {
            matches = 0
            setLabel(`COMPARANDO BIOMETRIA · ${pct}`)
          }
          setProgress(matches / NEEDED_MATCHES)
          if (matches >= NEEDED_MATCHES) return true
        }
        await sleep(120)
      }
      return false
    }

    const enroll = async (): Promise<boolean> => {
      setStage('enroll')
      setProgress(0)
      const samples: number[][] = []
      while (!cancelled && samples.length < ENROLL_SAMPLES) {
        const l = await face.look(el)
        if (!l.embedding) {
          setLabel('PROCURANDO ROSTO')
          setSub('OLHE PARA A CÂMERA')
        } else if (!face.isAlive(l)) {
          setLabel('VERIFICANDO PROVA DE VIDA')
        } else {
          samples.push(l.embedding)
          setProgress(samples.length / ENROLL_SAMPLES)
          setLabel(`REGISTRANDO AMOSTRA ${samples.length}/${ENROLL_SAMPLES}`)
          setSub('MOVA LEVEMENTE A CABEÇA')
          sfx.play('auth-tick')
          // Spaced out so the samples are different angles, not one frame six times.
          await sleep(450)
          continue
        }
        await sleep(150)
      }
      if (cancelled) return false
      face.enroll(samples)
      return true
    }

    ;(async () => {
      try {
        await sfx.unlockAudio()
        void loading.play().catch(() => {})
        setStage('loading')
        // One bar for the whole start-up: first the assistant's own systems,
        // then the biometric models and the camera. Every step is real work.
        const report = (offset: number, share: number) => (p: number, step: string) => {
          if (cancelled) return
          const total = offset + p * share
          setProgress(total)
          setLabel(`${step} · ${Math.round(total * 100)}%`)
          tick(total)
        }
        await systemsRef.current(report(0, SYSTEMS_SHARE))
        if (cancelled) return
        await face.prepare(el, report(SYSTEMS_SHARE, 1 - SYSTEMS_SHARE))
        if (cancelled) return

        for (;;) {
          const ok = face.isEnrolled() ? await verify() : await enroll()
          if (cancelled) return
          if (ok) break
          setStage('denied')
          setLabel('NOVA TENTATIVA EM INSTANTES')
          sfx.play('auth-denied')
          await sleep(2600)
          if (cancelled) return
        }

        setStage('granted')
        setProgress(1)
        setLabel(`${USER_TITLE === 'senhora' ? 'BEM-VINDA' : 'BEM-VINDO'}, ${USER_TITLE.toUpperCase()}`)
        setSub('')
        // The match is the cue for the entrance music — only the music.
        loading.pause()
        music.playMatch()
        face.stopCamera(el)
        await sleep(1900)
        if (!cancelled) done.current()
      } catch (err) {
        if (cancelled) return
        setStage('error')
        setLabel('ERRO')
        setSub(err instanceof Error ? err.message : String(err))
        sfx.play('auth-denied')
      }
    })()

    return () => {
      cancelled = true
      loading.pause()
      face.stopCamera(el)
    }
  }, [run])

  // Enrol again: forget the stored face and restart the gate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        face.forget()
        setRun((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const head = HEAD[stage]
  const scanning = stage === 'scan' || stage === 'enroll'

  return (
    <div className={`auth auth-${stage}`}>
      <div className="auth-plate">
        {/* Mounted throughout so the stream has somewhere to go; only shown
            while a face is actually being looked at. */}
        <div className={`auth-eye${scanning ? ' auth-eye-on' : ''}`}>
          <video ref={video} muted playsInline />
          <span className="auth-sweep" />
        </div>

        <div className="auth-head">
          <span className="auth-bracket auth-bracket-l" />
          <span className="auth-bracket auth-bracket-r" />
          <div className="auth-user">{head.user}</div>
          <div className="auth-title">{head.title}</div>
        </div>

        <div className="auth-bar">
          <div className="auth-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span key={label} className="auth-bar-text">
            {label}
          </span>
        </div>
        <div className="auth-detail">{sub}</div>

        {stage === 'error' && (
          <button className="auth-retry" onClick={() => setRun((n) => n + 1)}>
            TENTAR NOVAMENTE
          </button>
        )}
      </div>
    </div>
  )
}
