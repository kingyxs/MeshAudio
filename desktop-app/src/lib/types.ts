export type RouteEdge = [string, string]

export interface SourceNode {
  id: string
  sourceId?: string
  title: string
  icon: string
  iconClass?: string
  statusKey: 'online' | 'offline' | 'stopped' | 'waiting'
  deviceType: 'iOS' | 'Android' | 'other'
  endpoint: string
  rateKhz: number
  channels: number
  latencyMs?: number | null
  level: number
  offline: boolean
  muted: boolean
  stopped: boolean
  gain: number
  voiceEnhanced: boolean
  streamType?: 'microphone' | 'media' | 'unknown'
  transport?: string
  airplayLineId?: string
  connectionIp?: string
}

export interface BusNode {
  id: string
  title: string
  gain: number
  muted: boolean
}

export interface OutputNode {
  id: string
  title: string
  icon: string
  iconClass?: string
  kind: 'system' | 'virtual' | 'other'
  available: boolean
  enabled: boolean
  diagnostic?: string
  external?: boolean
}

export interface SnapshotConfig {
  settings?: { sampleRate?: number; channels?: number; language?: string }
  sources?: Record<string, unknown>[]
  buses?: Array<{ id: string; name?: string; gain?: number; muted?: boolean }>
  outputs?: Array<Record<string, any>>
  routes?: RouteEdge[]
}

export interface Snapshot {
  type?: string
  config?: SnapshotConfig
  sources?: Array<Record<string, any>>
  streams?: Array<Record<string, any>>
  server?: Record<string, any>
}

export interface ControlMessage {
  type: string
  [key: string]: unknown
}
