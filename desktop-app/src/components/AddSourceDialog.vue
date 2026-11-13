<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAudioStore } from '../stores/audio'
import { t } from '../i18n'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; openSettings: []; openIos: [] }>()
const audio = useAudioStore()
const selected = ref('')
const copied = ref('')
const qr = ref('')
declare global {
  interface Window {
    qrcode?: (typeNumber: number, level: string) => {
      addData: (data: string) => void
      make: () => void
      createSvgTag: (options: { cellSize?: number; margin?: number; scalable?: boolean }) => string
    }
  }
}
const addresses = computed(() => [...new Set((Array.isArray(audio.server.addresses) ? audio.server.addresses : []).filter((ip: unknown): ip is string => typeof ip === 'string' && !ip.startsWith('169.254.')))] as string[])
const gateway = computed(() => audio.server.browserAudio?.gateway)
const port = computed(() => Number(gateway.value?.port) || 4176)
const address = computed(() => addresses.value.includes(selected.value) ? selected.value : addresses.value[0] || '')
const url = computed(() => address.value ? 'http://' + address.value + ':' + port.value + '/ios-node.html' : '')
const setupUrl = computed(() => address.value && gateway.value?.port ? `http://${address.value}:${gateway.value.port}/ios-node.html` : '')
function draw() {
  qr.value = ''
  if (!url.value || typeof window.qrcode !== 'function') return
  try { const code = window.qrcode(0, 'M'); code.addData(url.value); code.make(); qr.value = code.createSvgTag({ cellSize: 4, margin: 6, scalable: true }) } catch { /* readable URL remains */ }
}
function choose(ip: string) { selected.value = ip }
async function copyText(text: string, key: string) {
  try { await navigator.clipboard.writeText(text); copied.value = key; setTimeout(() => copied.value = '', 1600) } catch { /* readable URL remains */ }
}
watch([() => props.open, url], () => { if (props.open) draw() }, { immediate: true })
</script>
<template>
  <div v-if="open" class="add-source-mask" @click.self="emit('close')">
    <section class="add-source" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
      <header class="add-source-head"><div><h2 id="add-source-title">{{ t('addSource.title') }}</h2><p>{{ t('addSource.subtitle') }}</p></div><button class="close" type="button" :aria-label="t('addSource.close')" @click="emit('close')">×</button></header>
      <div class="tabs"><button class="active" type="button">{{ t('addSource.tabBrowser') }}</button><button type="button" @click="emit('openIos')">{{ t('addSource.tabAirplay') }}</button></div>
        <div class="add-source-body">
          <div v-if="qr" class="qr" v-html="qr" />
          <div v-else class="qr placeholder">{{ t('addSource.qrFailed') }}</div>

          <div class="meta">
            <code class="url">{{ url || t('addSource.urlLoading') }}</code>
            <button class="copy" type="button" :disabled="!url" @click="copyText(url, 'url')">
              {{ copied === 'url' ? t('addSource.copied') : t('addSource.copyLink') }}
            </button>
            <div v-if="addresses.length > 1" class="alts">
              <span>{{ t('addSource.nics') }}</span>
              <button
                v-for="ip in addresses"
                :key="ip"
                type="button"
                :class="{ active: ip === address }"
                @click="choose(ip)"
              >{{ ip }}</button>
            </div>
          </div>
        </div>

        <p v-if="!addresses.length" class="note danger">{{ t('addSource.noAddress') }}</p>
        <p v-else class="note warn">{{ t('addSource.httpWarn') }}<a v-if="setupUrl" :href="setupUrl" target="_blank" rel="noopener">{{ t('addSource.certificateHelp') }}</a></p>
      <footer class="add-source-foot"><button class="ghost" type="button" @click="emit('close')">{{ t('addSource.close') }}</button></footer>
    </section>
  </div>
</template>
<style scoped>
.add-source-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, .62);
  backdrop-filter: blur(8px);
}
.add-source {
  width: min(560px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--separator-strong);
  border-radius: var(--r-card);
  box-shadow: var(--e2);
  padding: 22px 22px 18px;
  color: var(--ink);
}
.add-source-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
}
.add-source-head h2 { font: 600 18px/1.3 var(--font); margin: 0 0 4px; }
.add-source-head p { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
.close {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 1px solid var(--separator);
  background: var(--block);
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { color: var(--ink); }
.tabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  background: var(--inset);
  border: 1px solid var(--separator);
  border-radius: 12px;
  margin-bottom: 16px;
}
.tabs button {
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--muted);
  border-radius: 9px;
  padding: 8px 10px;
  font-size: 12.5px;
  cursor: pointer;
}
.tabs button.active { background: var(--block); color: var(--ink); }
.add-source-body {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 16px;
  align-items: start;
}
.qr { background: #fff; border-radius: 16px; padding: 8px; line-height: 0; }
.qr :deep(svg) { width: 100%; height: auto; display: block; }
.qr.placeholder {
  display: grid;
  place-items: center;
  height: 160px;
  color: #888;
  font-size: 12px;
  text-align: center;
  line-height: 1.5;
}
.meta { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.url {
  font: 11.5px/1.6 var(--font-num);
  color: var(--muted);
  overflow-wrap: anywhere;
  word-break: normal;
  background: var(--inset);
  border: 1px solid var(--separator);
  border-radius: 10px;
  padding: 8px 10px;
}
.copy {
  align-self: flex-start;
  border: 1px solid var(--separator-strong);
  background: var(--block);
  color: var(--ink);
  border-radius: 10px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
.copy:disabled { opacity: .45; cursor: not-allowed; }
.alts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--soft); }
.alts button {
  border: 1px solid var(--separator);
  background: var(--inset);
  color: var(--muted);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
.alts button.active { border-color: var(--primary); color: var(--primary); }
.note { margin: 14px 0 0; font-size: 12px; line-height: 1.6; border-radius: 10px; padding: 9px 11px; }
.note.warn { background: var(--warning-soft); color: var(--warning); }
.note.danger { background: var(--danger-soft); color: var(--danger); }
.add-source-foot { display: flex; justify-content: flex-end; margin-top: 14px; }
.ghost {
  border: 1px solid var(--separator-strong);
  background: transparent;
  color: var(--muted);
  border-radius: 10px;
  padding: 7px 16px;
  font-size: 12.5px;
  cursor: pointer;
}
.ghost:hover { color: var(--ink); }
.ghost.small { padding: 6px 12px; font-size: 12px; }
.ap { display: flex; flex-direction: column; gap: 8px; }
.ap-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  padding: 8px 10px;
  background: var(--inset);
  border: 1px solid var(--separator);
  border-radius: 10px;
}
.ap-row span { color: var(--muted); }
.ap-row strong { font-weight: 500; }
.ap-row strong.ok { color: var(--success); }
.ap-row strong.muted { color: var(--soft); }
.ap-path {
  font: 10.5px/1.5 var(--font-num);
  color: var(--soft);
  overflow-wrap: anywhere;
  padding: 0 4px;
}
.ap-actions { display: flex; gap: 8px; margin-top: 2px; }
.ap-qr { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 10px 12px;
         background: var(--inset); border: 1px solid var(--separator); border-radius: 12px; }
.ap-qr .qr { background: #fff; border-radius: 10px; padding: 6px; line-height: 0; flex: 0 0 auto; }
.ap-qr .qr :deep(svg) { width: 96px; height: 96px; display: block; }
.ap-qr .qr-hint { font-size: 12px; line-height: 1.6; color: var(--muted); }
.ap-help {
  margin-top: 6px;
  padding: 11px 12px;
  background: var(--inset);
  border: 1px solid var(--separator);
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.ap-help p { margin: 0 0 6px; }
.ap-help strong { color: var(--ink); font-weight: 500; margin-right: 4px; }
.ap-help code { color: var(--muted); font-family: var(--font-num); overflow-wrap: anywhere; }
.ap-help .cmd {
  display: block;
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--page);
  border-radius: 8px;
  font-size: 10.5px;
  line-height: 1.6;
}
.ap-components { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ap-components span { flex: 1; min-width: 180px; color: var(--soft); font-size: 11px; line-height: 1.55; }
@media (max-width: 520px) {
  .add-source-body { grid-template-columns: 130px 1fr; gap: 12px; }
}
</style>
