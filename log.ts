/**
 * 运行日志：按钮指令、参数修改与组件报错。
 * 刻意保持零依赖（只碰 Storage），因为 settings.ts 里也要记一条，
 * 反向 import settings / api 会成环。格式化成中文短句的事交给调用方（它才知道键名含义）。
 * 只在事件发生的那一下读写一次存储，绝不进组件渲染热路径。
 */
declare const Storage: { get<T>(key: string): T | null; set<T>(key: string, value: T): boolean }

export type LogKind = 'command' | 'settings' | 'error'
export type LogEntry = { at: number; kind: LogKind; title: string; detail: string }

const KEY = 'carlink.log.v1'
/** 环形缓冲上限：够翻一阵子，又不至于让 Storage 里躺一个大数组。 */
const MAX_ENTRIES = 300
/** 同一条内容十分钟内只留一条：离线时每次刷新失败都记，会把真正有用的记录挤出缓冲。 */
const DEDUPE_MS = 10 * 60 * 1000
/** 去重只看最近的这些条，不必每次扫全表。 */
const DEDUPE_SCAN = 40
const MAX_TEXT = 240

/** 把任意异常转成一行可读文字（组件里的 catch 拿到的可能是字符串）。 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (e === undefined || e === null || e === '') return '未知错误'
  return String(e)
}
function clip(text: string, max = MAX_TEXT): string {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}
/** 读全部记录（新的在前）。存储异常时当作空表，不往上抛。 */
export function readLog(): LogEntry[] {
  try {
    const raw = Storage.get<LogEntry[]>(KEY)
    if (!Array.isArray(raw)) return []
    return raw
      .filter(e => e && typeof e.at === 'number' && typeof e.title === 'string')
      .map(e => ({ at: e.at, kind: e.kind || 'error', title: e.title, detail: typeof e.detail === 'string' ? e.detail : '' }))
  } catch {
    return []
  }
}
export function clearLog(): void {
  try { Storage.set<LogEntry[]>(KEY, []) } catch { /* 清不掉也不影响使用，下次写盘会覆盖 */ }
}
/** 记一条。自身绝不抛错：日志写失败不能影响主流程（尤其是组件渲染）。 */
export function logEvent(kind: LogKind, title: string, detail = ''): void {
  try {
    const name = clip(title, 40)
    if (!name) return
    const text = clip(detail)
    const list = readLog()
    const now = Date.now()
    for (const entry of list.slice(0, DEDUPE_SCAN)) {
      if (entry.title === name && entry.detail === text && now - entry.at < DEDUPE_MS) return
    }
    Storage.set<LogEntry[]>(KEY, [{ at: now, kind, title: name, detail: text }, ...list].slice(0, MAX_ENTRIES))
  } catch {
    // 日志只是辅助信息，写不进去就算了
  }
}
export function logError(title: string, e: unknown): void {
  logEvent('error', title, errorText(e))
}
/** 把多条变更压成一行：最多列 max 条，其余用「等 N 项」收尾，日志要能一眼扫完。 */
export function summarize(items: string[], max = 4): string {
  if (!items.length) return ''
  return items.length > max ? items.slice(0, max).join('；') + ' 等 ' + items.length + ' 项' : items.join('；')
}
