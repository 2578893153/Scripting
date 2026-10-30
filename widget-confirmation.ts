import { Script, Widget } from 'scripting'
import { readCache } from './api'
import { readJson, writeJson } from './common'
import { readToken } from './credentials'
import { readSettingsForSize, visibleButtons, WIDGET_SIZES, type WidgetSize } from './settings'
import { parseControlRequest, createConfirmationExecutor, type ControlRequest } from './command-confirmation'

declare const Storage: { get<T>(key: string): T | null; set<T>(key: string, value: T): boolean }
type Phase = 'pending' | 'error'
export type WidgetConfirmation = ControlRequest & { id: string; issuedAt: number; readyAt: number; expiresAt: number; hideAt?: number; phase: Phase; message?: string }
export type StartConfirmation = { confirmAccount: string; confirmAction: string; confirmTarget: string; confirmVehicle: string; confirmSize: string; confirmSlot: number; id: string; issuedAt: number }
const PREFIX = 'CarLink.WidgetConfirmation.' + Script.name + '.'
// 确认界面只做两件事：① 10 秒后作废（hideAt 是硬截止，readWidgetConfirmation 见到
// hideAt<=now 就清票，超时再点「确认」不会发指令）；② 点「确认」/「取消」后立刻回到车况首页。
// 3.9.4 到 3.9.7 试过的自动回落（present 排期 + 意图/组件进程看门狗）在 iOS 上都不兑现：
// 组件渲染完进程即被挂起，WidgetKit 也不会为 10 秒级排期重绘，那部分代码已全部删除。
export const CONFIRM_SECONDS = 10
// 从点击到组件真正画出确认界面的最长容忍。系统重载可能晚几秒，超过就当成作废。
const PENDING_LIFE = 60000
const validSize = (size: unknown): size is WidgetSize => ['small', 'medium', 'large', 'extraLarge'].includes(String(size))
const key = (size: WidgetSize) => PREFIX + size
function store(size: WidgetSize, value: WidgetConfirmation | null) {
  if (!writeJson(key(size), value)) throw new Error('确认状态保存失败，请重新操作')
}
function clear(size: WidgetSize) { store(size, null) }
/** 恢复默认时清空：票、来源时间戳、完成时间戳一起清，免得旧票挡住下一次点击。 */
export function clearAllConfirmations(): void {
  WIDGET_SIZES.forEach(({ id: size }) => {
    const base = key(size)
    try {
      writeJson(base, null)
      Storage.set(base + '.lastSource', null)
      Storage.set(base + '.finished', null)
    } catch { /* 清理失败忽略 */ }
  })
}
// options 可以外部传入（组件已经把 settings 算好了），省掉一次 Storage 读 + 全量归一化。
function allowed(request: ControlRequest, options = readSettingsForSize(request.size)) {
  const slot = request.slot
  return slot >= 0 && slot < visibleButtons(options).length &&
    options.buttonConfirmations[slot] === true && options.buttons[slot] === request.action
}
export function readWidgetConfirmation(size: WidgetSize, now = Date.now(), options?: ReturnType<typeof readSettingsForSize>): WidgetConfirmation | null {
  const state = readJson<WidgetConfirmation>(key(size))
  if (!state) return null
  if (state.size !== size || !['pending', 'error'].includes(state.phase) ||
    !Number.isFinite(state.expiresAt) || state.expiresAt <= now ||
    (typeof state.hideAt === 'number' && state.hideAt <= now) ||
    !readCache()?.machineId || !readToken() ||
    !allowed(state, options)) { clear(size); return null }
  return state
}
// 组件真正把确认界面画出来时才开始计时：重载本身可能晚几秒，从点击时刻算会白吞掉这段时间。
// hideAt 只写一次，所以"10 秒没有操作"是个固定截止，不会被反复刷新延长。
export function armConfirmationWindow(state: WidgetConfirmation | null, now = Date.now()): WidgetConfirmation | null {
  if (!state || state.phase !== 'pending' || typeof state.hideAt === 'number') return state
  const next = { ...state, hideAt: now + CONFIRM_SECONDS * 1000 }
  try { store(state.size, next) } catch { return state }
  return next
}
export function beginWidgetConfirmation(parameters: StartConfirmation, now = Date.now()): void {
  const request = parseControlRequest(parameters)
  if (!request) return
  // 设置只读一遍：下面的票校验、allowed、readWidgetConfirmation 都复用这份。
  const options = readSettingsForSize(request.size)
  if (typeof parameters.id !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(parameters.id) ||
    !Number.isFinite(parameters.issuedAt) || parameters.issuedAt <= 0 || parameters.issuedAt > now ||
    !allowed(request, options) || !readCache()?.machineId || !readToken()) return
  // A dashboard may remain visible for hours. Allow its first tap, but never re-arm
  // an already consumed dashboard snapshot, even after cancellation or expiration.
  const sourceKey = key(request.size) + '.lastSource'
  const lastSource = Storage.get<number>(sourceKey) || 0
  if (parameters.issuedAt <= lastSource || readWidgetConfirmation(request.size, now, options)) return
  if (Storage.set(sourceKey, parameters.issuedAt) === false) throw new Error('确认状态保存失败')
  store(request.size, { ...request, id: parameters.id, issuedAt: parameters.issuedAt,
    readyAt: now, expiresAt: now + PENDING_LIFE, phase: 'pending' })
}
// 进入失败态时把显示窗口字段去掉（写 undefined 可能被存储层当成非法值）。
function withoutWindow(state: WidgetConfirmation): WidgetConfirmation {
  const next = { ...state }
  delete next.hideAt
  return next
}
export function cancelWidgetConfirmation({ size, id }: { size: string; id: string }): void {
  if (!validSize(size)) return
  // 取消只关心「这张票是不是这次点出来的」：不必走 readWidgetConfirmation 的全套校验，
  // 那要多读一次设置做全量归一化、再读一次钥匙串，点「取消」回首页会慢一拍。
  const state = readJson<WidgetConfirmation>(key(size))
  if (state?.id === id) clear(size)
}
export function recentlyFinishedConfirmation(size: WidgetSize, now = Date.now()): boolean {
  const finished = Storage.get<number>(key(size) + '.finished')
  return typeof finished === 'number' && now >= finished && now - finished < 15000
}
type SubmitOutcome = { ok: boolean; message: string }
// 返回值只给调用方（app_intents 的灵动岛）判断该把岛收成成功还是失败；
// 票作废时返回 null（什么都没执行，不挂岛）。
export async function submitWidgetConfirmation({ size, id }: { size: string; id: string }): Promise<SubmitOutcome | null> {
  if (!validSize(size)) return null
  const state = readWidgetConfirmation(size)
  // 票已作废（多半是 10 秒窗口过了）还点了「确认」：不执行指令，只重绘回车况首页。
  if (!state || state.id !== id || state.phase !== 'pending') { Widget.reloadAll(); return null }
  // 先收票再执行：这样组件下一次重绘直接就是车况首页，不再有「正在提交」这一帧。
  try { clear(size) } catch { /* 收票失败也照样执行并重绘，别把这次点击丢了 */ }
  // 收票后的这一帧就是「回到车况首页」：先记上完成时间，组件才会直接用缓存里的车况画，
  // 否则这一帧会白等一次完整的 loadCar（最多 REFRESH_BUDGET_MS = 5 秒）才出画面。
  Storage.set(key(size) + '.finished', Date.now())
  Widget.reloadAll()
  try {
    const message = await createConfirmationExecutor(state)()
    // 成功：完成时间再写一次，保证紧接着这次重绘也在窗口内，走缓存不跑网络。
    Storage.set(key(size) + '.finished', Date.now())
    return { ok: true, message: message || '操作已完成' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 失败要让人看见：写失败票，finally 里的重绘会画出「操作未完成」页。
    try {
      store(size, { ...withoutWindow(state), phase: 'error', expiresAt: Date.now() + 60000,
        message })
    } catch { /* 连失败票都存不下就只能回到车况首页 */ }
    return { ok: false, message }
  } finally { Widget.reloadAll() }
}
