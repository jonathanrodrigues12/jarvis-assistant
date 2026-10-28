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

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

/**
 * Installed, there is no Vite and no guarantee of a system Node. The face is the
 * built `dist/`, served from here, and the bridge runs on Electron's own Node.
 * Its own port, inside the range the bridge trusts (5173-5199), so an installed
 * JARVIS and `npm run app` from the source tree do not fight over 5173.
 */
const PACKAGED = app.isPackaged
const FACE_PORT = Number(process.env.JARVIS_FACE_PORT || (PACKAGED ? 5183 : 5173))

/**
 * Settings that must not ship inside an installer — the keys in .env.local and
 * the personal preferencias.md — live in %APPDATA%\JARVIS instead, where the
 * bridge is told to look. `npm run dist` copies this machine's copies there.
 */
const SETTINGS_DIR = path.join(app.getPath('appData'), 'JARVIS')

/**
 * Installed, there is no terminal to read the bridge's output in, and that
 * output is the only account of why a turn failed. So it also goes to
 * %APPDATA%\JARVIS\jarvis.log, started fresh on each launch.
 */
let logFile = null
if (PACKAGED) {
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true })
    logFile = fs.createWriteStream(path.join(SETTINGS_DIR, 'jarvis.log'), { flags: 'w' })
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        original(...args)
        logFile.write(args.map(String).join(' ') + '\n')
      }
    }
  } catch {
    /* logging is a convenience; run without it */
  }
}
const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT || 8787)
const CDP_PORT = Number(process.env.JARVIS_BROWSER_CDP || 9334)
const FACE_URL = `http://localhost:${FACE_PORT}/`
const PARTITION = 'persist:jarvis'

/**
 * Installed, JARVIS is one resident process: a second launch only brings the
 * window of the first back, rather than failing on ports that one holds.
 */
if (PACKAGED && !app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))
// The intro and the voice must play without a click on the page first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ---------------------------------------------------------------------------
// The bridge and the face, as children of the app.
// ---------------------------------------------------------------------------

const children = []

function run(name, args, env) {
  // From the source tree, system Node: the bridge spawns the Claude CLI and
  // expects an ordinary Node environment around it. Installed, Electron's own
  // binary in Node mode, since the machine may not have Node at all — the
  // Claude CLI the SDK spawns is a native executable either way.
  const child = PACKAGED
    ? spawn(process.execPath, args, {
        cwd: ROOT,
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      })
    : spawn('node', args, {
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * The built face, on localhost rather than file://. The bridge only accepts
 * sockets from localhost origins, the media permissions above are granted by
 * origin, and the page's CSP is written for 'self' over http — a file:// page
 * would fail all three. Bound to loopback; nothing outside the machine sees it.
 */
function serveFace() {
  const root = path.join(ROOT, 'dist')
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    const file = path.join(root, path.normalize(rel))
    // A path that climbs out of dist/ is refused, not resolved.
    if (!file.startsWith(root)) {
      res.writeHead(403)
      return res.end()
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(FACE_PORT, '127.0.0.1', () => resolve(server))
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
    // The installed exe carries the icon already; this covers `npm run app`,
    // where the window would otherwise show Electron's.
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // Hidden in the tray he still has to hear the wake word and answer, so
      // the page keeps its full timers and audio when nobody is looking at it.
      backgroundThrottling: false,
    },
  })
  // Installed, closing the window only hides it; JARVIS keeps running in the
  // tray, and quitting is the tray menu's job.
  if (PACKAGED) {
    win.on('close', (e) => {
      if (quitting) return
      e.preventDefault()
      win.hide()
    })
  }
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen())
  })
  win.loadURL(FACE_URL)
  return win
}

let mainWindow = null
let tray = null

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16, quality: 'best' }))
  tray.setToolTip('J.A.R.V.I.S.')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir J.A.R.V.I.S.', click: showWindow },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]),
  )
  tray.on('click', showWindow)
}

/**
 * Installed, each launch asks GitHub whether a newer release exists (the
 * release workflow publishes one per `v*` tag). Nothing is downloaded until the
 * user agrees; once it is, the installer runs silently and JARVIS restarts on
 * the new version.
 */
function checkForUpdates() {
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.logger = console

  autoUpdater.on('update-available', async (info) => {
    showWindow()
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Atualização disponível',
      message: `Uma nova versão do J.A.R.V.I.S. está disponível (${info.version}).`,
      detail: `Versão instalada: ${app.getVersion()}. Deseja atualizar agora? O app será reiniciado ao final.`,
      buttons: ['Atualizar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.downloadUpdate().catch(() => {})
  })
  autoUpdater.on('download-progress', (p) => mainWindow?.setProgressBar(p.percent / 100))
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.setProgressBar(-1)
    quitting = true
    autoUpdater.quitAndInstall(true, true)
  })
  autoUpdater.on('error', (err) => {
    mainWindow?.setProgressBar(-1)
    console.error(`[app] update failed: ${err.message}`)
  })

  autoUpdater.checkForUpdates().catch(() => {})
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
  const settings = PACKAGED
    ? {
        JARVIS_ENV_FILE: path.join(SETTINGS_DIR, '.env.local'),
        JARVIS_PREFS_FILE: path.join(SETTINGS_DIR, 'preferencias.md'),
        JARVIS_ALLOWED_ORIGINS: `http://localhost:${FACE_PORT},http://127.0.0.1:${FACE_PORT}`,
      }
    : {}
  run('bridge', ['bridge/server.mjs'], {
    JARVIS_BROWSER_CDP: String(CDP_PORT),
    ...settings,
    ...writes,
  })
  if (PACKAGED) {
    try {
      await serveFace()
    } catch (err) {
      console.error(`[app] could not serve the interface: ${err.message}`)
      app.quit()
      return
    }
  } else {
    run('face', ['node_modules/vite/bin/vite.js', '--port', String(FACE_PORT), '--strictPort'], {})
  }

  try {
    await waitFor(FACE_URL)
  } catch (err) {
    console.error(`[app] ${err.message}`)
    app.quit()
    return
  }
  mainWindow = createWindow()
  if (PACKAGED) {
    createTray()
    checkForUpdates()
  }
})

app.on('second-instance', showWindow)

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
