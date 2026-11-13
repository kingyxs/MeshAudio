import { beforeEach, describe, expect, it, vi } from 'vitest'

function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  return map
}

async function load() {
  vi.resetModules()
  return import('./index')
}

describe('i18n', () => {
  beforeEach(() => {
    installStorage()
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  })

  it('defaults to Chinese when nothing is stored', async () => {
    const { t, locale } = await load()
    expect(locale.value).toBe('zh-CN')
    expect(t('settings.title')).toBe('设置')
  })

  it('switches language and persists the choice', async () => {
    const { t, setLocale, locale } = await load()
    setLocale('en-US')
    expect(locale.value).toBe('en-US')
    expect(t('settings.title')).toBe('Settings')
    expect(globalThis.localStorage.getItem('meshaudio.locale')).toBe('en-US')
  })

  it('adopts the server language when this device has no choice yet', async () => {
    const { adoptLocale, locale } = await load()
    expect(adoptLocale('en-US')).toBe(true)
    expect(locale.value).toBe('en-US')
  })

  it('keeps a local choice over the server value', async () => {
    installStorage({ 'meshaudio.locale': 'zh-CN' })
    const { adoptLocale, locale } = await load()
    expect(adoptLocale('en-US')).toBe(false)
    expect(locale.value).toBe('zh-CN')
  })

  it('ignores unknown or missing locales', async () => {
    const { adoptLocale, locale } = await load()
    expect(adoptLocale('fr-FR')).toBe(false)
    expect(adoptLocale(undefined)).toBe(false)
    expect(adoptLocale(42)).toBe(false)
    expect(locale.value).toBe('zh-CN')
  })

  it('interpolates every placeholder occurrence', async () => {
    const { t } = await load()
    expect(t('canvas.col.sourcesCount', { count: 3 })).toBe('3 个来源')
    expect(t('health.outputsValue', { available: 2, pending: 1 })).toBe('2 个可用 · 1 个待验证')
  })
})
