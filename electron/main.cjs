/**
 * JARVIS as a desktop app.
 *
 * One window holding the interface, plus the two processes it needs — the
 * bridge (brain) and the Vite server (face) — started and stopped with it, so
 * `npm run app` is the whole thing.
 *
 * The reason this exists is the browser. A page in the plain web build can only
 * show other sites as proxied snapshots: no scripts, no logins. Here the
 * interface can host a real Chromium <webview>, with its own persistent profile
 * (`persist:jarvis`), so the user signs in once and JARVIS browses the way they
 * would. The bridge drives that webview over the DevTools protocol, on a port
 * passed to it as JARVIS_BROWSER_CDP.
 *
 * The debugging port listens on 127.0.0.1 only, but anything running on this
 * machine as this user can reach it — the same trust the bridge's own socket
 * already asks for.
 */

const { app, BrowserWindow, session } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const FACE_PORT = Number(process.env.JARVIS_FACE_PORT || 5173)
const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT || 8787)
const CDP_PORT = Number(process.env.JARVIS_BROWSER_CDP || 9334)
const FACE_URL = `http://localhost:${FACE_PORT}/`
const PARTITION = 'persist:jarvis'

app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))
// The intro and the voice must play without a click on the page first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ---------------------------------------------------------------------------
// The bridge and the face, as children of the app.
// ---------------------------------------------------------------------------

const children = []

function run(name, args, env) {
  // System Node rather than Electron's own: the bridge spawns the Claude CLI
  // and expects an ordinary Node environment around it.
  const child = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    windowsHide: true,
  })
  const tag = (d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => `[${name}] ${l}`)
      .join('\n')
  child.stdout.on('data', (d) => console.log(tag(d)))
  child.stderr.on('data', (d) => console.error(tag(d)))
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`)
    // Either half gone leaves a window that looks alive and answers nothing.
    if (!quitting) app.quit()
  })
  children.push(child)
}

/** Resolves once something answers at `url`, or rejects after `ms`. */
function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > until) reject(new Error(`${url} did not come up`))
        else setTimeout(poll, 400)
      })
      req.setTimeout(2000, () => req.destroy())
    }
    poll()
  })
}

/** True if something is already listening on `port` — another JARVIS, usually. */
function busy(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

// ---------------------------------------------------------------------------
// The window.
// ---------------------------------------------------------------------------

/** Chrome's own user agent, minus the parts that announce Electron. Google
 *  and others refuse to sign in to anything that admits to being embedded. */
function plainUserAgent(ua) {
  return ua.replace(/\s(Electron|jarvis)\/\S+/gi, '')
}

function hardenWebviews() {
  app.on('web-contents-created', (_e, contents) => {
    // Whatever page asks for a <webview>, it gets a plain, sandboxed browser:
    // no preload, no Node, and always the one persistent profile.
    contents.on('will-attach-webview', (_ev, prefs, params) => {
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      params.partition = PARTITION
    })

    if (contents.getType() === 'webview') {
      // Links that want a new window open in the same view instead — there is
      // one browser on screen, and a stray window behind the app is lost.
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) contents.loadURL(url)
        return { action: 'deny' }
      })
    } else {
      // The interface itself never opens windows.
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }
  })
}

function allowMediaForTheFace() {
  // Microphone and camera for the interface only. A site inside the webview
  // asking for them is refused: the user never sees a prompt for it.
  //
  // Judged by the requesting origin, not by the WebContents: permission checks
  // routinely arrive with no WebContents at all, and treating that as "not the
  // interface" is what left the microphone and camera denied.
  const FACE_ORIGINS = [`http://localhost:${FACE_PORT}`, `http://127.0.0.1:${FACE_PORT}`]
  const fromFace = (wc, origin) => {
    if (origin && FACE_ORIGINS.some((o) => origin.startsWith(o))) return true
    try {
      return Boolean(wc && FACE_ORIGINS.some((o) => wc.getURL().startsWith(o)))
    } catch {
      return false
    }
  }
  const DEVICES = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture', 'speaker-selection']
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const ok = fromFace(wc, details?.requestingUrl) && DEVICES.includes(permission)
    console.log(`[app] permission ${permission} ${ok ? 'granted' : 'refused'}`)
    done(ok)
  })
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    fromFace(wc, origin) && DEVICES.includes(permission),
  )
  ses.setDevicePermissionHandler((details) => fromFace(null, details.origin))

  const web = session.fromPartition(PARTITION)
  web.setUserAgent(plainUserAgent(web.getUserAgent()))
  web.setPermissionRequestHandler((_wc, permission, done) =>
    // Ordinary browsing permissions are fine; devices are not.
    done(['fullscreen', 'clipboard-sanitized-write', 'notifications'].includes(permission)),
  )
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    backgroundColor: '#04123a',
    autoHideMenuBar: true,
    title: 'J.A.R.V.I.S.',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen())
  })
  win.loadURL(FACE_URL)
  return win
}

// ---------------------------------------------------------------------------

let quitting = false

app.whenReady().then(async () => {
  if ((await busy(FACE_PORT)) || (await busy(BRIDGE_PORT))) {
    console.error(
      `[app] ports ${FACE_PORT}/${BRIDGE_PORT} are already in use — close the other ` +
        'JARVIS (npm start) first. The app starts its own bridge so it can hand it the browser.',
    )
    app.quit()
    return
  }

  hardenWebviews()
  allowMediaForTheFace()

  // `npm run app:writes` — buttons, typing and the rest of the effectful tools.
  const writes = process.argv.includes('--writes') ? { JARVIS_ALLOW_WRITES: '1' } : {}
  run('bridge', ['bridge/server.mjs'], { JARVIS_BROWSER_CDP: String(CDP_PORT), ...writes })
  run('face', ['node_modules/vite/bin/vite.js', '--port', String(FACE_PORT), '--strictPort'], {})

  try {
    await waitFor(FACE_URL)
  } catch (err) {
    console.error(`[app] ${err.message}`)
    app.quit()
    return
  }
  createWindow()
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  quitting = true
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
})
