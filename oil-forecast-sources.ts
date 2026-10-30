// 调价预测的多个来源：汽油价格网原文、原油变化率估算，以及给它们校准「下次窗口」的调价日历站。
// 抓取与解析的口径集中在这里，oil-price.ts 只负责缓存、校验与展示；加源/换源只动这一个文件。
// 注意：这里不能 import oil-price.ts（那边会 import 本文件），方向类型两边各写一份，结构相同即可互赋。
import { fetch } from 'scripting'
import { round2 } from './common'

export type ForecastDirection = 'rising' | 'falling' | 'stranded'

export type ForecastSourceId = 'auto' | 'qiyoujiage' | 'crude'

/** 各源统一的产出；adjustDate 允许为空（日历站拿不到时），展示层会跳过这一段。 */
export type SourceForecast = {
  direction: ForecastDirection
  /** 每升变动（元），搁浅为 0 */
  change: number
  /** 调价窗口，统一成 10/29 24时 这种口径 */
  adjustDate: string
  text: string
  /** 由原油行情推算而非站点原文：展示时要带「估算」，别冒充官方口径 */
  estimated?: boolean
}

export const forecastSourceOptions: { id: ForecastSourceId; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: '自动（推荐）',
    hint: '优先用汽油价格网原文，过期时改用原油变化率估算。'
  },
  {
    id: 'qiyoujiage',
    label: '汽油价格网',
    hint: '第三方原文预测，贴近发改委口径，但更新会滞后。'
  },
  {
    id: 'crude',
    label: '原油变化率估算',
    hint: '按布伦特原油近 10 日均价推算，跟得上行情但只是估算。'
  }
]

export function forecastSourceOf(id: string) {
  return forecastSourceOptions.find(item => item.id === id) ?? forecastSourceOptions[0]
}

const TONS_PER_LITER = 1385
/** 单次网页抓取的上限：加载卡死时必须能放弃，否则组件渲染会一直等下去。 */
const SCRAPE_TIMEOUT = 8000
/** fetch 的 timeout 单位是秒 */
const PAGE_TIMEOUT = 12
/** 调价周期约 10 个工作日：拿最近 10 日均价与前 10 日均价比 */
const CYCLE_DAYS = 10
/** 原油变化率每 1% 折算的汽柴油吨价（官方约 40–50 元/吨，取中间值，仅用于估算） */
const YUAN_TON_PER_PERCENT = 45
/** 幅度不足 50 元/吨 时按「搁浅」处理 */
const STRANDED_THRESHOLD = 50

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    task.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

/** 去掉标签与脚本，留下可读文本：三个源都靠正则在这上面找关键词。 */
function plainTextOf(raw: string): string {
  return String(raw ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ---------------------------- 窗口日期工具 ---------------------------- */

type WindowPoint = { month: number; day: number }

/** 把 10/29 24时 解析成 {month:10, day:29}；空串或脏数据返回 null。 */
export function parseWindowPoint(adjustDate: string): WindowPoint | null {
  const hit = String(adjustDate ?? '').match(/^(\d{1,2})\/(\d{1,2})/)
  if (!hit) return null
  const month = Number(hit[1])
  const day = Number(hit[2])
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  return { month, day }
}

function windowText(point: WindowPoint): string {
  return `${point.month}/${point.day} 24时`
}

/** 把窗口日记成「距今天的天数」，只用于比较两个窗口是否同一轮。 */
function dayNumber(point: WindowPoint): number {
  const now = Date.now()
  let date = new Date(new Date().getFullYear(), point.month - 1, point.day)
  // 窗口只会落在前后三个月内：差超过半年说明跨年了，补一年再算，避免 12/31 与 1/1 相减成 −364。
  if (date.getTime() - now > 183 * 86400000) date = new Date(date.getFullYear() - 1, point.month - 1, point.day)
  if (now - date.getTime() > 183 * 86400000) date = new Date(date.getFullYear() + 1, point.month - 1, point.day)
  return Math.round(date.getTime() / 86400000)
}

function shiftDay(point: WindowPoint, delta: number): WindowPoint {
  const date = new Date(new Date().getFullYear(), point.month - 1, point.day + delta)
  return { month: date.getMonth() + 1, day: date.getDate() }
}

/** 两个窗口差几天（a − b）。 */
export function windowDistance(a: WindowPoint, b: WindowPoint): number {
  return dayNumber(a) - dayNumber(b)
}

/* ------------------------- 源一：汽油价格网原文 ------------------------- */

declare const WebViewController: {
  new (options?: { ephemeral?: boolean }): {
    loadURL(url: string): Promise<boolean>
    evaluateJavaScript<T = any>(script: string): Promise<T>
    dispose(): void
  }
}

/** 抓 qiyoujiage 的 .tishi 段落；只有 http 可用（https 证书校验过不去）。 */
async function scrapeQiyoujiageText(areaName: string): Promise<string | null> {
  let web: { loadURL(url: string): Promise<boolean>; evaluateJavaScript<T = any>(script: string): Promise<T>; dispose(): void } | null = null
  try {
    web = new WebViewController({ ephemeral: true })
    const ok = await withTimeout(web.loadURL(`http://m.qiyoujiage.com/${areaName}.shtml`), SCRAPE_TIMEOUT)
    if (!ok) return null
    const text = await withTimeout(web.evaluateJavaScript<string>("return document.querySelector('.tishi').textContent"), SCRAPE_TIMEOUT)
    return typeof text === 'string' && text.trim() ? text : null
  } catch {
    return null
  } finally {
    try { web?.dispose() } catch { /* 释放失败不影响结果 */ }
  }
}

/** 解析 qiyoujiage 的 .tishi 文本：涨跌方向、每升变动、调价日期。 */
export function parseQiyoujiageText(raw: string): { direction: ForecastDirection; change: number; adjustDate: string; text: string; ok: boolean } {
  const plain = plainTextOf(raw.split(/\bvar\s/)[0]).slice(0, 200)

  // ok 用来区分「真的搁浅」和「什么都没认出来」：后者不该写缓存，
  // 否则页面改版后卡片会连续几小时显示「预计搁浅」这种假结论。
  let recognized = false
  let direction: ForecastDirection = 'stranded'
  if (/搁浅|不作调整|不调整|维持目前/.test(plain)) { direction = 'stranded'; recognized = true }
  else if (/上涨|上调|涨价|走高/.test(plain)) { direction = 'rising'; recognized = true }
  else if (/下跌|下调|降价|走低/.test(plain)) { direction = 'falling'; recognized = true }

  let change = 0
  const literRange = plain.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*升\s*[-~～—至到]\s*(\d+(?:\.\d+)?)/)
  const literSingle = plain.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*升/)
  const tonRange = plain.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*吨\s*[-~～—至到]\s*(\d+(?:\.\d+)?)/)
  const tonSingle = plain.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*吨/)
  if (literRange) change = round2((Number(literRange[1]) + Number(literRange[2])) / 2)
  else if (literSingle) change = round2(Number(literSingle[1]))
  else if (tonRange) change = round2((Number(tonRange[1]) + Number(tonRange[2])) / 2 / TONS_PER_LITER)
  else if (tonSingle) change = round2(Number(tonSingle[1]) / TONS_PER_LITER)
  if (!Number.isFinite(change) || change < 0) change = 0
  if (direction === 'stranded') change = 0

  let adjustDate = ''
  const date = plain.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (date) {
    adjustDate = `${Number(date[2])}/${Number(date[3])}`
    const hour = plain.match(/(\d{1,2})\s*时/)
    if (hour) adjustDate += ` ${Number(hour[1])}时`
  }
  return { direction, change, adjustDate, text: plain, ok: recognized || change > 0 || !!adjustDate }
}

/* --------------------------- 调价日历（校准窗口） --------------------------- */

const CALENDAR_SITES: { id: string; url: string }[] = [
  { id: 'soyoujia', url: 'https://www.soyoujia.cn/tiaojia' },
  { id: 'bcnet', url: 'https://www.bcnet.cc/youjiatiaozheng.html' }
]

function calendarWindowOf(id: string, raw: string): WindowPoint | null {
  const plain = plainTextOf(raw)
  if (id === 'soyoujia') {
    // 写作「距下次调整还有 2 天（ 10月30日 周五 ）」：这是生效日，换回 X日24时 的口径要减一天。
    const hit = plain.match(/距下次调整还有\s*\d+\s*天[（(]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
    if (hit) return shiftDay({ month: Number(hit[1]), day: Number(hit[2]) }, -1)
    return null
  }
  // 今日油价网：「下一次调价窗口： 2026年10月29日24时」
  const hit = plain.match(/下一次调价窗口[：:]?\s*(?:\d{4}\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (!hit) return null
  return { month: Number(hit[1]), day: Number(hit[2]) }
}

async function loadCalendarWindow(): Promise<WindowPoint | null> {
  for (const site of CALENDAR_SITES) {
    try {
      const res = await fetch(site.url, { timeout: PAGE_TIMEOUT })
      if (!res.ok) continue
      const point = calendarWindowOf(site.id, await res.text())
      if (point) return point
    } catch {
      // 换个日历站再试，全挂了就当没有日历
    }
  }
  return null
}

/* -------------------------- 源三：原油变化率估算 -------------------------- */

/** 新浪全球期货日线里的布伦特原油连续（OIL，纽约原油是 CL）：调价挂钩的一篮子更接近布伦特，取它 */
const CRUDE_SYMBOL = 'OIL'
const CRUDE_NAME = '布伦特原油'
/** 新浪行情接口不带 Referer 会 403 */
const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn' }

async function loadCrudeCloses(): Promise<number[]> {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine'
    + `?symbol=${CRUDE_SYMBOL}`
  const res = await fetch(url, { timeout: PAGE_TIMEOUT, headers: SINA_HEADERS })
  if (!res.ok) return []
  const text = await res.text()
  // 接口会把 1996 年以来的日线全吐出来（300 KB+）：只取末尾一段正则抓 date/close，
  // 既省掉整块 JSON.parse，也不怕末尾那条记录被截断（正则匹配不到就自然跳过）。
  const closes: number[] = []
  const tail = text.slice(-12000)
  const pattern = /\{"date":"\d{4}-\d{2}-\d{2}"[^}]*?"close":"([\d.]+)"/g
  let hit = pattern.exec(tail)
  while (hit) {
    const close = Number(hit[1])
    if (Number.isFinite(close) && close > 0) closes.push(close)
    hit = pattern.exec(tail)
  }
  return closes
}

async function estimateByCrude(anchor: WindowPoint | null): Promise<SourceForecast | null> {
  let closes: number[] = []
  try { closes = await loadCrudeCloses() } catch { return null }
  if (closes.length < CYCLE_DAYS * 2) return null
  const recent = closes.slice(-CYCLE_DAYS)
  const previous = closes.slice(-CYCLE_DAYS * 2, -CYCLE_DAYS)
  const average = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length
  const now = average(recent)
  const before = average(previous)
  if (!(now > 0) || !(before > 0)) return null

  const percent = ((now - before) / before) * 100
  const tons = percent * YUAN_TON_PER_PERCENT
  const direction: ForecastDirection = Math.abs(tons) < STRANDED_THRESHOLD ? 'stranded' : tons > 0 ? 'rising' : 'falling'
  const change = direction === 'stranded' ? 0 : round2(Math.abs(tons) / TONS_PER_LITER)
  const changeText = `${tons >= 0 ? '+' : '−'}${Math.round(Math.abs(tons))} 元/吨`
  const text = `${CRUDE_NAME}近 ${CYCLE_DAYS} 个交易日均价 ${round2(now)} 美元（前 ${CYCLE_DAYS} 日 ${round2(before)}），变化率 ${percent >= 0 ? '+' : '−'}${Math.abs(percent).toFixed(2)}%，折合 ${changeText}`

  return { direction, change, adjustDate: anchor ? windowText(anchor) : '', text, estimated: true }
}

/* ------------------------------- 统一入口 ------------------------------- */

/**
 * 按设置里的源取一次预测。areaName 是 qiyoujiage 的路径名（如 jiangsu）。
 * 返回 null 表示这次彻底没拿到东西，交给调用方退化成缓存 / 「暂不可用」。
 */
export async function loadSourceForecast(id: ForecastSourceId, areaName: string): Promise<SourceForecast | null> {
  if (id === 'crude') return estimateByCrude(await loadCalendarWindow())

  const raw = await scrapeQiyoujiageText(areaName)
  const parsed = raw ? parseQiyoujiageText(raw) : null
  const fromPage: SourceForecast | null = parsed && parsed.ok
    ? { direction: parsed.direction, change: parsed.change, adjustDate: parsed.adjustDate, text: parsed.text }
    : null
  if (id === 'qiyoujiage') return fromPage

  // auto：站点原文最贴近官方口径，但它的窗口可能停在上一轮（站点不更新就一直沿用），
  // 所以再拉一次日历核对窗口，对不上就改用原油估算。
  const anchor = await loadCalendarWindow()
  if (fromPage) {
    const pageWindow = parseWindowPoint(fromPage.adjustDate)
    if (!pageWindow) return anchor ? { ...fromPage, adjustDate: windowText(anchor) } : fromPage
    if (!anchor || Math.abs(windowDistance(anchor, pageWindow)) <= 1) return fromPage
  }
  const estimated = await estimateByCrude(anchor)
  if (estimated) return estimated
  // 估算也失败（接口挂 / 交易日不足）：老实回站点原文，别把日历上的新窗口拼到旧文案上。
  return fromPage
}
