<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRuntimeStore } from '../stores/audio'
import { locale } from '../i18n'
import type { ComponentEntry } from '../lib/components'
const runtime = useRuntimeStore()
const panel = ref<HTMLDialogElement | null>(null)
const components = ref<ComponentEntry[]>([])
const selected = ref<string[]>([])
const loading = ref(false)
const running = ref(false)
const error = ref('')
const initialized = ref(false)
const isOpen = ref(false)
let timer: number | undefined
let refreshing = false
let disposed = false
const en = computed(() => locale.value === 'en-US')
const words = computed(() => en.value ? {
  title: 'Welcome to MeshAudio', intro: 'Choose the features you need. Local playback and routing work without extra drivers.',
  included: 'Included', ready: 'Ready', missing: 'Not installed', installing: 'Download → verify → install → check', restart: 'Restart Windows to activate', failed: 'Needs attention',
  privacy: 'MeshAudio receives only the sources you enable. It never captures global Windows playback. Allow LAN access on trusted private networks if Windows asks.',
  consent: 'Selected components download directly from their publishers. Windows may ask for administrator approval and the official installer may require confirmation. Their own licence terms apply.',
  install: 'Install selected components', finish: 'Open routing canvas', close: 'Continue later', retry: 'Retry',
  guide: 'Drag a round source port to a bus, then drag the bus port to an output. No sound? Check both connections and mute controls.',
  limits: 'AirPlay must be selected manually in iPhone Control Center. QR codes open instructions and cannot select a receiver automatically. The web microphone stops when iOS suspends the page.',
  hint: 'You can reopen this guide in Settings. Closing it does not cancel an installer already running.'
} : {
  title: '欢迎使用 MeshAudio', intro: '选择需要的功能。系统播放和基础路由无需额外驱动，即可使用。',
  included: '已随应用提供', ready: '已就绪', missing: '尚未安装', installing: '下载 → 校验 → 安装 → 检测', restart: '重启 Windows 后启用', failed: '需要处理',
  privacy: 'MeshAudio 只接收你主动启用的音源，不采集 Windows 全局播放声音。如果 Windows 提示，请仅在可信的专用网络允许局域网访问。',
  consent: '勾选的组件将直接从原厂下载，适用各自许可。Windows 可能要求管理员授权，官方安装器可能需要点击确认；驱动安装后可能需要重启。',
  install: '安装所选组件', finish: '进入路由画布', close: '稍后继续', retry: '重试',
  guide: '按住来源的圆形端口拖到通道，再把通道拖到输出。没有声音时，检查两段连线与静音状态。',
  limits: 'AirPlay 需要在 iPhone 控制中心手动选择接收端；二维码只能打开指引，不能自动选择镜像设备。iOS 网页麦克风在锁屏或页面暂停时会中断。',
  hint: '可在设置中重新打开引导。关闭引导不会取消已经运行的安装器。'
})
const base = computed(() => `http://127.0.0.1:${runtime.port.value}`)
function local(value: Record<string, string>) { return value[locale.value] || value['en-US'] || '' }
function status(entry: ComponentEntry) {
  if (entry.detection === 'checking') return en.value ? 'Checking…' : '正在检查…'
  if (entry.restartRequired) return words.value.restart
  if (entry.progress.phase === 'error') return `${words.value.failed}: ${entry.progress.error}`
  if (entry.busy || ['downloading', 'verifying', 'extracting', 'installing'].includes(entry.progress.phase)) return `${words.value.installing}${entry.progress.phase === 'downloading' ? ` · ${entry.progress.percent}%` : ''}`
  if (entry.installKind === 'bundled' && entry.detected) return entry.ready ? (en.value ? 'Automatically installed · ready' : '已自动安装 · 已就绪') : (en.value ? 'Automatically installed · Bonjour setup required' : '已自动安装 · 待配置 Bonjour')
  if (entry.detected) return words.value.ready
  return words.value.missing
}
async function getComponents() {
  if (refreshing) return
  refreshing = true
  try {
    const response = await fetch(`${base.value}/api/components`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (!disposed) components.value = body.components || []
  } finally { refreshing = false }
}
async function show() {
  error.value = ''; isOpen.value = true
  await nextTick(); if (!panel.value?.open) panel.value?.showModal()
  loading.value = true
  try { await getComponents(); selected.value = components.value.filter(c => c.id === 'bonjour' && !c.detected).map(c => c.id) }
  catch (e) { error.value = String(e) }
  finally { loading.value = false }
  if (!timer) timer = window.setInterval(() => { void getComponents().catch(e => { error.value = String(e) }) }, 1500)
}
function close() { panel.value?.close(); isOpen.value = false; if (timer) window.clearInterval(timer); timer = undefined }
async function finish() {
  try {
    const response = await fetch(`${base.value}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: true }) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    close()
  } catch (e) { error.value = String(e) }
}
async function install() {
  running.value = true; error.value = ''
  try {
    // Serial installers avoid competing UAC windows. The server owns each job
    // so downloads continue if the guide is closed or the view changes.
    for (const id of selected.value) {
      if (disposed) break
      if (components.value.find(c => c.id === id)?.detected) continue
      const response = await fetch(`${base.value}/api/components/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setup' }) })
      const body = await response.json()
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
      await getComponents()
      while (!disposed && components.value.find(c => c.id === id)?.busy) { await new Promise(resolve => window.setTimeout(resolve, 1000)); await getComponents() }
      const failed = components.value.find(c => c.id === id)
      if (failed?.progress.phase === 'error') throw new Error(failed.progress.error || 'installation_failed')
    }
  } catch (e) { error.value = String(e) }
  finally { running.value = false }
}
watch(() => runtime.connected.value, async connected => {
  if (!connected || initialized.value) return
  try {
    const response = await fetch(`${base.value}/api/setup`)
    if (!response.ok) return
    const body = await response.json(); initialized.value = true
    if (body.setup?.completed !== true) await show()
  } catch { /* reconnect or manual guide can retry */ }
}, { immediate: true })
onUnmounted(() => { disposed = true; if (timer) window.clearInterval(timer) })
defineExpose({ show })
</script>
<template>
  <dialog ref="panel" class="setup-wizard" aria-labelledby="setup-title" @cancel.prevent="close">
    <header><h2 id="setup-title">{{ words.title }}</h2><button class="secondary" type="button" @click="close">{{ words.close }}</button></header>
    <p>{{ words.intro }}</p>
    <p class="setup-note">{{ words.privacy }}</p>
    <fieldset :disabled="loading || running"><legend>{{ en ? 'Optional features' : '可选功能' }}</legend>
      <label v-for="entry in components" :key="entry.id" class="setup-component">
        <input :checked="entry.detected || entry.installKind === 'bundled' || selected.includes(entry.id)" @change="selected = ($event.target as HTMLInputElement).checked ? [...selected, entry.id] : selected.filter(id => id !== entry.id)" type="checkbox" :value="entry.id" :disabled="entry.detected || entry.installKind === 'bundled' || entry.busy || entry.restartRequired" />
        <span><strong>{{ local(entry.names) }}</strong><small>{{ local(entry.summary) }}</small><small class="setup-state" role="status">{{ status(entry) }}</small><small>{{ entry.license }}</small></span>
      </label>
    </fieldset>
    <p class="setup-note">{{ words.consent }}</p>
    <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
    <button class="secondary" type="button" :disabled="loading || running || !selected.some(id => { const c = components.find(c => c.id === id); return c && !c.detected && !c.busy && !c.restartRequired })" @click="install">{{ running ? words.installing : words.install }}</button>
    <h3>{{ en ? 'Your first connection' : '第一条音频连线' }}</h3><p>{{ words.guide }}</p><p class="setup-note">{{ words.limits }}</p>
    <footer><small>{{ words.hint }}</small><button class="primary" type="button" @click="finish">{{ words.finish }}</button></footer>
  </dialog>
</template>
<style scoped>
.setup-wizard{width:min(670px,calc(100vw - 48px));max-height:85vh;overflow:auto;padding:26px;border:1px solid var(--separator-strong);border-radius:20px;background:var(--card);color:var(--ink);box-shadow:var(--e2)}
.setup-wizard::backdrop{background:rgba(3,7,12,.8);backdrop-filter:blur(8px)}header,footer{display:flex;gap:16px;justify-content:space-between;align-items:center}h2{font-size:23px;margin:0}h3{font-size:16px;margin-top:24px}p{font-size:14px;line-height:1.7}.setup-note,footer small{color:var(--muted);font-size:12px;line-height:1.65}fieldset{border:0;padding:0;margin:20px 0}legend{font-weight:600;margin-bottom:8px}.setup-component{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid var(--separator);cursor:pointer}.setup-component input{width:19px;height:19px;flex:0 0 auto;margin-top:2px;accent-color:var(--primary)}.setup-component small{display:block;color:var(--muted);font-size:12px;line-height:1.65;margin-top:4px}.setup-component .setup-state{color:var(--primary)}.setup-error{color:var(--danger);overflow-wrap:anywhere}footer{margin-top:24px}footer small{max-width:360px}button{min-height:38px;flex-shrink:0}button:focus-visible,input:focus-visible{outline:2px solid var(--primary);outline-offset:3px}@media(max-width:550px){header,footer{align-items:flex-start;flex-direction:column}.setup-wizard{padding:20px}}
</style>
