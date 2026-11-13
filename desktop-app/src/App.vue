<script setup lang="ts">
import { onMounted, ref } from 'vue'
import RoutingCanvas from './components/RoutingCanvas.vue'
import SettingsPage from './components/SettingsPage.vue'
import AppIcon from './components/AppIcon.vue'
import NewSourceDialog from './components/NewSourceDialog.vue'
import SetupWizard from './components/SetupWizard.vue'
import { t } from './i18n'
import { useAudioStore, useRuntimeStore } from './stores/audio'
const audio = useAudioStore()
const runtime = useRuntimeStore()
const view = ref<'canvas' | 'settings'>('canvas')
const wizard = ref<InstanceType<typeof SetupWizard> | null>(null)
onMounted(() => audio.connect())
</script>
<template>
  <div class="app-shell">
    <main class="shell">
      <template v-if="view === 'canvas'">
        <section class="intro">
          <div>
            <h1>MeshAudio</h1>
            <p class="sub">{{ t('app.tagline') }}</p>
          </div>
          <div class="intro-actions">
            <button class="icon-btn" type="button" :title="t('app.settings')" :aria-label="t('app.settings')" @click="view = 'settings'">
              <AppIcon name="settings" :size="17" />
            </button>
            <div class="status-orb" :class="{ live: audio.onlineSources.length > 0 }" :title="audio.onlineSources.length > 0 ? t('app.serverRunning') : t('activity.empty')">
              <AppIcon name="audio" :size="20" />
            </div>
            <div class="connection"><i :class="{ disconnected: !runtime.connected.value }" /><span>{{ runtime.connected.value ? t('app.serverRunning') : t('app.serverDown') }}</span></div>
          </div>
        </section>
        <section class="stats"><div><span>{{ t('stats.onlineSources') }}</span><b>{{ audio.onlineSources.length }}</b><em class="up">{{ t('stats.realtime') }}</em></div><div><span>{{ t('stats.activeBuses') }}</span><b>{{ audio.buses.length }}</b><em>{{ t('stats.stable') }}</em></div><div><span>{{ t('stats.routes') }}</span><b>{{ audio.routes.length }}</b><em>{{ t('stats.realtime') }}</em></div><div><span>{{ t('stats.avgLatency') }}</span><b>{{ audio.averageLatency ?? '—' }}<small> ms</small></b><em class="good">{{ audio.averageLatency === null ? t('stats.waiting') : t('stats.measured') }}</em></div></section>
        <RoutingCanvas />
        <section class="bottom-grid"><div class="activity panel"><div class="panel-head"><strong>{{ t('activity.title') }}</strong><button class="text-btn">{{ t('activity.viewAll') }}</button></div><div v-if="!audio.activity.length" class="empty">{{ t('activity.empty') }}</div><div v-for="item in audio.activity" :key="item" class="activity-item"><div class="activity-icon"><AppIcon name="activity" :size="14" /></div><div class="activity-copy">{{ item }}<small>{{ t('activity.justNow') }}</small></div></div></div><div class="health panel"><div class="panel-head"><strong>{{ t('health.title') }}</strong><span class="healthy"><i />{{ runtime.connected.value ? t('health.ok') : t('health.waiting') }}</span></div><div class="health-row"><span>{{ t('health.engine') }}</span><b>{{ runtime.connected.value ? t('health.engineOk') : t('health.enginePending') }}</b><i class="bar"><u :style="{ width: runtime.connected.value ? '94%' : '15%' }" /></i></div><div class="health-row"><span>{{ t('health.lan') }}</span><b>{{ runtime.connected.value ? t('health.lanOk') : t('health.lanOff') }}</b><i class="bar"><u :style="{ width: runtime.connected.value ? '88%' : '8%' }" /></i></div><div class="health-row"><span>{{ t('health.outputs') }}</span><b>{{ t('health.outputsValue', { available: audio.outputs.filter(output => output.available).length, pending: audio.outputs.filter(output => !output.available).length }) }}</b><i class="bar"><u :style="{ width: `${audio.outputs.length ? (audio.outputs.filter(output => output.available).length / audio.outputs.length) * 100 : 0}%` }" /></i></div></div></section>
      </template>
      <SettingsPage v-else @close="view = 'canvas'" @setup="wizard?.show()" />
      <NewSourceDialog />
      <SetupWizard ref="wizard" />
    </main>
  </div>
</template>
<style scoped>
.icon-btn {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--separator);
  background: var(--block);
  color: var(--muted);
  cursor: pointer;
  transition: color .16s ease, border-color .16s ease;
}
.icon-btn:hover { color: var(--ink); border-color: var(--separator-strong); }
</style>
