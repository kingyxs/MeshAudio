<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { bezierPath, edgeForPorts, type Point, type PortSide } from '../lib/routing'
import { useAudioStore } from '../stores/audio'
import { t } from '../i18n'
import AppIcon from './AppIcon.vue'
import { layoutCards } from '../lib/canvas-layout'
import AirplayLinesDialog from './AirplayLinesDialog.vue'

const audio = useAudioStore()
const workspace = ref<HTMLElement | null>(null)
const scrollport = ref<HTMLElement | null>(null)
const canvasFocused = ref(false)
const canvas = ref<HTMLElement | null>(null)
const svg = ref<SVGElement | null>(null)
const pending = ref<string | null>(null)
const pendingSide = ref<PortSide>('out')
const wireDrag = ref<{ id: string; side: PortSide; pointerId: number; capture: HTMLElement } | null>(null)
const wireCursor = ref<Point>({ x: 0, y: 0 })
const wireTarget = ref<{ id: string; side: PortSide } | null>(null)
const routeFeedback = ref('')
let lastClient = { x: 0, y: 0 }
const graph = computed(() => ({ sourceIds: new Set(audio.sources.map(s => s.id)), busIds: new Set(audio.buses.map(b => b.id)), outputs: new Map(audio.outputs.map(o => [o.id, { enabled: o.enabled }])) }))
const routeStart = computed(() => wireDrag.value || (pending.value ? { id: pending.value, side: pendingSide.value } : null))
const proposedEdge = computed(() => routeStart.value && wireTarget.value ? edgeForPorts(routeStart.value, wireTarget.value, graph.value) : null)
const duplicateEdge = computed(() => proposedEdge.value && audio.routes.some(([a, b]) => a === proposedEdge.value![0] && b === proposedEdge.value![1]))
const previewPath = computed(() => {
  const start = wireDrag.value
  if (!start) return ''
  const origin = points.value[start.id]?.[start.side]
  const target = proposedEdge.value && wireTarget.value ? points.value[wireTarget.value.id]?.[wireTarget.value.side] : wireCursor.value
  return origin && target ? (start.side === 'out' ? bezierPath(origin, target) : bezierPath(target, origin)) : ''
})
const routeHelp = computed(() => routeStart.value ? wireTarget.value ? !proposedEdge.value ? t('canvas.route.invalid') : duplicateEdge.value ? t('canvas.route.exists') : t('canvas.route.release') : pending.value ? routeFeedback.value || t('canvas.help.pickTarget') : t('canvas.route.dragging') : routeFeedback.value || t('canvas.help.connectHint'))
function portOf(element: EventTarget | null): { id: string; side: PortSide; element: HTMLElement } | null {
  if (!(element instanceof Element)) return null
  const port = element.closest<HTMLElement>('[data-port]')
  const id = port?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
  return port && id && canvas.value?.contains(port) ? { id, side: port.dataset.port as PortSide, element: port } : null
}
function portClass(id: string, side: PortSide) {
  const start = routeStart.value
  if (!start) return ''
  if (start.id === id && start.side === side) return 'route-origin'
  const valid = !!edgeForPorts(start, { id, side }, graph.value)
  return [valid ? 'route-compatible' : 'route-incompatible', wireTarget.value?.id === id && wireTarget.value.side === side ? (valid ? 'route-target' : 'route-rejected') : ''].join(' ')
}
function paintPorts() {
  canvas.value?.querySelectorAll<HTMLElement>('[data-port]').forEach(port => {
    port.classList.remove('route-origin', 'route-compatible', 'route-incompatible', 'route-target', 'route-rejected')
    const p = portOf(port)
    if (p) port.classList.add(...portClass(p.id, p.side).split(' ').filter(Boolean))
  })
}
watch([routeStart, wireTarget, graph], () => { void nextTick(paintPorts) })
function startWire(event: PointerEvent) {
  const port = portOf(event.target)
  if (!port || event.button !== 0 || !event.isPrimary) return
  event.preventDefault(); event.stopPropagation()
  cancelRoute(); finishDrag()
  port.element.focus({ preventScroll: true })
  wireDrag.value = { id: port.id, side: port.side, pointerId: event.pointerId, capture: port.element }
  lastClient = { x: event.clientX, y: event.clientY }
  port.element.setPointerCapture(event.pointerId)
  updatePoints(); updateWirePointer()
}
function updateWirePointer() {
  if (!wireDrag.value || !canvas.value) return
  const bounds = canvas.value.getBoundingClientRect()
  wireCursor.value = { x: lastClient.x - bounds.left, y: lastClient.y - bounds.top }
  const target = portOf(document.elementFromPoint(lastClient.x, lastClient.y))
  wireTarget.value = target && !(target.id === wireDrag.value.id && target.side === wireDrag.value.side) ? { id: target.id, side: target.side } : null
}
function finishWire(event: PointerEvent) {
  const drag = wireDrag.value
  if (!drag || event.pointerId !== drag.pointerId) return
  lastClient = { x: event.clientX, y: event.clientY }; updateWirePointer()
  const edge = proposedEdge.value
  const exists = duplicateEdge.value
  const invalid = !!wireTarget.value && !edge
  cancelRoute()
  if (edge && !exists) audio.connectRoute(edge)
  routeFeedback.value = t(exists ? 'canvas.route.exists' : edge ? 'canvas.route.connected' : invalid ? 'canvas.route.invalid' : 'canvas.route.cancelled')
}
function onPortClick(event: MouseEvent) {
  const port = portOf(event.target)
  if (!port) return
  event.preventDefault(); event.stopPropagation()
  // Pointer connections commit only on release; keyboard activation remains usable.
  if (event.detail !== 0) return
  if (!pending.value) { pending.value = port.id; pendingSide.value = port.side; selectedRoute.value = null; routeFeedback.value = ''; return }
  const edge = edgeForPorts({ id: pending.value, side: pendingSide.value }, port, graph.value)
  if (edge) { audio.connectRoute(edge); cancelRoute(); routeFeedback.value = t('canvas.route.connected') }
  else routeFeedback.value = t('canvas.route.invalid')
}
function abortPointer() { cancelRoute(); finishDrag(); canvasFocused.value = false }
function activateCanvas(event: PointerEvent) {
  canvasFocused.value = true
  if (!(event.target instanceof Element) || !event.target.closest('button,input,select,textarea,a,[contenteditable="true"]')) canvas.value?.focus({ preventScroll: true })
}
function leaveCanvas(event: PointerEvent) {
  if (event.target instanceof Node && !workspace.value?.contains(event.target)) { canvasFocused.value = false; cancelRoute() }
}
function onCanvasFocusout(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !scrollport.value?.contains(event.relatedTarget)) canvasFocused.value = false
}
function releaseCanvasFocus() {
  canvasFocused.value = false
  if (document.activeElement && scrollport.value?.contains(document.activeElement)) workspace.value?.focus({ preventScroll: true })
}
function onCanvasWheel(event: WheelEvent) {
  if (canvasFocused.value || event.ctrlKey) return
  // A scrollable descendant normally consumes the wheel before the page can
  // see it. Forward inactive-canvas deltas through the OUTER scroll chain.
  event.preventDefault()
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1
  let x = event.deltaX * scale, y = event.deltaY * scale
  for (let outer = scrollport.value?.parentElement; outer; outer = outer.parentElement) {
    const style = getComputedStyle(outer)
    const isPage = outer === document.scrollingElement
    const beforeY = outer.scrollTop, beforeX = outer.scrollLeft
    if (isPage || /auto|scroll/.test(style.overflowY)) outer.scrollTop += y
    if (isPage || /auto|scroll/.test(style.overflowX)) outer.scrollLeft += x
    y -= outer.scrollTop - beforeY; x -= outer.scrollLeft - beforeX
    if (Math.abs(x) < .5 && Math.abs(y) < .5) break
  }
}
const showAirplayLines = ref(false)
const selectedAirplayLine = ref<string | null>(null)
const points = ref<Record<string, { out?: Point; in?: Point }>>({})
const selectedRoute = ref<number | null>(null)
const selectedMidpoint = computed(() => {
  const edge = selectedRoute.value === null ? null : audio.routes[selectedRoute.value]
  if (!edge) return null
  const from = points.value[edge[0]]?.out, to = points.value[edge[1]]?.in
  // The symmetric horizontal control offsets in bezierPath cancel at t=.5.
  return from && to ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } : null
})
let frame = 0
let observer: ResizeObserver | undefined

const positions = ref<Record<string, number>>({})
const heights = ref<Record<string, number>>({})
const hoveredNode = ref<string | null>(null)
const drag = ref<{ id: string; startY: number; startTop: number } | null>(null)
const preferredCard = ref<string | undefined>()
const observedCards = new WeakSet<HTMLElement>()
try {
  const saved = JSON.parse(localStorage.getItem('meshaudio.canvas.positions.v1') || '{}')
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) positions.value = saved
} catch { /* fresh layout */ }
const columnIds = computed(() => [audio.sources.map(item => item.id), audio.buses.map(item => item.id), audio.outputs.map(item => item.id)])
const layout = computed(() => Object.assign({}, ...columnIds.value.map((ids, index) => layoutCards(ids.map(id => ({ id, height: heights.value[id] || [190, 155, 125][index]! })), positions.value, 20, preferredCard.value))) as Record<string, number>)
const laneHeight = computed(() => Math.max(390, ...Object.entries(layout.value).map(([id, top]) => top + (heights.value[id] || 190) + 20)))
const unroutedCount = computed(() => audio.onlineSources.filter(source => !audio.hasOutputPath(source.id)).length)
function rememberPositions() { try { localStorage.setItem('meshaudio.canvas.positions.v1', JSON.stringify(positions.value)) } catch { /* nonpersistent browser */ } }
function measureCards() {
  let changed = false
  const sizes = { ...heights.value }
  canvas.value?.querySelectorAll<HTMLElement>('[data-card-id]').forEach(card => { if (observer && !observedCards.has(card)) { observer.observe(card); observedCards.add(card) }; const id = card.dataset.cardId!; if (Math.abs((sizes[id] || 0) - card.offsetHeight) > 1) { sizes[id] = card.offsetHeight; changed = true } })
  if (changed) heights.value = sizes
  schedulePoints()
}
function startDrag(id: string, event: PointerEvent) {
  if (event.button !== 0) return
  positions.value = { ...positions.value, ...layout.value }
  drag.value = { id, startY: event.clientY, startTop: layout.value[id] || 0 }
  preferredCard.value = id
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  selectedRoute.value = null
}
function moveDrag(event: PointerEvent) {
  if (wireDrag.value && event.pointerId === wireDrag.value.pointerId) { lastClient = { x: event.clientX, y: event.clientY }; schedulePoints(); return }
  if (!drag.value) return
  positions.value[drag.value.id] = Math.max(0, Math.min(20000, drag.value.startTop + event.clientY - drag.value.startY))
  schedulePoints()
}
function finishDrag() {
  if (!drag.value) return
  positions.value = { ...positions.value, ...layout.value }
  drag.value = null
  rememberPositions(); schedulePoints()
}
function moveWithKeyboard(id: string, delta: number) {
  const top = layout.value[id] || 0
  let target = Math.max(0, top + delta)
  const peers = columnIds.value.find(ids => ids.includes(id)) || []
  const before = peers.filter(other => other !== id && (layout.value[other] || 0) < top).sort((a, b) => layout.value[b]! - layout.value[a]!)[0]
  if (delta < 0 && before && target < layout.value[before]! + (heights.value[before] || 190) + 20) target = Math.max(0, layout.value[before]! - 1)
  preferredCard.value = id
  positions.value[id] = target
  positions.value = { ...positions.value, ...layout.value }
  rememberPositions(); schedulePoints()
}
function arrangeCards() { preferredCard.value = undefined; positions.value = {}; rememberPositions(); schedulePoints() }
function relatedRoute(edge: [string, string]) {
  const id = hoveredNode.value
  if (!id) return true
  if (edge.includes(id)) return true
  return audio.routes.some(([from, to]) => (from === id && to === edge[0]) || (to === id && from === edge[1]))
}

function updatePoints() {
  const root = canvas.value
  if (!root) return
  const bounds = root.getBoundingClientRect()
  const next: Record<string, { out?: Point; in?: Point }> = {}
  root.querySelectorAll<HTMLElement>('[data-node-id]').forEach(node => {
    const id = node.dataset.nodeId!
    if (!id) return
    const out = node.querySelector<HTMLElement>('[data-port="out"]')?.getBoundingClientRect()
    const input = node.querySelector<HTMLElement>('[data-port="in"]')?.getBoundingClientRect()
    next[id] = {
      out: out ? { x: out.left - bounds.left + out.width / 2, y: out.top - bounds.top + out.height / 2 } : undefined,
      in: input ? { x: input.left - bounds.left + input.width / 2, y: input.top - bounds.top + input.height / 2 } : undefined,
    }
  })
  points.value = next
}

function pathFor(edge: [string, string] | undefined): string {
  if (!edge || !edge[0] || !edge[1]) return ''
  const from = points.value[edge[0]]?.out
  const to = points.value[edge[1]]?.in
  return from && to ? bezierPath(from, to) : ''
}

function selectRoute(index: number, event: Event) {
  event.stopPropagation()
  pending.value = null
  selectedRoute.value = selectedRoute.value === index ? null : index
}

function deleteSelected() {
  const idx = selectedRoute.value
  if (idx === null) return
  canvas.value?.focus({ preventScroll: true })
  selectedRoute.value = null
  audio.deleteRoute(idx)
}

function cancelRoute() {
  const active = wireDrag.value
  wireDrag.value = null
  wireTarget.value = null
  if (active?.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId)
  pending.value = null
  selectedRoute.value = null
  routeFeedback.value = ''
}

function openAirplayDetails(id: string) {
  selectedAirplayLine.value = id
  showAirplayLines.value = true
}

function schedulePoints() {
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = 0
    updatePoints()
    updateWirePointer()
  })
}

function onResize() { schedulePoints() }

// Clamp selectedRoute when routes array shrinks (deletion elsewhere)
watch(() => audio.routes.length, (len) => {
  if (selectedRoute.value !== null && selectedRoute.value >= len) {
    selectedRoute.value = null
  }
})

watch(() => [audio.sources.length, audio.buses.length, audio.outputs.length], async () => {
  await nextTick()
  measureCards()
})

onMounted(() => {
  scrollport.value?.addEventListener('wheel', onCanvasWheel, { passive: false })
  document.addEventListener('pointerdown', leaveCanvas, true)
  window.addEventListener('resize', onResize)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', finishDrag)
  window.addEventListener('pointerup', finishWire)
  window.addEventListener('pointercancel', abortPointer)
  window.addEventListener('blur', abortPointer)
  window.addEventListener('scroll', onResize, true)
  observer = canvas.value ? new ResizeObserver(measureCards) : undefined
  if (canvas.value && observer) observer.observe(canvas.value)
  measureCards()
})

onUnmounted(() => {
  scrollport.value?.removeEventListener('wheel', onCanvasWheel)
  document.removeEventListener('pointerdown', leaveCanvas, true)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', finishDrag)
  window.removeEventListener('pointerup', finishWire)
  window.removeEventListener('pointercancel', abortPointer)
  window.removeEventListener('blur', abortPointer)
  window.removeEventListener('scroll', onResize, true)
  cancelRoute()
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})

function onKeydown(event: KeyboardEvent) {
  if (showAirplayLines.value || document.querySelector('dialog[open]') || (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))) return
  if (event.key === 'Escape') { cancelRoute(); releaseCanvasFocus(); routeFeedback.value = t('canvas.route.cancelled') }
  if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected()
}
</script>

<template>
  <section ref="workspace" class="workspace" :class="{ 'canvas-focused': canvasFocused }" tabindex="-1">
    <div class="canvas-head">
      <div><strong>{{ t('canvas.title') }}</strong><span>{{ t('canvas.subtitle') }}</span></div>
      <div class="canvas-toolbar">
        <button class="primary" @click="selectedAirplayLine = null; showAirplayLines = true"><AppIcon name="plus" :size="14" /> {{ t('canvas.addIos') }}</button>
        <button class="secondary" @click="audio.addBus()"><AppIcon name="mixer" :size="14" /> {{ t('canvas.newBus') }}</button>
        <button class="secondary" @click="arrangeCards"><AppIcon name="route" :size="14" /> {{ t('canvas.arrange') }}</button>
        <button class="secondary" @click="audio.connect()"><AppIcon name="refresh" :size="14" /> {{ t('canvas.scan') }}</button>
      </div>
      <div class="legend"><span><i class="dot online" />{{ t('canvas.legend.online') }}</span><span><i class="dot idle" />{{ t('canvas.legend.idle') }}</span><span><i class="dot offline" />{{ t('canvas.legend.offline') }}</span></div>
    </div>
    <div class="canvas-notice"><AppIcon name="info" :size="14" /><span>{{ t('canvas.noSound') }}</span><strong v-if="unroutedCount">{{ t('canvas.unrouted', { count: unroutedCount }) }}</strong><span class="canvas-focus-hint" role="status">{{ t(canvasFocused ? 'canvas.scroll.active' : 'canvas.scroll.inactive') }}</span></div>
    <div ref="scrollport" class="canvas-scroll" @pointerdown.capture="activateCanvas" @focusin="canvasFocused = true" @focusout="onCanvasFocusout">
    <div ref="canvas" class="canvas" :class="{ connecting: routeStart, 'wire-dragging': wireDrag }" tabindex="0" :aria-label="t('canvas.title')" @keydown.esc="cancelRoute(); releaseCanvasFocus()" @click.self="cancelRoute" @pointerdown.capture="startWire" @click.capture="onPortClick">
      <svg ref="svg" class="wires" :aria-label="t('canvas.wiresAria')">
        <path v-if="previewPath" class="wire-preview" :class="{ valid: proposedEdge && !duplicateEdge, invalid: wireTarget && (!proposedEdge || duplicateEdge) }" :d="previewPath" />
        <template v-for="(edge, index) in audio.routes" :key="`${edge?.[0]}-${edge?.[1]}`">
          <path class="wire-hit" :d="pathFor(edge)" @click="selectRoute(index, $event)" />
          <path class="wire" :class="{ selected: selectedRoute === index, dimmed: hoveredNode && !relatedRoute(edge), related: hoveredNode && relatedRoute(edge) }" :d="pathFor(edge)" @click="selectRoute(index, $event)" />
        </template>
      </svg>
      <div class="wire-controls"><button v-if="selectedMidpoint" class="wire-delete-button" type="button" :style="{ left: selectedMidpoint.x + 'px', top: selectedMidpoint.y + 'px' }" :title="t('canvas.deleteWire')" :aria-label="t('canvas.deleteWire')" @pointerdown.stop @click.stop="deleteSelected"><AppIcon name="trash" :size="16" /></button></div>
      <div class="col sources"><div class="col-title"><span>{{ t('canvas.col.sources') }}</span><small>{{ t('canvas.col.sourcesCount', { count: audio.sources.length }) }}</small></div>
        <div class="card-lane" :style="{ height: laneHeight + 'px' }">
          <div v-if="!audio.sources.length" class="empty">{{ t('canvas.emptySources') }}</div>
          <div v-for="card in audio.sources" :key="card.id" class="canvas-card" :class="{ dragging: drag?.id === card.id }" :data-card-id="card.id" :style="{ top: (drag?.id === card.id ? positions[card.id] || 0 : layout[card.id] || 0) + 'px' }" @mouseenter="hoveredNode = card.id" @mouseleave="hoveredNode = null" @focusin="hoveredNode = card.id" @focusout="hoveredNode = null">
            <button class="card-drag-handle" type="button" :aria-label="card.title + ' · ' + t('canvas.drag')" :title="t('canvas.drag')" @pointerdown.prevent="startDrag(card.id, $event)" @keydown.up.prevent="moveWithKeyboard(card.id, -($event.shiftKey ? 80 : 20))" @keydown.down.prevent="moveWithKeyboard(card.id, $event.shiftKey ? 80 : 20)"><AppIcon name="grip" :size="14" /></button>
            <SourceNode :source="card" :pending="pending" @open-airplay-details="openAirplayDetails" />
          </div>
        </div>
      </div>
      <div class="col buses"><div class="col-title"><span>{{ t('canvas.col.buses') }}</span><small>{{ t('canvas.col.busesCount', { count: audio.buses.length }) }}</small></div>
        <div class="card-lane" :style="{ height: laneHeight + 'px' }">
          <div v-if="!audio.buses.length" class="empty">{{ t('canvas.emptySources') }}</div>
          <div v-for="card in audio.buses" :key="card.id" class="canvas-card" :class="{ dragging: drag?.id === card.id }" :data-card-id="card.id" :style="{ top: (drag?.id === card.id ? positions[card.id] || 0 : layout[card.id] || 0) + 'px' }" @mouseenter="hoveredNode = card.id" @mouseleave="hoveredNode = null" @focusin="hoveredNode = card.id" @focusout="hoveredNode = null">
            <button class="card-drag-handle" type="button" :aria-label="card.title + ' · ' + t('canvas.drag')" :title="t('canvas.drag')" @pointerdown.prevent="startDrag(card.id, $event)" @keydown.up.prevent="moveWithKeyboard(card.id, -($event.shiftKey ? 80 : 20))" @keydown.down.prevent="moveWithKeyboard(card.id, $event.shiftKey ? 80 : 20)"><AppIcon name="grip" :size="14" /></button>
            <BusNode :bus="card" :pending="pending" />
          </div>
        </div>
      </div>
      <div class="col outputs"><div class="col-title"><span>{{ t('canvas.col.outputs') }}</span><small>{{ t('canvas.col.outputsMeta') }}</small></div>
        <div class="card-lane" :style="{ height: laneHeight + 'px' }">
          <div v-if="!audio.outputs.length" class="empty">{{ t('canvas.emptySources') }}</div>
          <div v-for="card in audio.outputs" :key="card.id" class="canvas-card" :class="{ dragging: drag?.id === card.id }" :data-card-id="card.id" :style="{ top: (drag?.id === card.id ? positions[card.id] || 0 : layout[card.id] || 0) + 'px' }" @mouseenter="hoveredNode = card.id" @mouseleave="hoveredNode = null" @focusin="hoveredNode = card.id" @focusout="hoveredNode = null">
            <button class="card-drag-handle" type="button" :aria-label="card.title + ' · ' + t('canvas.drag')" :title="t('canvas.drag')" @pointerdown.prevent="startDrag(card.id, $event)" @keydown.up.prevent="moveWithKeyboard(card.id, -($event.shiftKey ? 80 : 20))" @keydown.down.prevent="moveWithKeyboard(card.id, $event.shiftKey ? 80 : 20)"><AppIcon name="grip" :size="14" /></button>
            <OutputNode :output="card" />
          </div>
        </div>
      </div>
      <div class="canvas-help">
        <span role="status" aria-live="polite" data-route-status>{{ routeHelp }}</span>
        <button v-if="routeStart" class="cancel-route" type="button" @click="cancelRoute">{{ t('canvas.help.cancel') }}</button>
        <span>·</span>
        <span>{{ selectedRoute !== null ? t('canvas.help.deleteSelected') : t('canvas.help.clickWire') }}</span>
      </div>
    </div>
    </div>
    <AirplayLinesDialog :open="showAirplayLines" :selected-id="selectedAirplayLine" @close="showAirplayLines = false" />
  </section>
</template>

<script lang="ts">
import SourceNode from './SourceNode.vue'
import BusNode from './BusNode.vue'
import OutputNode from './OutputNode.vue'
export default { components: { SourceNode, BusNode, OutputNode } }
</script>
