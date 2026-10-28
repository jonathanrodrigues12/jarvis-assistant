import { useEffect, useRef, useState } from 'react'
import * as sfx from '../lib/sfx'
import * as music from '../lib/music'
import { USER_NAME, USER_TITLE } from '../config'

/**
 * The start-up screen — the first thing on screen.
 *
 * A bracketed headline over a wide bar. The bar is real: its fill is the
 * assistant's own systems coming up (bridge, voice, microphone) and the words
 * inside it say what is happening right now rather than a generic "loading".
 * Once everything is up it greets the user by name and lets them in; there is
 * no face check in front of it any more.
 */

type Stage = 'loading' | 'granted' | 'error'

/** How the app reports its own start-up to the bar: 0..1 and what is happening. */
export type SystemProgress = (fraction: number, step: string) => void

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const HEAD: Record<Stage, { user: string; title: string }> = {
  loading: { user: 'INICIALIZANDO', title: 'J.A.R.V.I.S' },
  granted: { user: USER_NAME, title: 'ACESSO AUTORIZADO' },
  error: { user: 'FALHA NA INICIALIZAÇÃO', title: 'BLOQUEADO' },
}

export function AuthGate({
  systems,
  onGranted,
}: {
  /** Brings the assistant's own systems up — bridge, voice, microphone. */
  systems: (progress: SystemProgress) => Promise<void>
  onGranted: () => void
}) {
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

    ;(async () => {
      try {
        await sfx.unlockAudio()
        void loading.play().catch(() => {})
        setStage('loading')
        setSub('')
        await systemsRef.current((p, step) => {
          if (cancelled) return
          setProgress(p)
          setLabel(`${step} · ${Math.round(p * 100)}%`)
          tick(p)
        })
        if (cancelled) return

        setStage('granted')
        setProgress(1)
        setLabel(`${USER_TITLE === 'senhora' ? 'BEM-VINDA' : 'BEM-VINDO'}, ${USER_TITLE.toUpperCase()}`)
        // The systems being up is the cue for the entrance music — only the music.
        loading.pause()
        music.playMatch()
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
    }
  }, [run])

  const head = HEAD[stage]

  return (
    <div className={`auth auth-${stage}`}>
      <div className="auth-plate">
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
