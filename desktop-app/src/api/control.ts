import type { ControlMessage, Snapshot } from '../lib/types'

export interface ControlApi {
  getSnapshot(): Promise<Snapshot>
  send(message: ControlMessage): void
  subscribe(listener: (snapshot: Snapshot) => void): () => void
  close(): void
}

export interface ControlApiOptions {
  getPort: () => number
  getHost?: () => string
  fetchImpl?: typeof fetch
  webSocketFactory?: (url: string) => WebSocket
}

export function createControlApi(options: ControlApiOptions): ControlApi {
  let socket: WebSocket | undefined
  let stopped = false
  const pendingMessages: string[] = []
  const listeners = new Set<(snapshot: Snapshot) => void>()
  const fetchImpl = options.fetchImpl ?? fetch
  const host = options.getHost ?? (() => '127.0.0.1')
  const baseUrl = () => `http://${host()}:${options.getPort()}`
  const socketUrl = () => `ws://${host()}:${options.getPort()}/control`

  const notify = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (['state.snapshot', 'state.telemetry'].includes(String((value as { type?: string }).type))) {
      listeners.forEach(listener => listener(value as Snapshot))
    }
  }

  const connect = () => {
    if (stopped || typeof WebSocket === 'undefined') return
    try {
      socket = (options.webSocketFactory ?? (url => new WebSocket(url)))(socketUrl())
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'state.get' }))
        while (pendingMessages.length && socket?.readyState === WebSocket.OPEN) socket.send(pendingMessages.shift()!)
      }
      socket.onmessage = event => {
        try { notify(JSON.parse(String(event.data))) } catch { /* ignore malformed frames */ }
      }
      socket.onclose = () => {
        socket = undefined
        if (!stopped) window.setTimeout(connect, 1500)
      }
    } catch { socket = undefined }
  }

  connect()
  return {
    async getSnapshot() {
      const response = await fetchImpl(`${baseUrl()}/api/state`)
      if (!response.ok) throw new Error(`state request failed: ${response.status}`)
      return response.json() as Promise<Snapshot>
    },
    send(message) {
      const payload = JSON.stringify(message)
      if (socket?.readyState === WebSocket.OPEN) socket.send(payload)
      else if (!stopped && pendingMessages.length < 32) pendingMessages.push(payload)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      stopped = true
      socket?.close()
      pendingMessages.length = 0
      listeners.clear()
    },
  }
}
