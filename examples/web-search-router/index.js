/**
 * Smart web-search router for DeepSeek Harness.
 *
 * 中文说明（给以后维护的人）：
 *   这个插件原来只是"把 web_search 钉在 Tavily 上"。现在升级成"自动选路器"：
 *   每次 web_search 按问题的重要性/类型，自动选择走 Tavily（质量优先，花 Tavily 额度）
 *   还是走 DSH 自带的搜索（省 Tavily 额度）：
 *     - 重要 / 需要最新 / 需要全面对比 / 要官方来源 → Tavily（含总结答案）
 *     - 简短 / 定义类 / 报错排查 / 用户明说"随便查" → DSH 自带
 *   任何一方失败（限速 429 / 额度用完 / 钥匙失效 / 超时 / 断网）都会自动换另一条，
 *   并在短时间内"冷却"出问题的那条；冷却只影响优先级，不会让搜索彻底不可用。
 *   每次搜索结果顶部会加一行「搜索后端：…」标记，让用户一眼看到实际走了哪个。
 *
 *   另外注册一个工具 `web_search_router`，可查询状态/用量/最近记录、强制切换模式、
 *   以及 dry_run 预览某句话会怎么选路。
 *
 * Design rules carried over from the original plugin:
 *   - Imports NOTHING from @deepseek-ai/*. The bundle lives in the user's profile, where a
 *     second copy of those modules could resolve and break `instanceof` checks. Errors
 *     therefore carry a `code` string, which is what the seam's consumers route on.
 *   - Registering the provider is what makes the profile's `searchProvider: tavily` row work;
 *     removing the bundle registration from profile `package.json` is the only real rollback.
 *
 * Routing preference (mode):
 *   - auto (default): per-query decision, see planSearch().
 *   - tavily:         prefer Tavily for every query (fallback still applies unless disabled).
 *   - builtin:        prefer DSH's own search for every query (fallback still applies).
 *   `data/state.json` may hold a runtime override written by the `web_search_router` tool.
 *
 * Data files (under this plugin directory, ASCII path):
 *   - data/state.json       runtime mode override, survives hot reloads and restarts.
 *   - data/search-log.jsonl one JSON line per attempt (the audit trail / stats source).
 *   - data/status.json      snapshot for a future visual panel (schema documented in README).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER_ID = 'tavily'
const DEFAULT_BASE_URL = 'https://api.tavily.com'
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'
const USER_AGENT = 'dsh-web-search-router/0.3.0'
const KEYLESS_HEADER = 'X-Tavily-Access-Mode'
const KEYLESS_VALUE = 'keyless'
const ROUTER_TOOL_NAME = 'web_search_router'

/** Tavily's documented range for `max_results`. */
const TAVILY_MAX_RESULTS_CAP = 20
const TAVILY_DEFAULT_MAX_RESULTS = 5

/** Built-in DSH search providers, best first. `deepseek-search-api` is one direct HTTP call;
 *  `deepseek-official` is a model turn (slower, consumes chat tokens) and is the base default. */
const DEFAULT_BUILTIN_CHAIN = ['deepseek-search-api', 'deepseek-official']

const MODES = ['auto', 'tavily', 'builtin']

/* ------------------------------------------------------------------ *
 * Typed web error (same shape the seam routes on)                      *
 * ------------------------------------------------------------------ */

class WebProviderError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WebError'
    this.code = code
  }
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

function envValue(name) {
  const value = typeof process === 'undefined' ? undefined : process.env?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ------------------------------------------------------------------ *
 * Configuration                                                        *
 * ------------------------------------------------------------------ */

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.length > 0)
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeMode(value) {
  return typeof value === 'string' && MODES.includes(value) ? value : 'auto'
}

/** Data directory: configurable, defaulting to `<plugin>/data/`. */
function resolveDataDir(config) {
  if (typeof config.dataDir === 'string' && config.dataDir.length > 0) return config.dataDir
  try {
    return fileURLToPath(new URL('./data/', import.meta.url))
  } catch {
    return undefined
  }
}

/**
 * Build the options one search serves with. Values are fully defaulted here so the
 * provider itself never reads the environment.
 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV
  const literalApiKey = typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined

  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    apiKeyEnv,
    keyless: config.keyless !== false,
    resolveApiKey: async () => {
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(apiKeyEnv)
          if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
        } catch {
          // An unavailable store must not mask the environment fallback.
        }
      }
      return envValue(apiKeyEnv)
    },
    baseURL: typeof config.baseURL === 'string' && URL.canParse(config.baseURL) ? config.baseURL : DEFAULT_BASE_URL,
    searchDepth: typeof config.searchDepth === 'string' ? config.searchDepth : 'advanced',
    topic: typeof config.topic === 'string' ? config.topic : 'general',
    includeAnswer: config.includeAnswer !== false,
    includeDomains: stringList(config.includeDomains),
    excludeDomains: stringList(config.excludeDomains),

    // --- router options -------------------------------------------------
    mode: normalizeMode(config.mode),
    fallback: config.fallback !== false,
    showMarker: config.showMarker !== false,
    timeoutMs: positiveNumber(config.timeoutMs, 45_000),
    importanceThreshold: positiveNumber(config.importanceThreshold, 2),
    builtinChain: stringList(config.builtinChain).length > 0 ? stringList(config.builtinChain) : DEFAULT_BUILTIN_CHAIN,
    cooldowns: {
      rateLimit: positiveNumber(config.cooldownRateLimitMs, 10 * 60_000),
      quota: positiveNumber(config.cooldownQuotaMs, 30 * 60_000),
      auth: positiveNumber(config.cooldownAuthMs, 60 * 60_000),
      transient: positiveNumber(config.cooldownTransientMs, 60_000),
      error: positiveNumber(config.cooldownErrorMs, 60_000),
    },
    dataDir: resolveDataDir(config),
  }
}

/* ------------------------------------------------------------------ *
 * Router state: cooldowns + runtime override + recent ring            *
 * ------------------------------------------------------------------ */

/** backend key -> { until, kind, message, at } */
const cooldowns = new Map()
/** Throttle for data/status.json writes. */
let lastSnapshotAt = 0
/** Recent decisions, so `status` works even before/without the log. */
const recentDecisions = []

const BACKEND_LABELS = {
  tavily: 'Tavily',
  'deepseek-search-api': 'DSH 自带 · Search API',
  'deepseek-official': 'DSH 自带 · Messages 搜索',
}

function backendLabel(key) {
  return BACKEND_LABELS[key] ?? key
}

function isCooling(key) {
  const entry = cooldowns.get(key)
  return entry !== undefined && entry.until > Date.now()
}

function cooldownText(key) {
  const entry = cooldowns.get(key)
  if (entry === undefined || entry.until <= Date.now()) return undefined
  const secondsLeft = Math.ceil((entry.until - Date.now()) / 1000)
  return `${entry.kind}，冷却 ${secondsLeft}s`
}

function setCooldown(key, classification) {
  if (classification.kind === 'aborted') return
  cooldowns.set(key, { until: Date.now() + classification.cooldown, kind: classification.kind, message: preview(classification.message), at: Date.now() })
}

function preview(value, limit = 300) {
  const text = typeof value === 'string' ? value : String(value)
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** The runtime override lives in data/state.json; auto clears it. */
function readOverride(dataDir) {
  if (dataDir === undefined) return undefined
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
    return typeof state.modeOverride === 'string' && MODES.includes(state.modeOverride) ? state.modeOverride : undefined
  } catch {
    return undefined
  }
}

function writeOverride(dataDir, mode) {
  if (dataDir === undefined) return
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({ modeOverride: mode === 'auto' ? null : mode, updatedAt: new Date().toISOString() }, null, 2),
    )
  } catch {
    // A failed preference write must never break a search.
  }
}

/* ------------------------------------------------------------------ *
 * DSH built-in providers (read from the live seam registry)           *
 * ------------------------------------------------------------------ */

/**
 * The seam keeps `searchProviders` as a public Map on the live service instance, and the
 * built-in providers register into it. Reading it at call time (never caching) means a
 * provider that is disabled, failed to load, or lost its credentials is seen immediately.
 */
function builtinRegistry(ctx) {
  try {
    const map = ctx?.web?.searchProviders
    if (map === undefined || typeof map.get !== 'function' || typeof map.entries !== 'function') return new Map()
    return map
  } catch {
    return new Map()
  }
}

function builtinAvailable(ctx, id) {
  const provider = builtinRegistry(ctx).get(id)
  if (provider === undefined) return false
  try {
    return provider.available() === true
  } catch {
    return false
  }
}

function describeBuiltins(ctx, chain) {
  return chain.map((id) => ({
    id,
    label: backendLabel(id),
    registered: builtinRegistry(ctx).has(id),
    available: builtinAvailable(ctx, id),
  }))
}

/* ------------------------------------------------------------------ *
 * Decision heuristic                                                   *
 * ------------------------------------------------------------------ */

const RECENCY = /最新|最近|今日|今天|本周|这周|本月|今年|近期|刚刚|新发布|发布会|上市|新闻|动态|价格|多少钱|汇率|股价|天气|20\d\d|latest|newest|release|news|pricing|price|20\d\d/iu
const DEPTH = /对比|区别|差异|哪个好|怎么选|选型|推荐|评测|排行|优缺点|全面|汇总|梳理|综述|调研|报告|趋势|前景|方案|可行性|为什么|原因|如何选择|指南|comparison|compare|\bvs\.?\b|difference|alternatives|benchmark|review|best\b/iu
const AUTHORITY = /官网|官方网站|官方文档|文档|docs|github|论文|标准|规范|政策|法规|教程|来源|出处|引用|site:/iu
const EMPHASIS = /重要|关键|认真|仔细|全面|详细|深度|完整|权威|可靠|多个来源|交叉核对|调研|报告|方案|对比|选型|最新/iu
const SIMPLE_ASK = /简单|随便|大概|一句话|快速|不用太详细|粗略/iu
const DEFINITION = /是什么|的定义|是什么东西|什么意思|缩写|全称|怎么读/iu
const TROUBLESHOOT = /报错|错误|异常|exception|traceback|errno|status code|不工作|没反应|失败/iu
const ASCII_ONLY = /^[\w.\-+/:#@()[\]\s]{1,30}$/u

/**
 * Score one query. Positive points favour Tavily (quality), negative points favour DSH's
 * built-in search (cheap). Inputs are the search query plus the latest human prompt, so
 * "帮我做份深度调研" counts for every query the turn issues.
 *
 * @returns {{ backend: 'tavily'|'builtin', score: number, labels: string[], detail: object }}
 */
export function planSearch(query, latestPrompt = '', options = {}) {
  const threshold = positiveNumber(options.importanceThreshold, 2)
  const text = `${query}\n${latestPrompt}`
  const reasons = []
  let score = 0

  const add = (points, label) => {
    score += points
    reasons.push({ points, label })
  }

  if (RECENCY.test(text)) add(2, '时效性')
  if (DEPTH.test(query)) add(2, '全面/对比')
  else if (DEPTH.test(latestPrompt)) add(1, '用户要全面')
  if (AUTHORITY.test(text)) add(1, '要官方来源')
  if (EMPHASIS.test(latestPrompt)) add(2, '用户强调重要')
  if ((query.match(/[?？]/gu) ?? []).length >= 2) add(1, '多问题')
  const letters = (query.match(/[A-Za-z]/gu) ?? []).length
  if (query.length >= 12 && letters / query.length > 0.5) add(1, '英文资料')
  if (query.length >= 30) add(1, '复杂长查询')

  // Cheap-query signals pull the other way.
  if (query.length <= 10) add(-2, '短查询')
  if (DEFINITION.test(query) && query.length <= 20) add(-1, '定义类')
  if (TROUBLESHOOT.test(query) && !DEPTH.test(query)) add(-1, '报错排查')
  if (ASCII_ONLY.test(query) && query.length <= 24) add(-1, '单个名词')
  if (SIMPLE_ASK.test(latestPrompt)) add(-2, '用户说简单')

  const backend = score >= threshold ? 'tavily' : 'builtin'
  const labels = reasons.filter((entry) => (backend === 'tavily' ? entry.points > 0 : entry.points < 0)).map((entry) => entry.label)
  return { backend, score, labels, detail: { query, matched: reasons } }
}

/* ------------------------------------------------------------------ *
 * Error classification + cooldowns                                     *
 * ------------------------------------------------------------------ */

/** Classify an attempt failure into a cooldown bucket. */
export function classifyError(error, cooldownsConfig = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? error ?? '')
  if (code === 'WEB_ABORTED' || isAbortError(error)) return { kind: 'aborted', cooldown: 0, message }
  const status = Number((message.match(/HTTP (\d{3})/u) ?? [])[1] ?? 0)
  const table = {
    rateLimit: positiveNumber(cooldownsConfig.rateLimit, 10 * 60_000),
    quota: positiveNumber(cooldownsConfig.quota, 30 * 60_000),
    auth: positiveNumber(cooldownsConfig.auth, 60 * 60_000),
    transient: positiveNumber(cooldownsConfig.transient, 60_000),
    error: positiveNumber(cooldownsConfig.error, 60_000),
  }
  if (status === 429) return { kind: 'rate-limit', cooldown: table.rateLimit, message }
  if (status === 432 || status === 433 || status === 402) return { kind: 'quota', cooldown: table.quota, message }
  if (status === 401 || status === 403) return { kind: 'auth', cooldown: table.auth, message }
  if (status >= 500) return { kind: 'server', cooldown: table.transient, message }
  if (code === 'WEB_PROVIDER_CREDENTIAL_MISSING' || /api key|credential|unauthorized/iu.test(message)) {
    return { kind: 'auth', cooldown: table.auth, message }
  }
  if (/abort|timed? ?out|超时/iu.test(message)) return { kind: 'timeout', cooldown: table.transient, message }
  return { kind: 'error', cooldown: table.error, message }
}

/** Label shown inside the per-result marker; handles the "no signal" default. */
function decisionLabel(entry) {
  if (entry.reasons !== undefined && entry.reasons.length > 0) return entry.reasons.slice(0, 2).join('、')
  return entry.backend === 'tavily' ? '重要/需要全面资料' : '简单查询，省 Tavily 额度'
}

/* ------------------------------------------------------------------ *
 * Tavily backend                                                       *
 * ------------------------------------------------------------------ */

async function authHeaders(options, signal) {
  if (options.apiKey !== undefined) {
    return { headers: { authorization: `Bearer ${options.apiKey}` }, describe: () => 'configured API key' }
  }
  if (options.resolveApiKey !== undefined) {
    let key
    try {
      key = await options.resolveApiKey(signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
      throw new WebProviderError(`Tavily credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_CREDENTIAL_MISSING', error)
    }
    if (typeof key === 'string' && key.length > 0) {
      return { headers: { authorization: `Bearer ${key}` }, describe: () => `credential ${options.apiKeyEnv}` }
    }
  }
  if (options.keyless) return { headers: { [KEYLESS_HEADER]: KEYLESS_VALUE }, describe: () => 'keyless access' }
  throw new WebProviderError(
    `Tavily search needs a credential: set the ${options.apiKeyEnv} environment variable, or enable keyless mode`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

function tavilyAvailable(options) {
  return (
    URL.canParse(options.baseURL) &&
    (options.keyless === true || options.apiKey !== undefined || options.resolveApiKey !== undefined)
  )
}

async function runTavily(options, request, signal) {
  const { headers, describe } = await authHeaders(options, signal)
  if (signal?.aborted === true) throw abortedError(signal)
  const maxResults =
    Number.isInteger(request.maxResults) && request.maxResults > 0
      ? Math.min(request.maxResults, TAVILY_MAX_RESULTS_CAP)
      : TAVILY_DEFAULT_MAX_RESULTS

  const body = {
    query: request.query,
    max_results: maxResults,
    search_depth: options.searchDepth,
    topic: options.topic,
    include_answer: options.includeAnswer,
    include_raw_content: false,
    ...(options.includeDomains.length > 0 ? { include_domains: options.includeDomains } : {}),
    ...(options.excludeDomains.length > 0 ? { exclude_domains: options.excludeDomains } : {}),
  }

  let response
  try {
    response = await fetch(`${options.baseURL}/search`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new WebProviderError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
  }

  if (!response.ok) {
    throw new WebProviderError(
      `Tavily API error (HTTP ${response.status}, ${describe()})${await errorDetail(response, signal)}`,
      'WEB_PROVIDER_ERROR',
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new WebProviderError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
  }
  return mapTavilyResponse(payload)
}

async function errorDetail(response, signal) {
  try {
    const text = await response.text()
    if (text.length === 0) return ''
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return `: ${text.slice(0, 300)}`
    }
    const detail = parsed?.detail ?? parsed?.error ?? parsed?.message
    if (typeof detail === 'string' && detail.length > 0) return `: ${detail}`
    if (Array.isArray(detail)) return `: ${JSON.stringify(detail).slice(0, 300)}`
    return ''
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    return ''
  }
}

function abortedError(signal, cause) {
  const reason = signal?.reason
  const suffix = reason === undefined || reason === null ? '' : `: ${String(reason)}`
  return new WebProviderError(`search aborted${suffix}`, 'WEB_ABORTED', cause)
}

export function mapTavilyResponse(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    throw new WebProviderError('Tavily returned a response without a results array', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set()
  const sources = []
  for (const item of payload.results) {
    if (item === null || typeof item !== 'object') continue
    const url = typeof item.url === 'string' ? item.url : ''
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
    const snippet = typeof item.content === 'string' && item.content.length > 0 ? item.content : undefined
    const publishedAt = typeof item.published_date === 'string' && item.published_date.length > 0 ? item.published_date : undefined
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  const answer = typeof payload.answer === 'string' && payload.answer.length > 0 ? payload.answer : undefined
  return { ...(answer === undefined ? {} : { content: answer }), sources, truncated: false }
}

/* ------------------------------------------------------------------ *
 * Latest human prompt (for emphasis detection)                         *
 * ------------------------------------------------------------------ */

function latestUserPrompt(ctx) {
  try {
    const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.currentInitiator?.() : undefined
    const messages = agent?.session?.deriveMessages?.()
    if (!Array.isArray(messages)) return ''
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
      return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    }
    return ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Data files: audit log + status snapshot                              *
 * ------------------------------------------------------------------ */

function dataPaths(dataDir) {
  return { log: join(dataDir, 'search-log.jsonl'), status: join(dataDir, 'status.json') }
}

function appendLog(dataDir, entry) {
  if (dataDir === undefined) return
  try {
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(dataPaths(dataDir).log, `${JSON.stringify(entry)}\n`)
  } catch {
    // Logging must never break a search.
  }
}

/** Read at most `bytes` from the tail of a file (log lines are small). */
function readTail(path, bytes) {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const length = size - start
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return text
  } finally {
    closeSync(fd)
  }
}

function localDay(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  return new Date(at).toLocaleDateString('sv-SE')
}

function writeStatusSnapshot(options, extra = {}) {
  if (options.dataDir === undefined) return
  const now = Date.now()
  if (now - lastSnapshotAt < 1000) return
  lastSnapshotAt = now
  try {
    mkdirSync(options.dataDir, { recursive: true })
    const snapshot = {
      schema: 1,
      updatedAt: new Date(now).toISOString(),
      mode: extra.mode ?? options.mode,
      override: extra.override ?? null,
      providers: [
        { id: 'tavily', label: backendLabel('tavily'), available: tavilyAvailable(options), cooldown: cooldownText('tavily') ?? null },
        ...(extra.builtins ?? []).map((entry) => ({ ...entry, cooldown: cooldownText(entry.id) ?? null })),
      ],
      recent: recentDecisions.slice(-10),
    }
    writeFileSync(dataPaths(options.dataDir).status, JSON.stringify(snapshot, null, 2))
  } catch {
    // Snapshot is for a future panel; never fail a search for it.
  }
}

function logStats(dataDir, days = 7) {
  const empty = { total: 0, today: 0, byBackend: {}, todayByBackend: {}, failures: 0, fallbacks: 0, byDay: {} }
  if (dataDir === undefined) return empty
  const path = dataPaths(dataDir).log
  if (!existsSync(path)) return empty
  let text
  try {
    text = readTail(path, 2 * 1024 * 1024)
  } catch {
    return empty
  }
  const todayKey = new Date().toLocaleDateString('sv-SE')
  const result = { total: 0, today: 0, byBackend: {}, todayByBackend: {}, failures: 0, fallbacks: 0, byDay: {} }
  const since = Date.now() - days * 86_400_000
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry?.ts !== 'string') continue
    const day = localDay(entry.ts)
    if (day === undefined) continue
    const at = Date.parse(entry.ts)
    if (Number.isFinite(at) && at < since) continue
    result.total += 1
    result.byDay[day] = (result.byDay[day] ?? 0) + 1
    if (day === todayKey) result.today += 1
    if (entry.ok === true) {
      result.byBackend[entry.backend] = (result.byBackend[entry.backend] ?? 0) + 1
      if (day === todayKey) result.todayByBackend[entry.backend] = (result.todayByBackend[entry.backend] ?? 0) + 1
    } else {
      result.failures += 1
    }
    if (typeof entry.fallbackFrom === 'string') result.fallbacks += 1
  }
  return result
}

function recentEntries(dataDir, limit = 10) {
  if (dataDir === undefined) return []
  const path = dataPaths(dataDir).log
  if (!existsSync(path)) return []
  try {
    const text = readTail(path, 256 * 1024)
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .reverse()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * One attempt with a timeout that respects caller cancellation         *
 * ------------------------------------------------------------------ */

function runWithBudget(run, timeoutMs, outerSignal) {
  const controller = new AbortController()
  let timedOut = false
  const forward = () => controller.abort(outerSignal?.reason)
  if (outerSignal !== undefined) {
    if (outerSignal.aborted === true) forward()
    else outerSignal.addEventListener('abort', forward, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`search backend timed out after ${timeoutMs} ms`))
  }, timeoutMs)

  return Promise.resolve()
    .then(() => run(controller.signal))
    .catch((error) => {
      if (timedOut && outerSignal?.aborted !== true) {
        throw new WebProviderError(`搜索后端超时（${timeoutMs} ms）`, 'WEB_PROVIDER_ERROR', error)
      }
      throw error
    })
    .finally(() => {
      clearTimeout(timer)
      if (outerSignal !== undefined) outerSignal.removeEventListener('abort', forward)
    })
}

function seconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/* ------------------------------------------------------------------ *
 * Provider                                                             *
 * ------------------------------------------------------------------ */

/**
 * One seam provider whose `id` stays `tavily` (the profile already selects `tavily`), but
 * whose `search()` routes between Tavily and DSH's own providers per query.
 */
class SmartSearchProvider {
  constructor(ctx, resolveOptions) {
    this.ctx = ctx
    this.resolveOptions = resolveOptions
  }

  get id() {
    return PROVIDER_ID
  }

  available() {
    try {
      const options = this.resolveOptions()
      if (options.mode === 'builtin') return options.builtinChain.some((id) => builtinAvailable(this.ctx, id))
      if (tavilyAvailable(options)) return true
      return options.builtinChain.some((id) => builtinAvailable(this.ctx, id))
    } catch {
      return false
    }
  }

  /**
   * Build the attempt order for one request. The selected family comes first; cooling
   * backends are pushed after healthy ones; `fallback: false` limits the list to the
   * selected family's first choice.
   */
  plan(request, options) {
    const override = readOverride(options.dataDir)
    const mode = override ?? options.mode
    const prompt = latestUserPrompt(this.ctx)
    const decision = planSearch(request.query, prompt, options)
    const builtins = describeBuiltins(this.ctx, options.builtinChain)

    const tavilyStep = { kind: 'tavily', id: 'tavily' }
    const builtinSteps = options.builtinChain.map((id) => ({ kind: 'builtin', id }))

    let order
    if (mode === 'tavily') order = [tavilyStep, ...builtinSteps]
    else if (mode === 'builtin') order = [...builtinSteps, tavilyStep]
    else order = decision.backend === 'tavily' ? [tavilyStep, ...builtinSteps] : [...builtinSteps, tavilyStep]

    if (options.fallback === false) order = [order[0]]

    order = order.filter((step) => step.kind === 'tavily' || builtins.some((entry) => entry.id === step.id && entry.registered))
    order = [...order.filter((step) => !isCooling(step.id)), ...order.filter((step) => isCooling(step.id))]

    return { order, plan: { ...decision, mode, override: override ?? null, builtins } }
  }

  async search(request, signal) {
    const options = this.resolveOptions()
    const { order, plan } = this.plan(request, options)
    const startedAll = Date.now()
    const attempts = []

    if (order.length === 0) {
      throw new WebProviderError('没有可用的搜索后端：Tavily 与本机 DSH 自带搜索都不可用', 'WEB_PROVIDER_UNAVAILABLE')
    }

    for (const step of order) {
      if (signal?.aborted === true) throw abortedError(signal)
      const available = step.kind === 'tavily' ? tavilyAvailable(options) : builtinAvailable(this.ctx, step.id)
      if (!available) {
        attempts.push({ backend: step.id, ok: false, skipped: true, errorCode: 'UNAVAILABLE', errorKind: 'unavailable', ms: 0 })
        continue
      }

      const started = Date.now()
      try {
        const result =
          step.kind === 'tavily'
            ? await runWithBudget((budget) => runTavily(options, request, budget), options.timeoutMs, signal)
            : await runWithBudget((budget) => builtinRegistry(this.ctx).get(step.id).search(request, budget), options.timeoutMs, signal)

        const ms = Date.now() - started
        const previousFailure = attempts.find((entry) => entry.ok === false && entry.skipped !== true)
        const entry = {
          ts: new Date().toISOString(),
          query: request.query,
          backend: step.id,
          label: backendLabel(step.id),
          ok: true,
          ms,
          maxResults: request.maxResults ?? null,
          sourceCount: Array.isArray(result?.sources) ? result.sources.length : 0,
          hasAnswer: typeof result?.content === 'string' && result.content.length > 0,
          mode: plan.mode,
          score: plan.score,
          reasons: plan.labels,
          fallbackFrom: previousFailure?.backend ?? null,
          fallbackKind: previousFailure?.errorKind ?? null,
        }
        attempts.push({ backend: step.id, ok: true, ms, errorCode: null, errorKind: null })
        remember(entry)
        appendLog(options.dataDir, entry)
        writeStatusSnapshot(options, { mode: plan.mode, override: plan.override, builtins: plan.builtins })
        return decorateResult(result, entry, options)
      } catch (error) {
        const ms = Date.now() - started
        const classification = classifyError(error, options.cooldowns)
        if (classification.kind === 'aborted') throw error
        setCooldown(step.id, classification)
        const entry = {
          ts: new Date().toISOString(),
          query: request.query,
          backend: step.id,
          label: backendLabel(step.id),
          ok: false,
          ms,
          errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
          errorKind: classification.kind,
          errorMessage: preview(classification.message),
          mode: plan.mode,
          score: plan.score,
          reasons: plan.labels,
        }
        attempts.push({ backend: step.id, ok: false, ms, errorCode: entry.errorCode, errorKind: classification.kind })
        remember(entry)
        appendLog(options.dataDir, entry)
        writeStatusSnapshot(options, { mode: plan.mode, override: plan.override, builtins: plan.builtins })
      }
    }

    const trail = attempts
      .map((entry) => `${backendLabel(entry.backend)}${entry.skipped === true ? '（不可用）' : `（${entry.errorKind ?? entry.errorCode ?? '失败'}）`}`)
      .join(' → ')
    throw new WebProviderError(
      `所有搜索后端都失败了：${trail}。可以稍后再试；如果是 Tavily 限速/额度问题，冷却结束后会自动恢复。用时 ${seconds(Date.now() - startedAll)}。`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

function remember(entry) {
  recentDecisions.push(entry)
  if (recentDecisions.length > 20) recentDecisions.splice(0, recentDecisions.length - 20)
}

/** Human labels for a failed backend's error kind, used inside the marker. */
const KIND_LABELS = {
  'rate-limit': '限速',
  quota: '额度用完',
  auth: '钥匙/登录失效',
  timeout: '超时',
  server: '服务异常',
  error: '出错',
  unavailable: '不可用',
}

/** Prepend the one-line backend marker so both the user and the model see which ran. */
function decorateResult(result, entry, options) {
  if (options.showMarker === false) return result
  const bits = []
  if (entry.backend === 'tavily') bits.push(options.searchDepth)
  bits.push(seconds(entry.ms))
  bits.push(entry.hasAnswer ? '含总结' : '无总结')
  if (entry.fallbackFrom !== null) {
    bits.push(`${backendLabel(entry.fallbackFrom)} ${KIND_LABELS[entry.fallbackKind] ?? '失败'}，已自动降级`)
  } else if (entry.mode !== 'auto') {
    bits.push(`手动模式：优先${entry.mode === 'tavily' ? 'Tavily' : '自带'}`)
  } else {
    bits.push(`判断：${decisionLabel(entry)}`)
  }
  const marker = `> 🔎 搜索后端：**${entry.label}**（${bits.join(' · ')}）`
  const original = typeof result?.content === 'string' && result.content.length > 0 ? result.content : ''
  return { ...result, content: original.length > 0 ? `${marker}\n\n${original}` : marker }
}

/* ------------------------------------------------------------------ *
 * Status / control tool                                                *
 * ------------------------------------------------------------------ */

function toolText(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

async function runTool(ctx, resolve, args) {
  const options = resolve()
  const action = typeof args?.action === 'string' ? args.action : 'status'
  const builtins = describeBuiltins(ctx, options.builtinChain)

  if (action === 'set_mode') {
    const mode = normalizeMode(args?.mode)
    writeOverride(options.dataDir, mode)
    lastSnapshotAt = 0
    writeStatusSnapshot(options, { mode, override: mode === 'auto' ? null : mode, builtins })
    return toolText({
      ok: true,
      mode,
      note: mode === 'auto' ? '已恢复自动选路' : `已切换到「${mode === 'tavily' ? '优先 Tavily' : '优先 DSH 自带'}」，下次搜索生效`,
    })
  }

  if (action === 'dry_run') {
    const query = typeof args?.query === 'string' && args.query.length > 0 ? args.query : ''
    if (query.length === 0) return toolText({ ok: false, error: 'dry_run 需要 query 参数' })
    const override = readOverride(options.dataDir)
    const decision = planSearch(query, latestUserPrompt(ctx), options)
    const effectiveMode = override ?? options.mode
    return toolText({
      query,
      mode: effectiveMode,
      override: override ?? null,
      decision,
      tavily: { available: tavilyAvailable(options), cooldown: cooldownText('tavily') ?? null, searchDepth: options.searchDepth },
      builtins: builtins.map((entry) => ({ ...entry, cooldown: cooldownText(entry.id) ?? null })),
      wouldPrefer: effectiveMode === 'auto' ? decision.backend : effectiveMode,
    })
  }

  if (action === 'recent') {
    const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 50) : 10
    return toolText({ logPath: options.dataDir === undefined ? null : dataPaths(options.dataDir).log, entries: recentEntries(options.dataDir, limit) })
  }

  if (action === 'stats') {
    return toolText({ logPath: options.dataDir === undefined ? null : dataPaths(options.dataDir).log, stats: logStats(options.dataDir, 7) })
  }

  if (action === 'reset_stats') {
    if (options.dataDir === undefined) return toolText({ ok: false, error: 'dataDir 不可用' })
    const path = dataPaths(options.dataDir).log
    if (existsSync(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      renameSync(path, join(options.dataDir, `search-log.archived-${stamp}.jsonl`))
    }
    return toolText({ ok: true, note: '用量统计已清零（旧日志改名归档）' })
  }

  const override = readOverride(options.dataDir)
  const effectiveMode = override ?? options.mode
  return toolText({
    mode: effectiveMode,
    override: override ?? null,
    configMode: options.mode,
    tavily: {
      available: tavilyAvailable(options),
      apiKeyEnv: options.apiKeyEnv,
      keyless: options.keyless,
      searchDepth: options.searchDepth,
      cooldown: cooldownText('tavily') ?? null,
    },
    builtins: builtins.map((entry) => ({ ...entry, cooldown: cooldownText(entry.id) ?? null })),
    recent: recentEntries(options.dataDir, 5),
    stats: logStats(options.dataDir, 7),
    logPath: options.dataDir === undefined ? null : dataPaths(options.dataDir).log,
    statusPath: options.dataDir === undefined ? null : dataPaths(options.dataDir).status,
  })
}

const ROUTER_TOOL = {
  name: ROUTER_TOOL_NAME,
  description:
    'Inspect or control the automatic web_search backend router (Tavily API vs the harness built-in DeepSeek search). ' +
    'Call this whenever the user asks which search engine was used, how many Tavily calls happened, why a search failed, ' +
    'or wants to force/restore a backend. Actions: status (default; current mode, availability, cooldowns, last calls, usage), ' +
    'stats (usage counts), recent (latest calls), set_mode (auto|tavily|builtin), dry_run (explain the routing decision for a query ' +
    'without searching), reset_stats (archive the usage log).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'stats', 'recent', 'set_mode', 'dry_run', 'reset_stats'],
        description: 'Operation to perform. Defaults to status.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        description: 'For set_mode: auto = per-query routing, tavily = prefer Tavily, builtin = prefer harness built-in search.',
      },
      query: { type: 'string', description: 'For dry_run: the search query to explain.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'For recent: how many entries (default 10).' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: { content: { type: 'array', items: {} } },
      required: ['content'],
      additionalProperties: false,
    },
    render: (_args, value) => value.content,
  },
  isConcurrencySafe: () => true,
  async execute(args) {
    return runTool(toolContext.ctx, toolContext.resolve, args)
  },
}

/** Captured at apply() time so the tool can reach ctx without importing anything. */
const toolContext = { ctx: undefined, resolve: undefined }

/* ------------------------------------------------------------------ *
 * Load trace                                                           *
 * ------------------------------------------------------------------ */

async function traceLoad(message) {
  try {
    const fs = await import('node:fs')
    fs.appendFileSync(new URL('./load-trace.log', import.meta.url), `${new Date().toISOString()}  ${message}\n`)
  } catch {
    // Diagnostics are never worth failing a load over.
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry                                                         *
 * ------------------------------------------------------------------ */

export const name = 'web-search-router'
export const inject = ['web', 'tools']

export function apply(ctx, config = {}) {
  void traceLoad(`apply() called; mode=${String(config?.mode)}`)
  const resolve = () => resolveOptions(ctx, config)
  const provider = new SmartSearchProvider(ctx, resolve)

  ctx.web.registerSearchProvider(provider)

  toolContext.ctx = ctx
  toolContext.resolve = resolve
  try {
    ctx.tools.register(ROUTER_TOOL)
  } catch (error) {
    void traceLoad(`tool registration failed: ${String(error)}`)
  }

  try {
    const status = resolve()
    writeStatusSnapshot(status, { mode: status.mode, builtins: describeBuiltins(ctx, status.builtinChain) })
  } catch {
    // Snapshot only.
  }

  void traceLoad(`registered; provider=${PROVIDER_ID} tool=${ROUTER_TOOL_NAME}`)
}

export { PROVIDER_ID, SmartSearchProvider, ROUTER_TOOL_NAME, resolveOptions }
export default { name, inject, apply }
