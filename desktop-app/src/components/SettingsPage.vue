<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { LOCALES, locale, t, type MessageKey } from '../i18n'
import { APP_VERSION } from '../lib/version'
import { useAudioStore, useRuntimeStore } from '../stores/audio'

import type { ComponentEntry } from '../lib/components'

const emit = defineEmits<{ close: []; setup: [] }>()
const audio = useAudioStore()
const runtime = useRuntimeStore()

const components = ref<ComponentEntry[]>([])
const loading = ref(false)
const busy = ref('')
const notice = ref('')
const noticeKind = ref<'info' | 'danger'>('info')
const localPath = ref<Record<string, string>>({})
const localOpen = ref('')
let timer: number | undefined

const base = computed(() => `http://127.0.0.1:${runtime.port.value}`)
const appVersion = APP_VERSION
const service = computed(() => audio.server as Record<string, any>)
const connected = computed(() => runtime.connected.value)

const language = computed(() => locale.value)

function localName(entry: { names?: Record<string, string> }) {
  return entry.names?.[language.value] || entry.names?.['zh-CN'] || ''
}

function localSummary(entry: { summary?: Record<string, string> }) {
  return entry.summary?.[language.value] || entry.summary?.['zh-CN'] || ''
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`
}

function statusKey(entry: ComponentEntry): MessageKey {
  if (entry.restartRequired) return 'component.status.restart'
  if (entry.installKind === 'bundled' && entry.ready && !entry.busy) return 'component.status.autoInstalled'
  if (entry.installKind !== 'bundled' && entry.detected) return 'component.status.detected'
  const phase = entry.progress.phase
  if (phase === 'downloading') return 'component.status.downloading'
  if (phase === 'verifying') return 'component.status.verifying'
  if (phase === 'extracting') return 'component.status.extracting'
  if (phase === 'installing') return 'component.status.installing'
  if (phase === 'error') return 'component.status.error'
  if (entry.installKind === 'bundled') return entry.ready ? 'component.status.autoInstalled' : entry.detected ? 'component.status.needsSetup' : 'component.status.notInstalled'
  if (entry.detected) return 'component.status.detected'
  if (entry.downloaded) return 'component.status.downloaded'
  if (entry.installedByApp) return 'component.status.downloaded'
  return 'component.status.notInstalled'
}

function statusTone(entry: ComponentEntry): string {
  if (entry.installKind === 'bundled' ? entry.ready && !entry.busy : entry.detected) return 'ok'
  if (entry.progress.phase === 'error') return 'bad'
  if (entry.progress.phase === 'downloading' || entry.progress.phase === 'extracting' || entry.progress.phase === 'installing') return 'active'
  if (entry.installKind === 'bundled') return entry.ready ? 'ok' : 'idle'
  if (entry.detected) return 'ok'
  if (entry.downloaded) return 'ready'
  return 'idle'
}

function showNotice(message: string, kind: 'info' | 'danger' = 'info') {
  notice.value = message
  noticeKind.value = kind
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 6000)
}

async function refresh(silent = false) {
  if (!silent) loading.value = true
  try {
    const response = await fetch(`${base.value}/api/components`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { components?: ComponentEntry[] }
    components.value = Array.isArray(body.components) ? body.components : []
  } catch (error) {
    if (!silent) showNotice(error instanceof Error ? error.message : String(error), 'danger')
  } finally {
    if (!silent) loading.value = false
  }
}

async function act(entry: ComponentEntry, action: string, extra: Record<string, unknown> = {}) {
  busy.value = `${entry.id}:${action}`
  try {
    const response = await fetch(`${base.value}/api/components/${encodeURIComponent(entry.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra })
    })
    const body = await response.json() as { ok?: boolean; error?: string; components?: ComponentEntry[] }
    if (Array.isArray(body.components)) components.value = body.components
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
    if (action === 'remove') showNotice(t('component.removeHint'))
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'danger')
  } finally {
    busy.value = ''
  }
}

async function rescan() {
  busy.value = 'rescan'
  try {
    const response = await fetch(`${base.value}/api/components/rescan`, { method: 'POST' })
    const body = await response.json() as { components?: ComponentEntry[] }
    if (Array.isArray(body.components)) components.value = body.components
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'danger')
  } finally {
    busy.value = ''
    void refresh(true)
  }
}

function installLocal(entry: ComponentEntry) {
  const path = (localPath.value[entry.id] || '').trim()
  if (!path) return
  void act(entry, 'install-local', { path }).then(() => {
    localOpen.value = ''
  })
}

function toggleLocal(entry: ComponentEntry) {
  localOpen.value = localOpen.value === entry.id ? '' : entry.id
}

function chooseLocale(code: string) {
  audio.setLanguage(code)
}

onMounted(() => {
  void refresh()
  // Progress lives on the server, so polling is the simplest way to follow a
  // download started from another window or before this page was opened.
  timer = window.setInterval(() => { void refresh(true) }, 2000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <section class="settings">
    <header class="settings-head">
      <button class="back" type="button" @click="emit('close')">
        <AppIcon name="arrowLeft" :size="15" />
        {{ t('settings.back') }}
      </button>
      <div>
        <h1>{{ t('settings.title') }}</h1>
        <p>{{ t('settings.subtitle') }}</p>
      </div>
    </header>

    <p v-if="notice" class="notice" :class="noticeKind">{{ notice }}</p>

    <section class="card">
      <div class="card-head">
        <h2>{{ t('settings.general') }}</h2><button class="secondary" type="button" @click="emit('setup')">{{ t('settings.setup') }}</button>
      </div>
      <div class="row">
        <div class="row-copy">
          <strong>{{ t('settings.language') }}</strong>
          <span>{{ t('settings.languageHint') }}</span>
        </div>
        <select class="language-select" :value="language" :aria-label="t('settings.language')" @change="chooseLocale(($event.target as HTMLSelectElement).value)">
          <option v-for="item in LOCALES" :key="item.code" :value="item.code">{{ item.label }}</option>
        </select>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>{{ t('settings.components') }}</h2>
          <p class="hint">{{ t('settings.componentsHint') }}</p>
        </div>
        <button class="ghost" type="button" :disabled="busy === 'rescan'" @click="rescan">
          <AppIcon name="refresh" :size="13" /> {{ t('settings.refresh') }}
        </button>
      </div>

      <p v-if="!connected" class="notice danger">{{ t('settings.unavailable') }}</p>

      <article v-for="entry in components" :key="entry.id" class="component" :data-component-id="entry.id">
        <div class="component-head">
          <div class="component-title">
            <span class="component-icon"><AppIcon :name="entry.kind === 'driver' ? 'cable' : 'audio'" :size="16" /></span>
            <div>
              <strong>{{ localName(entry) }}</strong>
              <small v-if="entry.version">{{ t('component.version') }} {{ entry.version }}</small>
            </div>
          </div>
          <span class="badge" :class="statusTone(entry)">{{ t(statusKey(entry)) }}</span>
        </div>

        <p class="component-summary">{{ localSummary(entry) }}</p>

        <div v-if="entry.progress.phase === 'downloading'" class="progress">
          <div class="bar"><i :style="{ width: `${entry.progress.percent}%` }" /></div>
          <div class="progress-meta">
            <span>{{ formatBytes(entry.progress.received) }} / {{ entry.progress.total ? formatBytes(entry.progress.total) : '—' }}</span>
            <span>{{ entry.progress.percent }}% · {{ formatSpeed(entry.progress.speedBps) }}</span>
          </div>
        </div>

        <p v-if="entry.progress.phase === 'error' && entry.progress.error" class="inline-error">
          {{ t('component.actionFailed', { error: entry.progress.error }) }}
        </p>
        <p v-else-if="entry.progress.phase === 'installing'" class="inline-hint">{{ t('component.installerRunning') }}</p>
        <p v-else-if="entry.installKind === 'bundled'" class="inline-hint">{{ t(entry.detected ? 'component.bundledHint' : 'component.reinstallHint') }}</p>
        <p v-else-if="entry.detected" class="inline-hint">{{ t('component.detectedHint') }}</p>

        <p v-if="entry.restartRequired" class="inline-hint">{{ t('component.needsRestart') }}</p>
        <p v-if="entry.installKind === 'manual'" class="inline-hint">{{ t('component.manualOnly') }}</p>
        <p v-else-if="!entry.download && entry.installKind !== 'bundled'" class="inline-hint">{{ t('component.noDownload') }}</p>

        <div class="component-actions">
          <button v-if="entry.installKind === 'bundled' && entry.requirements?.length" class="primary" type="button" :disabled="entry.ready || entry.restartRequired || entry.busy || busy.startsWith(entry.id + ':')" @click="act(entry, 'setup')"><AppIcon name="package" :size="13" /> {{ t(entry.ready ? 'component.status.autoInstalled' : 'component.airplaySetup') }}</button>
          <button v-if="entry.download" class="primary" type="button" :disabled="entry.detected || entry.restartRequired || entry.busy || busy.startsWith(entry.id + ':')" @click="act(entry, 'setup')"><AppIcon name="package" :size="13" /> {{ t('component.setup') }}</button>
          <button
            v-if="entry.canLaunch && (entry.detected || entry.installedByApp)"
            class="secondary"
            type="button"
            :disabled="busy === `${entry.id}:launch`"
            @click="act(entry, 'launch')"
          >
            <AppIcon name="play" :size="13" /> {{ t('component.launch') }}
          </button>
          <a v-if="entry.homepage" class="ghost" :href="entry.homepage" target="_blank" rel="noreferrer">
            <AppIcon name="external" :size="13" /> {{ t('component.openHomepage') }}
          </a>
          <button v-if="entry.installKind !== 'bundled'" class="ghost" type="button" @click="toggleLocal(entry)">
            {{ t('component.localInstall') }}
          </button>
          <button v-if="entry.installKind !== 'bundled'" class="ghost" type="button" @click="act(entry, 'open')">
            <AppIcon name="folder" :size="13" /> {{ t('component.open') }}
          </button>
          <button v-if="entry.installedByApp && !entry.busy && entry.installKind !== 'bundled'" class="ghost danger" type="button" @click="act(entry, 'remove')">
            <AppIcon name="trash" :size="13" /> {{ t('component.remove') }}
          </button>
        </div>

        <div v-if="localOpen === entry.id" class="local">
          <input
            v-model="localPath[entry.id]"
            type="text"
            spellcheck="false"
            placeholder="C:\Users\you\Downloads\VBCABLE_Driver_Pack45.zip"
            @keydown.enter="installLocal(entry)"
          />
          <button class="secondary" type="button" :disabled="!localPath[entry.id] || entry.busy" @click="installLocal(entry)">
            {{ t('component.install') }}
          </button>
        </div>

        <div class="component-meta">
          <span v-if="entry.license">{{ t('component.license') }}：{{ entry.license }}</span>
          <span v-if="entry.sha256" class="mono">sha256 {{ entry.sha256.slice(0, 16) }}…</span>
          <span v-if="entry.downloadedBytes" class="mono">{{ formatBytes(entry.downloadedBytes) }}</span>
        </div>
      </article>

      <p v-if="!components.length && !loading" class="empty">—</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>{{ t('settings.about') }}</h2></div>
      <div class="about">
        <div><span>{{ t('settings.version') }}</span><b>{{ appVersion }}</b></div>
        <div><span>{{ t('settings.serviceVersion') }}</span><b>{{ service.version || '—' }}</b></div>
        <div><span>{{ t('settings.service') }}</span><b>{{ service.service || '—' }}</b></div>
        <div><span>{{ t('settings.protocol') }}</span><b>{{ service.protocol || '—' }}</b></div>
        <div><span>{{ t('settings.port') }}</span><b>{{ service.controlPort || runtime.port.value }}</b></div>
        <div><span>{{ t('settings.engine') }}</span><b>{{ service.audioEngine || '—' }}</b></div>
        <div><span>{{ t('settings.latencyMode') }}</span><b>{{ service.latencyMode || '—' }}</b></div>
      </div>
      <p class="about-note">{{ t('settings.aboutNote') }}</p>
    </section>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 14px; }
.settings-head { display: flex; flex-direction: column; gap: 14px; margin-bottom: 6px; }
.back {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 12px;
  border-radius: var(--r-pill);
  border: 1px solid var(--separator);
  background: var(--block);
  color: var(--muted);
  font-size: 11.5px; cursor: pointer;
}
.back:hover { color: var(--ink); }
.settings-head h1 { font: 700 30px/1.15 var(--font); letter-spacing: -.6px; margin: 0 0 6px; }
.settings-head p { margin: 0; color: var(--muted); font-size: 13px; }

.card {
  background: var(--card);
  border: 1px solid var(--separator);
  border-radius: var(--r-card);
  box-shadow: var(--e2);
  padding: 20px 22px;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.card-head h2 { font: 600 15px/1.3 var(--font); margin: 0; }
.hint { margin: 4px 0 0; color: var(--soft); font-size: 11.5px; line-height: 1.5; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.row-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-copy strong { font: 500 13px var(--font); }
.row-copy span { color: var(--soft); font-size: 11.5px; }
.languages { display: flex; gap: 8px; flex: 0 0 auto; }
.language {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px;
  border-radius: var(--r-pill);
  border: 1px solid var(--separator-strong);
  background: var(--inset);
  color: var(--muted);
  font-size: 12px; cursor: pointer;
  transition: border-color .16s ease, color .16s ease, background .16s ease;
}
.language:hover { color: var(--ink); }
.language.active { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }

.notice {
  margin: 0; padding: 9px 12px; border-radius: 12px;
  font-size: 12px; line-height: 1.55;
  background: var(--primary-soft); color: var(--primary);
}
.notice.danger { background: var(--danger-soft); color: var(--danger); }

.component {
  border-top: 1px solid var(--separator);
  padding: 16px 0 14px;
}
.component:first-of-type { border-top: none; padding-top: 4px; }
.component-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.component-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.component-title > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.component-title strong { font: 600 13px var(--font); }
.component-title small { color: var(--soft); font-size: 10.5px; font-family: var(--font-num); }
.component-icon {
  width: 32px; height: 32px; flex: 0 0 32px; border-radius: 10px;
  display: grid; place-items: center;
  background: var(--primary-soft); color: var(--primary);
}
.badge {
  flex: 0 0 auto; height: 22px; padding: 0 10px;
  display: inline-flex; align-items: center;
  border-radius: var(--r-pill);
  font: 600 10.5px var(--font);
  background: var(--block); color: var(--soft);
}
.badge.ok { background: var(--success-soft); color: var(--success); }
.badge.bad { background: var(--danger-soft); color: var(--danger); }
.badge.active { background: var(--primary-soft); color: var(--primary); }
.badge.ready { background: var(--warning-soft); color: var(--warning); }

.component-summary { margin: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.progress { margin-top: 10px; }
.bar { height: 5px; border-radius: var(--r-pill); background: rgba(255,255,255,.1); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--primary); border-radius: var(--r-pill); transition: width .2s ease; }
.progress-meta { display: flex; justify-content: space-between; margin-top: 5px; color: var(--soft); font: 10.5px var(--font-num); }

.inline-error { margin: 10px 0 0; color: var(--danger); font-size: 11.5px; line-height: 1.55; }
.inline-hint { margin: 8px 0 0; color: var(--soft); font-size: 11.5px; line-height: 1.55; }

.component-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.primary, .secondary {
  height: 32px; padding: 0 13px; border-radius: 10px;
  display: inline-flex; align-items: center; gap: 6px;
  font: 600 11.5px var(--font); cursor: pointer;
  border: 1px solid transparent; text-decoration: none;
}
.primary { background: var(--primary); color: #fff; }
.primary:disabled { opacity: .45; cursor: not-allowed; }
.secondary { background: var(--block); border-color: var(--separator-strong); color: var(--ink); }
.secondary:disabled { opacity: .45; cursor: not-allowed; }
.ghost {
  height: 32px; padding: 0 12px; border-radius: 10px;
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; border: 1px solid var(--separator);
  color: var(--muted); font: 600 11.5px var(--font); cursor: pointer;
  text-decoration: none;
}
.ghost:hover { color: var(--ink); }
.ghost:disabled { opacity: .4; cursor: not-allowed; }
.ghost.danger:hover { color: var(--danger); border-color: rgba(255,59,48,.4); }

.local { display: flex; gap: 8px; margin-top: 10px; }
.local input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px;
  border-radius: 10px; border: 1px solid var(--separator);
  background: var(--inset); color: var(--ink);
  font: 11px var(--font-num);
}
.local input::placeholder { color: var(--soft); }

.component-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: var(--soft); font-size: 10.5px; }
.mono { font-family: var(--font-num); }

.about { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; }
.about > div { display: flex; flex-direction: column; gap: 2px; }
.about span { color: var(--soft); font-size: 10.5px; }
.about b { font: 500 12px var(--font-num); color: var(--ink); }
.about-note { margin: 14px 0 0; color: var(--soft); font-size: 11px; line-height: 1.6; }
.empty { color: var(--soft); font-size: 11px; text-align: center; padding: 12px 0; margin: 0; }

@media (max-width: 720px) {
  .row { flex-direction: column; align-items: flex-start; }
  .about { grid-template-columns: repeat(2, 1fr); }
}
</style>
