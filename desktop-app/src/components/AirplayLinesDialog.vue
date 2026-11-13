<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { useAudioStore } from '../stores/audio'
import { locale } from '../i18n'

interface AirplayLine {
  id: string; index: number; name: string; sourceId: string; sourceName: string
  bridgePort: number; uxplayPort: number; state: string; pid: number | null
  error: string | null; guideUrl: string | null
  source: { id: string; online?: boolean; receiving?: boolean; address?: string } | null
  routes: [string, string][]
  paths?: { bus: string; muted: boolean; outputs: { name: string; enabled: boolean }[] }[]
  logs?: string[]
  stats?: { queuedMs: number; sent: number; underrun: number } | null
}
const props = defineProps<{ open: boolean; selectedId?: string | null }>()
const emit = defineEmits<{ close: [] }>()
const audio = useAudioStore()
const lines = ref<AirplayLine[]>([])
const error = ref('')
const busy = ref('')
const qr = ref<Record<string, string>>({})
const selectedLine = ref<string | null>(null)
const panel = ref<HTMLElement | null>(null)
const lastActionError = ref('')
const confirmRemove = ref('')
const lang = computed(() => locale.value === 'en-US')
const words = computed(() => lang.value ? {
  title: 'AirPlay receivers', sub: 'One independent receiver per iPhone. Volume and routes stay separate.',
  close: 'Close', note: 'The QR opens an iOS web microphone page and creates a separate microphone source. For AirPlay media, select this receiver manually in Control Center. Microphone access requires trusted HTTPS and Safari in the foreground.',
  empty: 'No iOS receiver lines yet.', all: 'All receivers', ip: 'Source IP', waiting: 'Waiting for connection', noRoute: 'Not connected to a bus', noOutput: 'No output connected',
  start: 'Start', stop: 'Stop', remove: 'Remove', confirm: 'Remove source and routes?', add: 'Add iOS source', done: 'Done',
  noReceiver: 'Native receiver missing. Build UxPlay first.', ready: 'Waiting for iPhone', stopped: 'Stopped', starting: 'Starting…', receiving: 'Receiving audio', connected: 'Connected, waiting for audio', fault: 'Receiver error',
  copy: 'Copy guide link', copied: 'Copied', noQr: 'No LAN guide available. Check your network and guide port.', diagnostic: 'Line diagnostics', packets: 'Packets', queue: 'Bridge queue', gap: 'Underruns', logs: 'Receiver log', muted: 'Muted', unavailable: 'Unavailable', limitation: 'DRM and call audio may be unavailable. Displayed source latency measures MeshAudio processing, not the full AirPlay delay.'
} : {
  title: 'AirPlay 接收线路', sub: '每台 iPhone 使用独立接收端，音量与路由分别控制。',
  close: '关闭', note: '扫码打开 iOS 网页麦克风页面，推流会创建独立的麦克风来源。接收 AirPlay 媒体仍需在控制中心手动选择本线路。网页麦克风需要可信 HTTPS，并保持 Safari 前台。',
  empty: '还没有添加 iOS 接收线路。', all: '全部线路', ip: '来源 IP', waiting: '等待连接', noRoute: '未连接到通道', noOutput: '未连接输出',
  start: '启动', stop: '停止', remove: '移除', confirm: '确认移除来源和连线？', add: '添加 iOS 源', done: '完成',
  noReceiver: '尚未集成原生接收器，请先完成 UxPlay 构建。', ready: '等待 iPhone 连接', stopped: '已停止', starting: '正在启动…', receiving: '正在接收音频', connected: '已连接，等待音频', fault: '接收器故障',
  copy: '复制引导链接', copied: '已复制', noQr: '暂无局域网引导页，请检查网络及引导页端口。', diagnostic: '线路诊断', packets: '音频包', queue: '桥接缓存', gap: '缺帧补静音', logs: '接收端日志', muted: '已静音', unavailable: '不可用', limitation: 'DRM 和通话音频可能不可用。来源显示的延迟为 MeshAudio 内部实测值，不包含完整 AirPlay 延迟。'
})
const visibleLines = computed(() => selectedLine.value ? lines.value.filter(line => line.id === selectedLine.value) : lines.value)
const copied = ref('')
let loading = false
let previousFocus: HTMLElement | null = null
let timer: number | undefined

const base = computed(() => `http://127.0.0.1:${Number(audio.server.controlPort) || 4173}`)
function renderQr(line: AirplayLine) {
  if (!line.guideUrl || typeof window.qrcode !== 'function') return ''
  try { const code = window.qrcode(0, 'M'); code.addData(line.guideUrl); code.make(); return code.createSvgTag({ cellSize: 3, margin: 3, scalable: true }) } catch { return '' }
}
async function load() {
  if (loading) return
  loading = true
  try {
    const response = await fetch(`${base.value}/api/airplay-lines`, { signal: AbortSignal.timeout(6000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    lines.value = result.lines as AirplayLine[]
    qr.value = Object.fromEntries(lines.value.map(line => [line.id, renderQr(line)]))
    error.value = !result.receiver ? words.value.noReceiver : result.guideError || ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading = false }
}
async function request(path: string, body?: unknown) {
  busy.value = path
  try {
    const response = await fetch(`${base.value}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`)
    await load()
  } catch (cause) { lastActionError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = '' }
}
async function addLine() {
  busy.value = 'add'
  try {
    const response = await fetch(`${base.value}/api/airplay-lines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`)
    await load()
    selectedLine.value = result.line.id
    await request(`/api/airplay-lines/${result.line.id}/start`)
  } catch (cause) { lastActionError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = '' }
}
function sourceStatus(line: AirplayLine) {
  return line.source?.receiving ? words.value.receiving : line.state === 'connected' ? words.value.connected : line.state === 'ready' ? words.value.ready : line.state === 'stopped' ? words.value.stopped : line.state === 'starting' ? words.value.starting : words.value.fault
}
async function remove(line: AirplayLine) {
  if (confirmRemove.value !== line.id) { confirmRemove.value = line.id; return }
  await request(`/api/airplay-lines/${line.id}/remove`)
  selectedLine.value = null; confirmRemove.value = ''
}
async function copyLink(line: AirplayLine) { try { await navigator.clipboard.writeText(line.guideUrl || ''); copied.value = line.id } catch { /* The URL remains selectable. */ } }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  const items = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a, input, summary, [tabindex="0"]') || [])]
  const first = items[0], last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(() => [props.open, props.selectedId] as const, ([open]) => {
  if (timer) { clearInterval(timer); timer = undefined }
  selectedLine.value = props.selectedId || null
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    lastActionError.value = ''; confirmRemove.value = ''
    void load(); timer = window.setInterval(load, 2500)
    void nextTick(() => panel.value?.querySelector<HTMLButtonElement>('button')?.focus())
  } else { previousFocus?.focus(); previousFocus = null }
}, { immediate: true })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div v-if="open" class="line-mask" @click.self="emit('close')">
    <section ref="panel" class="line-dialog" role="dialog" aria-modal="true" aria-labelledby="airplay-lines-title" @keydown="onKeydown">
      <header><div><h2 id="airplay-lines-title">{{ words.title }}</h2><p>{{ words.sub }}</p></div><button class="icon-button" :aria-label="words.close" @click="emit('close')">×</button></header>
      <p v-if="error || lastActionError" class="line-error" role="alert">{{ lastActionError || error }}</p>
      <p class="line-note">{{ words.note }}</p>
      <button v-if="selectedLine && !props.selectedId" class="line-button" @click="selectedLine = null">← {{ words.all }} ({{ lines.length }})</button>
      <div v-if="!lines.length" class="line-empty">{{ words.empty }}</div>
      <article v-for="line in visibleLines" :key="line.id" class="line-row">
        <div class="line-main"><div class="line-description"><strong>{{ line.name }}</strong><span role="status">{{ sourceStatus(line) }}</span><small>{{ words.ip }}: {{ line.source?.address || words.waiting }}</small><small v-if="!line.paths?.length">{{ words.noRoute }}</small><small v-for="(route, index) in line.paths" :key="index">{{ line.sourceName }} → {{ route.bus }}{{ route.muted ? ` (${words.muted})` : '' }} → {{ route.outputs.length ? route.outputs.map(output => `${output.name}${output.enabled ? '' : ` (${words.unavailable})`}`).join(' / ') : words.noOutput }}</small><small v-if="line.error" class="line-error">{{ line.error }}</small><template v-if="line.guideUrl"><code class="guide-url">{{ line.guideUrl }}</code><button class="line-button" @click="copyLink(line)">{{ copied === line.id ? words.copied : words.copy }}</button></template><small v-else>{{ words.noQr }}</small></div><div v-if="qr[line.id]" class="line-qr" role="img" :aria-label="`${line.name} QR`" v-html="qr[line.id]" /></div>
        <div class="line-actions"><button class="line-button primary" :disabled="!!busy || ['starting', 'ready', 'connected'].includes(line.state)" @click="lastActionError = ''; request(`/api/airplay-lines/${line.id}/start`)"><AppIcon name="play" :size="14" />{{ words.start }}</button><button class="line-button" :disabled="!!busy || line.state === 'stopped'" @click="lastActionError = ''; request(`/api/airplay-lines/${line.id}/stop`)"><AppIcon name="pause" :size="14" />{{ words.stop }}</button><button class="line-button danger" :disabled="!!busy" @click="remove(line)"><AppIcon name="trash" :size="14" />{{ confirmRemove === line.id ? words.confirm : words.remove }}</button></div>
        <details class="line-diagnostics"><summary>{{ words.diagnostic }}</summary><p>PCM: 127.0.0.1:{{ line.bridgePort }} · AirPlay TCP/UDP: {{ line.uxplayPort }}–{{ line.uxplayPort + 2 }}</p><p v-if="line.stats">{{ words.packets }}: {{ line.stats.sent }} · {{ words.queue }}: {{ line.stats.queuedMs }} ms · {{ words.gap }}: {{ line.stats.underrun }}</p><pre :aria-label="words.logs">{{ line.logs?.join('\n') || '—' }}</pre></details>
      </article>
      <p class="line-note">{{ words.limitation }}</p>
      <footer><button v-if="!props.selectedId" class="line-button primary" :disabled="!!busy || lines.length >= 8" @click="lastActionError = ''; addLine()"><AppIcon name="plus" :size="14" />{{ words.add }}</button><button class="line-button" @click="emit('close')">{{ words.done }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.line-mask{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:20px;background:rgba(3,7,12,.78);backdrop-filter:blur(12px)}
.line-dialog{width:min(740px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:24px;border:1px solid rgba(210,226,248,.16);border-radius:18px;background:linear-gradient(145deg,rgba(25,36,52,.97),rgba(10,15,23,.98));color:#eaf0f8}
.line-description{min-width:0;flex:1}.guide-url{display:block;overflow-wrap:anywhere;margin:10px 0;color:#c0d7f6;font-size:12px}.line-qr{flex:0 0 152px;width:152px!important;height:152px!important;box-sizing:border-box}.line-actions{flex-wrap:wrap}.line-button{min-height:38px}.line-button:focus-visible,.icon-button:focus-visible,summary:focus-visible{outline:2px solid #9bc8ff;outline-offset:3px}.line-diagnostics{margin-top:12px;font-size:12px;color:#b5c3d8}.line-diagnostics summary{cursor:pointer;padding:6px 0}.line-diagnostics pre{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:rgba(0,0,0,.2);border-radius:9px}.line-diagnostics p{overflow-wrap:anywhere}@media(max-width:550px){.line-main{flex-direction:column}.line-dialog{padding:18px}.line-qr{align-self:center}footer{flex-wrap:wrap}}
header,.line-main,footer,.line-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}header{align-items:flex-start;margin-bottom:15px}h2{margin:0;font-size:20px}header p,.line-note{color:#9eabc0;font-size:13px;line-height:1.6}.icon-button{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}.line-note{padding:10px 12px;border-radius:10px;background:rgba(127,170,224,.08)}.line-row{padding:14px 0;border-top:1px solid rgba(210,226,248,.12)}.line-row.selected{background:rgba(76,128,198,.08)}.line-main{align-items:flex-start}.line-main strong,.line-main span,.line-main small{display:block}.line-main span{margin-top:5px;color:#8bd5b2;font-size:13px}.line-main small{margin-top:4px;color:#9eabc0;font-size:12px}.line-qr{width:112px;height:112px;padding:7px;border-radius:10px;background:white;color:#10151c}.line-qr :deep(svg){width:100%;height:100%}.line-actions{justify-content:flex-start;margin-top:12px}.line-button{display:inline-flex;align-items:center;gap:6px;padding:8px 11px;border:1px solid rgba(210,226,248,.17);border-radius:9px;background:rgba(225,236,250,.06);color:inherit;cursor:pointer}.line-button.primary{background:#d5e4fa;color:#182335}.line-button.danger{color:#ff9c9c}.line-button:disabled{opacity:.45;cursor:default}.line-error{color:#ff9c9c!important}.line-empty{padding:24px;text-align:center;color:#9eabc0}footer{justify-content:flex-end;margin-top:14px}
</style>
