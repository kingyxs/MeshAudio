import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ControlApi } from '../api/control'
import type { ControlMessage, Snapshot } from '../lib/types'
import { useAudioStore } from './audio'

const source = (id: string, online = true) => ({ id, deviceName: id, online, gain: 1, streamType: 'media', address: '192.168.1.22' })
function snapshot(sources = [source('first')], routes: [string, string][] = []): Snapshot {
  return { type: 'state.snapshot', sources, config: {
    buses: [{ id: 'bus-main', name: '默认通道', gain: 1, muted: false }, { id: 'bus-other', gain: .5, muted: true }],
    outputs: [{ id: 'out-speaker', kind: 'system', enabled: true }], routes,
  } }
}
async function harness(initial: Snapshot) {
  const messages: ControlMessage[] = []
  let deliver: (value: Snapshot) => void = () => {}
  const api: ControlApi = {
    getSnapshot: async () => initial,
    send: message => messages.push(message),
    subscribe: listener => { deliver = listener; return () => {} }, close: () => {},
  }
  const audio = useAudioStore()
  await audio.connect(api)
  await Promise.resolve()
  return { audio, messages, deliver: (value: Snapshot) => deliver(value) }
}
beforeEach(() => setActivePinia(createPinia()))
describe('source connection confirmation and telemetry', () => {
  it('keeps existing online sources quiet, asks once for each newly connected source', async () => {
    const { audio, deliver } = await harness(snapshot())
    expect(audio.connectionSource).toBeNull()
    deliver(snapshot([source('first'), source('new', false)]))
    expect(audio.connectionSource).toBeNull()
    deliver(snapshot([source('first'), source('new')]))
    expect(audio.connectionSource?.id).toBe('new')
    audio.dismissConnection()
    deliver(snapshot([source('first'), source('new')]))
    deliver(snapshot([source('first'), source('new', false)]))
    deliver(snapshot([source('first'), source('new')]))
    expect(audio.connectionSource).toBeNull()
  })
  it('connects the default path in one update, preserving existing routes, gains and mute', async () => {
    const original: [string, string][] = [['first', 'bus-other'], ['bus-other', 'out-speaker']]
    const { audio, deliver, messages } = await harness(snapshot([source('first')], original))
    deliver(snapshot([source('first'), source('new')], original))
    audio.connectToDefault()
    expect(audio.routes).toEqual([...original, ['new', 'bus-main'], ['bus-main', 'out-speaker']])
    expect(audio.buses[1]?.muted).toBe(true)
    expect(audio.buses[1]?.gain).toBeCloseTo(-6.0206)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('config.patch')
    expect(audio.connectionSource).toBeNull()
  })
  it('updates telemetry in place without changing routes, device status or sending control', async () => {
    const { audio, deliver, messages } = await harness(snapshot())
    const first = audio.sources[0]
    const routes = audio.routes
    deliver({ type: 'state.telemetry', sources: [{ id: 'first', latencyMs: 32.4, rms: .2 }, { id: 'unknown', rms: 1 }], server: { latencyRefreshMs: 5000 } })
    expect(audio.sources[0]).toBe(first)
    expect(first?.latencyMs).toBe(32)
    expect(first?.level).toBe(48)
    expect(audio.routes).toBe(routes)
    expect(audio.sources).toHaveLength(1)
    expect(audio.connectionSource).toBeNull()
    expect(messages).toEqual([])
  })
  it('does not ask for a new source with an existing complete output path', async () => {
    const { audio, deliver } = await harness(snapshot())
    deliver(snapshot([source('first'), source('new')], [['new', 'bus-main'], ['bus-main', 'out-speaker']]))
    expect(audio.connectionSource).toBeNull()
  })
  it('cleans deleted pending sources and offers the next source', async () => {
    const { audio, deliver } = await harness(snapshot())
    deliver(snapshot([source('first'), source('second'), source('third')]))
    expect(audio.connectionSource?.id).toBe('second')
    deliver(snapshot([source('first'), source('third')]))
    expect(audio.connectionSource?.id).toBe('third')
  })
  it('creates new buses at unity gain, not an amplified default', async () => {
    const { audio, messages } = await harness(snapshot())
    audio.addBus()
    expect(audio.buses.at(-1)?.gain).toBe(0)
    expect((messages[0]?.patch as any).buses.at(-1).gain).toBe(1)
  })
})
