/**
 * A second brain: a local model served by Ollama.
 *
 * Ollama speaks the Anthropic Messages API on /v1/messages, so this is not a
 * second agent loop — it is the same SDK session with ANTHROPIC_BASE_URL
 * pointed at localhost. Tools, streaming, the permission gate and the HUD all
 * work unchanged; only the model behind them differs.
 *
 * Claude stays the default. The browser picks per connection (`?brain=ollama`
 * on the socket URL, toggled with M on the HUD); JARVIS_BRAIN sets what a
 * connection gets when it does not say.
 */

import http from 'node:http'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const DEFAULT_BRAIN = process.env.JARVIS_BRAIN === 'ollama' ? 'ollama' : 'claude'
export const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
/**
 * qwen3:4b-instruct with an 8k context, built from bridge/ollama/Modelfile:
 *
 *   ollama pull qwen3:4b-instruct
 *   ollama create jarvis-qwen3:4b -f bridge/ollama/Modelfile
 *
 * Why this one, measured on a 6GB laptop GPU:
 *   - qwen3:8b did not fit beside the interface: 20 of 37 layers on the GPU,
 *     the prompt read at 15 tokens/s and answers at 6, so turns timed out.
 *     The 4b fits whole — 2,500 tokens/s in, 45 out.
 *   - The plain qwen3:4b tag is the 2507 thinking model. With thinking off it
 *     writes its reasoning out as ordinary text, in English, which would be
 *     spoken. The instruct build answers directly.
 *   - Ollama's default context is 4096 and silently drops the front of a
 *     longer request — the persona and the tools — so the window is raised.
 */
export const OLLAMA_MODEL = process.env.JARVIS_OLLAMA_MODEL ?? 'jarvis-qwen3:4b'

/**
 * A small local model drowns in the full toolset. Claude Code's built-ins
 * (Bash, Read, WebSearch — the last of which only exists on Anthropic's
 * servers anyway) and every configured MCP server add up to tens of thousands
 * of tokens of definitions, more than an 8B model's context holds. So by
 * default the local brain gets only the in-process servers: HUD, interface,
 * camera, briefing, home, browser. JARVIS_OLLAMA_TOOLS=all hands it everything.
 */
export const OLLAMA_ALL_TOOLS = process.env.JARVIS_OLLAMA_TOOLS === 'all'

/**
 * The persona, cut down for a small model.
 *
 * The full prompt Claude gets — persona, preferences, the blade and interface
 * manual, the display tool's design system — is ~54KB, about thirteen
 * thousand tokens. On a 6GB laptop GPU, with half of an 8B model spilling onto
 * the CPU, reading that took over thirty seconds before the first word, and
 * the model still lost the thread: it ignored the data it had been handed and
 * ended "bom dia" on "Preparando o briefing, senhor." So the local brain gets
 * the voice rules that matter and nothing about the interface, plus only the
 * briefing and home tools. JARVIS_OLLAMA_TOOLS=all restores the full set.
 */
export const LOCAL_PROMPT = `Você é o JARVIS, o assistente do Homem de Ferro, falando em voz alta.

Fale SEMPRE em português do Brasil. Registro de mordomo britânico: formal, seco,
preciso. Chame o usuário de "senhor" em cerca de metade das falas, nunca pelo nome.
No máximo duas frases curtas por resposta. Cada palavra é lida em voz alta.
Sem entusiasmo, sem desculpas, sem palavras de enchimento, sem ponto de exclamação.
Somente prosa falada: sem markdown, listas, asteriscos ou emoji. Escreva números,
horas e temperaturas por extenso como se fala: "vinte e dois graus", "oito e quinze".
Nunca anuncie o que vai fazer; responda direto.

Use as ferramentas quando precisar de dados: get_now para data e hora,
get_weather para o clima, get_news para manchetes, open_camera para abrir a
câmera na tela, close_window para fechar janelas, e as ferramentas da casa para
luzes e tomadas.

BRIEFING. Quando a mensagem trouxer [contexto do briefing], todos os dados já
estão nela. NÃO chame nenhuma ferramenta. Responda de uma vez, nesta ordem: o
cumprimento exatamente como em agora.cumprimento ("Bom dia", "Boa tarde" ou
"Boa noite"), seguido de "senhor"; o clima numa frase (cidade, mínima, máxima, chance
de chuva); uma manchete por tema, citando o veículo; e uma pergunta curta no fim.
`

/**
 * The few screen controls the local brain does get.
 *
 * The full interface tools (display, blade, ui_*) cost more context than a
 * small model can afford, which also took away the one window people ask for
 * by name: the camera. These two tools put that back, with descriptions short
 * enough to cost almost nothing.
 */
let screenSeq = 0

export function localScreenServer({ emitBlade, emitUi }) {
  return createSdkMcpServer({
    name: 'screen',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'open_camera',
        'Abre a janela da câmera na tela, ao vivo. Use quando o usuário pedir para ' +
          'abrir, mostrar ou ligar a câmera.',
        {},
        async () => {
          emitBlade({
            id: `s${Date.now().toString(36)}-${(screenSeq++).toString(36)}`,
            title: 'CÂMERA',
            kind: 'camera',
            size: 'wide',
            // Stays until closed, not just for this answer.
            hold: 'sticky',
          })
          return { content: [{ type: 'text', text: 'Câmera aberta na tela.' }] }
        },
      ),
      tool(
        'close_window',
        'Fecha janelas da tela. target: "front" = a da frente, "all" = todas, ou parte ' +
          'do título, como "câmera" ou "clima".',
        { target: z.string().default('front').catch('front') },
        async ({ target }) => {
          emitUi('close', { target: target ?? 'front' })
          return { content: [{ type: 'text', text: 'Fechado.' }] }
        },
      ),
    ],
  })
}

/** JARVIS_OLLAMA_THINK=1 lets a reasoning model think before it answers. */
const THINK = process.env.JARVIS_OLLAMA_THINK === '1'

/** Whether Ollama is up and has the model. Asked by /health, so it stays cheap. */
export async function ollamaReady() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const { models = [] } = await res.json()
    return models.some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL)
  } catch {
    return false
  }
}

/**
 * Why there is a proxy at all: thinking.
 *
 * With thinking disabled the SDK simply leaves the `thinking` field out of the
 * request — which is "off" to Anthropic, but Ollama reads an absent field as
 * the model's own default, and for qwen3 that default is on. Measured with
 * qwen3:8b on this machine: "capital of Australia" took 1.1s with thinking
 * explicitly disabled and 15.5s without, the model talking itself through the
 * answer in English before giving it — none of which is ever spoken.
 *
 * Neither MAX_THINKING_TOKENS=0 nor a "/no_think" in the system prompt changed
 * that, so the request is rewritten on its way through instead: a missing
 * `thinking` becomes an explicit `{ type: 'disabled' }`. Everything else,
 * including the streamed response, passes through untouched.
 */
let proxyUrl = null
let starting = null

function startProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) body += chunk

      if (!THINK && req.method === 'POST' && req.url?.startsWith('/v1/messages') && body) {
        try {
          const json = JSON.parse(body)
          if (!json.thinking) {
            json.thinking = { type: 'disabled' }
            body = JSON.stringify(json)
          }
        } catch {
          /* not ours to fix — forward it as it came */
        }
      }

      const headers = { ...req.headers }
      delete headers.host
      delete headers['content-length']
      const upstream = await fetch(OLLAMA_URL + req.url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      })
      const out = Object.fromEntries(upstream.headers)
      // fetch has already decoded these; the body below is the plain bytes.
      delete out['content-encoding']
      delete out['content-length']
      res.writeHead(upstream.status, out)
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk)
      }
      res.end()
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(String(err?.message ?? err))
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // An ephemeral port on loopback only: nothing outside this machine needs it.
    server.listen(0, '127.0.0.1', () => {
      proxyUrl = `http://127.0.0.1:${server.address().port}`
      resolve(proxyUrl)
    })
  })
}

/**
 * Called once at bridge start-up. Sessions are built synchronously when a
 * socket connects, so the proxy has to be listening before the first one.
 */
export async function startOllamaProxy() {
  if (proxyUrl) return proxyUrl
  starting ??= startProxy().finally(() => {
    starting = null
  })
  return starting
}

/**
 * SDK options for a session on the local brain. The SDK's env option replaces
 * the environment rather than merging into it, hence the spread.
 */
export function ollamaOptions() {
  return {
    env: {
      ...process.env,
      // Straight to Ollama if the proxy never came up: slower, since the model
      // will think, but still answering.
      ANTHROPIC_BASE_URL: proxyUrl ?? OLLAMA_URL,
      // Any non-empty token; Ollama does not check it. The API key is blanked
      // so a real one in the environment is never sent to the local server.
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      // Background calls (titles, summaries) go to the "small fast" model,
      // which would otherwise name a Claude model Ollama does not have.
      ANTHROPIC_SMALL_FAST_MODEL: OLLAMA_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: OLLAMA_MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    thinking: { type: 'disabled' },
    ...(OLLAMA_ALL_TOOLS ? {} : { tools: [] }),
  }
}
