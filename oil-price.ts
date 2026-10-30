// 油价数据层：地区 / 价区 / 油号 / 石油公司 + 中石化公布价 + 下期调价预测（多数据源，见 oil-forecast-sources.ts）。
// 数据与「车辆」设置分开存放，避免被 normalizeSettings 清洗。
import { fetch } from 'scripting'
import type { Color } from 'scripting'
import { round2 } from './common'
import { logEvent, summarize } from './log'
import {
  forecastSourceOptions,
  loadSourceForecast,
  parseWindowPoint,
  type ForecastSourceId,
  type SourceForecast
} from './oil-forecast-sources'

declare const Storage: {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): boolean
}

/* ------------------------------ 地区 ------------------------------ */

export type OilAreaOption = { label: string; value: string; name: string }

export const areaOptions: OilAreaOption[] = [
  { label: '北京', value: '11', name: 'beijing' },
  { label: '天津', value: '12', name: 'tianjin' },
  { label: '河北', value: '13', name: 'hebei' },
  { label: '山西', value: '14', name: 'shanxi' },
  { label: '河南', value: '41', name: 'henan' },
  { label: '山东', value: '37', name: 'shandong' },
  { label: '上海', value: '31', name: 'shanghai' },
  { label: '江苏', value: '32', name: 'jiangsu' },
  { label: '浙江', value: '33', name: 'zhejiang' },
  { label: '安徽', value: '34', name: 'anhui' },
  { label: '福建', value: '35', name: 'fujian' },
  { label: '江西', value: '36', name: 'jiangxi' },
  { label: '湖北', value: '42', name: 'hubei' },
  { label: '湖南', value: '43', name: 'hunan' },
  { label: '广东', value: '44', name: 'guangdong' },
  { label: '广西', value: '45', name: 'guangxi' },
  { label: '云南', value: '53', name: 'yunnan' },
  { label: '贵州', value: '52', name: 'guizhou' },
  { label: '海南', value: '46', name: 'hainan' },
  { label: '重庆', value: '50', name: 'chongqing' },
  { label: '四川', value: '51', name: 'sichuan' },
  { label: '新疆', value: '65', name: 'xinjiang' },
  { label: '内蒙古', value: '15', name: 'neimenggu' },
  { label: '辽宁', value: '21', name: 'liaoning' },
  { label: '吉林', value: '22', name: 'jilin' },
  { label: '宁夏', value: '64', name: 'ningxia' },
  { label: '陕西', value: '61', name: 'shanxi-3' },
  { label: '黑龙江', value: '23', name: 'heilongjiang' },
  { label: '西藏', value: '54', name: 'xizang' },
  { label: '青海', value: '63', name: 'qinghai' },
  { label: '甘肃', value: '62', name: 'gansu' }
]

export function areaOptionOf(value: string): OilAreaOption {
  return areaOptions.find(item => item.value === value) ?? areaOptions[7]
}

/* ------------------------------ 油号 ------------------------------ */

export type OilTypeId = '89' | '92' | '95' | '98' | '0' | '-10' | '-20' | '-35'

export const oilTypeOptions: { value: OilTypeId; label: string; shortLabel: string }[] = [
  { value: '89', label: '89# 汽油', shortLabel: '89#' },
  { value: '92', label: '92# 汽油', shortLabel: '92#' },
  { value: '95', label: '95# 汽油', shortLabel: '95#' },
  { value: '98', label: '98# 汽油', shortLabel: '98#' },
  { value: '0', label: '0# 柴油', shortLabel: '0#' },
  { value: '-10', label: '-10# 柴油', shortLabel: '-10#' },
  { value: '-20', label: '-20# 柴油', shortLabel: '-20#' },
  { value: '-35', label: '-35# 柴油', shortLabel: '-35#' }
]

export const MAX_CARD_TYPES = 3

export function oilTypeOptionOf(value: OilTypeId) {
  return oilTypeOptions.find(item => item.value === value) ?? oilTypeOptions[1]
}

// 各油号在中石化接口里可能出现的数据字段，按优先级匹配。
const GRADE_FIELDS: { type: OilTypeId; fields: string[] }[] = [
  { type: '89', fields: ['GAS_89'] },
  { type: '92', fields: ['AIPAO92', 'AIPAO_GAS_92', 'AIPAOE92', 'AIPAO_GAS_E92', 'E92', 'GAS_92'] },
  { type: '95', fields: ['AIPAO95', 'AIPAO_GAS_95', 'AIPAOE95', 'AIPAO_GAS_E95', 'E95', 'GAS_95'] },
  { type: '98', fields: ['AIPAO98', 'AIPAO_GAS_98', 'AIPAOE98', 'AIPAO_GAS_E98', 'E98', 'GAS_98'] },
  { type: '0', fields: ['CHAI_0', 'CHECHAI_0'] },
  { type: '-10', fields: ['CHAI_10', 'CHECHAI_10'] },
  { type: '-20', fields: ['CHAI_20', 'CHECHAI_20'] },
  { type: '-35', fields: ['CHAI_35', 'CHECHAI_35'] }
]

/* ---------------------------- 石油公司 ---------------------------- */

export type OilCompanyId = 'sinopec' | 'petrochina' | 'cnooc' | 'shell' | 'other'

export const companyOptions: { id: OilCompanyId; name: string; short: string; tint: Color }[] = [
  { id: 'sinopec', name: '中国石化', short: '中石化', tint: '#E23B3B' },
  { id: 'petrochina', name: '中国石油', short: '中石油', tint: '#F08A24' },
  { id: 'cnooc', name: '中国海油', short: '中海油', tint: '#2C82C9' },
  { id: 'shell', name: '壳牌', short: '壳牌', tint: '#D9A400' },
  { id: 'other', name: '其他加油站', short: '其他', tint: '#6B7A90' }
]

export function companyOf(id: string) {
  return companyOptions.find(item => item.id === id) ?? companyOptions[0]
}

/* ------------------------------ 设置 ------------------------------ */

export type OilSettings = {
  enabled: boolean
  areaType: string
  areaZone: number
  company: OilCompanyId
  oilTypes: OilTypeId[]
  /** 加油油号：卡片用它折算「加满一箱」的金额 */
  refuelType: OilTypeId
  /** 每升优惠（元），用于把公布价折算成实际到店价 */
  discount: number
  /** 油箱容量（升）：0 = 跟随车机上报，其他值手动指定 */
  tankLiters: number
  /** 调价预测来源：auto 会按窗口是否过期在站点原文与原油估算之间自动挑 */
  forecastSource: ForecastSourceId
}

export const DEFAULT_OIL_SETTINGS: OilSettings = {
  enabled: true,
  areaType: '32',
  areaZone: 0,
  company: 'sinopec',
  oilTypes: ['92', '95', '0'],
  refuelType: '92',
  discount: 0,
  tankLiters: 0,
  forecastSource: 'auto'
}

export const OIL_SETTINGS_KEY = 'carlink.oil.settings.v1'
const SNAPSHOT_KEY = 'carlink.oil.snapshot.v1'
const FORECAST_KEY = 'carlink.oil.forecast.v1'
const SNAPSHOT_TTL = 10 * 60 * 1000
const FORECAST_TTL = 6 * 60 * 60 * 1000
/** 窗口已经开过但源站还停在旧窗时，最多间隔这么久重抓一次，兼顾及时与不刷网页。 */
const WINDOW_RETRY_MS = 20 * 60 * 1000
/**
 * 缓存是否还新鲜：时间戳落在未来（设备改过时间、备份还原了别机数据）时一律当过期，
 * 否则 Date.now() - at 会一直是负数，缓存永不过期、再也不会去刷新。
 */
function freshEnough(at: unknown, ttl: number): boolean {
  const age = Date.now() - Number(at || 0)
  return age >= 0 && age < ttl
}

function validOilType(value: any): value is OilTypeId {
  return oilTypeOptions.some(item => item.value === value)
}

export function normalizeOilSettings(raw: any): OilSettings {
  const src = raw && typeof raw === 'object' ? raw : {}
  const types = Array.isArray(src.oilTypes) ? src.oilTypes.filter(validOilType) : []
  const unique: OilTypeId[] = []
  types.forEach((t: OilTypeId) => { if (!unique.includes(t)) unique.push(t) })
  const discount = Number(src.discount)
  const tank = Number(src.tankLiters)
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_OIL_SETTINGS.enabled,
    areaType: areaOptions.some(item => item.value === src.areaType) ? String(src.areaType) : DEFAULT_OIL_SETTINGS.areaType,
    areaZone: Number.isFinite(Number(src.areaZone)) && Number(src.areaZone) >= 0 ? Math.round(Number(src.areaZone)) : 0,
    company: companyOptions.some(item => item.id === src.company) ? src.company : DEFAULT_OIL_SETTINGS.company,
    oilTypes: unique.length ? unique.slice(0, MAX_CARD_TYPES) : [...DEFAULT_OIL_SETTINGS.oilTypes],
    refuelType: validOilType(src.refuelType) ? src.refuelType : DEFAULT_OIL_SETTINGS.refuelType,
    discount: Number.isFinite(discount) ? Math.min(2, Math.max(0, Math.round(discount * 100) / 100)) : 0,
    tankLiters: Number.isFinite(tank) ? Math.min(200, Math.max(0, Math.round(tank * 10) / 10)) : 0,
    forecastSource: forecastSourceOptions.some(item => item.id === src.forecastSource) ? src.forecastSource : DEFAULT_OIL_SETTINGS.forecastSource
  }
}

// 设置对象按身份复用：设置页一次交互会读 2~3 次、油价卡片挂载读 2 次，
// 每次都是 Storage.get + normalizeOilSettings（含多次线性 find），没必要重复做。
// 写入一律走 saveOilSettings，它会把这份缓存换成刚落盘的对象。
let oilSettingsMemo: OilSettings | null = null
export function readOilSettings(): OilSettings {
  if (oilSettingsMemo) return oilSettingsMemo
  try {
    oilSettingsMemo = normalizeOilSettings(Storage.get<OilSettings>(OIL_SETTINGS_KEY))
    return oilSettingsMemo
  } catch {
    return { ...DEFAULT_OIL_SETTINGS }
  }
}

export function saveOilSettings(value: OilSettings): OilSettings {
  const next = normalizeOilSettings(value)
  // 改之前那一份留着写日志（油价设置一次只改一个键，但仍逐键比对）。
  const before = readOilSettings()
  if (Storage.set(OIL_SETTINGS_KEY, next) === false) throw new Error('油价设置保存失败，请重试')
  oilSettingsMemo = next
  logOilChange(before, next)
  return next
}
/** 油价设置键 → 日志里的中文短名；取值能翻译成名字的（地区 / 公司 / 预测源）就翻译。 */
const OIL_LABELS: Record<string, string> = {
  enabled: '显示油价', areaType: '地区', areaZone: '价区', company: '石油公司',
  oilTypes: '展示油号', refuelType: '加油油号', discount: '每升优惠', tankLiters: '油箱容量', forecastSource: '预测来源'
}
function oilLogValue(key: string, value: any): string {
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (key === 'company') return companyOptions.find(item => item.id === value)?.name || String(value)
  if (key === 'areaType') return areaOptions.find(item => item.value === String(value))?.label || String(value)
  if (key === 'forecastSource') return forecastSourceOptions.find(item => item.id === value)?.label || String(value)
  const types = (list: any[]) => list.map(id => oilTypeOptions.find(item => item.value === id)?.shortLabel || String(id)).join(' / ')
  if (key === 'oilTypes' && Array.isArray(value)) return types(value)
  if (key === 'refuelType') return oilTypeOptions.find(item => item.value === value)?.shortLabel || String(value)
  if (Array.isArray(value)) return value.join(' / ')
  return String(value)
}
function logOilChange(before: OilSettings, after: OilSettings): void {
  const changes: string[] = []
  for (const key of Object.keys(OIL_LABELS)) {
    const prev = (before as any)[key]
    const next = (after as any)[key]
    const same = Array.isArray(prev) || Array.isArray(next) ? JSON.stringify(prev) === JSON.stringify(next) : prev === next
    if (same) continue
    changes.push('油价 · ' + OIL_LABELS[key] + ' ' + oilLogValue(key, prev) + '→' + oilLogValue(key, next))
  }
  if (changes.length) logEvent('settings', '修改油价设置', summarize(changes))
}

/* ---------------------------- 中石化接口 ---------------------------- */

type SinopecDict = Record<string, any>

type SinopecZone = { areaCheck?: SinopecDict; areaData?: SinopecDict }

type SinopecResponse = {
  provinceCheck?: SinopecDict | null
  provinceData?: SinopecDict | null
  area?: SinopecZone[] | null
}

export type OilGrade = {
  type: OilTypeId
  label: string
  shortLabel: string
  price: number
}

export type OilZone = {
  index: number
  name: string
  description: string
  startDate: string
  grades: OilGrade[]
}

async function requestProvince(areaType: string): Promise<SinopecResponse> {
  const res = await fetch('https://cx.sinopecsales.com/yjkqiantai/data/switchProvince', {
    method: 'POST',
    timeout: 15,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://cx.sinopecsales.com',
      Referer: 'https://cx.sinopecsales.com/yjkqiantai/core/initCpb'
    },
    body: JSON.stringify({ provinceId: areaType })
  })
  if (!res.ok) throw new Error(`油价接口 HTTP ${res.status}`)
  const obj: any = await res.json()
  const data = obj?.data ?? obj
  if (!data || typeof data !== 'object') throw new Error('油价数据格式异常')
  return data as SinopecResponse
}

function priceIn(data: SinopecDict | null | undefined, fields: string[]): number {
  if (!data) return 0
  for (const field of fields) {
    const value = Number(data[field])
    if (Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100
  }
  return 0
}

function gradesFrom(zoneData: SinopecDict | null | undefined, fallback: SinopecDict | null | undefined): OilGrade[] {
  const rows: OilGrade[] = []
  GRADE_FIELDS.forEach(def => {
    const price = priceIn(zoneData, def.fields) || priceIn(fallback, def.fields)
    if (!price) return
    const option = oilTypeOptionOf(def.type)
    rows.push({ type: def.type, label: option.label, shortLabel: option.shortLabel, price })
  })
  return rows
}

function startDateOf(data: SinopecDict | null | undefined): string {
  const raw = data?.START_DATE ?? data?.startDate ?? ''
  return typeof raw === 'string' ? raw.slice(0, 10) : ''
}

/** 把接口响应整理成价区列表；没有价区的省份就是单个「全省」价区。 */
function zonesOf(response: SinopecResponse): OilZone[] {
  const provinceData = response.provinceData ?? null
  const areas = Array.isArray(response.area) ? response.area : []
  if (areas.length) {
    const zones = areas
      .map((entry, index) => {
        // 接口偶尔会在 area 里塞 null 元素，直接取属性会抛 TypeError 把整张卡片弄成错误态。
        const check = entry?.areaCheck ?? {}
        const data = entry?.areaData ?? null
        const grades = gradesFrom(data, provinceData)
        return {
          index,
          name: String(check.AREA_NAME ?? '') || `价区 ${index + 1}`,
          description: String(check.AREA_DESC ?? ''),
          startDate: startDateOf(data) || startDateOf(provinceData),
          grades
        }
      })
      .filter(zone => zone.grades.length > 0)
    // 过滤掉没有油号的价区后必须重排 index：设置里的 areaZone 与价区 Picker 的 tag
    // 都用「数组位置」，两者保持一致才不会选错价区。
    if (zones.length) return zones.map((zone, index) => ({ ...zone, index }))
  }
  const grades = gradesFrom(provinceData, null)
  if (!grades.length) throw new Error('该地区暂未公布油价')
  return [{ index: 0, name: '', description: '', startDate: startDateOf(provinceData), grades }]
}

export async function loadZones(areaType: string, force = true): Promise<OilZone[]> {
  // force=false（进设置页、切地区后回显）时先用快照里的价区：
  // 卡片刚刷过就不必再打一次中石化接口，开页也快。
  if (!force) {
    const cached = readSnapshot(areaType)
    if (cached && cached.zones.length && freshEnough(cached.updatedAt, SNAPSHOT_TTL)) return cached.zones
  }
  return zonesOf(await requestProvince(areaType))
}

/* ---------------------------- 调价预测 ---------------------------- */

type OilDirection = 'rising' | 'falling' | 'stranded'

export type OilForecast = {
  direction: OilDirection
  /** 每升变动金额（元），搁浅时为 0 */
  change: number
  /** 调价窗口，例如 10/15 24时 */
  adjustDate: string
  /** 原始提示文本，便于排查 */
  text: string
  at: number
  stale?: boolean
  /** 抓取/解析失败、手里也没有缓存时置真：文案必须说“暂不可用”，不能冒充“预计搁浅”。 */
  unknown?: boolean
  /** 产出这条预测的源（用于缓存失效判断与设置页回显） */
  source?: ForecastSourceId
  /** 由原油行情推算而非站点原文：文案要带「估算」 */
  estimated?: boolean
}

const EMPTY_FORECAST: OilForecast = { direction: 'stranded', change: 0, adjustDate: '', text: '', at: 0 }

/**
 * 缓存里的窗口是否已经开过了：站点停更时 adjustDate 会一直是上一轮，
 * 单靠 TTL 会让「10/15 24时」这种过期窗口再挂满 6 小时。
 * 允许当天（窗口 24 时才生效），过了就当作过期，最多每隔 WINDOW_RETRY_MS 重抓一次。
 */
function windowPassed(adjustDate: string): boolean {
  const point = parseWindowPoint(adjustDate)
  if (!point) return false
  const now = new Date()
  const window = new Date(now.getFullYear(), point.month - 1, point.day, 24)
  // 跨年修正：窗口比现在早半年以上，说明是明年的同一日期。
  if (window.getTime() < now.getTime() - 183 * 86400000) window.setFullYear(window.getFullYear() + 1)
  return now.getTime() - window.getTime() > 86400000
}

function forecastKey(areaType: string): string {
  return FORECAST_KEY + '.' + areaType
}

/** 缓存能否直接用：源要对得上，没过期，且窗口不是已经开过的旧窗期。 */
function cachedForecastUsable(cached: OilForecast | null, source: ForecastSourceId): boolean {
  if (!cached) return false
  if ((cached.source ?? 'qiyoujiage') !== source) return false
  if (!freshEnough(cached.at, FORECAST_TTL)) return false
  if (windowPassed(cached.adjustDate) && !freshEnough(cached.at, WINDOW_RETRY_MS)) return false
  return true
}

export async function loadForecast(areaType: string, force: boolean): Promise<OilForecast> {
  const cached = (() => {
    try { return Storage.get<OilForecast>(forecastKey(areaType)) } catch { return null }
  })()
  const source = readOilSettings().forecastSource
  if (!force && cachedForecastUsable(cached, source)) return cached as OilForecast

  let result: SourceForecast | null = null
  try {
    result = await loadSourceForecast(source, areaOptionOf(areaType).name)
  } catch {
    result = null
  }
  if (!result) {
    // 抓不到就退化成缓存 / 未知：卡片仍显示现价，只是没有预测。
    return cached ? { ...cached, stale: true } : { ...EMPTY_FORECAST, at: Date.now(), stale: true, unknown: true }
  }

  const value: OilForecast = {
    direction: result.direction,
    change: result.change,
    adjustDate: result.adjustDate,
    text: result.text,
    at: Date.now(),
    source
  }
  if (result.estimated) value.estimated = true
  try { Storage.set(forecastKey(areaType), value) } catch { /* 缓存失败不影响展示 */ }
  return value
}

/* ---------------------------- 快照缓存 ---------------------------- */

export type OilSnapshot = {
  areaType: string
  region: string
  zones: OilZone[]
  forecast: OilForecast
  updatedAt: number
  stale?: boolean
}

/** 快照按地区分开存：切换地区或同时放多个地区的组件时不会互相覆盖。 */
function snapshotKey(areaType: string): string {
  return SNAPSHOT_KEY + '.' + areaType
}

/**
 * 校验来自缓存 / 备份文件的预测数据：direction 之外还要求 change 与 at 是有限数字。
 * 形状不对就退成 unknown（文案「暂不可用」），否则 predictedPriceOf 会拿脏值算出 NaN 直接印在卡片上。
 */
function validForecastOf(value: any): OilForecast {
  if (!value || typeof value !== 'object') return EMPTY_FORECAST
  const direction = value.direction
  const change = Number(value.change)
  const at = Number(value.at)
  if (direction !== 'rising' && direction !== 'falling' && direction !== 'stranded') return { ...EMPTY_FORECAST, unknown: true }
  if (!Number.isFinite(change) || !Number.isFinite(at)) return { ...EMPTY_FORECAST, unknown: true }
  const forecast: OilForecast = {
    direction,
    change,
    adjustDate: typeof value.adjustDate === 'string' ? value.adjustDate : '',
    text: typeof value.text === 'string' ? value.text : '',
    at
  }
  if (value.unknown === true) forecast.unknown = true
  if (value.stale === true) forecast.stale = true
  if (value.estimated === true) forecast.estimated = true
  // 旧缓存没有 source：按当时的唯一源（汽油价格网）补齐，免得一升级就被当成「源不对」全部丢弃。
  forecast.source = forecastSourceOptions.some(item => item.id === value.source) ? value.source : 'qiyoujiage'
  return forecast
}

function readSnapshot(areaType: string): OilSnapshot | null {
  try {
    const value = Storage.get<OilSnapshot>(snapshotKey(areaType))
    if (!value || !Array.isArray(value.zones) || !value.zones.length) return null
    if (value.areaType && value.areaType !== areaType) return null
    // 价区必须带非空 grades：备份恢复或存储被写坏时，缺字段的价区会让 gradeRowsOf 里的
    // zone.grades.find 抛 TypeError，整张卡片变成错误态。这里直接滤掉，滤空就当作没有缓存。
    const zones = (value.zones as OilZone[]).filter(zone => Array.isArray(zone?.grades) && zone.grades.length > 0)
    if (!zones.length) return null
    // 抓取时间直接印在卡片上：旧缓存或被写坏的存储里可能没有这个字段，归零后显示「尚未更新」，
    // 而不是把 NaN / undefined 送进 TTL 判定。
    const updatedAt = Number(value.updatedAt)
    return { ...value, zones, forecast: validForecastOf(value.forecast), updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 }
  } catch {
    return null
  }
}

function writeSnapshot(value: OilSnapshot): void {
  try { Storage.set(snapshotKey(value.areaType), value) } catch { /* 缓存失败不影响展示 */ }
}

export function clearOilCache(areaType?: string): void {
  try {
    // 传了地区就只清这一区：手动刷新的目的是让卡片重抓这一区，
    // 其余地区各有自己的 key 与 TTL，没必要跟着写六十多次存储。
    (areaType ? [areaType] : areaOptions.map(area => area.value)).forEach(area => {
      Storage.set(forecastKey(area), null)
      Storage.set(snapshotKey(area), null)
    })
    // 顺带清掉旧版单 key 快照，避免升级后留下垃圾数据；全量清理时才需要。
    if (!areaType) Storage.set(SNAPSHOT_KEY, null)
  } catch { /* 清理失败忽略 */ }
}

/** 备份用：读当前地区已缓存的油价卡片数据，只读存储、不联网、不触发刷新。 */
export function readOilCache(): { snapshot: OilSnapshot | null; forecast: OilForecast | null } {
  try {
    const area = readOilSettings().areaType
    return { snapshot: readSnapshot(area), forecast: Storage.get<OilForecast>(forecastKey(area)) || null }
  } catch {
    return { snapshot: null, forecast: null }
  }
}

/** 单区写缓存：快照与预测各自校验，能写哪个写哪个；返回是否写了至少一项。 */
function writeOilCacheFor(area: string, snapshot: any, forecast: any): boolean {
  let ok = false
  if (snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.zones) && snapshot.zones.length) {
    // 备份文件是外部数据：价区缺 grades 会让卡片渲染抛错，宁可整份快照不写。
    const zones = snapshot.zones.filter((zone: any) => Array.isArray(zone?.grades) && zone.grades.length > 0)
    if (zones.length) {
      Storage.set(snapshotKey(area), { ...snapshot, areaType: area, zones, forecast: validForecastOf(snapshot.forecast) })
      ok = true
    }
  }
  if (forecast && typeof forecast === 'object' && typeof forecast.direction === 'string') {
    const valid = validForecastOf(forecast)
    // 只有真正通过校验（没有被打上 unknown）才写，避免把脏预测写进缓存。
    if (!valid.unknown) {
      Storage.set(forecastKey(area), valid)
      ok = true
    }
  }
  return ok
}

/** 恢复用：写回油价卡片数据（快照 + 预测），数据不合法的那一项直接跳过。 */
export function restoreOilCache(snapshot: any, forecast: any): boolean {
  try {
    const area = snapshot && typeof snapshot.areaType === 'string' && snapshot.areaType ? snapshot.areaType : readOilSettings().areaType
    return writeOilCacheFor(area, snapshot, forecast)
  } catch { return false }
}

/** 备份用：所有地区已缓存的油价数据（没缓存的地区不占地方），只读存储、不联网。 */
export function readOilCacheAll(): Record<string, { snapshot: OilSnapshot | null; forecast: OilForecast | null }> {
  const out: Record<string, { snapshot: OilSnapshot | null; forecast: OilForecast | null }> = {}
  for (const area of areaOptions) {
    let forecast: OilForecast | null = null
    try { forecast = Storage.get<OilForecast>(forecastKey(area.value)) || null } catch { forecast = null }
    const snapshot = readSnapshot(area.value)
    if (snapshot || forecast) out[area.value] = { snapshot, forecast }
  }
  return out
}

/** 恢复用：逐区写回，坏的一项不影响其它区；返回真正恢复的地区数。 */
export function restoreOilCacheAll(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  let count = 0
  try {
    for (const area of areaOptions) {
      const item = (raw as any)[area.value]
      if (!item || typeof item !== 'object') continue
      if (writeOilCacheFor(area.value, item.snapshot, item.forecast)) count += 1
    }
  } catch { /* 单区出错不影响已写入的 */ }
  return count
}

export async function loadOilSnapshot(settings: OilSettings, force: boolean): Promise<OilSnapshot> {
  const cached = readSnapshot(settings.areaType)
  if (!force && cached && freshEnough(cached.updatedAt, SNAPSHOT_TTL)) return cached

  const region = areaOptionOf(settings.areaType)
  let zones = cached?.zones ?? []
  let failed: Error | null = null
  try {
    zones = await loadZones(settings.areaType)
  } catch (error) {
    failed = error instanceof Error ? error : new Error(String(error))
  }
  // 价区没拿到、手里又没有可用缓存：现在就能确定要报错，
  // 不必再跑一次预测（每次都是一个最多 8 秒的 WebView），省时间也省电。
  if (failed && !zones.length) throw failed

  const forecast = await loadForecast(settings.areaType, force)

  if (!zones.length) throw new Error('该地区暂未公布油价')
  if (failed && cached) {
    return { ...cached, forecast, stale: true }
  }
  const snapshot: OilSnapshot = {
    areaType: settings.areaType,
    region: region.label,
    zones,
    forecast,
    updatedAt: Date.now()
  }
  writeSnapshot(snapshot)
  return snapshot
}

/* ---------------------------- 展示辅助 ---------------------------- */

export function zoneOf(snapshot: OilSnapshot | null, settings: OilSettings): OilZone | null {
  if (!snapshot || !snapshot.zones.length) return null
  const index = settings.areaZone >= 0 && settings.areaZone < snapshot.zones.length ? settings.areaZone : 0
  return snapshot.zones[index]
}

/** 按设置里的油号挑行；该地区没有对应油号时自动回退到前几个可用的。 */
export function gradeRowsOf(zone: OilZone | null, settings: OilSettings): OilGrade[] {
  if (!zone) return []
  const picked = settings.oilTypes
    .map(type => zone.grades.find(grade => grade.type === type))
    .filter((grade): grade is OilGrade => Boolean(grade))
  if (picked.length) return picked.slice(0, MAX_CARD_TYPES)
  return zone.grades.slice(0, MAX_CARD_TYPES)
}

export function netPriceOf(grade: OilGrade, settings: OilSettings): number {
  return Math.max(0, round2(grade.price - (settings.discount || 0)))
}

export function predictedPriceOf(price: number, forecast: OilForecast | null | undefined): number {
  if (!forecast) return price
  if (forecast.direction === 'rising') return round2(price + forecast.change)
  if (forecast.direction === 'falling') return round2(price - forecast.change)
  return price
}

export function directionTextOf(forecast: OilForecast | null | undefined): string {
  if (!forecast) return '待调价'
  if (forecast.unknown) return '调价信息暂不可用'
  // 估算源不是官方口径，文案必须写清楚，避免被当成发改委结论
  if (forecast.estimated) {
    if (forecast.direction === 'rising') return '估算上涨'
    if (forecast.direction === 'falling') return '估算下跌'
    return '估算搁浅'
  }
  if (forecast.direction === 'rising') return '预计上涨'
  if (forecast.direction === 'falling') return '预计下跌'
  return '预计搁浅'
}

export function trendSymbolOf(forecast: OilForecast | null | undefined): string {
  if (!forecast) return '·'
  if (forecast.direction === 'rising') return '↗'
  if (forecast.direction === 'falling') return '↘'
  return '→'
}

export function trendColorOf(forecast: OilForecast | null | undefined): Color {
  if (!forecast) return '#8A97A8'
  if (forecast.direction === 'rising') return '#D9463F'
  if (forecast.direction === 'falling') return '#2E9E6B'
  return '#8A97A8'
}

export function moneyText(value: number): string {
  return Number(value || 0).toFixed(2)
}

/* ---------------------------- 加满一箱 ---------------------------- */

/** 在价区里找“加油油号”对应的报价；该地区没公布这个油号时返回 null。 */
export function refuelGradeOf(zone: OilZone | null, settings: OilSettings): OilGrade | null {
  if (!zone) return null
  return zone.grades.find(grade => grade.type === settings.refuelType) ?? null
}

/** 还要加多少升：油箱容量 − 车机上报的剩余油量（均未上报时返回 null，不拿 0 充数）。 */
export function fillLitersOf(tankLiters: number | null | undefined, remainingLiters: number | null | undefined): number | null {
  if (tankLiters == null || remainingLiters == null) return null
  const tank = Number(tankLiters)
  const left = Number(remainingLiters)
  if (!Number.isFinite(tank) || !Number.isFinite(left) || tank <= 0 || left < 0) return null
  // 剩余量偶尔会略大于标称容量（浮点/传感器误差），钳到 0。
  const need = Math.max(0, tank - left)
  return Math.round(need * 10) / 10
}

/** 加满一箱的金额 = 升数 × 该油号折后单价。数据不足时返回 null。 */
export function refuelCostOf(liters: number | null, pricePerLiter: number): number | null {
  if (liters == null || !Number.isFinite(liters) || liters <= 0) return null
  if (!Number.isFinite(pricePerLiter) || pricePerLiter <= 0) return null
  return Math.round(liters * pricePerLiter * 100) / 100
}
