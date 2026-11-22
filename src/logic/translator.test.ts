import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { LanguageCode } from '../data/languages'
import {
  fromDeepLDetectedLang,
  getDeepLEndpoint,
  getDeepLWebUrl,
  toDeepLSourceLang,
  toDeepLTargetLang,
} from './deepl'
import { TranslateError, clearTranslateCache, translate, translateAll } from './translator'

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status: number, body?: unknown, statusText?: string, rawText?: string },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const res = handler(url, init)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText ?? '',
      json: async () => {
        if (res.rawText !== undefined)
          throw new SyntaxError('Unexpected token < in JSON')
        return res.body
      },
    } as Response
  }) as typeof fetch
}

describe('DeepL helpers', () => {
  it('routes :fx keys to Free endpoint and others to Pro endpoint', () => {
    assert.equal(getDeepLEndpoint('abc123:fx'), 'https://api-free.deepl.com/v2/translate')
    assert.equal(getDeepLEndpoint('  abc123:fx  '), 'https://api-free.deepl.com/v2/translate')
    assert.equal(getDeepLEndpoint('abc123-pro'), 'https://api.deepl.com/v2/translate')
  })

  it('maps target, source, and detected language codes accurately including case-insensitive and regional subtags', () => {
    assert.equal(toDeepLTargetLang('en'), 'EN-US')
    assert.equal(toDeepLTargetLang('pt'), 'PT-PT')
    assert.equal(toDeepLTargetLang('zh-CN'), 'ZH-HANS')
    assert.equal(toDeepLTargetLang('zh-TW'), 'ZH-HANT')
    assert.equal(toDeepLTargetLang('zh-cn' as LanguageCode), 'ZH-HANS')
    assert.equal(toDeepLTargetLang('zh-tw' as LanguageCode), 'ZH-HANT')
    assert.equal(toDeepLTargetLang('no'), 'NB')
    assert.equal(toDeepLTargetLang('ja'), 'JA')
    assert.equal(toDeepLTargetLang('sw'), null)
    assert.equal(toDeepLTargetLang('auto'), null)

    assert.equal(toDeepLSourceLang('en'), 'EN')
    assert.equal(toDeepLSourceLang('zh-CN'), 'ZH')
    assert.equal(toDeepLSourceLang('zh-cn' as LanguageCode), 'ZH')
    assert.equal(toDeepLSourceLang('zh-tw' as LanguageCode), 'ZH')
    assert.equal(toDeepLSourceLang('no'), 'NB')
    assert.equal(toDeepLSourceLang('auto'), null)

    assert.equal(fromDeepLDetectedLang('EN-US', 'auto'), 'en')
    assert.equal(fromDeepLDetectedLang('ZH', 'auto'), 'zh-CN')
    assert.equal(fromDeepLDetectedLang('ZH-HANT', 'auto'), 'zh-TW')
    assert.equal(fromDeepLDetectedLang('NB', 'auto'), 'no')
    assert.equal(fromDeepLDetectedLang('DE', 'auto'), 'de')
    assert.equal(fromDeepLDetectedLang('ES-419', 'auto'), 'es')
    assert.equal(fromDeepLDetectedLang('XX-UNKNOWN', 'auto'), 'auto')
    assert.equal(fromDeepLDetectedLang(undefined, 'auto'), 'auto')
  })

  it('builds DeepL web translator URLs and escapes hash router delimiters (/, \\, |)', () => {
    assert.equal(
      getDeepLWebUrl('hello world', 'en', 'zh-CN'),
      'https://www.deepl.com/translator#en/zh-hans/hello%20world',
    )
    assert.equal(
      getDeepLWebUrl('a/b\\c|d', 'en', 'de'),
      'https://www.deepl.com/translator#en/de/a%5C%2Fb%5C%5Cc%5C%7Cd',
    )
  })
})

describe('DeepL translation integration', () => {
  beforeEach(() => {
    clearTranslateCache()
  })

  it('sends DeepL-Auth-Key header, omits source_lang on auto, and caches results', async () => {
    let calls = 0
    const fakeFetch = mockFetch((url, init) => {
      calls += 1
      assert.equal(url, 'https://api-free.deepl.com/v2/translate')
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.Authorization, 'DeepL-Auth-Key test-key:fx')
      const payload = JSON.parse(String(init?.body))
      assert.deepEqual(payload, {
        text: ['Hello'],
        target_lang: 'JA',
      })
      return {
        status: 200,
        body: {
          translations: [{ detected_source_language: 'EN', text: 'こんにちは' }],
        },
      }
    })

    const res1 = await translate('Hello', 'auto', 'ja', {
      provider: 'deepl',
      deeplApiKey: 'test-key:fx',
      fetchFn: fakeFetch,
    })
    assert.deepEqual(res1, {
      original: 'Hello',
      translated: 'こんにちは',
      from: 'en',
      to: 'ja',
    })

    // Second call hits LRU cache
    const res2 = await translate('Hello', 'auto', 'ja', {
      provider: 'deepl',
      deeplApiKey: 'test-key:fx',
      fetchFn: fakeFetch,
    })
    assert.deepEqual(res2, res1)
    assert.equal(calls, 1)
  })

  it('includes source_lang when explicitly provided and routes Pro key to api.deepl.com', async () => {
    const fakeFetch = mockFetch((url, init) => {
      assert.equal(url, 'https://api.deepl.com/v2/translate')
      const payload = JSON.parse(String(init?.body))
      assert.deepEqual(payload, {
        text: ['Bonjour'],
        source_lang: 'FR',
        target_lang: 'EN-US',
      })
      return {
        status: 200,
        body: {
          translations: [{ detected_source_language: 'FR', text: 'Hello' }],
        },
      }
    })

    const res = await translate('Bonjour', 'fr', 'en', {
      provider: 'deepl',
      deeplApiKey: 'pro-secret-key',
      fetchFn: fakeFetch,
    })
    assert.equal(res.translated, 'Hello')
    assert.equal(res.from, 'fr')
  })

  it('short-circuits same-language targets in translateAll to save DeepL quota and skips unsupported targets', async () => {
    const requestedTargets: string[] = []
    const fakeFetch = mockFetch((_url, init) => {
      const payload = JSON.parse(String(init?.body))
      requestedTargets.push(payload.target_lang)
      return {
        status: 200,
        body: {
          translations: [{
            detected_source_language: 'EN',
            text: payload.target_lang === 'DE' ? 'Hallo' : 'Hello',
          }],
        },
      }
    })

    const results = await translateAll('Hello', 'en', ['en', 'de', 'sw'], {
      provider: 'deepl',
      deeplApiKey: 'test-key:fx',
      fetchFn: fakeFetch,
    })
    assert.deepEqual(requestedTargets, ['DE'])
    assert.equal(results.length, 1)
    assert.equal(results[0].to, 'de')
    assert.equal(results[0].translated, 'Hallo')
  })

  it('throws clear TranslateError when all configured target languages are unsupported by DeepL', async () => {
    await assert.rejects(
      () => translateAll('Hello', 'auto', ['sw', 'zu'], {
        provider: 'deepl',
        deeplApiKey: 'test-key:fx',
      }),
      (err: unknown) => err instanceof TranslateError && err.name === 'Unsupported language',
    )
  })

  it('throws clear TranslateError on missing key, 403/429/529/456, 500 JSON, 502 HTML, empty 200, and network failure', async () => {
    await assert.rejects(
      () => translate('Hello', 'auto', 'de', { provider: 'deepl', deeplApiKey: '   ' }),
      (err: unknown) => err instanceof TranslateError && err.name === 'Missing DeepL API key',
    )

    await assert.rejects(
      () => translate('Hello', 'sw', 'de', { provider: 'deepl', deeplApiKey: 'k:fx' }),
      (err: unknown) => err instanceof TranslateError && err.name === 'Unsupported language',
    )

    for (const [status, expectedName] of [
      [403, 'DeepL authentication failed'],
      [429, 'Too many requests'],
      [529, 'Too many requests'],
      [456, 'DeepL quota exceeded'],
    ] as const) {
      const fakeFetch = mockFetch(() => ({ status, body: { message: 'err' } }))
      await assert.rejects(
        () => translate(`test-${status}`, 'auto', 'de', {
          provider: 'deepl',
          deeplApiKey: 'k:fx',
          fetchFn: fakeFetch,
        }),
        (err: unknown) => err instanceof TranslateError && err.name === expectedName,
      )
    }

    // 500 with JSON message
    const fetch500 = mockFetch(() => ({ status: 500, body: { message: 'Internal failure' } }))
    await assert.rejects(
      () => translate('test-500', 'auto', 'de', { provider: 'deepl', deeplApiKey: 'k:fx', fetchFn: fetch500 }),
      (err: unknown) => err instanceof TranslateError && err.message === 'Internal failure',
    )

    // 502 with non-JSON HTML body and empty statusText (HTTP/2 / undici)
    const fetch502 = mockFetch(() => ({ status: 502, rawText: '<html>Bad Gateway</html>', statusText: '' }))
    await assert.rejects(
      () => translate('test-502', 'auto', 'de', { provider: 'deepl', deeplApiKey: 'k:fx', fetchFn: fetch502 }),
      (err: unknown) => err instanceof TranslateError && err.message === 'HTTP 502',
    )

    // 200 with empty/malformed translations array
    const fetchEmpty200 = mockFetch(() => ({ status: 200, body: { translations: [] } }))
    await assert.rejects(
      () => translate('test-empty-200', 'auto', 'de', { provider: 'deepl', deeplApiKey: 'k:fx', fetchFn: fetchEmpty200 }),
      (err: unknown) => err instanceof TranslateError && err.name === 'DeepL API error',
    )

    // Network rejection
    const fetchNetErr = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    await assert.rejects(
      () => translate('test-net', 'auto', 'de', { provider: 'deepl', deeplApiKey: 'k:fx', fetchFn: fetchNetErr }),
      (err: unknown) => err instanceof TranslateError && err.message === 'ECONNRESET',
    )
  })
})
