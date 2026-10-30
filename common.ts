/**
 * 跨模块的零依赖小工具。
 *
 * 这里只放「纯函数 + 一层 Storage 读写」，别 import 项目里的其它模块：
 * fuel-economy → fuel-reference → common 是本项目最长的依赖链，common 一旦反向依赖就会成环。
 */

declare const Storage: { get<T>(key: string): T | null; set<T>(key: string, value: T): boolean }

/** 保留两位小数（四舍五入）：油价、油耗、变化率的展示口径统一走这里。 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 合理的百公里油耗区间（L/100km）：超出说明车机上报的数据本身有问题（油表没上报、单位不是升等）。 */
export const MIN_L100 = 1
export const MAX_L100 = 40

/** 读一份本地 JSON 缓存：读失败 / 从没写过都当没命中。 */
export function readJson<T>(key: string): T | null {
  try { return Storage.get<T>(key) } catch { return null }
}

/** 写一份本地 JSON 缓存（value 传 null 即清空）；失败返回 false，由调用方决定是静默还是报错。 */
export function writeJson<T>(key: string, value: T | null): boolean {
  try { return Storage.set(key, value as T) !== false } catch { return false }
}
