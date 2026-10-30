/**
 * 小号组件右上角的天气。
 *
 * 数据来自 iOS 自带天气（WeatherKit）：`symbolName` 就是系统天气 App 用的那枚 SF Symbol，
 * 所以图标不用自己画、也不用映射表硬编码，晴 / 多云 / 雨 / 雪 / 昼夜都跟系统一致。
 *
 * 组件渲染有 5 秒预算，且每次重载都要重新跑整个模块，所以：
 * - 1 小时内、坐标没挪动（< 约 5km）时直接用缓存，一次请求都不发；
 * - 只有过期才请求，并且最多等 2.5 秒，超时 / 失败就退回旧缓存（没有就返回 null，调用方自己兜底）。
 */
import { readJson, writeJson } from './common'

export type WeatherInfo = {
  /** SF Symbol 名，例如 'sun.max.fill'、'cloud.moon.fill'。 */
  symbol: string
  /** 摄氏温度。 */
  temp: number
  updatedAt: number
  /** 缓存所属坐标，车挪远了要重取。 */
  lat: number
  lng: number
}

const CACHE_KEY = 'carlink.weather.current'
// 组件默认 30 分钟刷新一次，缓存 TTL 若是同样的 30 分钟，几乎每一轮都刚好过期，
// 等于每轮必发一次 WeatherKit 请求。放宽到 1 小时 → 请求量直接减半；
// 天气只用来画一枚图标 + 一个温度，且车机上报温度时优先用车机的值，1 小时足够。
const TTL_MS = 60 * 60 * 1000
const BUDGET_MS = 2500
/** 约 5km；再远一点可能换天气区了。 */
const NEAR = 0.05

/** symbolName 缺失时的兜底（正常不会走到，只在系统返回空值时显式给一枚）。 */
const DAY_SYMBOL: Record<string, string> = {
  clear: 'sun.max.fill', mostlyClear: 'sun.max.fill', hot: 'sun.max.fill', frigid: 'thermometer.snowflake',
  partlyCloudy: 'cloud.sun.fill', mostlyCloudy: 'cloud.fill', cloudy: 'cloud.fill',
  rain: 'cloud.rain.fill', drizzle: 'cloud.drizzle.fill', heavyRain: 'cloud.heavyrain.fill',
  sunShowers: 'cloud.sun.rain.fill', freezingRain: 'cloud.sleet.fill', freezingDrizzle: 'cloud.sleet.fill',
  snow: 'cloud.snow.fill', heavySnow: 'cloud.snow.fill', flurries: 'cloud.snow.fill', sunFlurries: 'cloud.sun.snow.fill',
  sleet: 'cloud.sleet.fill', wintryMix: 'cloud.sleet.fill', hail: 'cloud.hail.fill',
  thunderstorms: 'cloud.bolt.rain.fill', isolatedThunderstorms: 'cloud.bolt.rain.fill',
  scatteredThunderstorms: 'cloud.bolt.rain.fill', strongStorms: 'cloud.bolt.rain.fill',
  tropicalStorm: 'hurricane', hurricane: 'hurricane',
  foggy: 'cloud.fog.fill', haze: 'sun.haze.fill', smoky: 'smoke.fill', blowingDust: 'sun.dust.fill',
  windy: 'wind', breezy: 'wind', blowingSnow: 'wind.snow', blizzard: 'wind.snow',
}
const NIGHT_SYMBOL: Record<string, string> = {
  clear: 'moon.stars.fill', mostlyClear: 'moon.stars.fill', partlyCloudy: 'cloud.moon.fill', windy: 'moon.stars.fill',
}

function fallbackSymbol(condition: string, isDaylight: boolean): string {
  if (!condition) return 'cloud.fill'
  return (isDaylight ? DAY_SYMBOL[condition] : NIGHT_SYMBOL[condition] || DAY_SYMBOL[condition]) || 'cloud.fill'
}

/**
 * WeatherKit 的 `symbolName` 返回的是无后缀短名（实测 cloudy → 'cloud'），
 * 而系统天气 App 用的是填充彩色版。这里补成 .fill 变体，未知符号原样用。
 */
const FILL_SYMBOL: Record<string, string> = {
  sun: 'sun.max.fill', 'sun.max': 'sun.max.fill', 'sun.min': 'sun.min.fill',
  moon: 'moon.fill', 'moon.stars': 'moon.stars.fill', 'moon.haze': 'moon.haze.fill',
  cloud: 'cloud.fill', 'cloud.sun': 'cloud.sun.fill', 'cloud.moon': 'cloud.moon.fill',
  'cloud.rain': 'cloud.rain.fill', 'cloud.drizzle': 'cloud.drizzle.fill', 'cloud.heavyrain': 'cloud.heavyrain.fill',
  'cloud.snow': 'cloud.snow.fill', 'cloud.sleet': 'cloud.sleet.fill', 'cloud.hail': 'cloud.hail.fill',
  'cloud.fog': 'cloud.fog.fill', 'cloud.bolt': 'cloud.bolt.fill', 'cloud.bolt.rain': 'cloud.bolt.rain.fill',
  'cloud.sun.rain': 'cloud.sun.rain.fill', 'cloud.sun.bolt': 'cloud.sun.bolt.fill', 'cloud.moon.bolt': 'cloud.moon.bolt.fill',
  'smoke': 'smoke.fill', 'sun.haze': 'sun.haze.fill', 'sun.dust': 'sun.dust.fill',
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < NEAR
}

function readStored(): WeatherInfo | null {
  const v = readJson<WeatherInfo>(CACHE_KEY)
  return v && typeof v.symbol === 'string' && Number.isFinite(v.updatedAt) ? v : null
}

/** 缓存写失败不影响本次显示，返回值直接忽略。 */
function store(v: WeatherInfo): void {
  writeJson(CACHE_KEY, v)
}

let memo: WeatherInfo | null | undefined
function cached(): WeatherInfo | null {
  if (memo === undefined) memo = readStored()
  return memo
}

/** 备份用：导出当前天气缓存（没有就是 null）。 */
export function readWeatherCache(): WeatherInfo | null {
  return cached()
}

/** 恢复用：写回天气缓存并同步模块内缓存；数据不合法时返回 false。 */
export function restoreWeatherCache(value: any): boolean {
  if (!value || typeof value !== 'object' || typeof value.symbol !== 'string' || !Number.isFinite(value.updatedAt)) return false
  const next: WeatherInfo = {
    symbol: value.symbol,
    temp: Number.isFinite(value.temp) ? Number(value.temp) : 0,
    updatedAt: Number(value.updatedAt),
    lat: Number.isFinite(value.lat) ? Number(value.lat) : 0,
    lng: Number.isFinite(value.lng) ? Number(value.lng) : 0,
  }
  store(next)
  memo = next
  return true
}

/** 恢复默认时清缓存：下次渲染重新取一次天气。 */
export function clearWeatherCache(): void {
  writeJson(CACHE_KEY, null)
  memo = undefined
}

async function request(lat: number, lng: number): Promise<WeatherInfo | null> {
  let timer: any
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BUDGET_MS) })
  try {
    const current = await Promise.race([Weather.requestCurrent({ latitude: lat, longitude: lng }), timeout])
    if (!current) return null
    const temp = Number(current.temperature?.value)
    return {
      symbol: FILL_SYMBOL[current.symbolName] || current.symbolName || fallbackSymbol(String(current.condition ?? ''), current.isDaylight !== false),
      temp: Number.isFinite(temp) ? temp : NaN,
      updatedAt: Date.now(),
      lat, lng,
    }
  } catch { return null }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

/**
 * 取当前天气。永不抛错、永不长时间阻塞：命中缓存立刻返回，过期最多等 2.5 秒。
 * `lat` / `lng` 无效（车机没上报坐标）时只用缓存，不发请求。
 */
export async function weatherAt(lat: number, lng: number): Promise<WeatherInfo | null> {
  const hit = cached()
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
  const usable = hit && near(hit.lat, lat) && near(hit.lng, lng) ? hit : null
  if (!valid) return usable
  if (usable && Date.now() - usable.updatedAt < TTL_MS) return usable
  const fresh = await request(lat, lng)
  if (fresh) {
    // 温度偶尔取不到（NaN），别把它盖掉旧值——旧温度比空着好。
    const merged = Number.isFinite(fresh.temp) || !usable ? fresh : { ...fresh, temp: usable.temp }
    memo = merged
    store(merged)
    return merged
  }
  return usable
}
