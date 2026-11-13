import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { createControlApi, type ControlApi } from '../api/control'
import { addRoute, removeRoute } from '../lib/routing'
import { t, adoptLocale, setLocale } from '../i18n'
import type { BusNode, OutputNode, RouteEdge, Snapshot, SourceNode } from '../lib/types'

const runtimePort = () => {
  const value = Number((globalThis as { __MESHAUDIO_PORT__?: number }).__MESHAUDIO_PORT__)
  return Number.isFinite(value) && value > 0 ? value : 4173
}

function linearToDb(gain: number): number {
  if (gain <= 0) return -60
  return Math.max(-60, Math.min(12, 20 * Math.log10(gain)))
}

function normalizeSnapshot(snapshot: Snapshot) {
  const config = snapshot.config ?? {}
  const streams = new Map((snapshot.streams ?? []).filter(Boolean).map(stream => [String(stream.sourceId ?? '').toLowerCase(), stream]))
  const sources: SourceNode[] = (snapshot.sources ?? config.sources ?? []).filter(Boolean).map(source => {
    const stream = streams.get(String(source.sourceId ?? '').toLowerCase())
    const online = source.online === true && source.stopped !== true
    const type = source.streamType ?? stream?.streamType ?? 'unknown'
    const address = String(source.address ?? stream?.address ?? '').trim()
    const deviceName = String(source.deviceName ?? '')
    const deviceType = deviceName.startsWith('iOS') ? 'iOS' : deviceName.startsWith('Android') ? 'Android' : 'other'
    const rate = Number(source.sampleRate ?? config.settings?.sampleRate ?? 48000)
    const channels = Number(source.channels ?? config.settings?.channels ?? 2)
    // Per-source measured playout latency (arrival -> jitter buffer exit ->
    // output FIFO), reported by the server on the latency refresh cadence.
    const rawLatency = source.latencyMs ?? stream?.latencyMs
    const latency = rawLatency == null ? NaN : Number(rawLatency)
    const statusKey: SourceNode['statusKey'] = source.stopped === true ? 'stopped' : online ? 'online' : 'offline'
    return {
      id: String(source.id ?? `net-${source.sourceId ?? 'unknown'}`), sourceId: source.sourceId,
      title: deviceName,
      icon: type === 'microphone' ? 'mic' : 'waveform', iconClass: type === 'microphone' ? 'phone' : '',
      streamType: type as SourceNode['streamType'],
      transport: String(source.transport ?? stream?.transport ?? ''),
      airplayLineId: typeof source.airplayLineId === 'string' ? source.airplayLineId : undefined,
      connectionIp: address,
      statusKey,
      deviceType,
      endpoint: address,
      rateKhz: Math.round(rate / 1000),
      channels,
      latencyMs: online && Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
      level: online ? Math.min(100, Math.round(Number(source.rms ?? 0) * 240)) : 0,
      offline: !online, muted: source.muted === true, stopped: source.stopped === true,
      gain: Number.isFinite(Number(source.gain)) ? Number(source.gain) : 1,
      voiceEnhanced: source.voiceEnhanced === true,
    }
  })
  const buses: BusNode[] = (config.buses ?? []).map(bus => ({
    id: bus.id, title: String(bus.name ?? bus.id), gain: linearToDb(Number.isFinite(Number(bus.gain)) ? Number(bus.gain) : 1), muted: bus.muted === true,
  }))
  const outputs: OutputNode[] = (config.outputs ?? []).map(output => {
    const virtual = output.kind === 'virtual-mic'
    const available = output.enabled === true
    return {
      id: String(output.id), title: String(output.name ?? output.id),
      icon: output.kind === 'system' ? 'speaker' : 'cable', iconClass: output.kind === 'system' ? 'speaker' : '',
      kind: virtual ? 'virtual' : output.kind === 'system' ? 'system' : 'other',
      available, enabled: available, external: virtual,
      diagnostic: output.diagnostic ?? (virtual && available ? String(output.captureDeviceName ?? 'CABLE Output') : undefined),
    }
  })
  return { sources, buses, outputs, routes: (config.routes ?? []).filter(Boolean).map(edge => [String(edge[0] ?? ''), String(edge[1] ?? '')] as RouteEdge).filter(([a, b]) => a && b), server: snapshot.server ?? {} }
}

export const useRuntimeStore = defineStore('runtime', () => {
  const port = reactive({ value: runtimePort() })
  const connected = reactive({ value: false })
  const setPort = (next: number) => { if (Number.isFinite(next) && next > 0) port.value = Math.round(next) }
  return { port, connected, setPort }
})

export const useAudioStore = defineStore('audio', () => {
  const runtime = useRuntimeStore()
  const sources = reactive<SourceNode[]>([])
  const buses = reactive<BusNode[]>([])
  const outputs = reactive<OutputNode[]>([])
  const routes = reactive<RouteEdge[]>([])
  const server = reactive<Record<string, any>>({})
  const activity = reactive<string[]>([])
  const pendingConnections = reactive<string[]>([])
  const promptedSources = new Set<string>()
  let initialized = false
  let api: ControlApi | undefined
  const connectionSource = computed(() => sources.find(source => source.id === pendingConnections[0]) ?? null)
  const defaultBus = computed(() => buses.find(bus => bus.id === 'bus-main') ?? buses[0] ?? null)
  const defaultOutput = computed(() => outputs.find(output => output.id === 'out-speaker' && output.enabled) ?? outputs.find(output => output.enabled) ?? null)
  function hasOutputPath(id: string) {
    return routes.some(([from, busId]) => from === id && buses.some(bus => bus.id === busId) && routes.some(([fromBus, outputId]) => fromBus === busId && outputs.some(output => output.id === outputId && output.enabled)))
  }
  function dismissConnection() { pendingConnections.shift() }
  function connectToDefault() {
    const source = connectionSource.value
    if (!source || source.offline || !defaultOutput.value) return
    if (!defaultBus.value) buses.push({ id: 'bus-main', title: t('canvas.defaultBus'), gain: 0, muted: false })
    const bus = defaultBus.value!
    let next = addRoute(routes, [source.id, bus.id], graph.value)
    if (!next.some(([from, target]) => from === bus.id && outputs.some(output => output.id === target && output.enabled))) next = addRoute(next, [bus.id, defaultOutput.value.id], graph.value)
    routes.splice(0, routes.length, ...next)
    persist()
    dismissConnection()
  }

  const onlineSources = computed(() => sources.filter(source => !source.offline))
  // Average of the per-source measured latencies. It is a real measurement
  // (arrival -> jitter buffer exit -> output FIFO), not the configured buffer
  // target, so it moves with the actual link conditions.
  const averageLatency = computed(() => {
    const values = sources
      .map(source => source.latencyMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    if (!values.length) return null
    return Math.round(values.reduce((total, value) => total + value, 0) / values.length)
  })
  const graph = computed(() => ({
    sourceIds: new Set(sources.map(source => source.id)),
    busIds: new Set(buses.map(bus => bus.id)),
    outputs: new Map(outputs.map(output => [output.id, { enabled: output.enabled }])),
  }))

  function applySnapshot(snapshot: Snapshot) {
    try {
      if (snapshot.type === 'state.telemetry') {
        for (const metric of snapshot.sources ?? []) {
          const source = sources.find(item => item.id === metric.id)
          if (!source) continue
          const latency = metric.latencyMs == null ? NaN : Number(metric.latencyMs)
          source.latencyMs = !source.offline && Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null
          source.level = !source.offline ? Math.min(100, Math.round(Number(metric.rms ?? 0) * 240)) : 0
        }
        Object.assign(server, snapshot.server)
        return
      }
      trace('applySnapshot', `raw: sources=${(snapshot.sources ?? snapshot.config?.sources ?? []).length} streams=${(snapshot.streams ?? []).length} routes=${(snapshot.config?.routes ?? []).length}`)
      // Language lives in config so a fresh webview (or a different port) keeps
      // the choice; an explicit local choice always wins.
      adoptLocale(snapshot.config?.settings?.language)
      const normalized = normalizeSnapshot(snapshot)
      trace('applySnapshot', `normalized: sources=${normalized.sources.length} buses=${normalized.buses.length} outputs=${normalized.outputs.length} routes=${normalized.routes.length}`)
      sources.splice(0, sources.length, ...normalized.sources)
      buses.splice(0, buses.length, ...normalized.buses)
      outputs.splice(0, outputs.length, ...normalized.outputs)
      routes.splice(0, routes.length, ...normalized.routes)
      Object.assign(server, normalized.server)
      for (const source of sources) {
        if (source.offline || promptedSources.has(source.id)) continue
        promptedSources.add(source.id)
        if (initialized && !hasOutputPath(source.id)) pendingConnections.push(source.id)
      }
      for (let i = pendingConnections.length - 1; i >= 0; i--) if (!sources.some(source => source.id === pendingConnections[i])) pendingConnections.splice(i, 1)
      initialized = true
      runtime.connected.value = true
    } catch (error) {
      const msg = error instanceof Error ? (error.stack || error.message) : String(error)
      trace('applySnapshot-ERROR', msg)
    }
  }
  function log(message: string) {
    activity.unshift(message)
    if (activity.length > 5) activity.pop()
    if (isTauri()) invoke('frontend_log', { message: `[store] ${message}` }).catch(() => {})
  }
  function trace(fn: string, detail: string) {
    if (!fn.includes('ERROR') && !(globalThis as { __MESHAUDIO_DEBUG__?: boolean }).__MESHAUDIO_DEBUG__) return
    if (isTauri()) invoke('frontend_log', { message: `[trace:${fn}] ${detail}` }).catch(() => {})
  }
  function send(message: Parameters<ControlApi['send']>[0]) {
    trace('ws-send', `type=${message.type}`)
    api?.send(message)
  }
  function persist() {
    try {
      trace('persist', `buses=${buses.length} routes=${routes.length}`)
      send({ type: 'config.patch', patch: { buses: buses.map(bus => ({ id: bus.id, name: bus.title, gain: dbToLinear(bus.gain), muted: bus.muted })), routes: [...routes] } })
    } catch (error) {
      const msg = error instanceof Error ? (error.stack || error.message) : String(error)
      trace('persist-ERROR', msg)
    }
  }
  function dbToLinear(db: number): number { return Math.pow(10, db / 20) }
  async function connect(controlApi?: ControlApi) {
    api?.close()
    if (isTauri() && !controlApi) {
      // Starting the backend can fail transiently (port race, slow disk on
      // first launch). Retry with backoff before surfacing an error, so a
      // single hiccup never leaves the window blank.
      let status: { controlPort?: number } | null = null
      let lastError = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          status = await invoke<{ controlPort?: number }>('start_sidecar')
          break
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)))
        }
      }
      if (!status?.controlPort) {
        runtime.connected.value = false
        log(lastError || t('log.sidecarFailed'))
        return
      }
      runtime.setPort(status.controlPort)
    }
    api = controlApi ?? createControlApi({ getPort: () => runtime.port.value })
    api.subscribe(applySnapshot)
    void api.getSnapshot().then(applySnapshot).catch(() => { runtime.connected.value = false })
  }
  function toggleSourceMute(source: SourceNode) { source.muted = !source.muted; send({ type: 'source.mute', sourceId: source.id, muted: source.muted }); log(t(source.muted ? 'log.sourceMuted' : 'log.sourceRestored', { name: source.title })) }
  function deleteSource(source: SourceNode) {
    send({ type: 'source.remove', sourceId: source.id })
    const index = sources.findIndex(item => item.id === source.id)
    if (index >= 0) sources.splice(index, 1)
    for (let index = routes.length - 1; index >= 0; index--) if (routes[index][0] === source.id) routes.splice(index, 1)
    log(t('log.sourceRemoved', { name: source.title }))
  }
  function stopSource(source: SourceNode) { if (source.stopped) return; send({ type: 'source.stop', sourceId: source.id }); source.stopped = true; source.offline = true; source.statusKey = 'stopped'; log(t('log.sourceStopped', { name: source.title })) }
  function startSource(source: SourceNode) {
    if (!source.stopped) return
    send({ type: 'source.start', sourceId: source.id })
    source.stopped = false
    source.offline = true
    source.statusKey = 'waiting'
    log(t('log.sourceStarted', { name: source.title }))
  }
  function setSourceGain(source: SourceNode, gain: number) { source.gain = gain; send({ type: 'source.gain', sourceId: source.id, gain }) }
  function toggleVoiceEnhanced(source: SourceNode) {
    source.voiceEnhanced = !source.voiceEnhanced
    send({ type: 'source.voiceEnhanced', sourceId: source.id, enabled: source.voiceEnhanced })
    log(t(source.voiceEnhanced ? 'log.voiceOn' : 'log.voiceOff', { name: source.title }))
  }
  function toggleBusMute(bus: BusNode) { bus.muted = !bus.muted; persist(); log(t(bus.muted ? 'log.busMuted' : 'log.busRestored', { name: bus.title })) }
  function setBusGain(bus: BusNode, gain: number) { try { bus.gain = gain; persist() } catch (e) { console.error('[setBusGain]', e) } }
  function renameBus(bus: BusNode, name: string) {
    try {
      const trimmed = name.trim()
      trace('renameBus', `"${bus.title}" → "${trimmed}"`)
      if (!trimmed || trimmed === bus.title) return
      bus.title = trimmed
      persist()
      log(t('log.busRenamed', { name: trimmed }))
    } catch (e) { trace('renameBus-ERROR', String(e)) }
  }
  function renameOutput(output: OutputNode, name: string) {
    try {
      const trimmed = name.trim()
      trace('renameOutput', `"${output.title}" → "${trimmed}"`)
      if (!trimmed || trimmed === output.title) return
      output.title = trimmed
      send({ type: 'config.patch', patch: { outputs: outputs.map(o => ({ ...o as Record<string, unknown>, id: o.id, name: o.title })) } })
      log(t('log.outputRenamed', { name: trimmed }))
    } catch (e) { trace('renameOutput-ERROR', String(e)) }
  }
  function setLanguage(code: string) {
    setLocale(code)
    // Persisted with the routing config so the choice survives a fresh webview.
    send({ type: 'config.patch', patch: { settings: { language: code } } })
  }
  function deleteBus(bus: BusNode): boolean {
    // The server keeps the previous buses on an empty list (it cannot tell an
    // explicit delete apart from a patch that arrives before the snapshot), so
    // the last bus must stay.
    if (buses.length <= 1) {
      log(t('log.lastBus'))
      return false
    }
    const index = buses.findIndex(item => item.id === bus.id)
    if (index === -1) return false
    const name = bus.title
    buses.splice(index, 1)
    // Wires touching the removed bus are meaningless now; drop them locally so
    // the next persist sends a clean route list.
    for (let i = routes.length - 1; i >= 0; i--) {
      const [from, to] = routes[i]
      if (from === bus.id || to === bus.id) routes.splice(i, 1)
    }
    persist()
    log(t('log.busDeleted', { name }))
    return true
  }
  function addBus() {
    try {
      trace('addBus', `before=${buses.length}`)
      buses.push({ id: `bus-${Date.now()}`, title: t('canvas.newBus'), gain: 0, muted: false })
      persist()
      log(t('log.busCreated'))
    } catch (e) { trace('addBus-ERROR', String(e)) }
  }
  function connectRoute(edge: RouteEdge): boolean {
    try {
      trace('connectRoute', `${edge[0]} → ${edge[1]}`)
      const next = addRoute(routes, edge, graph.value)
      if (next.length === routes.length) {
        const [from, to] = edge
        const sourceToBus = graph.value.sourceIds.has(from) && graph.value.busIds.has(to)
        const busToOutput = graph.value.busIds.has(from) && graph.value.outputs.get(to)?.enabled === true
        log(sourceToBus || busToOutput ? t('log.routeExists') : t('log.routeInvalid'))
        return false
      }
      routes.splice(0, routes.length, ...next)
      persist()
      log(t('log.routeCreated'))
      return true
    } catch (e) { trace('connectRoute-ERROR', String(e)); return false }
  }
  function deleteRoute(index: number) {
    try {
      trace('deleteRoute', `index=${index} total=${routes.length}`)
      routes.splice(index, 1)
      persist()
      log(t('log.routeRemoved'))
    } catch (e) { trace('deleteRoute-ERROR', String(e)) }
  }
  return { sources, buses, outputs, routes, server, activity, onlineSources, averageLatency, graph, connectionSource, defaultBus, defaultOutput, hasOutputPath, dismissConnection, connectToDefault, connect, applySnapshot, toggleSourceMute, deleteSource, stopSource, startSource, setSourceGain, toggleVoiceEnhanced, toggleBusMute, setBusGain, renameBus, renameOutput, addBus, deleteBus, setLanguage, connectRoute, deleteRoute }
})

