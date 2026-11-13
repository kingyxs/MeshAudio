<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { SourceNode as Source } from '../lib/types'
import { useAudioStore } from '../stores/audio'
import { t, type MessageKey } from '../i18n'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ source: Source; pending: string | null }>()
const emit = defineEmits<{ startRoute: [id: string]; finishRoute: [id: string]; openAirplayDetails: [id: string] }>()
const audio = useAudioStore()
const armed = ref(false)
let disarmTimer: number | undefined

const streamLabel = computed(() => t(`source.type.${props.source.streamType ?? 'unknown'}` as MessageKey))
const deviceLabel = computed(() => t(`source.device.${props.source.deviceType}` as MessageKey))
const statusLabel = computed(() => t(`source.status.${props.source.statusKey}` as MessageKey))
const latencyText = computed(() => {
  if (props.source.offline) return t('source.offlineShort')
  return props.source.latencyMs === null ? '— ms' : `${props.source.latencyMs} ms`
})

// dB <-> linear conversion (professional audio standard)
// gain (linear) = 10^(dB/20), dB = 20*log10(gain)
function linearToDb(gain: number): number {
  if (gain <= 0) return -60
  return Math.max(-60, Math.min(12, 20 * Math.log10(gain)))
}
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}
function onDelete() {
  if (!armed.value) {
    armed.value = true
    if (disarmTimer) window.clearTimeout(disarmTimer)
    disarmTimer = window.setTimeout(() => { armed.value = false }, 8000)
    return
  }
  if (disarmTimer) window.clearTimeout(disarmTimer)
  disarmTimer = undefined
  armed.value = false
  audio.deleteSource(props.source)
}
onUnmounted(() => { if (disarmTimer) window.clearTimeout(disarmTimer) })
function onGainInput(source: Source, event: Event) {
  const db = Number((event.target as HTMLInputElement).value)
  audio.setSourceGain(source, dbToLinear(db))
}
</script>
<template>
  <article class="node" :class="{ offline: source.offline }" :data-node-id="source.id">
    <div class="node-top">
      <div class="node-icon" :class="source.iconClass"><AppIcon :name="source.icon" :size="16" /></div>
      <div class="node-info">
        <div class="node-title">{{ source.title || t('source.unknownDevice') }}</div>
        <div class="node-sub">{{ streamLabel }} · {{ deviceLabel }} · {{ source.endpoint || t('source.waitingAddress') }}</div>
      </div>
      <div class="node-status"><i />{{ statusLabel }}</div>
    </div>
    <div class="node-actions">
      <button v-if="source.airplayLineId" class="node-action" type="button" :title="t('source.connectionDetails')" :aria-label="t('source.connectionDetails')" @click="emit('openAirplayDetails', source.airplayLineId)"><AppIcon name="info" :size="12" /><small>{{ t('source.connectionDetails') }}</small></button>
      <button class="node-action delete-action delete-source" :class="{ armed }" type="button" :title="armed ? t('source.deleteArmed') : t('source.delete')" :aria-label="armed ? t('source.deleteArmed') : t('source.delete')" @click="onDelete"><AppIcon :name="armed ? 'check' : 'trash'" :size="12" /><small>{{ armed ? t('node.confirmDelete') : t('node.delete') }}</small></button>
      <button v-if="source.streamType === 'microphone'" class="node-action enhance-action" :class="{ active: source.voiceEnhanced }" :title="source.voiceEnhanced ? t('source.enhanceOn') : t('source.enhanceOff')" @click="audio.toggleVoiceEnhanced(source)"><AppIcon name="sparkles" :size="12" /><small>{{ t('source.enhance') }}</small></button>
      <button class="node-action mute-action" :class="{ active: source.muted }" :title="source.muted ? t('source.restore') : t('source.mute')" @click="audio.toggleSourceMute(source)"><AppIcon :name="source.muted ? 'muted' : 'volume'" :size="12" /><small>{{ source.muted ? t('source.restore') : t('source.mute') }}</small></button>
      <button v-if="!source.stopped" class="node-action stop-action" :title="t('source.pause')" @click="audio.stopSource(source)"><AppIcon name="pause" :size="12" /><small>{{ t('source.pause') }}</small></button>
      <button v-else class="node-action start-action" :title="t('source.start')" @click="audio.startSource(source)"><AppIcon name="play" :size="12" /><small>{{ t('source.start') }}</small></button>
    </div>
    <div class="node-meta">
      <span class="meta-fmt">{{ source.offline ? '—' : t('source.format', { khz: source.rateKhz, channels: source.channels }) }}</span>
      <span class="latency" :title="t('source.latencyTitle')">{{ latencyText }}</span>
    </div>
    <div class="node-gain">
      <input class="source-gain" type="range" min="-60" max="12" step="0.5" :value="linearToDb(source.gain)" :aria-label="t('source.gainAria')" @input="onGainInput(source, $event)" />
      <span class="gain-db">{{ linearToDb(source.gain).toFixed(1) }} dB</span>
    </div>
    <div class="meter" :class="{ warn: source.offline }" :title="t('source.levelTitle', { level: source.level })"><i :style="{ width: `${source.level}%` }" /></div>
    <button class="port" data-port="out" :aria-label="t('source.portAria')" @click.stop="pending ? emit('finishRoute', source.id) : emit('startRoute', source.id)" />
  </article>
</template>
