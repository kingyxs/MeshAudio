import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { invoke, isTauri } from '@tauri-apps/api/core'
import App from './App.vue'
import './styles.css'

// A packaged build has no console, so a blank window leaves nothing to debug.
// Report the boot URL and the first runtime error to the Rust side, which
// appends them to %TEMP%/meshaudio-sidecar.log. The boot line also tells a dev
// build (localhost:1420) apart from a packaged one (tauri://localhost).
if (isTauri()) {
  const report = (kind: string, detail: string) => {
    invoke('frontend_log', { message: `${kind} ${detail}` }).catch(() => {})
  }
  report('boot', `${location.href} ua=${navigator.userAgent}`)
  window.addEventListener('error', event => {
    report('error', `${event.message} @ ${event.filename}:${event.lineno}`)
  })
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason as { stack?: string; message?: string } | string | undefined
    report('rejection', String((typeof reason === 'object' && reason && (reason.stack || reason.message)) || reason))
  })
}

const app = createApp(App).use(createPinia())
app.config.errorHandler = (err, _instance, info) => {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err)
  if (isTauri()) {
    invoke('frontend_log', { message: `[vue-error] ${info} :: ${msg}` }).catch(() => {})
  }
  console.error('[vue-error]', msg, info)
}
// Global unhandled errors from event handlers, timers, etc.
window.addEventListener('error', (e) => {
  const msg = `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`
  if (isTauri()) invoke('frontend_log', { message: `[global-error] ${msg}` }).catch(() => {})
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { stack?: string; message?: string } | string | undefined
  const msg = String((typeof r === 'object' && r && (r.stack || r.message)) || r)
  if (isTauri()) invoke('frontend_log', { message: `[unhandled-rejection] ${msg}` }).catch(() => {})
})
app.mount('#app')
