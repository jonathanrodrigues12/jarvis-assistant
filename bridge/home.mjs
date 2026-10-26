import { createHmac, createHash } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The house — switches and lights on the Tuya cloud.
 *
 * Smart Life is Tuya's own app, and a great many brands (Eleka among them) are
 * Tuya underneath, so one client covers the whole house. It talks to the Tuya
 * OpenAPI directly with fetch and an HMAC signature — no SDK, nothing that
 * assumes which model is on the other end.
 *
 * That last part is deliberate. The file is split in two: everything above
 * `homeTools` is plain Node that knows nothing about Claude, and `homeTools` is
 * a provider-neutral list of { name, description, params, run }. homeServer()
 * wraps that list for the Agent SDK; a different backend (Ollama, say) wraps
 * the same list its own way — z.toJSONSchema(z.object(params)) is its schema.
 *
 * Setup, once:
 *   1. iot.tuya.com → Cloud → Create Cloud Project, data center "Western
 *      America" for a Brazilian Smart Life account.
 *   2. In the project: Devices → Link App Account → scan the QR code with
 *      Smart Life (Eu → ícone de leitura no topo).
 *   3. Copy the Access ID and Access Secret into .env.local as TUYA_ACCESS_ID
 *      and TUYA_ACCESS_SECRET, then `npm run check:home`.
 */

const ACCESS_ID = process.env.TUYA_ACCESS_ID ?? ''
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET ?? ''
const REGION = process.env.TUYA_REGION ?? 'us'
/** Optional: list one app user's devices instead of every linked account's. */
const UID = process.env.TUYA_UID ?? ''

const HOSTS = {
  us: 'https://openapi.tuyaus.com',
  ueaz: 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  weaz: 'https://openapi-weaz.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
}
const HOST = HOSTS[REGION] ?? REGION

const TIMEOUT_MS = 10_000

export const homeEnabled = Boolean(ACCESS_ID && ACCESS_SECRET)

// -- the signed client -------------------------------------------------------

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (s) => createHmac('sha256', ACCESS_SECRET).update(s).digest('hex').toUpperCase()

/** Tuya signs the path with its query parameters sorted by key. */
function canonical(path, query) {
  const keys = Object.keys(query ?? {}).sort()
  if (!keys.length) return path
  return path + '?' + keys.map((k) => `${k}=${query[k]}`).join('&')
}

let token = null // { value, until }

async function signed(method, path, { query, body, auth = true } = {}) {
  const url = canonical(path, query)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const t = String(Date.now())
  const access = auth ? await accessToken() : ''
  const toSign = [method, sha256(payload), '', url].join('\n')

  const res = await fetch(HOST + url, {
    method,
    headers: {
      client_id: ACCESS_ID,
      sign: hmac(ACCESS_ID + access + t + toSign),
      t,
      sign_method: 'HMAC-SHA256',
      ...(access ? { access_token: access } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.success) {
    const err = new Error(`Tuya ${json.code ?? res.status}: ${json.msg ?? res.statusText}`)
    err.code = json.code
    throw err
  }
  return json.result
}

async function accessToken() {
  if (token && Date.now() < token.until) return token.value
  const r = await signed('GET', '/v1.0/token', { query: { grant_type: 1 }, auth: false })
  // A minute's margin, so a token never expires between signing and arriving.
  token = { value: r.access_token, until: Date.now() + (r.expire_time - 60) * 1000 }
  return token.value
}

/** One retry with a fresh token, for the one error a stale token produces. */
async function call(method, path, opts) {
  try {
    return await signed(method, path, opts)
  } catch (err) {
    if (err.code !== 1010) throw err
    token = null
    return signed(method, path, opts)
  }
}

// -- devices -----------------------------------------------------------------

let deviceCache = null // { at, list }
const DEVICE_TTL_MS = 60_000

async function fetchDevices() {
  if (UID) return call('GET', `/v1.0/users/${UID}/devices`)
  const all = []
  let last = ''
  for (let page = 0; page < 20; page++) {
    const r = await call('GET', '/v1.0/iot-01/associated-users/devices', {
      query: { size: 100, ...(last ? { last_row_key: last } : {}) },
    })
    all.push(...(r.devices ?? []))
    if (!r.has_more || !r.last_row_key) break
    last = r.last_row_key
  }
  return all
}

async function devices({ fresh = false } = {}) {
  if (!fresh && deviceCache && Date.now() - deviceCache.at < DEVICE_TTL_MS) return deviceCache.list
  const list = (await fetchDevices()).map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    online: d.online,
    status: Object.fromEntries((d.status ?? []).map((s) => [s.code, s.value])),
  }))
  deviceCache = { at: Date.now(), list }
  return list
}

const SWITCH_CODE = /^switch(_\d+)?$/
const isLight = (d) => 'switch_led' in d.status || 'bright_value' in d.status || 'bright_value_v2' in d.status

/** The on/off codes a device has, gangs in order. */
function switchCodes(d) {
  if ('switch_led' in d.status) return ['switch_led']
  return Object.keys(d.status).filter((c) => SWITCH_CODE.test(c)).sort()
}

/** What a device is doing, in terms worth saying aloud. */
function describe(d) {
  const codes = switchCodes(d)
  const s = d.status
  const out = {
    nome: d.name,
    tipo: isLight(d) ? 'luz' : codes.length ? 'interruptor' : d.category,
    online: d.online,
  }
  if (codes.length === 1) out.ligado = Boolean(s[codes[0]])
  else if (codes.length > 1) out.canais = codes.map((c, i) => ({ canal: i + 1, ligado: Boolean(s[c]) }))
  if (isLight(d)) {
    const m = lightModel(d)
    // In colour mode the brightness that counts is the colour's own.
    const inColour = m.colour && (s.work_mode === 'colour' || !m.brightCode)
    const b = inColour ? m.colour.v : s[m.brightCode]
    const max = inColour ? m.colourMax : m.brightMax
    if (b !== undefined) out.brilho = Math.round((b / max) * 100)
    if (s.work_mode) out.modo = s.work_mode === 'colour' ? 'cor' : s.work_mode === 'white' ? 'branco' : s.work_mode
  }
  return out
}

/**
 * Which codes a light speaks, and on what scale.
 *
 * The code names are not a reliable guide to the scale: the "_v2" codes are
 * 0-1000, but plenty of strips (the RGBIC controllers among them) report the
 * old `colour_data` name with 0-1000 values inside it. So the colour scale is
 * read off the value itself — anything above 255 can only be the larger one.
 * Some of those strips have no brightness or white codes at all; for them
 * brightness is the colour's `v` and white is a colour with no saturation.
 */
function lightModel(d) {
  const s = d.status
  const colourCode = ['colour_data_v2', 'colour_data'].find((c) => c in s)
  const brightCode = ['bright_value_v2', 'bright_value'].find((c) => c in s)
  const tempCode = ['temp_value_v2', 'temp_value'].find((c) => c in s)
  let colour = null
  if (colourCode) {
    const raw = s[colourCode]
    try {
      colour = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : raw
    } catch {
      colour = null
    }
  }
  const big = colourCode === 'colour_data_v2' || (colour && (colour.s > 255 || colour.v > 255))
  return {
    colourCode,
    brightCode,
    tempCode,
    colour,
    colourMax: big ? 1000 : 255,
    brightMax: brightCode === 'bright_value_v2' ? 1000 : 255,
    brightMin: brightCode === 'bright_value_v2' ? 10 : 25,
  }
}

const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

/** "tudo", "todas as luzes", "todos os leds", "a casa toda". */
const EVERYTHING = /^(tud[oa]s?|tod[oa]s?|casa toda|a casa)\b/
const ONLY_STRIPS = /\b(leds?|fitas?)\b/

/**
 * Resolves a spoken name to devices. Exact, then contained, then every word
 * present — so "sala" finds "Luz da Sala" and "luz sala" finds it too. More
 * than one match is returned as such; the caller decides whether that is an
 * answer ("as luzes da sala") or a question.
 */
function match(list, query) {
  const q = fold(query)
  if (EVERYTHING.test(q)) {
    if (ONLY_STRIPS.test(q)) return list.filter(isLight)
    // Switches first: the strips hang off them, and a strip whose switch is
    // off is offline until it is back on.
    return [...list].sort((a, b) => isLight(a) - isLight(b))
  }
  const byId = list.filter((d) => d.id === query)
  if (byId.length) return byId
  const exact = list.filter((d) => fold(d.name) === q)
  if (exact.length) return exact
  const within = list.filter((d) => fold(d.name).includes(q))
  if (within.length) return within
  const words = q.split(/\s+/).filter((w) => w.length > 2 && !['luz', 'luzes', 'led', 'leds'].includes(w))
  return words.length ? list.filter((d) => words.every((w) => fold(d.name).includes(w))) : []
}

async function resolve(query, { lightsOnly = false } = {}) {
  let list = await devices()
  if (lightsOnly) list = list.filter(isLight)
  let found = match(list, query)
  if (!found.length) {
    // The name may be new since the cache was filled.
    list = await devices({ fresh: true })
    if (lightsOnly) list = list.filter(isLight)
    found = match(list, query)
  }
  if (!found.length) throw new Error(`Nenhum dispositivo chamado "${query}".`)
  return found
}

async function send(d, commands) {
  await call('POST', `/v1.0/devices/${d.id}/commands`, { body: { commands } })
  // Reflect it locally so the next "está ligada?" does not need the cloud.
  for (const c of commands) d.status[c.code] = c.value
}

// -- colour ------------------------------------------------------------------

const HUES = {
  vermelho: 0, laranja: 30, amarelo: 55, verde: 120, ciano: 180, turquesa: 175,
  azul: 230, roxo: 275, violeta: 275, lilas: 285, rosa: 320, magenta: 300,
}

/** A colour name or hex to { h: 0-360, s: 0-1 }, or 'white' for white light. */
function parseColour(input) {
  const c = fold(input)
  if (/^branc[oa]|^white/.test(c)) return 'white'
  if (c in HUES) return { h: HUES[c], s: 1 }
  const m = c.match(/^#?([0-9a-f]{6})$/)
  if (!m) throw new Error(`Cor desconhecida: ${input}`)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  let h = 0
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6)
    else if (max === g) h = 60 * ((b - r) / delta + 2)
    else h = 60 * ((r - g) / delta + 4)
  }
  return { h: Math.round((h + 360) % 360), s: max ? delta / max : 0 }
}

// -- actions -----------------------------------------------------------------

export async function listHome() {
  return (await devices({ fresh: true })).map(describe)
}

export async function setPower(query, on, channel) {
  const found = await resolve(query)
  return each(found, query, (d) => {
    let codes = switchCodes(d)
    if (channel) {
      const code = codes[channel - 1]
      if (!code) throw new Error(`${d.name} não tem o canal ${channel}.`)
      codes = [code]
    }
    return codes.map((code) => ({ code, value: on }))
  })
}

export async function setLight(query, { on, brightness, colour, saturation, warmth }) {
  const found = await resolve(query, { lightsOnly: true })
return each(found, query, (d) => {
    const s = d.status
    const m = lightModel(d)
    const scale = (pct, max, min = 1) => Math.max(min, Math.round((pct / 100) * max))
    // Strips without a white channel make white out of an unsaturated colour.
    const whiteByColour = !m.brightCode && m.colourCode

    const commands = []
    if (on !== undefined) commands.push({ code: 'switch_led', value: on })
    else if (brightness !== undefined || colour || saturation !== undefined || warmth !== undefined) {
      commands.push({ code: 'switch_led', value: true })
    }

    const c = colour ? parseColour(colour) : null
    const colourCmd = (h, sat, pct) => ({
      code: m.colourCode,
      value: { h, s: scale(sat * 100, m.colourMax, 0), v: scale(pct, m.colourMax) },
    })

    if (c && (c !== 'white' || whiteByColour) && m.colourCode) {
      const pct = brightness ?? (m.colour ? Math.round((m.colour.v / m.colourMax) * 100) : 100)
      const sat = c === 'white' ? 0 : saturation !== undefined ? saturation / 100 : c.s
      if ('work_mode' in s) commands.push({ code: 'work_mode', value: 'colour' })
      commands.push(colourCmd(c === 'white' ? 0 : c.h, sat, pct))
    } else if (saturation !== undefined && m.colour) {
      const pct = brightness ?? Math.round((m.colour.v / m.colourMax) * 100)
      if ('work_mode' in s) commands.push({ code: 'work_mode', value: 'colour' })
      commands.push(colourCmd(m.colour.h, saturation / 100, pct))
    } else if (brightness !== undefined && m.colour && (s.work_mode === 'colour' || !m.brightCode)) {
      // In colour mode, brightness lives inside the colour itself.
      commands.push(colourCmd(m.colour.h, m.colour.s / m.colourMax, brightness))
    } else if (c === 'white' || brightness !== undefined || warmth !== undefined) {
      if ('work_mode' in s) commands.push({ code: 'work_mode', value: 'white' })
      if (brightness !== undefined && m.brightCode) {
        commands.push({ code: m.brightCode, value: scale(brightness, m.brightMax, m.brightMin) })
      }
      if (warmth !== undefined && m.tempCode) {
        // Tuya counts temperature from warm (0) to cold (max); warmth is the reverse.
        commands.push({ code: m.tempCode, value: scale(100 - warmth, m.brightMax, 0) })
      }
    }
    return commands
  })
}

/**
 * Sends each device its commands and reports device by device, so one strip
 * with its power cut does not stop "apaga tudo" from reaching the rest.
 */
async function each(found, query, plan) {
  const done = []
  const failed = []
  for (const d of found) {
    const commands = plan(d)
    if (!commands.length) continue
    try {
      await send(d, commands)
      done.push(describe(d))
    } catch (err) {
      failed.push({
        nome: d.name,
        erro: d.online === false ? 'offline — sem energia ou fora da rede' : err.message,
      })
    }
  }
  if (!done.length && !failed.length) throw new Error(`Nada a mudar em "${query}".`)
  if (!done.length) throw new Error(failed.map((f) => `${f.nome}: ${f.erro}`).join('; '))
  return failed.length ? { feito: done, falhou: failed } : done
}

// -- tools, provider-neutral -------------------------------------------------

export const homeTools = [
  {
    name: 'home_list',
    description:
      'Lista os dispositivos da casa (interruptores e luzes) com o estado de cada um. ' +
      'Use para saber os nomes antes de agir, ou para responder "o que está ligado".',
    params: {},
    run: () => listHome(),
  },
  {
    name: 'home_switch',
    description:
      'Liga ou desliga um interruptor ou luz pelo nome, como aparece no Smart Life. ' +
      'O nome pode ser parcial ("sala"); "tudo" age sobre a casa inteira. Num ' +
      'interruptor de várias teclas, sem canal liga ou desliga todas.',
    params: {
      device: z.string().describe('Nome do dispositivo, parcial serve, ou "tudo".'),
      on: z.boolean().describe('true liga, false desliga.'),
      channel: z.number().int().min(1).max(6).optional().describe('Tecla do interruptor, a partir de 1.'),
    },
    run: ({ device, on, channel }) => setPower(device, on, channel),
  },
  {
    name: 'home_light',
    description:
      'Ajusta uma luz ou fita de LED: brilho, cor ou tom do branco. Liga a luz se ' +
      'estiver apagada. Cores em português ("azul", "vermelho", "branco") ou hex.',
    params: {
      device: z.string().describe('Nome da luz, parcial serve, ou "tudo".'),
      on: z.boolean().optional().describe('Omita para manter ligada.'),
      brightness: z.number().int().min(1).max(100).optional().describe('Brilho em porcentagem.'),
      colour: z.string().optional().describe('Cor: nome em português ou hex como #ff8800.'),
      saturation: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Intensidade da cor: 100 viva, 0 branca. É o que o usuário chama de "contraste".'),
      warmth: z.number().int().min(0).max(100).optional().describe('Branco: 0 frio, 100 quente.'),
    },
    run: ({ device, ...opts }) => setLight(device, opts),
  },
]

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Falhou: ${err?.message ?? err}` }],
})

export function homeServer() {
  return createSdkMcpServer({
    name: 'home',
    version: '1.0.0',
    instructions:
      'Automação da casa do usuário: interruptores e fitas de LED do Smart Life. Aja ' +
      'direto, sem confirmar, e responda numa frase curta ("Quarto casal ligado."). ' +
      'Como ele fala:\n' +
      '- "ligar/desligar Quarto Casal" → home_switch, device "Quarto Casal".\n' +
      '- "ligar/desligar todas as luzes" → home_switch, device "todas as luzes".\n' +
      '- "mudar cor do Led Sala para amarelo" → home_light, colour "amarelo".\n' +
      '- "alterar brilho para X%" → home_light, brightness X.\n' +
      '- "alterar contraste para X%" → home_light, saturation X.\n' +
      'Sem nome de luz no pedido, use a última luz mencionada na conversa; se não ' +
      'houver, pergunte qual. Se o nome for ambíguo, chame home_list e pergunte. ' +
      'Se um LED vier offline, diga que ele está sem energia e sugira ligar o ' +
      'interruptor do cômodo.',
    alwaysLoad: true,
    tools: homeTools.map((t) =>
      tool(t.name, t.description, t.params, async (args) => {
        try {
          return ok(await t.run(args))
        } catch (err) {
          return fail(err)
        }
      }),
    ),
  })
}

export const homeConfig = { region: REGION, host: HOST, enabled: homeEnabled }

