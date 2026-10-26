import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import WebSocket from 'ws'

/**
 * JARVIS's own browser — the <webview> on the browser blade in the desktop app.
 *
 * electron/main.cjs opens Chromium's DevTools port and hands its number down as
 * JARVIS_BROWSER_CDP. Every webview in the app is a target on that port, and
 * there is only ever one browser blade, so "the browser" is simply the webview
 * target that exists. Each tool call dials it, does its work, and hangs up:
 * the blade can be closed and reopened between two questions, and a held
 * connection would be to a view that no longer exists.
 *
 * Reading, looking, scrolling and following links change nothing and always
 * run. Pressing a button or typing into a field can — a form sends, an order
 * goes through — so those wait for JARVIS_ALLOW_WRITES, the same gate as the
 * user's Chrome.
 */

const PORT = process.env.JARVIS_BROWSER_CDP
export const browserEnabled = Boolean(PORT)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findView() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
      signal: AbortSignal.timeout(3000),
    })
    const list = await res.json()
    return list.find((t) => t.type === 'webview') ?? null
  } catch {
    return null
  }
}

/** Waits for the browser blade's view to exist, up to `ms`. */
async function waitForView(ms) {
  const until = Date.now() + ms
  for (;;) {
    const view = await findView()
    if (view || Date.now() > until) return view
    await sleep(300)
  }
}

/** One DevTools session against the view, closed when `fn` is done. */
async function withView(fn, { waitMs = 0 } = {}) {
  const view = waitMs ? await waitForView(waitMs) : await findView()
  if (!view) {
    throw new Error('O navegador não está aberto na tela. Use browser_open primeiro.')
  }
  const ws = new WebSocket(view.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    const slot = msg.id && pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error.message))
    else slot.resolve(msg.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} não respondeu a tempo`))
      }, 30_000)
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    return await fn(send)
  } finally {
    ws.close()
  }
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'erro na página')
  return r.result?.value
}

/** Until the document has loaded, or `ms` has passed — a slow page is still a page. */
async function settle(send, ms = 15_000) {
  const until = Date.now() + ms
  await sleep(400)
  while (Date.now() < until) {
    try {
      if ((await evaluate(send, 'document.readyState')) === 'complete') break
    } catch {
      /* mid-navigation: the context is being replaced */
    }
    await sleep(300)
  }
  await sleep(300)
}

/**
 * The page as text, plus every visible thing that can be clicked or typed
 * into, numbered. The numbers are stamped onto the elements themselves, so
 * browser_click and browser_type find exactly what was described, not a guess.
 */
const READ = (max) => `(() => {
  document.querySelectorAll('[data-jarvis-id]').forEach((e) => e.removeAttribute('data-jarvis-id'))
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const items = []
  let n = 0
  for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true]')) {
    if (items.length >= 80) break
    if (!visible(el)) continue
    const field = el.matches('input, textarea, [contenteditable=true]')
    const kind = el.tagName === 'A' ? 'link' : field ? 'campo' : el.tagName === 'SELECT' ? 'lista' : 'botão'
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80)
    if (!label && !field) continue
    el.setAttribute('data-jarvis-id', String(++n))
    items.push('[' + n + '] ' + kind + ': ' + (label || '(sem rótulo)') + (field ? ' (' + (el.type || 'texto') + ')' : ''))
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${max})
  return { url: location.href, titulo: document.title, texto: text, elementos: items }
})()`

/** Where on the screen an element is, scrolled into view first. */
const LOCATE = (id) => `(() => {
  const el = document.querySelector('[data-jarvis-id="${id}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const link = el.closest('a[href]')
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    link: Boolean(link && /^https?:/i.test(link.href)),
    field: el.matches('input, textarea, select, [contenteditable=true]'),
  }
})()`

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
})
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: String(err?.message ?? err) }],
})

const READ_ONLY_NOTE =
  'Bloqueado: o JARVIS está em modo somente leitura. Ele pode abrir, ler e seguir links, ' +
  'mas apertar botões e digitar em campos exige o modo de escrita.'

/**
 * @param {{ allowWrites: boolean, emitBlade: (blade: object) => void }} opts
 */
export function browserServer({ allowWrites, emitBlade }) {
  const summary = async (send, max = 1500) => {
    const page = await evaluate(send, READ(max))
    return page
  }

  return createSdkMcpServer({
    name: 'jarvis_browser',
    version: '1.0.0',
    instructions:
      'O navegador próprio do JARVIS, aberto dentro da interface. Logins feitos nele ficam salvos.',
    alwaysLoad: true,
    tools: [
      tool(
        'browser_open',
        'Abre um endereço no navegador do JARVIS, dentro da interface, na frente do usuário. ' +
          'É um navegador de verdade (scripts, logins salvos). Para uma busca, abra ' +
          'https://www.google.com/search?q=... Devolve o título, o endereço e o começo do texto.',
        {
          url: z.string().describe('Endereço completo, com https://'),
          title: z.string().optional().catch(undefined).describe('Nome curto para a janela, ex.: "GitHub"'),
        },
        async ({ url, title }) => {
          let target
          try {
            target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
          } catch {
            return fail(`Endereço inválido: ${url}`)
          }
          if (!/^https?:$/.test(target.protocol)) return fail('Só endereços http e https.')
          emitBlade({
            // One browser on screen: the same id replaces it rather than stacking.
            id: 'browser',
            title: (title || target.hostname.replace(/^www\./, '')).toUpperCase(),
            kind: 'browser',
            url: target.href,
            size: 'wide',
            hold: 'sticky',
          })
          try {
            return text(
              await withView(
                async (send) => {
                  await settle(send)
                  const page = await summary(send)
                  delete page.elementos
                  return page
                },
                { waitMs: 15_000 },
              ),
            )
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_read',
        'Lê a página aberta no navegador do JARVIS: texto e uma lista numerada de links, ' +
          'botões e campos. Use os números com browser_click e browser_type. Leia de novo ' +
          'depois de navegar: os números mudam de página para página.',
        { max_chars: z.number().int().min(500).max(20000).default(6000) },
        async ({ max_chars }) => {
          try {
            return text(await withView((send) => summary(send, max_chars)))
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_screenshot',
        'Uma imagem do que está no navegador do JARVIS agora, para quando o layout importa ' +
          '(gráficos, painéis, imagens) ou para conferir que um clique funcionou.',
        {},
        async () => {
          try {
            const shot = await withView((send) =>
              send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }),
            )
            return { content: [{ type: 'image', data: shot.data, mimeType: 'image/jpeg' }] }
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_click',
        'Clica num elemento pelo número que browser_read deu. Links sempre funcionam; ' +
          'botões só com o modo de escrita ligado.',
        { id: z.number().int().min(1) },
        async ({ id }) => {
          try {
            return text(
              await withView(async (send) => {
                const at = await evaluate(send, LOCATE(id))
                if (!at) return 'Elemento não encontrado. Chame browser_read de novo.'
                if (!allowWrites && !at.link) return READ_ONLY_NOTE
                for (const type of ['mousePressed', 'mouseReleased']) {
                  await send('Input.dispatchMouseEvent', {
                    type, x: at.x, y: at.y, button: 'left', clickCount: 1,
                  })
                }
                await settle(send, 10_000)
                const page = await summary(send, 800)
                delete page.elementos
                return page
              }),
            )
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_type',
        'Digita num campo pelo número que browser_read deu, substituindo o que houver. ' +
          'submit: true aperta Enter depois. Exige o modo de escrita.',
        {
          id: z.number().int().min(1),
          text: z.string(),
          submit: z.boolean().default(false),
        },
        async ({ id, text: typed, submit }) => {
          if (!allowWrites) return text(READ_ONLY_NOTE)
          try {
            return text(
              await withView(async (send) => {
                const ok = await evaluate(
                  send,
                  `(() => { const el = document.querySelector('[data-jarvis-id="${id}"]');
                    if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus();
                    if (el.select) el.select(); else document.execCommand('selectAll');
                    return true })()`,
                )
                if (!ok) return 'Campo não encontrado. Chame browser_read de novo.'
                await send('Input.insertText', { text: typed })
                if (submit) {
                  for (const type of ['keyDown', 'keyUp']) {
                    await send('Input.dispatchKeyEvent', {
                      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
                      ...(type === 'keyDown' ? { text: '\r' } : {}),
                    })
                  }
                  await settle(send, 10_000)
                }
                return submit ? `Enviado. Página: ${await evaluate(send, 'document.title')}` : 'Digitado.'
              }),
            )
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_scroll',
        'Rola a página do navegador do JARVIS: "down", "up", "top" ou "bottom".',
        { to: z.enum(['down', 'up', 'top', 'bottom']).default('down') },
        async ({ to }) => {
          const js = {
            down: 'window.scrollBy(0, innerHeight * 0.8)',
            up: 'window.scrollBy(0, -innerHeight * 0.8)',
            top: 'window.scrollTo(0, 0)',
            bottom: 'window.scrollTo(0, document.body.scrollHeight)',
          }[to]
          try {
            await withView((send) => evaluate(send, js))
            return text('Feito.')
          } catch (err) {
            return fail(err)
          }
        },
      ),

      tool(
        'browser_back',
        'Volta para a página anterior no navegador do JARVIS.',
        {},
        async () => {
          try {
            return text(
              await withView(async (send) => {
                await evaluate(send, 'history.back()')
                await settle(send, 10_000)
                return { url: await evaluate(send, 'location.href'), titulo: await evaluate(send, 'document.title') }
              }),
            )
          } catch (err) {
            return fail(err)
          }
        },
      ),
    ],
  })
}
