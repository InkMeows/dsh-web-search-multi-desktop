/**
 * The plugin's single registered provider: a router over the configured search
 * backends. Mode auto walks the user's priority order and falls through to the
 * next API on any non-cancellation failure (quota exhausted, auth, network), so
 * an exhausted free tier hands the next search to another API. A transient
 * failure (429/5xx/network) is first retried on the SAME backend with
 * exponential backoff, because providers such as Exa recover on a retry. The
 * master enable switch turns third-party routing off entirely and pins DeepSeek.
 * @module @dsh-external/dsh-web-search-multi/composite
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { isCancellation, isTransientError } from './backends.ts'
import type { SearchBackend, SearchBackendId } from './backends.ts'

/** The id this plugin registers under in ctx.web (the profile pin names it). */
export const MULTI_SEARCH_PROVIDER_ID = 'multi-search'

/** Total attempts per backend when a failure looks transient. */
export const DEFAULT_RETRY_ATTEMPTS = 3

/** Base backoff before a retry, in ms; doubles per retry. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 800

/** Upper bound on one backoff sleep. */
export const MAX_RETRY_DELAY_MS = 8000

/** One fallback observation, for logging and diagnostics. */
export interface FallbackEvent {
  readonly from: SearchBackendId
  readonly to: SearchBackendId | undefined
  readonly reason: string
}

/** One same-backend retry observation. */
export interface RetryEvent {
  readonly from: SearchBackendId
  readonly attempt: number
  readonly delayMs: number
  readonly reason: string
}

/** The backend that ultimately served a search. */
export interface SuccessEvent {
  readonly from: SearchBackendId
  readonly retries: number
}

/** Resolved router options (the plugin's apply supplies the backend set). */
export interface MultiSearchOptions {
  /** Master switch; false routes every search to DeepSeek only. */
  enabled: boolean
  /** auto walks the order; a concrete id is tried first. */
  mode: 'auto' | SearchBackendId
  /** Priority order for auto mode and for fallback. */
  order: readonly SearchBackendId[]
  /** Whether a non-cancellation failure advances to the next backend. */
  failover: boolean
  /** Total attempts per backend, including the first. Defaults to 3. */
  retryAttempts?: number
  /** Base backoff before a retry, in ms; doubles per retry. Defaults to 800. */
  retryDelayMs?: number
  /** Build one backend instance (stable instances are owned by apply). */
  build: (id: SearchBackendId) => SearchBackend
  /** Observe each fallback (logging/diagnostics). */
  onFallback?: (event: FallbackEvent) => void
  /** Observe each same-backend retry. */
  onRetry?: (event: RetryEvent) => void
  /** Observe the backend that ultimately served the search. */
  onSuccess?: (event: SuccessEvent) => void
}

/**
 * The multi-backend search router registered with ctx.web. It is the only
 * search provider this plugin registers, so the seam never sees more than one
 * candidate and never has to choose between APIs itself.
 */
export class MultiSearchProvider implements WebSearchProvider {
  readonly id = MULTI_SEARCH_PROVIDER_ID

  constructor(private readonly resolveOptions: () => MultiSearchOptions) {}

  /** The ordered backend ids one search will attempt. */
  private plan(): SearchBackendId[] {
    const options = this.resolveOptions()
    if (!options.enabled) return ['deepseek']
    if (options.mode === 'auto') {
      return options.failover ? [...options.order] : options.order.slice(0, 1)
    }
    const rest = options.order.filter(id => id !== options.mode)
    return options.failover ? [options.mode, ...rest] : [options.mode]
  }

  available(): boolean {
    const options = this.resolveOptions()
    return this.plan().some(id => options.build(id).available())
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const plan = this.plan()
    const attempts = Math.max(1, Math.trunc(options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS))
    const baseDelay = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS))
    const failures: Array<{ id: SearchBackendId; reason: string }> = []
    let attempted = 0
    let lastError: unknown
    for (let index = 0; index < plan.length; index++) {
      const id = plan[index]!
      const backend = options.build(id)
      if (!backend.available()) {
        const reason = 'unavailable (missing credential or invalid configuration)'
        failures.push({ id, reason })
        options.onFallback?.({ from: id, to: plan[index + 1], reason })
        continue
      }
      attempted++
      let served: WebSearchResult | undefined
      let retries = 0
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          served = await backend.search(request, signal)
          retries = attempt - 1
          break
        } catch (error: unknown) {
          if (isCancellation(error)) throw error
          lastError = error
          if (isTransientError(error) && attempt < attempts) {
            const delayMs = retryDelay(attempt, baseDelay)
            options.onRetry?.({ from: id, attempt, delayMs, reason: message(error) })
            await backoff(delayMs, signal)
            continue
          }
          const reason = message(error)
          failures.push({ id, reason })
          options.onFallback?.({ from: id, to: plan[index + 1], reason })
          break
        }
      }
      if (served !== undefined) {
        options.onSuccess?.({ from: id, retries })
        return served
      }
    }
    if (lastError !== undefined && failures.length === 1) throw lastError
    const summary = failures.length === 0
      ? 'no backend is configured'
      : failures.map(failure => failure.id + ': ' + failure.reason).join('; ')
    throw new WebError(
      'all configured search backends failed (' + summary + ')',
      attempted === 0 ? 'WEB_PROVIDER_UNAVAILABLE' : 'WEB_PROVIDER_ERROR',
      lastError !== undefined ? { cause: lastError } : undefined,
    )
  }
}

/** One error's human-readable message. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Exponential backoff for one failed attempt, capped. */
function retryDelay(attempt: number, baseDelay: number): number {
  return Math.min(baseDelay * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/** Sleep between attempts, remaining responsive to the caller's abort. */
function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortedDuringBackoff(signal))
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortedDuringBackoff(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The router's own cancellation error while sleeping between retries. */
function abortedDuringBackoff(signal?: AbortSignal): WebError {
  return new WebError('search aborted during retry backoff', 'WEB_ABORTED', { cause: signal?.reason })
}

export default MultiSearchProvider
