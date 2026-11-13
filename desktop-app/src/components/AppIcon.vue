<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import {
  Activity,
  ArrowLeft,
  AudioLines,
  AudioWaveform,
  Cable,
  Check,
  CircleUserRound,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  GripVertical,
  Info,
  Mic,
  PackageCheck,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Speaker,
  Trash,
  Volume2,
  VolumeX,
} from '@lucide/vue'

const props = withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number }>(), {
  size: 16,
  strokeWidth: 1.8,
})

const icons: Record<string, Component> = {
  activity: Activity,
  arrowLeft: ArrowLeft,
  audio: AudioLines,
  waveform: AudioWaveform,
  cable: Cable,
  check: Check,
  download: Download,
  edit: Pencil,
  external: ExternalLink,
  folder: FolderOpen,
  globe: Globe,
  grip: GripVertical,
  info: Info,
  mic: Mic,
  package: PackageCheck,
  pause: Pause,
  sparkles: Sparkles,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  route: Route,
  settings: Settings,
  mixer: SlidersHorizontal,
  speaker: Speaker,
  trash: Trash,
  user: CircleUserRound,
  volume: Volume2,
  muted: VolumeX,
}

const iconComponent = computed(() => icons[props.name] ?? Activity)
</script>

<template>
  <component :is="iconComponent" class="app-icon" :size="size" :stroke-width="strokeWidth" aria-hidden="true" focusable="false" />
</template>
