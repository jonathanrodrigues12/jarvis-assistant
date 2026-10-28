/**
 * What the interface needs to know about being inside the app: that it is, so
 * the browser blade renders a real <webview> instead of a proxied snapshot; and
 * what the installer asked (name, form of address, voice), which src/config.ts
 * prefers over the values compiled in. Nothing else from Electron or Node is
 * exposed to the page.
 *
 * Fetched synchronously because config.ts reads it while the modules are still
 * loading, before anything could await it.
 */
const { contextBridge, ipcRenderer } = require('electron')

let settings = {}
try {
  settings = ipcRenderer.sendSync('jarvis:settings') || {}
} catch {
  /* an older main process; the compiled-in values stand */
}

contextBridge.exposeInMainWorld('jarvisApp', { electron: true, settings })
