<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useAudioStore } from '../stores/audio'
import { t } from '../i18n'
import AppIcon from './AppIcon.vue'
const audio = useAudioStore()
const panel = ref<HTMLDialogElement | null>(null)
watch(() => audio.connectionSource?.id, async id => {
  await nextTick()
  if (id && !panel.value?.open) panel.value?.showModal()
  if (!id && panel.value?.open) panel.value.close()
}, { immediate: true })
</script>
<template>
  <dialog ref="panel" class="new-source-dialog" aria-labelledby="new-source-title" @cancel.prevent="audio.dismissConnection()">
    <template v-if="audio.connectionSource">
      <div class="new-source-heading"><AppIcon name="audio" :size="22" /><h2 id="new-source-title">{{ t('connection.title') }}</h2></div>
      <p class="new-source-name">{{ audio.connectionSource.title }}<span>{{ audio.connectionSource.endpoint || t('source.waitingAddress') }}</span></p>
      <p>{{ t('connection.question', { bus: audio.defaultBus?.title || t('canvas.defaultBus') }) }}</p>
      <p class="connection-note">{{ t('connection.note') }}</p>
      <p v-if="!audio.defaultOutput" class="connection-note">{{ t('connection.noOutput') }}</p>
      <footer><button class="secondary" type="button" @click="audio.dismissConnection()">{{ t('connection.skip') }}</button><button class="primary" type="button" :disabled="!audio.defaultOutput || audio.connectionSource.offline" @click="audio.connectToDefault()">{{ t('connection.connect') }}</button></footer>
    </template>
  </dialog>
</template>
<style scoped>
.new-source-dialog{width:min(440px,calc(100vw - 40px));padding:26px;border:1px solid var(--separator-strong);border-radius:20px;background:var(--card);color:var(--ink);box-shadow:var(--e2)}
.new-source-dialog::backdrop{background:rgba(3,7,12,.72);backdrop-filter:blur(8px)}
.new-source-heading{display:flex;align-items:center;gap:12px;color:var(--primary)}h2{margin:0;color:var(--ink);font-size:19px}.new-source-name{font-weight:600}.new-source-name span{display:block;font:12px var(--font-num);color:var(--muted);margin-top:5px}p{line-height:1.7;font-size:14px}.connection-note{color:var(--muted);font-size:12px}footer{display:flex;gap:10px;justify-content:flex-end;margin-top:22px}button:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
</style>
