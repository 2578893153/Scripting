import { anyBitSet, known } from './dashboard-model'
import { loadCar, readCache, writeCache, patchCache, sendCommand, type CarData } from './api'
import { readToken } from './credentials'
import { readSettingsForSize, seatLevelOf, engineTimeOf, centerEngineTimeOf, visibleButtons, type Settings, type WidgetSize } from './settings'
import { logError, logEvent } from './log'

// slot 是触发这条指令的按钮槽位（确认页 / 组件按钮都带）；车辆中心页面没有槽位概念，统一传 -1。
export type ControlRequest = { action: string; target: boolean; machineId: string; size: WidgetSize; accountId: string; slot: number }
const ACTIONS = ['refresh', 'lock', 'window', 'engine', 'find', 'cool', 'hot', 'ac', 'trunk', 'seat']
export function parseControlRequest(parameters: Record<string, unknown>): ControlRequest | null {
  if (typeof parameters.confirmAction !== 'string' || !ACTIONS.includes(parameters.confirmAction)) return null
  const action = parameters.confirmAction
  if (['lock', 'window', 'engine', 'ac', 'seat'].includes(action) && parameters.confirmTarget !== '0' && parameters.confirmTarget !== '1') return null
  if (!['small', 'medium', 'large', 'extraLarge'].includes(String(parameters.confirmSize))) return null
  // 槽位只用于座椅加热挡位。缺失 / 非法按 -1 处理（页面按钮没有槽位）。
  const slot = Number(parameters.confirmSlot)
  return { action, target: parameters.confirmTarget === '1', machineId: String(parameters.confirmVehicle || ''), size: parameters.confirmSize as WidgetSize, accountId: String(parameters.confirmAccount || ''), slot: Number.isInteger(slot) && slot >= 0 ? slot : -1 }
}
// 一条可下发的车机指令：label 用于确认弹窗/提示文案，patch 是下发后可以先乐观写进缓存的状态。
export type VehicleCommand = { label: string; command: string; data: any; raw?: boolean; patch?: Partial<CarData> }
/** 取「触发这条指令的那个槽位的设置」：页面按钮没槽位时，退到该尺寸里第一个这种功能的按钮。 */
function slotSettings(request: ControlRequest, action: string): { settings: Settings; slot: number } {
  const settings = readSettingsForSize(request.size)
  const slot = request.slot >= 0 ? request.slot : Math.max(0, visibleButtons(settings).indexOf(action))
  return { settings, slot }
}
/**
 * 启动 / 冷车 / 热车的运行时长：组件里的按钮用自己槽位那份值；
 * 车辆中心页面那几个固定按钮没有槽位，用“组件设置 › 车辆中心”里单独那几份（全局，不跟尺寸）。
 */
function minutesFor(request: ControlRequest, action: 'engine' | 'cool' | 'hot', settings: Settings, slot: number): number {
  return request.slot < 0 ? centerEngineTimeOf(settings, action) : engineTimeOf(settings, slot)
}
export function requestedCommand(request: ControlRequest): VehicleCommand {
  const on = request.target
  switch (request.action) {
    case 'refresh': return { label: '刷新车况', command: '', data: {} }
    case 'lock': return { label: on ? '锁车' : '解锁', command: 'CMD_LOCK', data: { flag: on ? 1 : 0 }, patch: { locked: on } }
    case 'window': return { label: on ? '开窗' : '关窗', command: 'CMD_WINDOW', data: { flag: on ? 1 : 0 }, patch: { windows: on ? [1, 1, 1, 1] : [0, 0, 0, 0] } }
    // 启动 / 冷车 / 热车的运行时长：组件按钮跟各自槽位走（设置页每个这类按钮下面各有一个运行时间），
    // 车辆中心页面用“车辆中心”里那几份全局值；都写进 CMD_ENGINE 的 engine_time，确认文案也带上。
    case 'engine': {
      const { settings, slot } = slotSettings(request, 'engine')
      const minutes = on ? minutesFor(request, 'engine', settings, slot) : 0
      return { label: on ? '启动发动机 ' + minutes + ' 分钟' : '熄火', command: 'CMD_ENGINE', data: on ? { flag: 1, engine_time: minutes, temperature: 230 } : { flag: 0, engine_time: 0 }, patch: { engineOn: on } }
    }
    case 'find': return { label: '鸣笛寻车', command: 'CMD_SEARCHCAR', data: { search_status: 0 } }
    case 'cool': {
      const { settings, slot } = slotSettings(request, 'cool')
      const minutes = minutesFor(request, 'cool', settings, slot)
      return { label: '冷车 ' + minutes + ' 分钟', command: 'CMD_ENGINE', data: { flag: 2, engine_time: minutes, temperature: 160 } }
    }
    case 'hot': {
      const { settings, slot } = slotSettings(request, 'hot')
      const minutes = minutesFor(request, 'hot', settings, slot)
      return { label: '热车 ' + minutes + ' 分钟', command: 'CMD_ENGINE', data: { flag: 3, engine_time: minutes, temperature: 280 } }
    }
    case 'ac': return { label: on ? '开启空调' : '关闭空调', command: on ? 'CMD_ENGINE' : 'CMD_AC', data: on ? { flag: 3, engine_time: 10, temperature: 230 } : { flag: 0 }, patch: { acOn: on } }
    case 'trunk': {
      const aojie = request.accountId.startsWith('aojie:')
      return { label: on ? '打开尾门' : '关闭尾门', command: 'CMD_TRUNK', data: aojie ? { flag: on ? 0 : 1 } : '', raw: !aojie }
    }
    // 座椅加热：CMD_HEATSEAT，type 是加热挡位（'1' / '2' / '3'，每个按钮各存一份），flag 带开关方向。
    // flag 与其它指令一样写成 on ? 1 : 0；关闭时 type 跟着归 0（0 表示不带挡位），不能把挡位一路带下去。
    // 故意不写 patch：heatSeat 是车况里上报的位串，格式不确定，乐观写入可能伪造成错误挡位；
    // 指令成功后由 performControlAction 主动回读车况（syncSeatState），显示车机上报的真实状态。
    case 'seat': {
      // 挡位跟着按钮走：取触发它的那个槽位的挡位；页面按钮没槽位时退到该尺寸里第一个座椅加热按钮的挡位。
      const { settings: options, slot } = slotSettings(request, 'seat')
      const level = seatLevelOf(options, slot)
      return {
        label: on ? '开启座椅加热（' + level + ' 挡）' : '关闭座椅加热',
        command: 'CMD_HEATSEAT',
        // type 按数值下发（3.9.9 已验证可用的格式），挡位在设置里存的是字符串。
        data: { flag: on ? 1 : 0, type: on ? Number(level) : 0 }
      }
    }
    default: throw new Error('不支持的控车操作')
  }
}
// 只做「动作 + 目标状态 → 车机指令」的换算，页面里的按钮用它拿文案和载荷。
export function commandFor(action: string, target: boolean, accountId = ''): VehicleCommand {
  return requestedCommand({ action, target, machineId: '', size: 'medium', accountId, slot: -1 })
}

// 组件意图与车辆中心页面共用的执行核心：
// 校验 Token →（刷新车况只读数据）→ 乐观写入状态并重绘 → 下发指令 → 失败回滚缓存。
// 全局一条在途闸门：直连按钮没有确认单的一次性保护，连点两下会真的下发两条相反指令。
let inFlight = false
export async function performControlAction(request: ControlRequest, onSent?: () => void): Promise<string> {
  if (inFlight) throw new Error('上一条指令还在执行，请稍候')
  inFlight = true
  const label = actionLabel(request)
  try {
    const text = await runControlAction(request, onSent)
    logEvent('command', label, text)
    return text
  } catch (e) {
    // 失败单独归一类（报错），方便在日志里筛出来。
    logError('指令失败 · ' + label, e)
    throw e
  } finally { inFlight = false }
}
/** 日志里的指令名就用确认单那句文案（锁车 / 开启空调 / 热车 30 分钟），取不到时退回动作 id。 */
function actionLabel(request: ControlRequest): string {
  try { return requestedCommand(request).label } catch { return request.action }
}
async function runControlAction(request: ControlRequest, onSent?: () => void): Promise<string> {
  if (!readToken()) throw new Error('请先填写 Token')
  if (request.action === 'refresh') {
    const fresh = await loadCar()
    writeCache(fresh)
    return '车况已刷新'
  }
  const command = requestedCommand(request)
  const previous = readCache()
  // 快照与当前车辆/授权不一致时不要盲目下发：那会把指令发到另一台车、或者按另一套权限执行。
  if (previous && ((request.machineId && request.machineId !== previous.machineId) ||
    (request.accountId && request.accountId !== previous.accountId))) {
    throw new Error('车辆或授权已变化，请重新刷新车况')
  }
  // 接口没上报过的字段不要乐观写入：那会把“未知”伪造成确定状态（如凭空写成 4 扇窗全开）。
  const patch = optimisticPatch(command.patch, previous)
  // 只写缓存、不在这里重绘：组件点击路径（widget-confirmation / app_intents）下发前后
  // 本来就各重绘一次，页面路径由调用方拿到新数据后统一重绘。
  // 去掉这次多余的 Widget.reloadAll() 就少了一整轮组件进程启动（省电 + 指令更快发出）。
  try {
    // 座椅加热靠发动机供电：先启动车辆再下发加热（启动失败直接报错，不再发加热指令）。
    // onSent 在这里（真正下发前）就置位：sendCommand 一旦发出就可能已经到达车机，
    // 之后哪怕回读失败也不能让调用方以为「没发出去」而重试第二次。
    if (request.action === 'seat' && request.target) { onSent?.(); await startEngineForSeat(request, previous) }
    onSent?.()
    // 请求先发出去，再写乐观缓存：patchCache 是同步写盘（iCloud 键值存储），排在 await 前面
    // 会让每条指令都白等一次磁盘写入才出发。对调之后网络与写盘并行，回滚语义不变。
    const sending = sendCommand(command.command, command.data, command.raw)
    if (patch) patchCache(patch)
    const text = await sending
    // 关掉座椅加热后再把车熄火：加热是最后的用电需求，没必要留着发动机空转。
    if (request.action === 'seat' && !request.target) await stopEngineForSeat(previous)
    // 座椅加热没有乐观写入（heatSeat 是位串，猜错就会画出假挡位），所以下发成功后自己回读车况：
    // 车机上报有延迟，先等一会儿再拉，最多三次；拿到真实开关就收工，回读失败只当指令成功。
    // 这样页面和组件不用等下一次时间线刷新才显示真实状态。
    if (request.action === 'seat') await syncSeatState(request.target)
    return text
  } catch (e) {
    // 下发失败：只把刚才乐观改动的几个字段回滚，不覆盖期间刷新的其它数据。
    if (patch && previous) {
      const revert: any = {}
      for (const field of Object.keys(patch)) revert[field] = (previous as any)[field]
      patchCache(revert)
    }
    throw e
  }
}
/**
 * 开启座椅加热前先把车启动：没有发动机运行时车机会拒收加热指令。
 * 车况已明确在启动状态（engineOn === true）就不重复下发；时长跟「启动」按钮槽位走。
 */
async function startEngineForSeat(request: ControlRequest, previous: CarData | null): Promise<void> {
  if (previous?.engineOn === true) return
  const settings = readSettingsForSize(request.size)
  const slot = Math.max(0, visibleButtons(settings).indexOf('engine'))
  await sendCommand('CMD_ENGINE', { flag: 1, engine_time: engineTimeOf(settings, slot), temperature: 230 })
  // 车机上电到加热可用要几秒，留出这个时间再发加热指令。
  await new Promise<void>(resolve => setTimeout(resolve, 1500))
}
/**
 * 关闭座椅加热后接着熄火：与开启对称，车况已明确处于熄火状态就不重复下发。
 */
async function stopEngineForSeat(previous: CarData | null): Promise<void> {
  if (previous?.engineOn === false) return
  await sendCommand('CMD_ENGINE', { flag: 0, engine_time: 0 })
}
// 座椅加热专用的车况回读：heatSeat 是车机上报的位串，只有真正拉一次才知道开没开。
// 三次机会（0.4 秒 / 再 1.3 秒 / 再 1.6 秒）覆盖常见的车机延迟，命中就立刻收工。
// 用 light 模式（只拉两个车况接口）：位置在这几秒里不会变，没必要为此再多跑两次网络。
async function syncSeatState(on: boolean): Promise<void> {
  const delays = [400, 1300, 1600]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]))
    try {
      const fresh = await loadCar({ light: true })
      writeCache(fresh)
      // 车机没上报 heatSeat 时永远等不到结果，再轮询也是白跑两次网络，直接收工。
      if (!known(fresh, 'heatSeat')) return
      if (anyBitSet(fresh.heatSeat) === on) return
    } catch { return }
  }
}
function optimisticPatch(patch: Partial<CarData> | undefined, previous: CarData | null): Partial<CarData> | null {
  if (!patch) return null
  if (!previous) return patch
  const out: any = {}
  for (const field of Object.keys(patch)) {
    if ((previous.availability as any)?.[field] !== false) out[field] = (patch as any)[field]
  }
  return Object.keys(out).length ? out : null
}

// 生成确认页的提交闭包：创建或展示确认页本身不会下发任何指令。
export function createConfirmationExecutor(request: ControlRequest): () => Promise<string> {
  let submitted = false // 一次性闸门，防止连点重复下发
  return async () => {
    if (submitted) throw new Error('本次确认已提交，请关闭后重新操作')
    submitted = true
    // 指令还没真正发出去就失败（读 Token / 车辆校验 / 网络前置失败）时解锁，
    // 确认页的「确认执行」按钮在失败后会保留，用户重试不该被自己的闸门挡住。
    let sent = false
    try {
      return await performControlAction(request, () => { sent = true })
    } catch (e) {
      if (!sent) submitted = false
      throw e
    }
  }
}
