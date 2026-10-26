import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The browser blade — a real browser inside the interface.
 *
 * In the desktop app this is an Electron <webview>: full Chromium, scripts and
 * all, on the persistent `persist:jarvis` profile, so a site signed into once
 * stays signed in. The bridge drives the same view over the DevTools protocol
 * (bridge/browser.mjs); the toolbar here is for the user's own hands.
 *
 * In a plain browser tab there is no <webview>, so it falls back to the
 * bridge's live page proxy — the site's look, without its scripts — and says so.
 */

type WebviewTag = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
}

/**
 * React types `allowpopups` as a boolean and would drop it from the DOM; the
 * webview only honours it as a present attribute, so it is passed as a string.
 * Without it, links that open a new window do nothing at all.
 */
const POPUPS = { allowpopups: 'true' } as object

export const inApp = Boolean((window as unknown as { jarvisApp?: { electron?: boolean } }).jarvisApp?.electron)

/** What the user typed into the address bar, made into somewhere to go. */
function toUrl(typed: string): string {
  const t = typed.trim()
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

export function BrowserBlade({ url }: { url: string }) {
  const view = useRef<WebviewTag | null>(null)
  const [address, setAddress] = useState(url)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  // The first URL is given to the element as its src; later ones are loaded
  // into the same view, so history and the signed-in session carry over.
  const [initial] = useState(url)

  useEffect(() => {
    const wv = view.current
    if (!wv) return
    const sync = () => {
      try {
        setAddress(wv.getURL())
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        /* not attached yet */
      }
    }
    const start = () => setLoading(true)
    const stop = () => {
      setLoading(false)
      sync()
    }
    wv.addEventListener('did-start-loading', start)
    wv.addEventListener('did-stop-loading', stop)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    return () => {
      wv.removeEventListener('did-start-loading', start)
      wv.removeEventListener('did-stop-loading', stop)
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
    }
  }, [])

  // JARVIS opening a new address on the blade that is already up.
  useEffect(() => {
    const wv = view.current
    if (!wv || url === initial) return
    try {
      if (wv.getURL() !== url) void wv.loadURL(url)
    } catch {
      /* the view will pick it up from src */
    }
  }, [url, initial])

  if (!inApp) {
    return (
      <div className="bw">
        <div className="bw-note">
          Navegador completo só no app (npm run app). Aqui: visualização sem scripts nem login.
        </div>
        <iframe
          className="bl-frame"
          src={`${BRIDGE_HTTP_URL}/page?mode=live&url=${encodeURIComponent(url)}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={url}
        />
      </div>
    )
  }

  const go = (e: FormEvent) => {
    e.preventDefault()
    const next = toUrl(address)
    setAddress(next)
    void view.current?.loadURL(next)
  }

  return (
    <div className="bw">
      <form className="bw-bar" onSubmit={go}>
        <button type="button" disabled={!nav.back} onClick={() => view.current?.goBack()} title="Voltar">
          ‹
        </button>
        <button type="button" disabled={!nav.forward} onClick={() => view.current?.goForward()} title="Avançar">
          ›
        </button>
        <button
          type="button"
          onClick={() => (loading ? view.current?.stop() : view.current?.reload())}
          title={loading ? 'Parar' : 'Recarregar'}
        >
          {loading ? '×' : '↻'}
        </button>
        <input
          className="bw-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.target.select()}
          spellCheck={false}
        />
      </form>
      <webview
        ref={(el) => {
          view.current = el as WebviewTag | null
        }}
        className="bw-view"
        src={initial}
        partition="persist:jarvis"
        {...POPUPS}
      />
    </div>
  )
}
