/**
 * Shared vocabulary for the multi-backend search router: the backend interface
 * every API adapter implements, the backend-id vocabulary the settings and the
 * auto-order parser share, and the cancellation test that keeps a caller's
 * abort from triggering a failover.
 * @module @dsh-external/dsh-web-search-multi/backends
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

/** Stable ids of the search APIs this plugin can route to. */
export type SearchBackendId = 'tavily' | 'exa' | 'deepseek'

/** Every backend id, in the shipped default priority order. */
export const SEARCH_BACKEND_IDS: readonly SearchBackendId[] = ['tavily', 'exa', 'deepseek']

/** Default auto-mode priority, as the settings string spells it. */
export const DEFAULT_AUTO_ORDER = 'tavily,exa,deepseek'

/**
 * One search API adapter the router can dispatch to. Structured exactly like
 * the seam's own WebSearchProvider (id/available/search) so a concrete
 * provider class can serve as a backend without an adapter.
 */
export interface SearchBackend {
  /** Stable backend id (also the route key in settings and diagnostics). */
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one search; honor the abort signal for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/**
 * Parse the settings autoOrder string into a deduped, complete backend order.
 * Unknown tokens are dropped, and ids the string omits are appended in the
 * shipped order, so a truncated or misspelled setting can never silently lose
 * the DeepSeek fallback.
 * @param raw - comma-separated backend ids from the settings section.
 * @returns every backend id exactly once, user priority first then shipped order.
 */
export function parseAutoOrder(raw: string | undefined): SearchBackendId[] {
  const seen = new Set<SearchBackendId>()
  const order: SearchBackendId[] = []
  for (const token of (raw ?? DEFAULT_AUTO_ORDER).split(',')) {
    const id = token.trim().toLowerCase() as SearchBackendId
    if (SEARCH_BACKEND_IDS.includes(id) && !seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
  }
  for (const id of SEARCH_BACKEND_IDS) {
    if (!seen.has(id)) order.push(id)
  }
  return order
}

/**
 * True when an error is the caller's own cancellation. Aborts must propagate
 * untouched: a cancelled search is not a provider failure and must never fall
 * through to another API.
 * @param error - the caught value.
 * @returns true for the seam's WEB_ABORTED error.
 */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'WEB_ABORTED'
}

/** HTTP statuses worth retrying on the same backend before falling through. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Build a provider HTTP failure with its status attached, so the router can
 * tell a transient overload (429/5xx) from a hard auth/quota error without
 * re-parsing the message text.
 * @param message - the human-readable provider message.
 * @param status - the HTTP response status.
 * @returns the WebError carrying the status.
 */
export function providerHttpError(message: string, status: number): WebError {
  const error = new WebError(message, 'WEB_PROVIDER_ERROR')
  ;(error as { status?: number }).status = status
  return error
}

/** The HTTP status attached by providerHttpError, when present. */
export function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * True when a failure deserves a same-backend retry before falling through:
 * server overload (429/5xx) or a transport-level network failure. Auth, quota,
 * and malformed-request errors are not retried.
 * @param error - the caught value.
 * @returns true when a retry may succeed.
 */
export function isTransientError(error: unknown): boolean {
  if (isCancellation(error)) return false
  const status = httpStatusOf(error)
  if (status !== undefined) return TRANSIENT_HTTP_STATUSES.has(status)
  return error instanceof Error
    && /request failed|failed to fetch|fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(error.message)
}
