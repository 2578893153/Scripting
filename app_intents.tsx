import { AppIntentManager, AppIntentProtocol, Widget } from 'scripting'
import { beginWidgetConfirmation, cancelWidgetConfirmation, readWidgetConfirmation, submitWidgetConfirmation, type StartConfirmation } from './widget-confirmation'
import { parseControlRequest, performControlAction } from './command-confirmation'
import { beginActionActivity, type ActionActivity, type ActionStage } from './action-activity'
import type { WidgetSize } from './settings'

// slot 只有座椅加热用得上（每个按钮各记一份挡位）；其它动作带着也无害。
type Binding = { accountId: string; machineId: string; size: string; slot?: number }

// 每个动作在灵动岛上的说法：[参数为 false 时, 参数为 true 时]。
// 直接执行的按钮和二次确认的按钮共用这套文案，只是挂岛的时机不同（见 submitConfirmed）。
const VERB: Record<string, [string, string]> = {
  lock: ['解锁', '锁车'],
  window: ['关窗', '开窗'],
  engine: ['熄火', '启动'],
  ac: ['关空调', '开空调'],
  seat: ['关加热', '开加热'],
  trunk: ['关尾门', '开尾门'],
  cool: ['冷车', '冷车'],
  hot: ['热车', '热车'],
  find: ['寻车', '寻车'],
}

function stageOf(action: string, target: boolean): ActionStage {
  if (action === 'refresh') return { running: '正在刷新车况', done: '车况已刷新', failed: '刷新失败' }
  const pair = VERB[action]
  const verb = pair ? pair[target ? 1 : 0] : '操作'
  return { running: `正在${verb}`, done: `${verb}成功`, failed: `${verb}失败` }
}

// 所有组件控车意图共用的入口：挂灵动岛 → 交给统一执行核心（乐观状态、失败回滚都它做）→ 收岛。
async function execute(action: string, target: boolean, parameters: Binding): Promise<void> {
  const stage = stageOf(action, target)
  let activity: ActionActivity | null = null
  try {
    const request = parseControlRequest({ confirmAction: action, confirmTarget: target ? '1' : '0',
      confirmVehicle: parameters?.machineId, confirmSize: parameters?.size, confirmAccount: parameters?.accountId, confirmSlot: parameters?.slot })
    if (!request) throw new Error('组件操作已失效，请刷新后重试')
    // 参数校验通过才挂岛：无效点击不该在岛上闪一下。
    activity = await beginActionActivity(stage)
    const message = await performControlAction(request)
    // 先重绘组件：灵动岛要停 1 秒多才收，不能扣着状态不刷新。
    Widget.reloadAll()
    await activity?.finish(true, message || stage.done)
  } catch (e) {
    // 失败时缓存已回滚，同样要立刻重绘回真实状态。
    Widget.reloadAll()
    await activity?.finish(false, errorDetail(e))
    throw e
  }
}

// 十个控车意图只有名字、动作和布尔参数键不同：用同一个工厂登记，避免十份几乎一样的包装。
// boolKey 为空表示这个动作不需要布尔参数（寻车 / 冷车 / 热车 / 尾门 / 刷新）。
function controlIntent(name: string, action: string, boolKey?: string) {
  return AppIntentManager.register({
    // 必须用 LiveActivityIntent 而不是 AppIntent：普通 AppIntent 跑在 app_intents 扩展里，
    // 那个进程里 Scripting 把 LiveActivity.* 全做成了未实现的空方法（实测报 "not implemented method"），
    // 灵动岛根本起不来。LiveActivityIntent 由主 App 进程执行，才起得来岛（也才能震动）。
    name, protocol: AppIntentProtocol.LiveActivityIntent,
    perform: async (parameters: any) => {
      const flag = boolKey ? parameters?.[boolKey] : false
      if (boolKey && typeof flag !== 'boolean') throw new Error('无效的组件操作')
      await execute(action, flag, parameters)
    },
  })
}

export const LockIntent = controlIntent('CarLinkCarLock', 'lock', 'locked')
export const WindowIntent = controlIntent('CarLinkCarWindow', 'window', 'open')
export const EngineIntent = controlIntent('CarLinkCarEngine', 'engine', 'start')
export const ACIntent = controlIntent('CarLinkCarAC', 'ac', 'on')
export const SeatIntent = controlIntent('CarLinkCarSeat', 'seat', 'on')
export const CoolIntent = controlIntent('CarLinkCarCool', 'cool')
export const HotIntent = controlIntent('CarLinkCarHot', 'hot')
export const FindIntent = controlIntent('CarLinkCarFind', 'find')
export const TrunkIntent = controlIntent('CarLinkCarTrunk', 'trunk', 'open')
// 点组件里的车辆图片刷新车况，走同一套「挂岛 → 执行 → 收岛」流程。
export const RefreshIntent = controlIntent('CarLinkCarRefresh', 'refresh')

/** 失败原因压成一行塞进灵动岛（系统报错有时很长，撑不开岛）。 */
function errorDetail(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? '')
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return '请稍后重试'
  return oneLine.length > 36 ? oneLine.slice(0, 36) + '…' : oneLine
}

export const BeginConfirmationIntent = AppIntentManager.register({
  name: 'CarLinkCarBeginConfirmation', protocol: AppIntentProtocol.AppIntent,
  perform: async (parameters: StartConfirmation) => {
    try { beginWidgetConfirmation(parameters) } finally { Widget.reloadAll() }
    // 这里只做同步动作，绝不能再 await 长任务：意图不返回时系统会把重绘压到意图结束后，
    // 确认页就出不来（3.9.5 的教训）。
  },
})
export const CancelConfirmationIntent = AppIntentManager.register({
  name: 'CarLinkCarCancelConfirmation', protocol: AppIntentProtocol.AppIntent,
  perform: async (parameters: { size: string; id: string }) => {
    try { cancelWidgetConfirmation(parameters) } finally { Widget.reloadAll() }
  },
})
export const SubmitConfirmationIntent = AppIntentManager.register({
  name: 'CarLinkCarSubmitConfirmation', protocol: AppIntentProtocol.LiveActivityIntent,
  perform: async (parameters: { size: string; id: string }) => { await submitConfirmed(parameters) },
})

const SIZES = ['small', 'medium', 'large', 'extraLarge']
/**
 * 二次确认后才执行的按钮：岛要在点「确认」的这一下弹出来。
 * 确认单存在 App Group 存储里，主 App 进程读得到——先按单上的动作 / 方向算出岛上文案，
 * 再交给原提交逻辑（收票 → 重绘回车况首页 → 下发指令），最后按返回值收岛。
 * 单已作废（10 秒窗口过了 / 被取消）时不挂岛：只重绘回车况首页。
 */
async function submitConfirmed(parameters: { size: string; id: string }): Promise<void> {
  let ticket: ReturnType<typeof readWidgetConfirmation> = null
  try {
    if (SIZES.includes(String(parameters?.size))) ticket = readWidgetConfirmation(parameters.size as WidgetSize)
  } catch (e) {
    // 读单失败不该拦住下发：当成没有单，下面 submitWidgetConfirmation 会自己再做一遍校验。
    ticket = null
  }
  if (!ticket || ticket.id !== parameters?.id || ticket.phase !== 'pending') {
    await submitWidgetConfirmation(parameters)
    return
  }
  const stage = stageOf(ticket.action, ticket.target)
  const activity = await beginActionActivity(stage, 'confirm')
  const outcome = await submitWidgetConfirmation(parameters)
  if (!outcome) await activity?.finish(false, stage.failed)
  else await activity?.finish(outcome.ok, outcome.ok ? outcome.message : errorDetail(outcome.message))
}
