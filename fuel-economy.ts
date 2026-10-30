/**
 * 油耗与剩余续航。
 *
 * 输入只有车机上报的两个字段：累计里程（km）与剩余油量（L，与 oilBox 同单位）。
 * 每次真实采集车况时记一个基准点，隔一段里程再用「这段跑的公里数 ÷ 这段烧掉的升数」
 * 得到 L/100km；用滑动窗口（最近约 500km）平滑，避免单次油表抖动带偏结果。
 * 剩余可行驶里程 = 当前油量 ÷ 油耗。
 *
 * 只有 loadCar 成功拿到真实上报值时才采样。加油站让油量上涨时只重置基准点，
 * 窗口内已经积累的里程与油量保留，不会因为加一次油就从头再来。
 *
 * 样本还不够（新装脚本、刚换车、跑得少）时，回落到小熊油耗的车系加权参考值，
 * 并在 source 里标出来，界面据此把标题写成“参考油耗”，不冒充自己的实测数据。
 */

import { MAX_L100, MIN_L100 } from './common'
import { currentFuelReference, type FuelReference } from './fuel-reference'

declare const Storage: {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): boolean
}

const KEY = 'carlink.fuel.economy.v1'

/** 结算一段至少要跑的里程：油表精度有限，几公里算出来的误差太大。 */
const MIN_SEGMENT_KM = 10
/** 油量上涨超过这么多升才算加油。低于它的上涨是油面晃动，保持基准继续等。 */
const REFUEL_L = 1.5
/** 滑动窗口：累计超过这个里程就按比例缩小，让近期数据占更大权重。 */
const POOL_KM = 500
/** 窗口内里程不足这个数就别显示油耗了，样本太少。 */
const MIN_TOTAL_KM = 20

export type FuelState = {
  /** 基准点的累计里程（km） */
  mileage: number
  /** 基准点的剩余油量（L） */
  oil: number
  /** 窗口内累计行驶里程（km） */
  km: number
  /** 窗口内累计消耗油量（L） */
  liters: number
  /** 最近一次采样时间 */
  at: number
}

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function parse(raw: unknown): FuelState | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as any
  const mileage = positive(source.mileage)
  const oil = positive(source.oil)
  const km = positive(source.km)
  const liters = positive(source.liters)
  if (mileage === null || oil === null || km === null || liters === null) return null
  return { mileage, oil, km, liters, at: positive(source.at) ?? 0 }
}

function save(state: FuelState): void {
  try {
    Storage.set(KEY, state)
  } catch {
    // 写失败只影响下一次结算的基准，不该打断车况刷新。
  }
}

/** 当前累计状态；没有或数据不合法时返回 null（备份也会用它导出）。 */
export function readFuelState(): FuelState | null {
  try {
    return parse(Storage.get<FuelState>(KEY))
  } catch {
    return null
  }
}

/** 恢复备份用：外部数据先过一次校验，不合法就忽略，不覆盖本机已积累的样本。 */
export function writeFuelState(raw: unknown): void {
  const state = parse(raw)
  if (state) save(state)
}

/**
 * 采样一次车况。只在车机确实上报了里程与油量时调用。
 * 绝大多数调用会在这里直接返回（里程差不够 10km），不写盘。
 */
export function recordFuelSample(mileage: number, oil: number): void {
  if (!(mileage > 0) || !(oil >= 0)) return
  const now = Date.now()
  const prev = readFuelState()
  // 第一次采样，或里程倒退（换车 / 仪表清零 / 接口换了字段单位）：重新起基准。
  if (!prev || mileage < prev.mileage) {
    save({ mileage, oil, km: 0, liters: 0, at: now })
    return
  }
  const dKm = mileage - prev.mileage
  const dL = prev.oil - oil
  // 加油：只把基准点挪到当前，窗口里的历史油耗不动。
  if (dL <= -REFUEL_L) {
    save({ ...prev, mileage, oil, at: now })
    return
  }
  // 里程不够长，或油量没降（停车怠速、油表抖动）：基准保持不动，等累计够了再一起结算。
  if (dKm < MIN_SEGMENT_KM || dL <= 0) return
  let km = prev.km + dKm
  let liters = prev.liters + dL
  // 滑动窗口：等比缩小，油耗比值不变，只是让新数据慢慢取代旧数据。
  if (km > POOL_KM) {
    const factor = POOL_KM / km
    km *= factor
    liters *= factor
  }
  save({ mileage, oil, km, liters, at: now })
}

type FuelSource = 'sampled' | 'reference' | 'none'

type FuelStats = {
  /** 平均油耗（L/100km）；样本不足且没有参考值时为 null */
  l100km: number | null
  /** 按当前油量估算的剩余可行驶里程（km）；同样可能为 null */
  rangeKm: number | null
  /** sampled = 本机实测；reference = 小熊车系加权参考；none = 都没有 */
  source: FuelSource
  /** 本机窗口样本算出的油耗，样本不足时仍可能有值，供设置页核对 */
  sampledL100km: number | null
  /** 窗口内累计里程与油量，用来解释样本为什么不够 */
  sampleKm: number
  sampleLiters: number
  /** 本次用于兜底的参考值；source != 'reference' 时为 null */
  reference: FuelReference | null
}

/**
 * 由当前剩余油量算出油耗与续航。
 * 油耗优先用本机窗口样本；样本不足时才回落到车系加权参考值（model 用于确认参考值是当前这辆车）。
 */
export function fuelStats(oilLiters: number | null, model?: string | null): FuelStats {
  const state = readFuelState()
  const raw = state && state.km >= MIN_TOTAL_KM && state.liters > 0 ? (state.liters / state.km) * 100 : null
  const sampled = raw !== null && raw >= MIN_L100 && raw <= MAX_L100 ? raw : null
  const reference = sampled === null ? currentFuelReference(model) : null
  const l100km = sampled ?? reference?.l100km ?? null
  const rangeKm = l100km !== null && oilLiters !== null && oilLiters > 0 ? (oilLiters / l100km) * 100 : null
  return {
    l100km,
    rangeKm,
    source: sampled !== null ? 'sampled' : reference ? 'reference' : 'none',
    sampledL100km: sampled,
    sampleKm: state?.km ?? 0,
    sampleLiters: state?.liters ?? 0,
    reference,
  }
}
