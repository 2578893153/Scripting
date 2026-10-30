/**
 * 车系加权油耗参考（数据来自小熊油耗 xiaoxiongyouhao.com 公开页面）。
 *
 * 车机上报的车型通常只到车系（“奥迪A6L”），小熊上同一个车系会拆成几十上百个具体车型，
 * 每个车型有自己的平均油耗和车主样本数。所以这里的“车系加权”是：
 *   Σ(车型均耗 × 车型样本数) / Σ(车型样本数)
 * 也就是按车主数量加权，车主多、样本足的车型权重更大。
 * 它不是小熊官方给的车系均值，页面上必须标明是参考值。
 *
 * 自己的用车样本（fuel-economy.ts）永远优先，只有在样本不足时才回落到这里的参考值。
 */
import { fetch } from 'scripting'
import { MAX_L100, MIN_L100, round2 } from './common'

declare const Storage: { get<T>(key: string): T | null; set<T>(key: string, value: T): boolean }

const KEY = 'carlink.fuel.reference.v1'
const API = 'https://www.xiaoxiongyouhao.com/api/cha.php?a=querychexingreportlist&chexiname='
const SERIES_PAGE = 'https://www.xiaoxiongyouhao.com/chexiyh/'
const MODEL_PAGE = 'https://www.xiaoxiongyouhao.com/report/modelyh.php?model='
// 参考油耗不用天天更新：成功结果缓存一周，失败后 6 小时内不再重试，避免每次刷新车况都打接口。
const SUCCESS_TTL = 7 * 24 * 3600 * 1000
const FAIL_TTL = 6 * 3600 * 1000
// 接口单次返回条数上限附近说明车系没取全，加权值只能当粗略参考。
const ROW_LIMIT = 200

export type FuelModelRow = {
  modelId: number
  seriesId: number
  name: string
  l100km: number
  samples: number
  year: number
}

export type FuelReference = {
  /** series = 车系加权；model = 命中了具体车型，直接用该车型的均耗 */
  kind: 'series' | 'model'
  /** 实际用于查询的关键字，换车后据此判断缓存是否还适用 */
  keyword: string
  /** 展示名：车系名或具体车型名 */
  name: string
  l100km: number
  samples: number
  /** 参与加权的车型数量 */
  models: number
  seriesId: number
  modelId: number | null
  yearFrom: number
  yearTo: number
  /** 命中结果可能不完整（车系车型数触到接口上限） */
  partial: boolean
  fetchedAt: number
  url: string
}

export type FuelReferenceState = {
  /** 关闭后油耗计算只用本机样本，不再回落到参考值 */
  enabled: boolean
  /** 手动指定的查询关键字，空串表示按车机车型自动推断 */
  keyword: string
  reference: FuelReference | null
  error: string
  failedAt: number
}

const EMPTY: FuelReferenceState = { enabled: true, keyword: '', reference: null, error: '', failedAt: 0 }

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parseReference(raw: any): FuelReference | null {
  if (!raw || typeof raw !== 'object') return null
  const l100km = asNumber(raw.l100km)
  const samples = asNumber(raw.samples)
  const keyword = asText(raw.keyword)
  if (l100km === null || l100km < MIN_L100 || l100km > MAX_L100) return null
  if (samples === null || samples <= 0 || !keyword) return null
  return {
    kind: raw.kind === 'model' ? 'model' : 'series',
    keyword,
    name: asText(raw.name) || keyword,
    l100km: round2(l100km),
    samples: Math.round(samples),
    models: Math.max(1, Math.round(asNumber(raw.models) ?? 1)),
    seriesId: Math.round(asNumber(raw.seriesId) ?? 0),
    modelId: asNumber(raw.modelId) === null ? null : Math.round(asNumber(raw.modelId)!),
    yearFrom: Math.round(asNumber(raw.yearFrom) ?? 0),
    yearTo: Math.round(asNumber(raw.yearTo) ?? 0),
    partial: raw.partial === true,
    fetchedAt: Math.round(asNumber(raw.fetchedAt) ?? 0),
    url: asText(raw.url),
  }
}

export function readFuelReferenceState(): FuelReferenceState {
  let raw: any = null
  try {
    raw = Storage.get<any>(KEY)
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object') return { ...EMPTY }
  return {
    enabled: raw.enabled !== false,
    keyword: asText(raw.keyword),
    reference: parseReference(raw.reference),
    error: asText(raw.error),
    failedAt: Math.round(asNumber(raw.failedAt) ?? 0),
  }
}

/** 备份用：参考缓存里的 enabled / keyword 本身就是设置项，必须跟着备份走。 */
export function exportFuelReferenceState(): FuelReferenceState {
  return readFuelReferenceState()
}

/**
 * 恢复用：按“备份里真有的键”合并，脏的参考值直接跳过、保留本机已缓存的。
 * 返回是否写入了任何一项。
 */
export function restoreFuelReferenceState(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const src = raw as any
  const patch: Partial<FuelReferenceState> = {}
  if (typeof src.enabled === 'boolean') patch.enabled = src.enabled
  if (typeof src.keyword === 'string') patch.keyword = asText(src.keyword)
  // 参考值过一遍校验（油耗区间、样本数、关键字都不能缺），旧的抓取失败记录不带过来。
  const reference = parseReference(src.reference)
  if (reference) {
    patch.reference = reference
    patch.error = ''
    patch.failedAt = 0
  }
  if (!Object.keys(patch).length) return false
  saveFuelReferenceState(patch)
  return true
}

export function saveFuelReferenceState(patch: Partial<FuelReferenceState>): FuelReferenceState {
  const next: FuelReferenceState = { ...readFuelReferenceState(), ...patch }
  try {
    Storage.set(KEY, next)
  } catch {
    // 写缓存失败不影响本次使用
  }
  return next
}

/** 恢复默认时清空：开关、手动关键字与缓存的参考值一起回到初始状态。 */
export function clearFuelReferenceState(): void {
  try {
    Storage.set(KEY, null)
  } catch {
    // 清理失败不影响设置本身
  }
}

/**
 * 车机车型 → 查询关键字。去掉年款、配置后缀；车系名不会跨过第一个空格。
 * 例如 “奥迪A6L 2025款 45 TFSI 臻选动感型” → “奥迪A6L”。
 */
export function referenceKeyword(model: string | null | undefined): string {
  const text = String(model ?? '').replace(/[\s\u3000]+/g, ' ').trim()
  if (!text) return ''
  const beforeYear = text.split(/\s*(?:\d{4}款|[（(]\d{4})/)[0].trim()
  const first = beforeYear.split(' ')[0].trim()
  return first.length >= 2 ? first : text.split(' ')[0] || text
}

function candidateKeywords(model: string | null | undefined): string[] {
  const full = String(model ?? '').replace(/[\s\u3000]+/g, ' ').trim()
  const list = [referenceKeyword(full), full].map(v => v.trim()).filter(Boolean)
  return list.filter((v, i) => list.indexOf(v) === i)
}

function compact(value: string): string {
  return value.replace(/[\s\u3000]+/g, '').toLowerCase()
}

function toRow(raw: any): FuelModelRow | null {
  if (!raw || typeof raw !== 'object') return null
  const name = asText(raw.name)
  const l100km = asNumber(raw.avgConsumption)
  const samples = asNumber(raw.samples)
  const seriesId = asNumber(raw.chexi)
  const modelId = asNumber(raw.model)
  if (!name || l100km === null || samples === null) return null
  if (l100km < MIN_L100 || l100km > MAX_L100 || samples <= 0) return null
  return {
    modelId: Math.round(modelId ?? 0),
    seriesId: Math.round(seriesId ?? 0),
    name,
    l100km,
    samples: Math.round(samples),
    year: Math.round(asNumber(raw.modelYear) ?? 0),
  }
}

/**
 * 接口响应 → 参考值。纯函数，方便单独验证。
 * 1. 名称与关键字完全一致 → 直接取该车型（用户/车机给出的车型足够具体）；
 * 2. 否则取名称以关键字开头的行，按车系分组，取样本最多的车系做加权，
 *    这样同一关键字命中多个车系（如“奥迪A6”同时命中 A6L / A6 Allroad）时不会把两个车系混在一起。
 */
export function matchFuelReference(rawRows: unknown, keyword: string): FuelReference | null {
  const kw = compact(keyword)
  if (!kw) return null
  const all = (Array.isArray(rawRows) ? rawRows : []).map(toRow).filter((row): row is FuelModelRow => row !== null)
  if (!all.length) return null

  const exact = all.find(row => compact(row.name) === kw)
  if (exact) {
    return {
      kind: 'model',
      keyword: keyword.trim(),
      name: exact.name,
      l100km: round2(exact.l100km),
      samples: exact.samples,
      models: 1,
      seriesId: exact.seriesId,
      modelId: exact.modelId || null,
      yearFrom: exact.year,
      yearTo: exact.year,
      partial: false,
      fetchedAt: Date.now(),
      url: MODEL_PAGE + exact.modelId,
    }
  }

  const prefixed = all.filter(row => compact(row.name).startsWith(kw))
  const pool = prefixed.length ? prefixed : all
  const groups = new Map<number, FuelModelRow[]>()
  for (const row of pool) {
    const bucket = groups.get(row.seriesId)
    if (bucket) bucket.push(row)
    else groups.set(row.seriesId, [row])
  }

  let picked: FuelModelRow[] = []
  let pickedSamples = 0
  for (const group of groups.values()) {
    const total = group.reduce((sum, row) => sum + row.samples, 0)
    if (total > pickedSamples) {
      picked = group
      pickedSamples = total
    }
  }
  if (!picked.length || pickedSamples <= 0) return null

  const weighted = picked.reduce((sum, row) => sum + row.l100km * row.samples, 0) / pickedSamples
  if (!Number.isFinite(weighted) || weighted < MIN_L100 || weighted > MAX_L100) return null

  const years = picked.map(row => row.year).filter(year => year > 0)
  const seriesName = asText(picked[0].name).split(' ')[0] || keyword.trim()
  return {
    kind: 'series',
    keyword: keyword.trim(),
    name: seriesName,
    l100km: round2(weighted),
    samples: pickedSamples,
    models: picked.length,
    seriesId: picked[0].seriesId,
    modelId: null,
    yearFrom: years.length ? Math.min(...years) : 0,
    yearTo: years.length ? Math.max(...years) : 0,
    partial: pool.length >= ROW_LIMIT,
    fetchedAt: Date.now(),
    url: SERIES_PAGE + picked[0].seriesId + '.html',
  }
}

export async function queryFuelReference(keyword: string): Promise<FuelReference> {
  const clean = keyword.replace(/[\s\u3000]+/g, ' ').trim()
  if (clean.replace(/\s+/g, '').length < 2) throw new Error('车系名称太短，至少 2 个字')

  const response = await fetch(API + encodeURIComponent(clean), {
    timeout: 15,
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.xiaoxiongyouhao.com/cha/',
    },
  })
  if (!response.ok) throw new Error(`小熊油耗返回 HTTP ${response.status}`)
  const body: any = await response.json().catch(() => null)
  if (!body) throw new Error('小熊油耗返回的不是有效数据')
  const status = asNumber(body.status)
  if (status !== 0) throw new Error(asText(body.message) || '小熊油耗没有查到该车系')

  const rows = Array.isArray(body.chexing_report_list) ? body.chexing_report_list : []
  const matched = matchFuelReference(rows, clean)
  if (!matched) throw new Error(`未在「${clean}」下找到有效油耗数据`)
  return matched
}

/**
 * 取当前可用的参考值（同步，供油耗计算直接调用）。
 * 关闭开关、缓存过期、缓存对不上当前车型时都返回 null。
 */
export function currentFuelReference(model?: string | null): FuelReference | null {
  const state = readFuelReferenceState()
  if (!state.enabled || !state.reference) return null
  const reference = state.reference
  if (Date.now() - reference.fetchedAt > SUCCESS_TTL) return null
  if (state.keyword) {
    if (reference.keyword !== state.keyword) return null
  } else if (model) {
    const keywords = candidateKeywords(model)
    if (keywords.length && !keywords.some(value => value === reference.keyword)) return null
  }
  return reference
}

let IN_FLIGHT = false

/**
 * 按需拉取参考值（fire-and-forget 也可以）。返回 true 表示这次真的更新了缓存。
 * force = true 时忽略缓存与失败冷却，用于设置页的“立即查询”。
 */
export async function ensureFuelReference(model: string | null | undefined, force = false): Promise<boolean> {
  const state = readFuelReferenceState()
  if (!state.enabled) return false

  const manual = state.keyword
  const keywords = manual ? [manual] : candidateKeywords(model)
  if (!keywords.length) return false

  const now = Date.now()
  const cached = state.reference
  if (!force && cached) {
    const sameCar = manual ? cached.keyword === manual : keywords.some(value => value === cached.keyword)
    if (sameCar && now - cached.fetchedAt < SUCCESS_TTL) return false
  }
  if (!force && state.failedAt && now - state.failedAt < FAIL_TTL) return false
  if (IN_FLIGHT) return false

  IN_FLIGHT = true
  try {
    let reference: FuelReference | null = null
    let lastError = ''
    for (const keyword of keywords) {
      try {
        reference = await queryFuelReference(keyword)
        break
      } catch (error: any) {
        lastError = String(error?.message || error || '查询失败')
      }
    }
    if (!reference) {
      saveFuelReferenceState({ error: lastError || '查询失败', failedAt: Date.now() })
      return false
    }
    saveFuelReferenceState({ reference, error: '', failedAt: 0 })
    return true
  } finally {
    IN_FLIGHT = false
  }
}
