<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import type { OutputNode as Output } from '../lib/types'
import { useAudioStore } from '../stores/audio'
import { t } from '../i18n'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ output: Output }>()
const emit = defineEmits<{ finishRoute: [id: string] }>()
const audio = useAudioStore()
const editing = ref(false)
const editValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const subtitle = computed(() => {
  if (props.output.kind === 'virtual') {
    return props.output.available ? t('output.virtualReady') : t('output.virtualMissing')
  }
  if (props.output.kind === 'system') return t('output.system')
  return ''
})

function startRename() {
  editValue.value = props.output.title
  editing.value = true
  nextTick(() => inputRef.value?.select())
}
function commitRename() {
  if (editing.value) {
    audio.renameOutput(props.output, editValue.value)
    editing.value = false
  }
}
function cancelRename() {
  editing.value = false
}
</script>
<template>
  <article class="node output-node" :class="{ offline: !output.available }" :data-node-id="output.id">
    <button class="port in" data-port="in" :aria-label="t('output.portAria')" @click.stop="emit('finishRoute', output.id)" />
    <div class="node-top">
      <div class="node-icon" :class="output.iconClass"><AppIcon :name="output.icon" :size="16" /></div>
      <div>
        <template v-if="editing">
          <input
            ref="inputRef"
            v-model="editValue"
            class="rename-input"
            :placeholder="t('output.placeholder')"
            @keydown.enter="commitRename"
            @keydown.escape="cancelRename"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <div class="node-title">
            {{ output.title }}
            <button class="rename-btn" :title="t('output.rename')" :aria-label="t('output.rename')" @click.stop="startRename">
              <AppIcon name="edit" :size="11" />
            </button>
          </div>
        </template>
        <div v-if="subtitle" class="node-sub">{{ subtitle }}</div>
      </div>
    </div>
    <div v-if="output.diagnostic" class="output-diagnostic">{{ output.diagnostic }}</div>
  </article>
</template>
