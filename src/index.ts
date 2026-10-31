/**
 * Multi-API web search provider for the DeepSeek Harness web capability seam
 * (ctx.web). It registers ONE provider (id multi-search) that routes each
 * search across Tavily, Exa, and DeepSeek native search. Auto mode walks a
 * user-set priority order and falls through to the next API on any
 * non-cancellation failure, so an exhausted free tier hands the next search to
 * another API. A master switch turns third-party routing off and pins DeepSeek
 * native search. Every credential resolves per search through the credentials
 * seam, so a key saved from the GUI applies on the next request.
 * @module @dsh-external/dsh-web-search-multi
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { DEFAULT_AUTO_ORDER, parseAutoOrder } from './backends.ts'
import type { SearchBackend, SearchBackendId } from './backends.ts'
import { MULTI_SEARCH_PROVIDER_ID, MultiSearchProvider } from './composite.ts'
import { TAVILY_DEFAULT_BASE_URL, TavilySearchProvider } from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'
import {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  ExaSearchBackend,
} from './exa.ts'
import type { ExaSearchBackendOptions } from './exa.ts'
import {
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_SEARCH_BASE_URL,
  DeepSeekSearchBackend,
} from './deepseek.ts'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  mapTavilyResponse,
  mapTavilyResult,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'
export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  ExaSearchBackend,
  mapExaResponse,
  mapExaResult,
} from './exa.ts'
export type { ExaSearchBackendOptions } from './exa.ts'
export {
  DEEPSEEK_BACKEND_ID,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_SEARCH_BASE_URL,
  DeepSeekSearchBackend,
} from './deepseek.ts'
export { MULTI_SEARCH_PROVIDER_ID, MultiSearchProvider } from './composite.ts'
export { DEFAULT_AUTO_ORDER, SEARCH_BACKEND_IDS, parseAutoOrder } from './backends.ts'
export type { SearchBackend, SearchBackendId } from './backends.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-multi'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying this provider's routing and per-API options. */
export const WEB_SEARCH_MULTI_SETTINGS_NAMESPACE = 'web-search-multi'

const TAVILY_BASE_URL_ENV = 'TAVILY_BASE_URL'
const EXA_BASE_URL_ENV = 'EXA_BASE_URL'
const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/**
 * Plugin config. Every field is `Volatile` because the settings document
 * rewrites this plugin's loader entry in place: the live reference a search
 * reads through `.get()` is what lets a saved change apply to the next
 * request without re-registering the provider. Fields carrying a schema
 * default are always present; the rest resolve to undefined.
 */
export interface Config {
  /** Master switch. false routes every search to DeepSeek native. Defaults to true. */
  enabled: Volatile<boolean>
  /** auto walks autoOrder; a concrete id is tried first. Defaults to auto. */
  mode: Volatile<'auto' | 'tavily' | 'exa' | 'deepseek'>
  /** Comma-separated priority order for auto mode. Defaults to tavily,exa,deepseek. */
  autoOrder: Volatile<string>
  /** Fall through to the next backend on a non-cancellation failure. Defaults to true. */
  failover: Volatile<boolean>
  /** Total attempts per backend, including the first. Defaults to 3. */
  retryAttempts: Volatile<number>
  /** Base backoff before a retry, in ms; doubles per retry. Defaults to 800. */
  retryDelayMs: Volatile<number>

  /** Literal Tavily key; prefer apiKeyEnv so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to TAVILY_API_KEY. */
  apiKeyEnv: Volatile<string>
  /** Tavily endpoint base; /search is appended. */
  baseURL: Volatile<string | undefined>
  /** Tavily search_depth. Defaults to basic. */
  searchDepth: Volatile<'basic' | 'advanced'>
  /** Tavily default result count. Defaults to 8. */
  maxResults: Volatile<number>
  /** Request Tavily's generated answer. Defaults to false. */
  includeAnswer: Volatile<boolean>
  /** Tavily recency filter, 1..30 days. */
  days: Volatile<number | undefined>

  /** Literal Exa key; prefer exaApiKeyEnv so no secret enters configuration files. */
  exaApiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to EXA_API_KEY. */
  exaApiKeyEnv: Volatile<string>
  /** Exa endpoint base; /search is appended. */
  exaBaseURL: Volatile<string | undefined>
  /** Exa retrieval type. Defaults to auto. */
  exaSearchType: Volatile<'auto' | 'keyword' | 'neural'>
  /** Exa default result count. */
  exaNumResults: Volatile<number | undefined>
  /** Exa highlight sentences requested per result. Defaults to 1. */
  exaHighlightsPerResult: Volatile<number>

  /** Literal DeepSeek key; prefer deepseekApiKeyEnv so no secret enters configuration files. */
  deepseekApiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to DEEPSEEK_API_KEY. */
  deepseekApiKeyEnv: Volatile<string>
  /** DeepSeek auxiliary-search endpoint base; /messages is appended. */
  deepseekBaseURL: Volatile<string | undefined>
  /** Anthropic-format model name. Defaults to deepseek-v4-flash. */
  deepseekModel: Volatile<string>
  /** Upper bound on generated tokens. Defaults to 4096. */
  deepseekMaxTokens: Volatile<number>
  /** Maximum web_search server-tool uses per request. Defaults to 5. */
  deepseekMaxUses: Volatile<number>
}

/**
 * The config schema. `volatile()` is what makes each field a live reference the
 * Host can rewrite when the settings document changes; without it the value is
 * captured once and a saved edit would only apply after a reload.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  mode: z.union(['auto', 'tavily', 'exa', 'deepseek'] as const).default('auto').volatile(),
  autoOrder: z.string().default(DEFAULT_AUTO_ORDER).volatile(),
  failover: z.boolean().default(true).volatile(),
  retryAttempts: z.number().step(1).min(1).default(3).volatile(),
  retryDelayMs: z.number().step(1).min(0).default(800).volatile(),

  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('TAVILY_API_KEY').volatile(),
  // Declared on the schema rather than only at the use site: the settings form
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  searchDepth: z.union(['basic', 'advanced'] as const).default('basic').volatile(),
  maxResults: z.number().step(1).min(1).default(8).volatile(),
  includeAnswer: z.boolean().default(false).volatile(),
  days: z.number().step(1).min(1).max(30).volatile(),

  exaApiKey: z.string().role('secret').volatile(),
  exaApiKeyEnv: z.string().role('credential-ref').default('EXA_API_KEY').volatile(),
  exaBaseURL: z.string().volatile(),
  exaSearchType: z.union(['auto', 'keyword', 'neural'] as const).default('auto').volatile(),
  exaNumResults: z.number().step(1).min(1).volatile(),
  exaHighlightsPerResult: z.number().step(1).min(1).default(1).volatile(),

  deepseekApiKey: z.string().role('secret').volatile(),
  deepseekApiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  deepseekBaseURL: z.string().volatile(),
  deepseekModel: z.string().default(DEEPSEEK_DEFAULT_MODEL).volatile(),
  deepseekMaxTokens: z.number().step(1).min(1).default(4096).volatile(),
  deepseekMaxUses: z.number().step(1).min(1).default(5).volatile(),
})

/** One search's view of the config: every volatile field's value at read time. */
type ConfigValues = { [K in keyof Config]: ReturnType<Config[K]['get']> }

/**
 * Snapshot every config field. Each search and each provider call takes one
 * snapshot at its entry point, which is this plugin's standing design: a
 * settings change reaches the next request with no re-registration.
 * @param config - the loader entry's volatile config.
 * @returns every field's current value.
 */
function readConfig(config: Config): ConfigValues {
  return {
    enabled: config.enabled.get(),
    mode: config.mode.get(),
    autoOrder: config.autoOrder.get(),
    failover: config.failover.get(),
    retryAttempts: config.retryAttempts.get(),
    retryDelayMs: config.retryDelayMs.get(),
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    searchDepth: config.searchDepth.get(),
    maxResults: config.maxResults.get(),
    includeAnswer: config.includeAnswer.get(),
    days: config.days.get(),
    exaApiKey: config.exaApiKey.get(),
    exaApiKeyEnv: config.exaApiKeyEnv.get(),
    exaBaseURL: config.exaBaseURL.get(),
    exaSearchType: config.exaSearchType.get(),
    exaNumResults: config.exaNumResults.get(),
    exaHighlightsPerResult: config.exaHighlightsPerResult.get(),
    deepseekApiKey: config.deepseekApiKey.get(),
    deepseekApiKeyEnv: config.deepseekApiKeyEnv.get(),
    deepseekBaseURL: config.deepseekBaseURL.get(),
    deepseekModel: config.deepseekModel.get(),
    deepseekMaxTokens: config.deepseekMaxTokens.get(),
    deepseekMaxUses: config.deepseekMaxUses.get(),
  }
}

/** A literal-or-credential key source shared by every backend. */
interface KeySource {
  apiKey?: string
  apiKeyEnv: CredentialRef
  resolveApiKey: () => Promise<string | undefined>
}

/**
 * Build one backend's key source: a literal wins, otherwise the credentials
 * seam resolves the reference per search (environment is the whole credential
 * plane only when the seam is absent).
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param literal - the section's literal key, when set.
 * @param ref - the resolved credential reference.
 * @returns the key source fields every backend option shape accepts.
 */
function keySource(ctx: Context, literal: string | undefined, ref: CredentialRef): KeySource {
  const literalKey = literal !== undefined && literal.length > 0 ? literal : undefined
  return {
    ...literalKey === undefined ? {} : { apiKey: literalKey },
    apiKeyEnv: ref,
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(ref))?.value
      const ambient = launchEnvironmentOf(ctx).get(ref)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
  }
}

/** Project one config snapshot into Tavily's per-search options. */
function tavilyOptions(ctx: Context, config: ConfigValues): TavilySearchProviderOptions {
  const ref = credentialRef(config.apiKeyEnv)
  return {
    ...keySource(ctx, config.apiKey, ref),
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(TAVILY_BASE_URL_ENV)?.value
      ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth,
    maxResults: config.maxResults,
    includeAnswer: config.includeAnswer,
    ...config.days !== undefined ? { days: config.days } : {},
  }
}

/** Project one config snapshot into Exa's per-search options. */
function exaOptions(ctx: Context, config: ConfigValues): ExaSearchBackendOptions {
  const ref = credentialRef(config.exaApiKeyEnv)
  return {
    ...keySource(ctx, config.exaApiKey, ref),
    baseURL: config.exaBaseURL
      ?? launchEnvironmentOf(ctx).get(EXA_BASE_URL_ENV)?.value
      ?? EXA_DEFAULT_BASE_URL,
    searchType: config.exaSearchType,
    highlightsPerResult: config.exaHighlightsPerResult,
    ...config.exaNumResults !== undefined ? { numResults: config.exaNumResults } : {},
  }
}

/** Project one config snapshot into the DeepSeek backend's per-search options. */
function deepseekOptions(ctx: Context, config: ConfigValues): DeepSeekSearchProviderOptions {
  const ref = credentialRef(config.deepseekApiKeyEnv)
  return {
    ...keySource(ctx, config.deepseekApiKey, ref),
    baseURL: config.deepseekBaseURL
      ?? launchEnvironmentOf(ctx).get(DEEPSEEK_SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_SEARCH_BASE_URL,
    model: config.deepseekModel,
    apiVersion: '2023-06-01',
    maxTokens: config.deepseekMaxTokens,
    maxUses: config.deepseekMaxUses,
  }
}

/**
 * Register the multi-backend search router with ctx.web.
 *
 * The settings surface is the loader entry's own `Config`: the Host rewrites
 * the entry in place, so an edit arrives through the volatile field references
 * and is read at each search's entry point.
 * @param ctx - plugin context supplying the web seam, credentials, and environment.
 * @param config - the entry's volatile config.
 */
export function apply(ctx: Context, config: Config): void {
  const backends: Record<SearchBackendId, SearchBackend> = {
    tavily: new TavilySearchProvider(() => tavilyOptions(ctx, readConfig(config))),
    exa: new ExaSearchBackend(() => exaOptions(ctx, readConfig(config))),
    deepseek: new DeepSeekSearchBackend(() => deepseekOptions(ctx, readConfig(config))),
  }

  const logger = ctx.logger(name)
  ctx.web.registerSearchProvider(new MultiSearchProvider(() => {
    const section = readConfig(config)
    return {
      enabled: section.enabled,
      mode: section.mode,
      order: parseAutoOrder(section.autoOrder),
      failover: section.failover,
      retryAttempts: section.retryAttempts,
      retryDelayMs: section.retryDelayMs,
      build: (id) => backends[id],
      onFallback: (event) => {
        logger.warn(
          'search backend %s failed (%s); next: %s',
          event.from,
          event.reason,
          event.to ?? 'none',
        )
      },
      onRetry: (event) => {
        logger.warn(
          'search backend %s transient failure (%s); retry %d in %dms',
          event.from,
          event.reason,
          event.attempt,
          event.delayMs,
        )
      },
      onSuccess: (event) => {
        if (event.retries > 0) {
          logger.info('search served by %s after %d retry/ies', event.from, event.retries)
        }
      },
    }
  }))
}
