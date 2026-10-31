/**
 * DeepSeek native-search backend: a thin adapter over the harness's shipped
 * DeepSeek provider (Anthropic-compatible Messages with the native
 * web_search_20250305 server tool). Reused rather than reimplemented so the
 * wire format and result mapping cannot drift from the harness.
 * @module @dsh-external/dsh-web-search-multi/deepseek
 */

import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { SearchBackend } from './backends.ts'

/** Stable backend id. */
export const DEEPSEEK_BACKEND_ID = 'deepseek'

/** Default auxiliary-search endpoint (including /v1); /messages is appended. */
export const DEEPSEEK_DEFAULT_SEARCH_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Default Anthropic-format model name. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * The DeepSeek-backed search backend. Its id is the router's route key; the
 * wrapped provider keeps its own harness id, which is never registered here.
 */
export class DeepSeekSearchBackend implements SearchBackend {
  readonly id = DEEPSEEK_BACKEND_ID
  private readonly provider: DeepSeekSearchProvider

  constructor(resolveOptions: () => DeepSeekSearchProviderOptions) {
    this.provider = new DeepSeekSearchProvider(resolveOptions)
  }

  available(): boolean {
    return this.provider.available()
  }

  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return this.provider.search(request, signal)
  }
}

export default DeepSeekSearchBackend
