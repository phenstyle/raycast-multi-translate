import googleTranslate from '@iamtraction/google-translate'
import { LRUCache } from 'lru-cache'
import type { LanguageCode } from '../data/languages'
import type { TranslateOptions, TranslateResult } from '../types'
import { toDeepLTargetLang, translateWithDeepL } from './deepl'

export const AUTO_DETECT = 'auto'

const cache = new LRUCache<string, TranslateResult>({
  max: 1000,
})

export function clearTranslateCache() {
  cache.clear()
}

export class TranslateError extends Error {
  constructor(message?: string | Error, name?: string) {
    if (message instanceof Error) {
      super(message.message)
      this.name = name || message.name
    }
    else {
      super(message)
      this.name = name || this.name
    }
  }
}

export async function translate(
  text: string,
  from: LanguageCode,
  to: LanguageCode,
  options: TranslateOptions = {},
): Promise<TranslateResult> {
  if (!text) {
    return {
      original: text,
      translated: '',
      from,
      to,
    }
  }

  const provider = options.provider || 'google'
  const key = `${provider}:${from}:${to}:${text}`
  const cached = cache.get(key)
  if (cached)
    return cached

  try {
    let result: TranslateResult
    if (provider === 'deepl') {
      result = await translateWithDeepL(
        text,
        from,
        to,
        options.deeplApiKey,
        (msg, name) => new TranslateError(msg, name),
        options.fetchFn,
      )
    }
    else {
      const translated = await googleTranslate(text, {
        from,
        to,
      })

      result = {
        original: text,
        translated: translated.text,
        from: translated?.from?.language?.didYouMean
          ? from
          : translated?.from?.language?.iso as LanguageCode,
        to,
      }
    }

    if (result.translated)
      cache.set(key, result)
    return result
  }
  catch (err) {
    if (err instanceof TranslateError)
      throw err

    if (err instanceof Error) {
      switch (err.name) {
        case 'TooManyRequestsError':
          throw new TranslateError('please try again later', 'Too many requests')
        default:
          throw new TranslateError(err)
      }
    }

    throw err
  }
}

export async function translateAll(
  text: string,
  from: LanguageCode = 'auto',
  languages: LanguageCode[],
  options: TranslateOptions = {},
) {
  if (!text)
    return []

  const normalizedFrom = from.toLowerCase()
  const targets = normalizedFrom === 'auto'
    ? languages
    : languages.filter(to => to.toLowerCase() !== normalizedFrom)

  if (targets.length === 0)
    return []

  if (options.provider === 'deepl' && targets.every(to => !toDeepLTargetLang(to)))
    throw new TranslateError('None of the configured target languages are supported by DeepL', 'Unsupported language')

  const result = (await Promise.all(targets.map(async to => translate(text, from, to, options)))).filter(i => i.translated)

  const fromLangs = new Set(result?.map(i => i.from))
  const singleSource = fromLangs.size === 1
  if (singleSource)
    return result.filter(i => i.from !== i.to && i.translated.trim().toLowerCase() !== i.original.trim().toLowerCase())
  return result
}
