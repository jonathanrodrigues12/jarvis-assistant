import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The morning briefing's sources.
 *
 * "Bom dia" is answered with the day laid out — the time, the weather, the
 * headlines — and none of that should depend on which MCP servers happen to be
 * configured on this machine. So the two things every briefing needs live here,
 * in-process, against public endpoints that need no key:
 *
 *   - weather from Open-Meteo, geocoded from a city name;
 *   - headlines from Google News' Brazilian RSS, by topic.
 *
 * Mail and calendar are deliberately NOT here. They need the user's own
 * accounts, and those already arrive through MCP servers or the user's Chrome;
 * the persona is told to use them when present and skip them when not.
 */

const CITY = process.env.JARVIS_CITY ?? 'São Paulo'
const TOPICS = (process.env.JARVIS_NEWS_TOPICS ?? 'tecnologia,inteligência artificial,economia')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TZ = process.env.JARVIS_TZ ?? 'America/Sao_Paulo'

const TIMEOUT_MS = 10_000

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${new URL(url).host} respondeu ${res.status}`)
  return res.json()
}

/** WMO weather codes, as Open-Meteo reports them, in words worth saying aloud. */
const WMO = {
  0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina com geada',
  51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte',
  61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte',
  66: 'chuva congelante', 67: 'chuva congelante forte',
  71: 'neve fraca', 73: 'neve', 75: 'neve forte', 77: 'grãos de neve',
  80: 'pancadas de chuva fracas', 81: 'pancadas de chuva', 82: 'pancadas de chuva fortes',
  85: 'pancadas de neve', 86: 'pancadas de neve fortes',
  95: 'trovoadas', 96: 'trovoadas com granizo', 99: 'trovoadas com granizo forte',
}

/**
 * The right greeting for the hour, decided here rather than by the model.
 * Left to infer it from "14:30", and handed a message that itself began "boa
 * tarde", the model still opened with "Bom dia, senhor".
 */
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Bom dia'
  if (hour >= 12 && hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

function now() {
  const d = new Date()
  const fmt = (opts) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(d)
  const hour = Number(fmt({ hour: 'numeric', hourCycle: 'h23' }))
  return {
    data: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    hora: fmt({ hour: '2-digit', minute: '2-digit' }),
    cumprimento: greetingFor(hour),
    fuso: TZ,
  }
}

async function weather(city) {
  const geo = await getJson(
    'https://geocoding-api.open-meteo.com/v1/search?count=1&language=pt&format=json&name=' +
      encodeURIComponent(city),
  )
  const place = geo.results?.[0]
  if (!place) throw new Error(`Cidade não encontrada: ${city}`)

  const f = await getJson(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
      '&timezone=auto&forecast_days=1',
  )
  return {
    cidade: place.name,
    regiao: [place.admin1, place.country].filter(Boolean).join(', '),
    agora: {
      temperatura: f.current?.temperature_2m,
      sensacao: f.current?.apparent_temperature,
      umidade: f.current?.relative_humidity_2m,
      vento_kmh: f.current?.wind_speed_10m,
      condicao: WMO[f.current?.weather_code] ?? 'indefinida',
    },
    hoje: {
      minima: f.daily?.temperature_2m_min?.[0],
      maxima: f.daily?.temperature_2m_max?.[0],
      chance_chuva: f.daily?.precipitation_probability_max?.[0],
      condicao: WMO[f.daily?.weather_code?.[0]] ?? 'indefinida',
    },
    unidades: { temperatura: '°C', umidade: '%', chance_chuva: '%' },
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, name) => ENTITIES[name] ?? m)
    .trim()

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decode(m[1]) : ''
}

async function news(topic, max) {
  const url = topic
    ? 'https://news.google.com/rss/search?hl=pt-BR&gl=BR&ceid=BR:pt-419&q=' +
      encodeURIComponent(`${topic} when:1d`)
    : 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419'
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Google Notícias respondeu ${res.status}`)
  const xml = await res.text()

  const items = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const source = tag(m[1], 'source')
    // Google appends " - Fonte" to every title; the source is reported apart.
    let title = tag(m[1], 'title')
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    items.push({ titulo: title, fonte: source, publicado: tag(m[1], 'pubDate'), link: tag(m[1], 'link') })
    if (items.length >= max) break
  }
  return { tema: topic || 'principais', noticias: items }
}

/**
 * Ten-minute caches, warmed at bridge start-up.
 *
 * "Bom dia" used to wait on every source before a word was spoken — a geocode,
 * a forecast and an RSS fetch per topic, each a round trip abroad. Weather and
 * headlines do not change inside ten minutes, so they are fetched ahead of
 * time and the briefing reads them from memory. Concurrent callers share one
 * request rather than each starting their own.
 */
const TTL_MS = 10 * 60_000
const cache = new Map()

function cached(key, load) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = load()
  cache.set(key, { at: Date.now(), value })
  // A failure must not be remembered for ten minutes.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key)
  })
  return value
}

export const cachedWeather = (city = CITY) => cached(`weather:${city}`, () => weather(city))
export const cachedNews = (topic, max = 3) => cached(`news:${topic}:${max}`, () => news(topic, max))

/** Fetch everything the briefing will ask for, so it is in memory by "bom dia". */
export function warmBriefing() {
  const all = [cachedWeather(), ...TOPICS.map((t) => cachedNews(t, 3))]
  return Promise.allSettled(all)
}

/**
 * What "bom dia" needs before the first word: the time and the weather.
 *
 * Handed to the model with the greeting itself, so it can open with "Bom dia,
 * senhor — vinte e dois graus em Sorocaba" straight away instead of spending
 * two tool round trips finding out. Waits only briefly for the weather: if the
 * cache is cold and the network slow, the model gets the time alone and calls
 * get_weather itself, which is what it did before.
 */
export async function morningContext({ withNews = false } = {}) {
  const within = (p) =>
    Promise.race([
      p.catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ])
  const [clima, ...topics] = await Promise.all([
    within(cachedWeather()),
    // The local brain is handed the headlines too, so it can narrate the whole
    // briefing without a tool call. Titles and sources only: links and dates
    // are tokens a small model has to read and is never meant to say.
    ...(withNews ? TOPICS.map((t) => within(cachedNews(t, 3))) : []),
  ])
  const ctx = { agora: now(), clima }
  if (withNews) {
    ctx.noticias = topics.filter(Boolean).map((n) => ({
      tema: n.tema,
      itens: n.noticias.slice(0, 2).map((i) => ({ titulo: i.titulo, fonte: i.fonte })),
    }))
  }
  return ctx
}

/**
 * The briefing's cards, built here rather than by the model.
 *
 * The local brain has no display tool — its manual alone is more than a small
 * model can read in time — so on a greeting the bridge puts the cards up
 * itself, from the same data it handed the model. Same shape and classes as
 * the display tool's output, so they land in the deck like any other card.
 */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const round = (n) => (typeof n === 'number' ? Math.round(n) : '–')

let cardSeq = 0
const card = (fields) => ({
  id: `b${Date.now().toString(36)}-${(cardSeq++).toString(36)}`,
  kind: 'markup',
  size: 'compact',
  hold: 'turn',
  ...fields,
})

export function briefingCards(ctx) {
  const cards = []
  const w = ctx.clima
  if (w) {
    cards.push(
      card({
        kicker: 'PANORAMA · CLIMA',
        title: w.cidade,
        tag: `${round(w.hoje?.chance_chuva)}% CHUVA`,
        html:
          `<div><span class="hud-metric">${round(w.agora?.temperatura)}°</span>` +
          `<span class="hud-unit">${esc(w.agora?.condicao)} · sensação ${round(w.agora?.sensacao)}°</span></div>` +
          '<div class="hud-rows">' +
          `<div class="hud-row"><span class="hud-idx">↓</span><span class="hud-main"><span class="hud-label">Mínima ${round(w.hoje?.minima)}°</span></span></div>` +
          `<div class="hud-row"><span class="hud-idx">↑</span><span class="hud-main"><span class="hud-label">Máxima ${round(w.hoje?.maxima)}°</span></span></div>` +
          `<div class="hud-row"><span class="hud-idx">~</span><span class="hud-main"><span class="hud-label">${esc(w.hoje?.condicao)}</span><span class="hud-sub">umidade ${round(w.agora?.umidade)}% · vento ${round(w.agora?.vento_kmh)} km/h</span></span></div>` +
          '</div>',
      }),
    )
  }
  for (const n of ctx.noticias ?? []) {
    const items = n.itens ?? []
    if (!items.length) continue
    cards.push(
      card({
        kicker: 'RADAR · NOTÍCIAS',
        title: n.tema.charAt(0).toUpperCase() + n.tema.slice(1),
        tag: items[0].fonte,
        html:
          '<div class="hud-rows">' +
          items
            .map(
              (i, k) =>
                `<div class="hud-row"><span class="hud-idx">0${k + 1}</span>` +
                `<span class="hud-main"><span class="hud-label">${esc(i.titulo)}</span></span>` +
                `<span class="hud-tag">${esc(i.fonte)}</span></div>`,
            )
            .join('') +
          '</div>',
      }),
    )
  }
  return cards
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Falhou: ${err?.message ?? err}` }],
})

export function briefingServer() {
  return createSdkMcpServer({
    name: 'briefing',
    version: '1.0.0',
    instructions:
      'Fontes do briefing matinal: data e hora, clima e manchetes. Use quando o ' +
      'usuário disser "bom dia" ou perguntar sobre o dia, o tempo ou as notícias.',
    alwaysLoad: true,
    tools: [
      tool(
        'get_now',
        'Data e hora atuais no fuso do usuário. Chame antes de cumprimentar, para saber se é manhã, tarde ou noite.',
        {},
        async () => ok(now()),
      ),
      tool(
        'get_weather',
        `Clima atual e previsão de hoje para uma cidade. Sem cidade, usa a do usuário (${CITY}).`,
        { city: z.string().optional().describe('Nome da cidade. Omita para a cidade do usuário.') },
        async ({ city }) => {
          try {
            return ok(await cachedWeather(city || CITY))
          } catch (err) {
            return fail(err)
          }
        },
      ),
      tool(
        'get_news',
        'Manchetes das últimas 24 horas no Google Notícias Brasil. Sem tema, traz as ' +
          `principais. Os temas de interesse do usuário são: ${TOPICS.join(', ')}.`,
        {
          topic: z.string().optional().describe('Tema da busca, em português. Omita para as principais.'),
          max: z.number().int().min(1).max(10).default(3).describe('Quantas manchetes.'),
        },
        async ({ topic, max }) => {
          try {
            return ok(await cachedNews(topic, max))
          } catch (err) {
            return fail(err)
          }
        },
      ),
    ],
  })
}

export const briefingConfig = { city: CITY, topics: TOPICS, tz: TZ }

/** The sources themselves, for scripts/check-briefing.mjs. */
export { now, weather, news }
