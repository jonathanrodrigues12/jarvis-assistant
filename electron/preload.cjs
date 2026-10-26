/**
 * The one thing the interface needs to know about being inside the app: that
 * it is, so the browser blade renders a real <webview> instead of a proxied
 * snapshot. Nothing else from Electron or Node is exposed to the page.
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('jarvisApp', { electron: true })
