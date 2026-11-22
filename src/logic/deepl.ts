import type { LanguageCode } from '../data/languages'
import { languagesByCode } from '../data/languages'
import type { TranslateResult } from '../types'

const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate'
const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate'

// Standard ISO 639-1 codes supported directly by DeepL API v2 (uppercase).
const DEEPL_DIRECT_LANGS = new Set<LanguageCode>([
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'he',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'nl',
  'pl',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
])

const DEEPL_TARGET_MAP: Record<string, string> = {
  'en': 'EN-US',
  'pt': 'PT-PT',
  'zh-cn': 'ZH-HANS',
  'zh-tw': 'ZH-HANT',
  'no': 'NB',
}

const DEEPL_SOURCE_MAP: Record<string, string> = {
  'en': 'EN',
  'pt': 'PT',
  'zh-cn': 'ZH',
  'zh-tw': 'ZH',
  'no': 'NB',
}

const DEEPL_DETECTED_MAP: Record<string, LanguageCode> = {
  'EN': 'en',
  'EN-US': 'en',
  'EN-GB': 'en',
  'PT': 'pt',
  'PT-PT': 'pt',
  'PT-BR': 'pt',
  'ZH': 'zh-CN',
  'ZH-HANS': 'zh-CN',
  'ZH-HANT': 'zh-TW',
  'NB': 'no',
}

export function getDeepLEndpoint(apiKey: string): string {
  return apiKey.trim().endsWith(':fx')
    ? DEEPL_FREE_ENDPOINT
    : DEEPL_PRO_ENDPOINT
}

export function toDeepLTargetLang(code: LanguageCode): string | null {
  const normalized = code.toLowerCase()
  if (normalized === 'auto')
    return null
  const mapped = DEEPL_TARGET_MAP[normalized]
  if (mapped)
    return mapped
  if (DEEPL_DIRECT_LANGS.has(normalized as LanguageCode))
    return normalized.toUpperCase()
  return null
}

export function toDeepLSourceLang(code: LanguageCode): string | null {
  const normalized = code.toLowerCase()
  if (normalized === 'auto')
    return null
  const mapped = DEEPL_SOURCE_MAP[normalized]
  if (mapped)
    return mapped
  if (DEEPL_DIRECT_LANGS.has(normalized as LanguageCode))
    return normalized.toUpperCase()
  return null
}

export function fromDeepLDetectedLang(detected: string | undefined, fallback: LanguageCode): LanguageCode {
  if (!detected)
    return fallback
  const upper = detected.toUpperCase()
  if (upper in DEEPL_DETECTED_MAP)
    return DEEPL_DETECTED_MAP[upper]
  const lower = upper.toLowerCase() as LanguageCode
  if (lower in languagesByCode)
    return lower
  const base = upper.split('-')[0].toLowerCase() as LanguageCode
  if (base in languagesByCode)
    return base
  return fallback
}

export function getDeepLWebUrl(text: string, from: LanguageCode, to: LanguageCode): string {
  const src = from.toLowerCase() === 'auto' ? 'auto' : (toDeepLSourceLang(from)?.toLowerCase() ?? 'auto')
  const dst = (toDeepLTargetLang(to) ?? to).toLowerCase()
  // DeepL's hash router treats unescaped '/', '\', and '|' as route delimiters.
  const escaped = text.replace(/([\\/|])/g, '\\$1')
  return `https://www.deepl.com/translator#${src}/${dst}/${encodeURIComponent(escaped)}`
}

interface DeepLResponse {
  translations?: Array<{
    detected_source_language?: string
    text?: string
  }>
  message?: string
}

export async function translateWithDeepL(
  text: string,
  from: LanguageCode,
  to: LanguageCode,
  apiKey: string | undefined,
  createError: (message?: string | Error, name?: string) => Error,
  fetchFn: typeof fetch = fetch,
): Promise<TranslateResult> {
  const trimmedKey = apiKey?.trim()
  if (!trimmedKey)
    throw createError('Please set your DeepL API key in extension preferences', 'Missing DeepL API key')

  const targetLang = toDeepLTargetLang(to)
  if (!targetLang) {
    // Gracefully skip target languages unsupported by DeepL when translating to multiple targets.
    return {
      original: text,
      translated: '',
      from,
      to,
    }
  }

  let sourceLang: string | undefined
  if (from.toLowerCase() !== 'auto') {
    const mappedSource = toDeepLSourceLang(from)
    if (!mappedSource)
      throw createError(`DeepL does not support source language "${from}"`, 'Unsupported language')
    sourceLang = mappedSource
  }

  const endpoint = getDeepLEndpoint(trimmedKey)
  const payload: Record<string, unknown> = {
    text: [text],
    target_lang: targetLang,
  }
  if (sourceLang)
    payload.source_lang = sourceLang

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${trimmedKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    let apiMessage = ''
    try {
      const errBody = await response.json() as DeepLResponse
      apiMessage = errBody?.message || ''
    }
    catch {}

    switch (response.status) {
      case 403:
        throw createError('Invalid DeepL API key. Check your key in extension preferences.', 'DeepL authentication failed')
      case 429:
      case 529:
        throw createError('Please try again later', 'Too many requests')
      case 456:
        throw createError('DeepL character quota exceeded', 'DeepL quota exceeded')
      default: {
        const statusSummary = response.statusText
          ? `HTTP ${response.status} ${response.statusText}`
          : `HTTP ${response.status}`
        throw createError(apiMessage || statusSummary, 'DeepL API error')
      }
    }
  }

  const data = await response.json() as DeepLResponse
  const first = data?.translations?.[0]
  if (!first || typeof first.text !== 'string')
    throw createError('Unexpected empty response from DeepL API', 'DeepL API error')

  return {
    original: text,
    translated: first.text,
    from: from.toLowerCase() === 'auto'
      ? fromDeepLDetectedLang(first.detected_source_language, from)
      : from,
    to,
  }
}
