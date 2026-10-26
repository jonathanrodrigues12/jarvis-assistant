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

type HomeDevice = {
  id: string
  nome: string
  tipo: 'luz' | 'interruptor' | string
  online: boolean
  ligado?: boolean
  brilho?: number
  cor?: string
  canais?: { canal: number; nome: string; ligado: boolean }[]
}

type Home = { atualizado: number; dispositivos: HomeDevice[] }

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
                <stop offset="0" stopColor="#ff3d7f" />
                <stop offset="0.5" stopColor="#8a6bff" />
                <stop offset="1" stopColor="#38d4ff" />
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
      const dpr = devicePixelRatio
      const w = (el.width = el.clientWidth * dpr)
      const h = (el.height = el.clientHeight * dpr)
      g.clearRect(0, 0, w, h)

      // The chart's furniture: faint horizontal guides and a baseline.
      g.shadowBlur = 0
      g.strokeStyle = 'rgba(140, 170, 220, 0.12)'
      g.lineWidth = dpr
      for (let k = 1; k <= 3; k++) {
        const y = Math.round((h * k) / 4) + 0.5
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(w, y)
        g.stroke()
      }

      // A histogram from the baseline, as in the reference: the low half of the
      // spectrum in hot magenta-red, the high half in cold blue.
      const hot = g.createLinearGradient(0, h, 0, 0)
      hot.addColorStop(0, '#b23cff')
      hot.addColorStop(1, '#ff3d5e')
      const cold = g.createLinearGradient(0, h, 0, 0)
      cold.addColorStop(0, '#2a6bff')
      cold.addColorStop(1, '#38d4ff')
      const gap = w / BARS
      const bw = gap * 0.78
      for (let i = 0; i < BARS; i++) {
        // Quick to rise, slower to fall, so speech reads as a moving shape.
        shown[i] += (want[i] - shown[i]) * (want[i] > shown[i] ? 0.55 : 0.12)
        const bh = Math.max(2 * dpr, shown[i] * h * 0.95)
        const x = i * gap + (gap - bw) / 2
        const isHot = i < BARS / 2
        g.fillStyle = isHot ? hot : cold
        g.shadowColor = isHot ? 'rgba(255, 61, 94, 0.7)' : 'rgba(56, 160, 255, 0.7)'
        g.shadowBlur = 6 * dpr
        g.fillRect(x, h - bh, bw, bh)
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

/** A device's one-word state. Offline wins: a strip with its power cut still
 *  reports the last colour it had, and showing that as "on" would be a lie. */
const stateOf = (d: HomeDevice) => (!d.online ? 'offline' : d.ligado ? 'on' : 'off')

const STATE_LABEL = { on: 'ligado', off: 'desligado', offline: 'offline' } as const

/**
 * The house at a glance: how much is on, then every device with its keys.
 *
 * The bar is one segment per state, sized by device count — the question it
 * answers is "is anything left on", not "how much power". Each state carries
 * its word as well as its colour, so it reads the same without the colour.
 * Polled every ten seconds; the bridge answers from a one-minute cache, so
 * this costs the Tuya quota nothing extra, and changes JARVIS makes himself
 * show on the next poll.
 */
function HomeCard() {
  const home = usePoll<Home>('/home', 10_000)
  if (!home) return null

  const list = home.dispositivos
  const count = { on: 0, off: 0, offline: 0 }
  for (const d of list) count[stateOf(d)]++
  const switches = list.filter((d) => d.tipo !== 'luz')
  const strips = list.filter((d) => d.tipo === 'luz')

  return (
    <section className="side-card home-card">
      <header className="side-head side-head-row">
        <div className="side-head">
          <span className="side-kicker">CASA · SMART LIFE</span>
          <span className="side-title">
            {count.on ? `${count.on} ${count.on === 1 ? 'ligado' : 'ligados'}` : 'Tudo desligado'}
          </span>
        </div>
        <span className="side-pill">{list.length} disp.</span>
      </header>

      <div className="home-bar" role="img" aria-label={`${count.on} ligados, ${count.off} desligados, ${count.offline} offline`}>
        {(['on', 'off', 'offline'] as const).map((k) =>
          count[k] ? (
            <span
              key={k}
              className={`home-seg home-${k}`}
              style={{ flexGrow: count[k] }}
              title={`${count[k]} ${STATE_LABEL[k]}`}
            />
          ) : null,
        )}
      </div>
      <div className="home-legend">
        {(['on', 'off', 'offline'] as const).map((k) => (
          <span key={k}>
            <i className={`home-dot home-${k}`} />
            {count[k]} {count[k] === 1 || k === 'offline' ? STATE_LABEL[k] : `${STATE_LABEL[k]}s`}
          </span>
        ))}
      </div>

      <div className="home-list">
        {switches.length > 0 && <div className="home-sec">INTERRUPTORES</div>}
        {switches.map((d) => (
          <div key={d.id} className="home-row" title={`${d.nome} · ${STATE_LABEL[stateOf(d)]}`}>
            <i className={`home-dot home-${stateOf(d)}`} />
            <span className="home-name">{d.nome}</span>
            <span className="home-keys">
              {(d.canais ?? []).map((c) => (
                <span key={c.canal} className={`home-key${c.ligado ? ' is-on' : ''}`} title={`${c.nome} · ${c.ligado ? 'ligado' : 'desligado'}`}>
                  {c.nome}
                </span>
              ))}
            </span>
          </div>
        ))}

        {strips.length > 0 && <div className="home-sec">FITAS LED</div>}
        {strips.map((d) => {
          const st = stateOf(d)
          return (
            <div key={d.id} className="home-row" title={`${d.nome} · ${STATE_LABEL[st]}`}>
              <i className={`home-dot home-${st}`} />
              <span className="home-name">{d.nome}</span>
              <span className="home-meta">
                {st === 'offline' ? 'sem energia' : st === 'on' ? `${d.brilho ?? 100}%` : 'desligado'}
              </span>
              <i
                className={`home-swatch${st === 'on' ? '' : ' is-dim'}`}
                style={{ background: d.cor ?? '#ffffff' }}
                title={d.cor ? `cor ${d.cor}` : 'branco'}
              />
            </div>
          )
        })}
      </div>
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
      <HomeCard />
      <SystemsCard />
    </aside>
  )
}
