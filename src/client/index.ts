/**
 * @dsh-external/dsh-web-search-multi — browser side.
 *
 * Registers the `web-search-multi` card into the Plugins settings tab
 * (`settings.plugin.item`, keyed by the Host settings namespace). The Host
 * registers the namespace and the tab dispatches only namespaces that serve a
 * card, so without this half the settings section was invisible in the GUI.
 *
 * The API key deliberately does NOT ride a settings section: it is written
 * through the credentials domain addressed by `TAVILY_API_KEY` (or the
 * section-named reference), exactly like the built-in web-search card treats
 * `DEEPSEEK_API_KEY` — a secret never materializes into the settings document
 * or any response. Every other field edits the section through the bound
 * settings scope (field-level `set`/`unset` with revision fencing).
 *
 * Pure React.createElement (no JSX), no CSS modules, no locale service: styled
 * with the theme's `--dsw-*` variables and the web-app conventions.
 */

import React from 'react'

const PLUGIN_ID = '@dsh-external/dsh-web-search-multi'

/** The Host settings namespace this card edits (spelled, never imported). */
const NS = 'web-search-multi'

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'TAVILY_API_KEY'

/** Credential reference the Exa backend resolves when the section names none. */
const DEFAULT_EXA_API_KEY_REF = 'EXA_API_KEY'

/** Credential reference the DeepSeek backend resolves when the section names none. */
const DEFAULT_DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

// ------------------------------------------------------------------ types ---

/** Field-level snapshot the scope serves. */
interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
  /** Raw user layer; a present field marks a user override. */
  user?: T | undefined
}

/** The bound settings scope's public face (contract-shaped). */
interface SettingsScopeLike<T> {
  getSnapshot(): ScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/**
 * 0.1.7 `ctx.configForms` scope face. The upstream `ConfigForm<T>` already
 * matches {@link SettingsScopeLike} field-for-field except that its writes
 * resolve `boolean` instead of `void`; this adapter narrows that difference so
 * the card's controller is unchanged across host generations.
 */
interface ConfigFormLike<T> {
  getSnapshot(): ScopeSnapshot<T> & { revision?: number | undefined }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

/** The 0.1.7 config-form service: form scopes addressed by Host entry id. */
interface ConfigFormsLike {
  get<T>(namespace: string): ConfigFormLike<T>
  /**
   * Run `register` exactly while the Host serves every named namespace, so a
   * deployment without the plugin shows no trace of its page.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** What the card edits — a subset of the served schema by design. */
interface TavilySettings {
  enabled?: boolean
  mode?: 'auto' | 'tavily' | 'exa' | 'deepseek'
  autoOrder?: string
  failover?: boolean
  apiKeyEnv?: string
  searchDepth?: 'basic' | 'advanced'
  maxResults?: number
  includeAnswer?: boolean
  days?: number
  exaApiKeyEnv?: string
  exaSearchType?: 'auto' | 'keyword' | 'neural'
  exaNumResults?: number
  exaHighlightsPerResult?: number
  deepseekApiKeyEnv?: string
}

/** Snapshots the card consumes (destructured subset of the runtime store). */
interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The card's own publish handle; the runtime store is wider. */
interface CardStore<T> extends SnapshotStoreLike<T> {
  set(next: T): void
}

/** One Remote call's result, as the generated client face resolves it. */
type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** The credentials remote namespace the section's key reference is addressed on. */
interface CredentialsRemoteLike {
  describe(refs: string[]): Promise<
    RemoteResultLike<Record<string, { configured?: boolean; writable?: boolean } | undefined>>
  >
  set(ref: string, value: string): Promise<RemoteResultLike<unknown>>
}

/** Structural client context (duck-typed; the runtime's real face is wider). */
interface ClientContextLike {
  effect(fn: () => void | (() => void), label?: string): () => void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: {
      name: string
      key?: string
      id?: string
      order?: number
      priority?: number
      label?: string | (() => string)
      inject?: () => object
    }, component: unknown): () => void
  }
  /** 0.1.7+ config-form service; the host generation that serves settings cards. */
  configForms?: ConfigFormsLike
  remote: {
    credentials: CredentialsRemoteLike
  }
}

/**
 * Bind the plugin's settings namespace.
 *
 * 0.1.7 replaced `settingsScope.bind({ namespace })` with `configForms.get(ns)`
 * and moved the "is the Host serving this namespace" question into
 * `configForms.whileServed`. The old binder is not probed at all: cordis throws
 * on reading a service the plugin did not declare, so touching `settingsScope`
 * would fail the entry on a 0.1.7 host rather than degrade.
 * @param ctx - the browser plugin context.
 * @param ns - the Host loader entry id owning the settings section.
 * @returns the bound scope, or undefined when this host serves no config forms.
 */
function bindScope<T>(ctx: ClientContextLike, ns: string): SettingsScopeLike<T> | undefined {
  const forms = ctx.configForms
  if (forms === undefined) return undefined
  const form = forms.get<T>(ns)
  return {
    getSnapshot: () => form.getSnapshot(),
    subscribe: listener => form.subscribe(listener),
    set: async (field, value) => {
      if (!await form.set(field, value)) throw new Error(`Settings write refused: ${field}`)
    },
    unset: async (field) => {
      if (!await form.unset(field)) throw new Error(`Settings clear refused: ${field}`)
    },
  }
}

/**
 * Run `register` while the Host serves the namespace.
 *
 * On 0.1.7 this is `configForms.whileServed`; the older host had no equivalent
 * gate, so the registration runs unconditionally there (its scope reports
 * `unavailable` and the card renders nothing).
 * @param ctx - the browser plugin context.
 * @param ns - the Host loader entry id owning the settings section.
 * @param register - the slot registration to gate.
 * @returns the disposer.
 */
function whileServed(ctx: ClientContextLike, ns: string, register: () => () => void): () => void {
  if (ctx.configForms !== undefined) return ctx.configForms.whileServed([ns], () => register())
  return register()
}

/** One staged text/number field. */
interface FieldState {
  /** Effective value the Host resolves (plain editing display). */
  effective: string
  /** User-staged literal; equals `effective` when untouched. */
  staged: string
  /** Whether the user layer overrides this field. */
  overridden: boolean
}

/** The credential control's state (the key never rides a response). */
interface CredentialState {
  /** Whether the Host reports a credential configured for the referenced key. */
  configured: boolean
  /** Whether the credentials domain accepts a write for it. */
  writable: boolean
}

/** What the card renders. */
interface TavilyCardState {
  /** False while the Host serves no section under NS. */
  available: boolean
  /** False when the Host document is read-only. */
  writable: boolean
  /** True while a save is in flight. */
  saving: boolean
  /** True after a save failed. */
  failed: boolean
  /** Whether any staged edit differs from the effective section. */
  dirty: boolean
  /** Effective section the form derives from. */
  section: TavilySettings | undefined
  enabled: FieldState
  mode: FieldState
  autoOrder: FieldState
  failover: FieldState
  searchDepth: FieldState
  maxResults: FieldState
  includeAnswer: FieldState
  days: FieldState
  apiKeyEnv: FieldState
  exaSearchType: FieldState
  exaNumResults: FieldState
  exaHighlightsPerResult: FieldState
  exaApiKeyEnv: FieldState
  deepseekApiKeyEnv: FieldState
  /** Credential presence for the two key fields (literals never echo back). */
  credentials: { tavily: CredentialState; exa: CredentialState }
}

/** The registration-side face the card's slot entry injects. */
interface TavilyCardFace {
  hooks: { tavilyCard: SnapshotStoreLike<TavilyCardState> }
  edit(field: string, raw: string): void
  resetField(field: string): void
  save(): Promise<void>
  discard(): void
}

type Translate = (key: string) => string

// ------------------------------------------------------------------ copy ---

const zh: Record<string, string> = {
  title: '多引擎搜索（Tavily / Exa / DeepSeek）',
  description: 'web_search 后端：按额度自动切换 Tavily / Exa，关闭后回退 DeepSeek 原生搜索',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '有未保存的修改',
  readOnly: '当前部署的 settings 文档为只读',
  saveFailed: '保存失败，请重试',
  apiKey: 'Tavily API key',
  apiKeyHint: '密钥写入凭据域（不落 settings 文档）。留空 = 保留现有 key。',
  apiKeyConfigured: '已配置',
  apiKeyMissing: '未配置',
  apiKeyRef: '凭据引用',
  searchDepth: '检索深度',
  searchDepthBasic: 'basic（默认，更快更省）',
  searchDepthAdvanced: 'advanced（更深入）',
  maxResults: '结果数量',
  maxResultsHint: '单次搜索返回的来源上限（1–20）',
  includeAnswer: '生成式总结（include_answer）',
  includeAnswerHint: '额外消耗 credit 与延迟；默认关闭',
  days: '仅最近 N 天',
  daysHint: '留空 = 不限时间（1–30）',
  overridden: '已覆盖默认值',
  reset: '恢复默认',
  invalidNumber: '请输入有效整数',
  invalidDays: '请输入 1–30 的整数',
  enabled: '启用第三方 API 搜索',
  enabledHint: '关闭后 web_search 使用 DeepSeek 原生搜索，不再调用 Tavily / Exa',
  mode: '搜索方式',
  modeAuto: 'auto（按顺序自动切换）',
  modeTavily: 'tavily（仅 Tavily）',
  modeExa: 'exa（仅 Exa）',
  modeDeepseek: 'deepseek（仅 DeepSeek 原生）',
  autoOrder: '自动优先级顺序',
  autoOrderHint: '逗号分隔，如 tavily,exa,deepseek；额度用完自动切下一个',
  failover: '失败自动回退',
  failoverHint: '某个 API 报错或额度耗尽时自动尝试下一个',
  tavilySection: 'Tavily',
  exaSection: 'Exa',
  deepseekSection: 'DeepSeek 原生搜索',
  exaApiKey: 'Exa API key',
  exaApiKeyHint: '写入凭据域（不落 settings 文档）。留空 = 保留现有 key。',
  exaSearchType: 'Exa 检索类型',
  exaNumResults: 'Exa 结果数量',
  exaHighlightsPerResult: 'Exa 每结果高亮句数',
  exaApiKeyEnv: 'Exa 凭据引用',
  deepseekApiKeyEnv: 'DeepSeek 凭据引用',
  tavilyApiKeyEnv: 'Tavily 凭据引用',
}

const en: Record<string, string> = {
  title: 'Multi-engine search (Tavily / Exa / DeepSeek)',
  description: 'web_search backend: auto-switch across Tavily / Exa on quota; off falls back to DeepSeek native search',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard changes',
  unsaved: 'Unsaved changes',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'Save failed, please retry',
  apiKey: 'Tavily API key',
  apiKeyHint: 'Stored in the credentials domain (never the settings document). Leave blank to keep the current key.',
  apiKeyConfigured: 'Configured',
  apiKeyMissing: 'Not configured',
  apiKeyRef: 'Credential reference',
  searchDepth: 'Search depth',
  searchDepthBasic: 'basic (default, faster)',
  searchDepthAdvanced: 'advanced (deeper)',
  maxResults: 'Result count',
  maxResultsHint: 'Max sources per search (1–20)',
  includeAnswer: 'Generated answer (include_answer)',
  includeAnswerHint: 'Extra credit and latency; off by default',
  days: 'Last N days only',
  daysHint: 'Blank = any time (1–30)',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'Enter a whole number',
  invalidDays: 'Enter a whole number 1–30',
  enabled: 'Enable third-party API search',
  enabledHint: 'Off: web_search uses DeepSeek native search and never calls Tavily / Exa',
  mode: 'Search mode',
  modeAuto: 'auto (walk the order)',
  modeTavily: 'tavily (Tavily only)',
  modeExa: 'exa (Exa only)',
  modeDeepseek: 'deepseek (native only)',
  autoOrder: 'Auto priority order',
  autoOrderHint: 'Comma-separated, e.g. tavily,exa,deepseek; an exhausted API falls through to the next',
  failover: 'Automatic failover',
  failoverHint: 'On an API error or exhausted quota, try the next backend',
  tavilySection: 'Tavily',
  exaSection: 'Exa',
  deepseekSection: 'DeepSeek native search',
  exaApiKey: 'Exa API key',
  exaApiKeyHint: 'Stored in the credentials domain (never the settings document). Leave blank to keep the current key.',
  exaSearchType: 'Exa search type',
  exaNumResults: 'Exa result count',
  exaHighlightsPerResult: 'Exa highlights per result',
  exaApiKeyEnv: 'Exa credential reference',
  deepseekApiKeyEnv: 'DeepSeek credential reference',
  tavilyApiKeyEnv: 'Tavily credential reference',
}

const t: Translate = (key: string): string => zh[key] ?? en[key] ?? key

// ----------------------------------------------------------------- styles ---

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
}

const fieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  opacity: 0.75,
  marginBottom: 2,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  borderRadius: '6px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

const hintStyle: React.CSSProperties = { display: 'block', fontSize: 11, opacity: 0.6, marginTop: 2 }

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 11,
  padding: '1px 8px',
  borderRadius: '999px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  opacity: 0.85,
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
}

const buttonStyle: React.CSSProperties = {
  padding: '5px 14px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  borderRadius: '8px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const saveStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-accent, #4c8dff)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 600,
}

const resetLinkStyle: React.CSSProperties = {
  border: '0',
  background: 'none',
  color: 'inherit',
  opacity: 0.6,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  textDecoration: 'underline',
}

// ------------------------------------------------------------------ card ---

interface TavilyCardProps {
  /**
   * Which face the Plugins page asks for. `summary` is the list one-liner the
   * `plugins.item` slot renders under the registration's label; anything else
   * (`page`) is the plugin's own settings page.
   */
  view?: string
  useTavilyCard<T>(selector: (snapshot: TavilyCardState) => T): T
  edit(field: string, raw: string): void
  resetField(field: string): void
  save(): Promise<void>
  discard(): void
}

/**
 * One form row: label + hint + control + reset. Pure createElement, no JSX.
 */
function Field({
  label, hint, value, overridden, disabled,
  onChange, onReset, control, options, tag,
}: {
  label: string
  hint?: string
  value: string
  overridden?: boolean
  disabled: boolean
  onChange: (raw: string) => void
  onReset: () => void
  control: 'text' | 'number' | 'select' | 'toggle'
  options?: readonly string[]
  tag?: string
}) {
  const choices = control === 'select' ? (options ?? ['basic', 'advanced']) : undefined
  const controlEl = control === 'toggle'
    ? React.createElement('input', {
      style: { ...inputStyle, width: 'auto' },
      type: 'checkbox',
      checked: value === 'true',
      disabled,
      'aria-label': label,
      onChange: (event: { target: { checked: boolean } }) => { onChange(event.target.checked ? 'true' : 'false') },
    })
    : control === 'select'
      ? React.createElement('select', {
        style: inputStyle,
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
      }, choices!.map(option => React.createElement('option', { key: option, value: option }, option)))
      : React.createElement('input', {
        style: inputStyle,
        type: control === 'number' ? 'number' : 'text',
        value,
        disabled,
        'aria-label': label,
        onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
      })
  return React.createElement(
    'div',
    { style: fieldStyle },
    React.createElement('label', { style: labelStyle }, label),
    controlEl,
    hint === undefined ? null : React.createElement('span', { style: hintStyle }, hint),
    React.createElement('div', { style: rowStyle },
      overridden === true
        ? React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, `${t('overridden')} · ${tag ?? ''}`)
        : null,
      React.createElement('button', { type: 'button', style: resetLinkStyle, onClick: onReset }, t('reset'))),
  )
}

/**
 * One credential row: a password input whose writes go to the credentials
 * domain, plus the Host-reported configured badge. The key itself never rides
 * a response, so the input is uncontrolled and always starts blank.
 */
function CredentialField({
  label, hint, state, disabled, onEdit,
}: {
  label: string
  hint: string
  state: CredentialState
  disabled: boolean
  onEdit: (raw: string) => void
}) {
  return React.createElement(
    'div',
    { style: fieldStyle },
    React.createElement('label', { style: labelStyle }, label),
    React.createElement('div', { style: rowStyle },
      React.createElement('input', {
        style: { ...inputStyle, flex: 1 },
        type: 'password',
        placeholder: hint,
        disabled: disabled || !state.writable,
        'aria-label': label,
        onChange: (event: { target: { value: string } }) => { onEdit(event.target.value) },
      }),
      React.createElement('span', { style: badgeStyle },
        state.configured ? t('apiKeyConfigured') : t('apiKeyMissing'))),
    React.createElement('span', { style: hintStyle }, hint),
  )
}

/** A plain section heading inside the card body. */
function SectionHeading({ text }: { text: string }) {
  return React.createElement('p', {
    style: { margin: '4px 0 0', fontSize: 12, fontWeight: 600, opacity: 0.85 },
  }, text)
}

/**
 * Render the multi-engine search card for the Plugins page.
 *
 * The `plugins.item` slot owns the row chrome: it renders this registration's
 * `label` as the card title and calls the component back with `view: "summary"`
 * for the one-liner beneath it; the plugin's own page renders the same title and
 * one-liner and then asks for `view: "page"` for the form. Rendering our own
 * card (as this component used to) put a second title and a nested card inside
 * the list row's description slot.
 * @param props - the view the Plugins page asks for, plus the injected card face.
 * @returns the one-line description in summary view, otherwise the settings form.
 */
export function TavilyCard(props: TavilyCardProps) {
  const state = props.useTavilyCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  const blocked = !state.dirty || state.saving
  return React.createElement(
    'div',
    { style: bodyStyle },
        !state.writable ? React.createElement('p', { role: 'status', style: { margin: 0, fontSize: 12, opacity: 0.7 } }, t('readOnly')) : null,
        React.createElement(Field, {
          label: t('enabled'), hint: t('enabledHint'),
          value: state.enabled.staged, disabled, control: 'toggle',
          onChange: (raw) => { props.edit('enabled', raw) },
          onReset: () => { props.resetField('enabled') },
          overridden: state.enabled.overridden,
          tag: state.enabled.effective,
        }),
        React.createElement(Field, {
          label: t('mode'),
          value: state.mode.staged, disabled, control: 'select',
          options: ['auto', 'tavily', 'exa', 'deepseek'],
          onChange: (raw) => { props.edit('mode', raw) },
          onReset: () => { props.resetField('mode') },
          overridden: state.mode.overridden,
          tag: state.mode.effective,
        }),
        React.createElement(Field, {
          label: t('autoOrder'), hint: t('autoOrderHint'),
          value: state.autoOrder.staged, disabled, control: 'text',
          onChange: (raw) => { props.edit('autoOrder', raw) },
          onReset: () => { props.resetField('autoOrder') },
          overridden: state.autoOrder.overridden,
          tag: state.autoOrder.effective,
        }),
        React.createElement(Field, {
          label: t('failover'), hint: t('failoverHint'),
          value: state.failover.staged, disabled, control: 'toggle',
          onChange: (raw) => { props.edit('failover', raw) },
          onReset: () => { props.resetField('failover') },
          overridden: state.failover.overridden,
          tag: state.failover.effective,
        }),
        React.createElement(SectionHeading, { text: t('tavilySection') }),
        React.createElement(CredentialField, {
          label: t('apiKey'), hint: t('apiKeyHint'),
          state: state.credentials.tavily, disabled,
          onEdit: (raw) => { props.edit('apiKey', raw) },
        }),
        React.createElement(Field, {
          label: t('tavilyApiKeyEnv'),
          value: state.apiKeyEnv.staged, disabled, control: 'text',
          onChange: (raw) => { props.edit('apiKeyEnv', raw) },
          onReset: () => { props.resetField('apiKeyEnv') },
          overridden: state.apiKeyEnv.overridden,
          tag: state.apiKeyEnv.effective,
        }),
        React.createElement(Field, {
          label: `${t('searchDepth')}`, hint: state.section?.searchDepth === 'advanced' ? t('searchDepthAdvanced') : t('searchDepthBasic'),
          value: state.searchDepth.staged, disabled, control: 'select',
          onChange: (raw) => { props.edit('searchDepth', raw) },
          onReset: () => { props.resetField('searchDepth') },
          overridden: state.searchDepth.overridden,
          tag: state.searchDepth.effective,
        }),
        React.createElement(Field, {
          label: t('maxResults'), hint: t('maxResultsHint'),
          value: state.maxResults.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('maxResults', raw) },
          onReset: () => { props.resetField('maxResults') },
          overridden: state.maxResults.overridden,
          tag: state.maxResults.effective,
        }),
        React.createElement(Field, {
          label: t('includeAnswer'), hint: t('includeAnswerHint'),
          value: state.includeAnswer.staged, disabled,
          control: 'select', options: ['false', 'true'],
          onChange: (raw) => { props.edit('includeAnswer', raw) },
          onReset: () => { props.resetField('includeAnswer') },
          overridden: state.includeAnswer.overridden,
          tag: state.includeAnswer.effective,
        }),
        React.createElement(Field, {
          label: t('days'), hint: t('daysHint'),
          value: state.days.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('days', raw) },
          onReset: () => { props.resetField('days') },
          overridden: state.days.overridden,
          tag: state.days.effective,
        }),
        React.createElement(SectionHeading, { text: t('exaSection') }),
        React.createElement(CredentialField, {
          label: t('exaApiKey'), hint: t('exaApiKeyHint'),
          state: state.credentials.exa, disabled,
          onEdit: (raw) => { props.edit('exaApiKey', raw) },
        }),
        React.createElement(Field, {
          label: t('exaApiKeyEnv'),
          value: state.exaApiKeyEnv.staged, disabled, control: 'text',
          onChange: (raw) => { props.edit('exaApiKeyEnv', raw) },
          onReset: () => { props.resetField('exaApiKeyEnv') },
          overridden: state.exaApiKeyEnv.overridden,
          tag: state.exaApiKeyEnv.effective,
        }),
        React.createElement(Field, {
          label: t('exaSearchType'),
          value: state.exaSearchType.staged, disabled, control: 'select',
          options: ['auto', 'keyword', 'neural'],
          onChange: (raw) => { props.edit('exaSearchType', raw) },
          onReset: () => { props.resetField('exaSearchType') },
          overridden: state.exaSearchType.overridden,
          tag: state.exaSearchType.effective,
        }),
        React.createElement(Field, {
          label: t('exaNumResults'),
          value: state.exaNumResults.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('exaNumResults', raw) },
          onReset: () => { props.resetField('exaNumResults') },
          overridden: state.exaNumResults.overridden,
          tag: state.exaNumResults.effective,
        }),
        React.createElement(Field, {
          label: t('exaHighlightsPerResult'),
          value: state.exaHighlightsPerResult.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('exaHighlightsPerResult', raw) },
          onReset: () => { props.resetField('exaHighlightsPerResult') },
          overridden: state.exaHighlightsPerResult.overridden,
          tag: state.exaHighlightsPerResult.effective,
        }),
        React.createElement(SectionHeading, { text: t('deepseekSection') }),
        React.createElement(Field, {
          label: t('deepseekApiKeyEnv'),
          value: state.deepseekApiKeyEnv.staged, disabled, control: 'text',
          onChange: (raw) => { props.edit('deepseekApiKeyEnv', raw) },
          onReset: () => { props.resetField('deepseekApiKeyEnv') },
          overridden: state.deepseekApiKeyEnv.overridden,
          tag: state.deepseekApiKeyEnv.effective,
        }),
        React.createElement('div', { style: footerStyle },
          state.dirty
            ? React.createElement('span', { style: { ...badgeStyle, color: '#e5a50a', marginRight: 'auto' } }, t('unsaved'))
            : null,
          state.failed ? React.createElement('p', { role: 'status', style: { margin: 0, fontSize: 12, color: '#e57373' } }, t('saveFailed')) : null,
          React.createElement('button', {
            type: 'button',
            style: buttonStyle,
            disabled: !state.dirty || state.saving,
            onClick: () => { props.discard() },
          }, t('discard')),
          React.createElement('button', {
            type: 'button',
            style: saveStyle,
            disabled: blocked,
            onClick: () => { void props.save() },
          }, state.saving ? t('saving') : t('save'))),
  )
}

// ------------------------------------------------------------ controller ---

/**
 * Bridges the `web-search-multi` scope and the credentials domain onto the
 * card. Field edits stage locally and commit on Save as revision-fenced
 * section writes; the key is written to the credentials domain, never the
 * section.
 */
class TavilyCardController {
  private readonly store: CardStore<TavilyCardState>
  private readonly stopScope: () => void
  private stage: Record<string, string> = {}
  private dirtyKeys = new Set<string>()
  private saving = false
  private failed = false
  private loaded = false
  private keyState: { tavily: CredentialState; exa: CredentialState } = {
    tavily: { configured: false, writable: true },
    exa: { configured: false, writable: true },
  }

  constructor(
    private readonly scope: SettingsScopeLike<TavilySettings>,
    private readonly credentials: CredentialsRemoteLike,
  ) {
    this.store = this.makeStore()
    this.publish()
    this.stopScope = scope.subscribe(() => {
      // ConfigForm publishes accepted or recovery values during a save.
      // Keep pending edits until all writes have settled successfully.
      if (!this.saving && this.dirtyKeys.size === 0) this.stage = {}
      this.publish()
      void this.readCredential()
    })
    void this.readCredential()
  }

  /** Release the form subscription when the plugin unloads. */
  dispose(): void {
    this.stopScope()
    this.stage = {}
    this.dirtyKeys.clear()
  }

  private makeStore(): CardStore<TavilyCardState> {
    let snapshot = this.projection()
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next: TavilyCardState) => {
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  }

  private field(key: keyof TavilySettings): FieldState {
    const snap = this.scope.getSnapshot()
    const value = snap.value
    const effective = renderField(key, value)
    const staged = this.stage[key] ?? ''
    const touched = this.dirtyKeys.has(key) || this.stage[key] !== undefined
    return {
      effective,
      staged: touched ? staged : effective,
      overridden: isOverridden(key, snap),
    }
  }

  private projection(): TavilyCardState {
    const snap = this.scope.getSnapshot()
    const available = snap.status === 'ready'
    return {
      available,
      writable: snap.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.dirtyKeys.size > 0,
      section: snap.value,
      enabled: this.field('enabled'),
      mode: this.field('mode'),
      autoOrder: this.field('autoOrder'),
      failover: this.field('failover'),
      searchDepth: this.field('searchDepth'),
      maxResults: this.field('maxResults'),
      includeAnswer: this.field('includeAnswer'),
      days: this.field('days'),
      apiKeyEnv: this.field('apiKeyEnv'),
      exaSearchType: this.field('exaSearchType'),
      exaNumResults: this.field('exaNumResults'),
      exaHighlightsPerResult: this.field('exaHighlightsPerResult'),
      exaApiKeyEnv: this.field('exaApiKeyEnv'),
      deepseekApiKeyEnv: this.field('deepseekApiKeyEnv'),
      credentials: { tavily: this.keyState.tavily, exa: this.keyState.exa },
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  /** Stage one edit; a raw equal to the effective value is not dirty. */
  edit(field: string, raw: string): void {
    if (field === 'apiKey' || field === 'exaApiKey') {
      this.stage[field] = raw
      if (raw.length > 0) this.dirtyKeys.add(field)
      else this.dirtyKeys.delete(field)
      this.publish()
      return
    }
    this.stage[field] = raw
    const effective = this.field(field as keyof TavilySettings).effective
    if (raw === effective) this.dirtyKeys.delete(field)
    else this.dirtyKeys.add(field)
    this.publish()
  }

  resetField(field: string): void {
    if (field === 'apiKey') {
      delete this.stage.apiKey
      this.dirtyKeys.delete('apiKey')
      this.publish()
      return
    }
    delete this.stage[field]
    this.dirtyKeys.delete(field)
    this.publish()
  }

  discard(): void {
    this.stage = {}
    this.dirtyKeys = new Set()
    this.failed = false
    this.publish()
  }

  /** Commit every staged edit; key literals go to the credentials domain. */
  async save(): Promise<void> {
    if (this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    const writes: Array<Promise<unknown>> = []
    for (const key of [...this.dirtyKeys]) {
      if (key === 'apiKey' || key === 'exaApiKey') {
        const value = this.stage[key] ?? ''
        if (value.length > 0) {
          writes.push(this.credentials.set(this.keyRef(key), value).then(result => {
            if (!result.ok) throw new Error('Credential write refused')
          }))
        }
        continue
      }
      const raw = this.stage[key] ?? ''
      if (BOOLEAN_SETTING_KEYS.has(key as keyof TavilySettings)) {
        if (raw === '') continue
        writes.push(this.scope.set(key, raw === 'true'))
        continue
      }
      if (raw === '') {
        writes.push(this.scope.unset(key))
        continue
      }
      if (NUMBER_SETTING_KEYS.has(key as keyof TavilySettings)) {
        const numeric = parseNumber(raw)
        if (numeric === undefined || numeric < 1 || (key === 'days' && numeric > 30)) continue
        writes.push(this.scope.set(key, numeric))
        continue
      }
      writes.push(this.scope.set(key, raw))
    }
    if (writes.length === 0) {
      this.saving = false
      this.failed = this.dirtyKeys.size > 0
      this.publish()
      return
    }
    const results = await Promise.allSettled(writes)
    this.failed = results.some(result => result.status === 'rejected')
    this.saving = false
    if (!this.failed) {
      this.stage = {}
      this.dirtyKeys = new Set()
    }
    await this.readCredential()
    this.publish()
  }

  /** The Tavily credential reference the section names, or the default. */
  private tavilyRef(): string {
    const declared = this.scope.getSnapshot().value?.apiKeyEnv
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
  }

  /** The Exa credential reference the section names, or the default. */
  private exaRef(): string {
    const declared = this.scope.getSnapshot().value?.exaApiKeyEnv
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_EXA_API_KEY_REF
  }

  /** The credential reference one staged key field writes to. */
  private keyRef(field: string): string {
    const refField = field === 'exaApiKey' ? 'exaApiKeyEnv' : 'apiKeyEnv'
    if (this.dirtyKeys.has(refField)) {
      return this.stage[refField]?.trim() || (field === 'exaApiKey' ? DEFAULT_EXA_API_KEY_REF : DEFAULT_API_KEY_REF)
    }
    return field === 'exaApiKey' ? this.exaRef() : this.tavilyRef()
  }

  /** Ask the credentials domain about both key references the section names. */
  private async readCredential(): Promise<void> {
    try {
      const refs = [this.tavilyRef(), this.exaRef()]
      const response = await this.credentials.describe(refs)
      if (!response.ok) return
      const tavilyView = response.value[refs[0]!]
      const exaView = response.value[refs[1]!]
      const next = {
        tavily: { configured: tavilyView?.configured ?? false, writable: tavilyView?.writable ?? true },
        exa: { configured: exaView?.configured ?? false, writable: exaView?.writable ?? true },
      }
      const same = next.tavily.configured === this.keyState.tavily.configured
        && next.tavily.writable === this.keyState.tavily.writable
        && next.exa.configured === this.keyState.exa.configured
        && next.exa.writable === this.keyState.exa.writable
      if (same) return
      this.keyState = next
      this.publish()
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key controls simply report the
      // last state they knew, and a write still reaches the Host.
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): TavilyCardFace {
    return {
      hooks: { tavilyCard: this.store },
      edit: (field, raw) => { this.edit(field, raw) },
      resetField: (field) => { this.resetField(field) },
      save: () => this.save(),
      discard: () => { this.discard() },
    }
  }
}

// ---------------------------------------------------------------- helpers ---

/** Fields whose staged literal is a boolean. */
const BOOLEAN_SETTING_KEYS = new Set<keyof TavilySettings>(['enabled', 'failover', 'includeAnswer'])

/** Fields whose staged literal is a whole number. */
const NUMBER_SETTING_KEYS = new Set<keyof TavilySettings>(['maxResults', 'days', 'exaNumResults', 'exaHighlightsPerResult'])

/** Render one section field as its text representation. */
function renderField(key: keyof TavilySettings, value: TavilySettings | undefined): string {
  if (value === undefined) return ''
  const raw = value[key]
  if (raw === undefined) return ''
  if (BOOLEAN_SETTING_KEYS.has(key)) return raw ? 'true' : 'false'
  return String(raw)
}

/** Whether the user layer overrides one field (presence marks an override). */
function isOverridden(key: keyof TavilySettings, snap: ScopeSnapshot<TavilySettings>): boolean {
  const user = snap.user
  if (user === undefined) return false
  return user[key] !== undefined && !String(key).endsWith('Env')
}

/** Parse a numeric field literal. */
function parseNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && Number.isInteger(value) ? value : undefined
}

// ------------------------------------------------------------------- apply ---

// 0.1.7 serves editable entry configuration through configForms.
export const inject = ['slots', 'remote', 'remote.credentials', 'configForms']

export function apply(ctx: ClientContextLike): void {
  const scope = bindScope<TavilySettings>(ctx, NS)
  if (scope === undefined) return
  const controller = new TavilyCardController(scope, ctx.remote.credentials)
  ctx.effect(() => () => controller.dispose(), 'web-search-multi: form subscription')
  // 0.1.7 renamed the keyed `settings.plugin.item` slot to the list slot
  // `plugins.item`, addressed by id/order and gated on the Host serving NS.
  ctx.effect(() => whileServed(ctx, NS, () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'web-search-multi',
    order: 41,
    label: () => t('title'),
    inject: () => controller.inject(),
  }, TavilyCard))), 'web-search-multi: settings page')
}