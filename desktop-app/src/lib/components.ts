export interface ComponentEntry {
  id: string
  names: Record<string, string>
  summary: Record<string, string>
  kind: string
  license: string
  homepage: string
  version: string | null
  installKind: string
  canLaunch: boolean
  needsRestart: boolean
  restartRequired?: boolean
  busy?: boolean
  download: { filename: string; expectedBytes: number | null; url: string | null } | null
  detected: boolean
  ready?: boolean
  requirements?: string[]
  detection: string
  installedByApp: boolean
  installedAt: number | null
  sha256: string | null
  installDir: string | null
  downloaded: boolean
  downloadedBytes: number
  progress: { phase: string; received: number; total: number | null; percent: number; speedBps: number; message: string; error: string | null }
}
