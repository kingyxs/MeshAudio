<script setup lang="ts">
import type { BusNode as Bus } from '../lib/types'
import { useAudioStore } from '../stores/audio'
import { ref, nextTick, onUnmounted } from 'vue'
import { t } from '../i18n'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ bus: Bus; pending: string | null }>()
const emit = defineEmits<{ startRoute: [id: string]; finishRoute: [id: string] }>()
const audio = useAudioStore()
const editing = ref(false)
const editValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

function startRename() {
  editValue.value = props.bus.title
  editing.value = true
  nextTick(() => inputRef.value?.select())
}
function commitRename() {
  if (editing.value) {
    audio.renameBus(props.bus, editValue.value)
    editing.value = false
  }
}
function cancelRename() {
  editing.value = false
}

// Two-step delete: native confirm() is unreliable inside the Tauri webview, so
// the button arms on the first click and deletes on the second within 8 s.
const armed = ref(false)
let disarmTimer: number | undefined
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
  audio.deleteBus(props.bus)
}
onUnmounted(() => {
  if (disarmTimer) window.clearTimeout(disarmTimer)
})
</script>
<template>
  <article class="node bus-node" :data-node-id="bus.id">
    <button class="port in" data-port="in" :aria-label="t('bus.portAria')" @click.stop="pending ? emit('finishRoute', bus.id) : undefined" />
    <div class="node-top">
      <div class="node-icon"><AppIcon name="mixer" :size="16" /></div>
      <div>
        <template v-if="editing">
          <input
            ref="inputRef"
            v-model="editValue"
            class="rename-input"
            :placeholder="t('bus.placeholder')"
            @keydown.enter="commitRename"
            @keydown.escape="cancelRename"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <div class="node-title">
            {{ bus.title }}
            <button class="rename-btn" :title="t('bus.rename')" :aria-label="t('bus.rename')" @click.stop="startRename">
              <AppIcon name="edit" :size="11" />
            </button>

          </div>
        </template>
        <div class="node-sub">{{ t('bus.sub') }} · {{ bus.muted ? t('bus.muted') : t('bus.running') }}</div>
      </div>

    </div>
    <div class="node-actions">
      <button class="node-action mute-action" :class="{ active: bus.muted }" :title="bus.muted ? t('bus.restoreTitle') : t('bus.muteTitle')" :aria-label="bus.muted ? t('bus.restoreTitle') : t('bus.muteTitle')" @click="audio.toggleBusMute(bus)">
        <AppIcon :name="bus.muted ? 'muted' : 'volume'" :size="13" />
        <small>{{ bus.muted ? t('bus.restore') : t('bus.mute') }}</small>
      </button>
      <button class="node-action delete-action" :class="{ armed }" type="button" :title="armed ? t('bus.deleteArmed') : t('bus.delete')" :aria-label="armed ? t('bus.deleteArmed') : t('bus.delete')" @click.stop="onDelete"><AppIcon :name="armed ? 'check' : 'trash'" :size="12" /><small>{{ armed ? t('node.confirmDelete') : t('node.delete') }}</small></button>
    </div>
    <div class="bus-controls">
      <label>{{ t('bus.gain') }}</label>
      <input class="range" type="range" min="-60" max="12" step="0.5" :value="bus.gain" :aria-label="t('bus.gainAria')" @input="audio.setBusGain(bus, Number(($event.target as HTMLInputElement).value))" />
      <span class="gain-value">{{ bus.gain.toFixed(1) }} dB</span>
      <button class="port" data-port="out" :aria-label="t('bus.portAria')" @click.stop="pending ? emit('finishRoute', bus.id) : emit('startRoute', bus.id)" />
    </div>
  </article>
</template>
