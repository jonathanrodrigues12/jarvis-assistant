import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL, USER_NAME } from '../config'
import { micSpectrum } from '../lib/audio'

/**
 * The two columns either side of the orb.
 *
 * Left: the world (Kaspersky's live attack map), the machine (semicircular
 * gauges of real telemetry from the bridge's /system) and the room (the
 * microphone's spectrum, or his own voice while he speaks). Right: the day —
 * greeting and clock, the weather, and which systems are connected.
 *
 * Every figure is real. Anything the machine cannot report — on most Windows
 * machines, the CPU temperature — reads N/D rather than a plausible number.
 */

type Stats = {
  cpu: { usage: number | null; temp: number | null; cores: number }
  memory: { usage: number; totalGb: number }
  gpu: { name: string; usage: number; temp: number; memUsed: number; memTotal: number } | null
  network: { down: number | null; up: number | null } | null
}

type Weather = {
  cidade: string
  agora: { temperatura: number; condicao: string; umidade: number; vento_kmh: number }
  hoje: { minima: number; maxima: number; chance_chuva: number }
}

function usePoll<T>(path: string, everyMs: number): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch(BRIDGE_HTTP_URL + path, { signal: AbortSignal.timeout(4000) })
        if (res.ok && alive) setData((await res.json()) as T)
      } catch {
        /* bridge not up yet — the next poll will catch it */
      }
    }
    void pull()
    const id = setInterval(pull, everyMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [path, everyMs])
  return data
}

const pct = (v: number | null | undefined) => (v == null ? 'N/D' : `${Math.round(v * 100)}%`)
const deg = (v: number | null | undefined) => (v == null ? 'N/D' : `${Math.round(v)}°C`)

function rate(bps: number | null | undefined): string {
  if (bps == null) return 'N/D'
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1).replace('.', ',')} MB/s`
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`
  return `${Math.round(bps)} B/s`
}

/** Throughput on a log scale, so a trickle and a download both read. 0..1 at 50 MB/s. */
const rateFill = (bps: number | null | undefined) =>
  bps == null ? null : Math.min(1, Math.log10(1 + bps) / Math.log10(5e7))

/** A temperature as a fill: 30°C empty, 100°C full. */
const tempFill = (t: number | null | undefined) =>
  t == null ? null : Math.min(1, Math.max(0, (t - 30) / 70))

// ---------------------------------------------------------------------------

/** A semicircular gauge. `hot` swaps the ramp for one that warms toward red. */
function Gauge({
  label,
  value,
  text,
  sub,
  hot,
}: {
  label: string
  value: number | null
  text: string
  sub?: string
  hot?: boolean
}) {
  const id = useRef(`g${Math.random().toString(36).slice(2, 8)}`).current
  const r = 34
  const length = Math.PI * r
  const fill = value == null ? 0 : Math.max(0, Math.min(1, value))
  return (
    <div className={`gauge${value == null ? ' gauge-na' : ''}`}>
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
            {hot ? (
              <>
                <stop offset="0" stopColor="#38d4ff" />
                <stop offset="0.6" stopColor="#ffb347" />
                <stop offset="1" stopColor="#ff4d5e" />
              </>
            ) : (
              <>
                <stop offset="0" stopColor="#38d4ff" />
                <stop offset="1" stopColor="#8a6bff" />
              </>
            )}
          </linearGradient>
        </defs>
        <path className="gauge-track" d={`M 8 42 A ${r} ${r} 0 0 1 76 42`} />
        <path
          className="gauge-fill"
          d={`M 8 42 A ${r} ${r} 0 0 1 76 42`}
          stroke={`url(#${id})`}
          strokeDasharray={`${length * fill} ${length}`}
        />
      </svg>
      <div className="gauge-value">{text}</div>
      <div className="gauge-label">{label}</div>
      {sub && <div className="gauge-sub">{sub}</div>}
    </div>
  )
}

function SystemGauges() {
  const s = usePoll<Stats>('/system', 2000)
  const g = s?.gpu
  return (
    <section className="side-card">
      <header className="side-head">
        <span className="side-kicker">TELEMETRIA · AO VIVO</span>
        <span className="side-title">Sistema</span>
      </header>
      <div className="gauges">
        <Gauge label="CPU" value={s?.cpu.usage ?? null} text={pct(s?.cpu.usage)} sub={s ? `${s.cpu.cores} núcleos` : ''} />
        <Gauge label="MEMÓRIA" value={s?.memory.usage ?? null} text={pct(s?.memory.usage)} sub={s ? `${Math.round(s.memory.totalGb)} GB` : ''} />
        <Gauge label="GPU" value={g?.usage ?? null} text={pct(g?.usage)} sub={g ? `${(g.memUsed / 1024).toFixed(1)}/${Math.round(g.memTotal / 1024)} GB` : 'N/D'} />
        <Gauge label="TEMP CPU" value={tempFill(s?.cpu.temp)} text={deg(s?.cpu.temp)} sub={s?.cpu.temp == null ? 'sem sensor' : ''} hot />
        <Gauge label="TEMP GPU" value={tempFill(g?.temp)} text={deg(g?.temp)} hot />
        <Gauge
          label="REDE"
          value={rateFill((s?.network?.down ?? 0) + (s?.network?.up ?? 0))}
          text={rate(s?.network?.down)}
          sub={s?.network ? `↑ ${rate(s.network.up)}` : ''}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

/**
 * The room, as bars. The microphone's spectrum while the user talks; while
 * JARVIS speaks the mic is quiet by design (echo cancellation), so his own
 * output level drives the bars instead, shaped into a moving voice-like curve.
 */
function AudioCard() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const phase = useStore((s) => s.phase)
  const BARS = 36

  useEffect(() => {
    const el = canvas.current!
    const g = el.getContext('2d')!
    const shown = new Array<number>(BARS).fill(0)
    let raf = 0
    const draw = (t: number) => {
      const { phase: p, level } = useStore.getState()
      const want =
        p === 'speaking'
          ? shown.map((_, i) => {
              const x = i / (BARS - 1)
              const shape = Math.sin(x * Math.PI) * (0.55 + 0.45 * Math.sin(t / 140 + i * 0.9))
              return Math.min(1, level * 1.4 * shape)
            })
          : micSpectrum(BARS)
      const w = (el.width = el.clientWidth * devicePixelRatio)
      const h = (el.height = el.clientHeight * devicePixelRatio)
      g.clearRect(0, 0, w, h)
      const grad = g.createLinearGradient(0, 0, w, 0)
      grad.addColorStop(0, '#38d4ff')
      grad.addColorStop(1, '#8a6bff')
      g.fillStyle = grad
      g.shadowColor = 'rgba(80, 160, 255, 0.8)'
      g.shadowBlur = 8 * devicePixelRatio
      const gap = w / BARS
      const bw = gap * 0.55
      for (let i = 0; i < BARS; i++) {
        // Quick to rise, slower to fall, so speech reads as a moving shape.
        shown[i] += (want[i] - shown[i]) * (want[i] > shown[i] ? 0.55 : 0.12)
        const bh = Math.max(2 * devicePixelRatio, shown[i] * h * 0.92)
        const x = i * gap + (gap - bw) / 2
        g.beginPath()
        g.roundRect(x, (h - bh) / 2, bw, bh, bw / 2)
        g.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const who =
    phase === 'speaking' ? 'JARVIS falando' : phase === 'listening' ? 'Ouvindo você' : 'Ambiente'
  return (
    <section className="side-card">
      <header className="side-head">
        <span className="side-kicker">ÁUDIO · MICROFONE</span>
        <span className="side-title">{who}</span>
      </header>
      <canvas ref={canvas} className="audio-bars" />
    </section>
  )
}

// ---------------------------------------------------------------------------

/**
 * Kaspersky's live cyber-threat map, through its official embeddable widget —
 * cropped down to the globe alone.
 *
 * The widget is another site's page, so its title bar and counters cannot be
 * restyled; they are cut away instead. It is always loaded at a fixed 600×500,
 * where its layout is stable and the globe sits centred near (295, 258) with a
 * radius of about 150, and a circular window is laid exactly over that.
 * `screen` blending drops the widget's black sky, so the globe floats on the
 * card. If Kaspersky ever moves the globe, the window constants are all there
 * is to adjust.
 */
const WIDGET = { width: 600, height: 500, cx: 295, cy: 258, r: 150 }
const GLOBE_PX = 210

function ThreatMap() {
  const scale = GLOBE_PX / (WIDGET.r * 2)
  return (
    <section className="side-card side-map">
      <header className="side-head">
        <span className="side-kicker">KASPERSKY · AO VIVO</span>
        <span className="side-title">Ameaças globais</span>
      </header>
      <div className="threat-globe" style={{ width: GLOBE_PX, height: GLOBE_PX }}>
        <iframe
          src="https://cybermap.kaspersky.com/en/widget/dynamic/dark"
          title="Mapa de ameaças cibernéticas da Kaspersky"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          style={{
            width: WIDGET.width,
            height: WIDGET.height,
            transform: `scale(${scale})`,
            left: -(WIDGET.cx - WIDGET.r) * scale,
            top: -(WIDGET.cy - WIDGET.r) * scale,
          }}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function Greeting() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const h = now.getHours()
  const hello = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
  const first = USER_NAME.split(/\s+/)[0]
  const name = first.charAt(0) + first.slice(1).toLowerCase()
  return (
    <section className="side-card">
      <header className="side-head side-head-row">
        <span className="side-kicker">{hello},</span>
        <span className="side-pill">{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      </header>
      <div className="greet-name">{name === 'Senhor' ? 'Senhor' : name}</div>
      <div className="greet-date">
        {now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </div>
    </section>
  )
}

function WeatherCard() {
  const w = usePoll<Weather>('/weather', 10 * 60_000)
  return (
    <section className="side-card">
      <header className="side-head">
        <span className="side-kicker">CLIMA · {w?.cidade?.toUpperCase() ?? '—'}</span>
      </header>
      {w ? (
        <>
          <div className="weather-now">
            <span className="weather-temp">{Math.round(w.agora.temperatura)}°</span>
            <span className="weather-cond">{w.agora.condicao}</span>
          </div>
          <div className="weather-rows">
            <span>Máx {Math.round(w.hoje.maxima)}° · Mín {Math.round(w.hoje.minima)}°</span>
            <span>Chuva {w.hoje.chance_chuva}% · Umidade {w.agora.umidade}%</span>
          </div>
        </>
      ) : (
        <div className="side-empty">Aguardando dados…</div>
      )}
    </section>
  )
}

function SystemsCard() {
  const connected = useStore((s) => s.connected)
  const voice = useStore((s) => s.voice)
  return (
    <section className="side-card">
      <header className="side-head">
        <span className="side-kicker">INTEGRAÇÕES</span>
        <span className="side-title">Sistemas</span>
      </header>
      <ul className="side-list">
        {connected.map((c) => (
          <li key={c}>
            <span className="side-dot" />
            {c}
          </li>
        ))}
        <li>
          <span className="side-dot" />
          Web
        </li>
        {voice && (
          <li>
            <span className="side-dot side-dot-voice" />
            Voz · {voice.replace(/\(.*?\)/g, '').trim()}
          </li>
        )}
      </ul>
    </section>
  )
}

export function SideLeft() {
  return (
    <aside className="side side-left">
      <ThreatMap />
      <SystemGauges />
      <AudioCard />
    </aside>
  )
}

export function SideRight() {
  return (
    <aside className="side side-right">
      <Greeting />
      <WeatherCard />
      <SystemsCard />
    </aside>
  )
}
