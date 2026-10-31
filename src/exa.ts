/**
 * Exa search backend: POST {baseURL}/search with highlight contents, mapped to
 * the seam's normalized sources. Mirrors the harness's shipped Exa provider but
 * resolves the API key per search through the credentials seam, so a key
 * written from the GUI applies on the next request.
 * @module @dsh-external/dsh-web-search-multi/exa
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { providerHttpError } from './backends.ts'
import type { SearchBackend } from './backends.ts'

/** Stable backend id. */
export const EXA_BACKEND_ID = 'exa'

/** Default Exa endpoint; /search is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Default retrieval mode: let Exa pick between keyword and neural search. */
export const EXA_DEFAULT_SEARCH_TYPE = 'auto'

/** Default number of highlight sentences requested per result. */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-multi/0.0.2'

/** One entry of Exa's results[]. */
interface ExaResult {
  readonly url: string
  readonly title?: string
  readonly highlights?: readonly string[]
  readonly publishedDate?: string
}

/** Parsed Exa response envelope. */
interface ExaSearchResponse {
  readonly results?: readonly ExaResult[]
}

/** Exa error envelope. */
interface ExaErrorBody {
  readonly error?: string
  readonly message?: string
}

/** Resolved backend options (the plugin's apply supplies credential and constant defaults). */
export interface ExaSearchBackendOptions {
  /** Literal Exa key; when present it wins over resolveApiKey. */
  apiKey?: string
  /** Resolve the current Exa key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; /search is appended. */
  baseURL: string
  /** Retrieval mode sent as Exa's type. */
  searchType: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no maxResults. */
  numResults?: number
  /** Highlight sentences requested per result. */
  highlightsPerResult: number
}

/**
 * Map one Exa result to a normalized source, or undefined when it carries no
 * portable snippet (an entry with no highlight is dropped).
 * @param result - one entry of Exa's results[].
 * @returns the normalized source, or undefined when the entry has no highlight.
 */
export function mapExaResult(result: ExaResult): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map an Exa response envelope to a normalized search result.
 * @param response - the parsed POST /search response body.
 * @returns the normalized result; snippet-less entries are dropped.
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapExaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** The Exa-backed search backend; HTTP redirects fail as WEB_PROVIDER_ERROR. */
export class ExaSearchBackend implements SearchBackend {
  readonly id = EXA_BACKEND_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   * at each operation entry so one search never mixes two settings writes.
   */
  constructor(private readonly resolveOptions: () => ExaSearchBackendOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.highlightsPerResult)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const numResults = request.maxResults ?? options.numResults
    let response: Response
    try {
      response = await fetch(options.baseURL + '/search', {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          type: options.searchType,
          contents: { highlights: { highlightsPerUrl: options.highlightsPerResult } },
          ...numResults !== undefined ? { numResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError('Exa search request failed: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = 'Exa API error (HTTP ' + status + ')'
      try {
        const parsed = await response.json() as ExaErrorBody
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      }
      throw providerHttpError(message, status)
    }

    try {
      const payload = await response.json() as ExaSearchResponse
      return mapExaResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError('Exa returned an unprocessable response body: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async apiKey(options: ExaSearchBackendOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError('Exa search credential resolution failed: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'EXA_API_KEY'
    throw new WebError(
      'Exa search has no API key for "' + ref + '"; store it in the web-search-multi settings section, export EXA_API_KEY, or set a literal exaApiKey config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the backend's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the backend's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Exa search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/AbortSignal abort, surfaced as WEB_ABORTED. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default ExaSearchBackend
