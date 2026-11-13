import { ref } from 'vue'
import { enUS, zhCN, type MessageKey } from './messages'

export type { MessageKey }

export interface LocaleOption {
  code: string
  label: string
  htmlLang: string
}

export const LOCALES: LocaleOption[] = [
  { code: 'zh-CN', label: '简体中文', htmlLang: 'zh-CN' },
  { code: 'en-US', label: 'English', htmlLang: 'en-US' },
]

const STORAGE_KEY = 'meshaudio.locale'
const dictionaries: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

function detect(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && dictionaries[stored]) return stored
  } catch { /* private mode / storage disabled */ }
  const preferred = typeof navigator !== 'undefined' ? String(navigator.language || '') : ''
  if (/^zh\b/i.test(preferred)) return 'zh-CN'
  if (/^en\b/i.test(preferred)) return 'en-US'
  return 'zh-CN'
}

export const locale = ref(detect())

function applyHtmlLang(code: string) {
  if (typeof document === 'undefined') return
  const option = LOCALES.find(item => item.code === code)
  document.documentElement.lang = option?.htmlLang ?? code
}

applyHtmlLang(locale.value)

export function setLocale(code: string) {
  if (!dictionaries[code]) return
  locale.value = code
  try { localStorage.setItem(STORAGE_KEY, code) } catch { /* ignore */ }
  applyHtmlLang(code)
}

/** True when this device already made an explicit choice. */
export function hasStoredLocale(): boolean {
  try { return Boolean(localStorage.getItem(STORAGE_KEY)) } catch { return false }
}

/**
 * Adopt the language saved in the server config. Only used when this device has
 * no explicit choice, so a local switch always wins over a stale config value.
 */
export function adoptLocale(code: unknown): boolean {
  if (typeof code !== 'string' || !dictionaries[code]) return false
  if (hasStoredLocale()) return false
  setLocale(code)
  return true
}

/**
 * Translate a key. Reading `locale.value` here makes every template that calls
 * `t()` re-render when the language changes, without a plugin or a reload.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dictionary = dictionaries[locale.value] ?? dictionaries['zh-CN']
  let text = dictionary[key] ?? zhCN[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
