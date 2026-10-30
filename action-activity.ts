import { LiveActivity, Script } from 'scripting'
import { CarLinkActionActivity, type ActionState } from './live_activity'
import { ISLAND_DELAY_DEFAULT, readSettings } from './settings'

// 与 live_activity.tsx 里 register 的名字保持一致。
const NAME = 'CarLinkAction'
// 记一份活动 ID：进程被系统掐掉时活动还挂在岛上，下次执行先把旧的收掉。
const ID_KEY = 'carlink.action.activity.v2'
// 我们创建过的活动 id 历史，用于逐条兜底收岛（不能按 App 全量清，会误伤智能体的活动）。
const HISTORY_KEY = 'carlink.action.activity.history'

const LOG_PATH = FileManager.appGroupDocumentsDirectory + '/action-activity.log'
function reasonOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
export function traceActivity(line: string): void {
  try {
    FileManager.appendTextSync(LOG_PATH, `${new Date().toISOString()} [${Script.env}] ${line}\n`)
  } catch { /* 日志写不进去也不能影响动作本身 */ }
}

/** 一次组件动作在灵动岛上的三段文案，例如 { running: '正在锁车', done: '锁车成功', failed: '锁车失败' }。 */
export type ActionStage = { running: string; done: string; failed: string }

/** 动作执行期间握在手里的一张凭据：finish 只生效一次，成功失败都要调它收岛。 */
export type ActionActivity = { finish(ok: boolean, detail: string): Promise<void> }

// 震动全部包一层：老系统/静音模式下这些调用可能直接失败，绝不能因此中断指令下发。
// 开始用 vibrate()（系统振动，主 App 在被意图唤起、处于后台时也能响），
// 结果用 notification*（更短促，成功失败听感不同）。
// 日志里带相对动作起点的毫秒数，用来分辨“震动早于岛”是我们震早了，还是系统给组件的点击反馈。
let actionStart = 0
function buzz(kind: 'start' | 'ok' | 'fail'): void {
  try {
    traceActivity(`buzz(${kind}) +${actionStart ? Date.now() - actionStart : -1}ms`)
    if (kind === 'start') HapticFeedback.vibrate()
    else if (kind === 'ok') HapticFeedback.notificationSuccess()
    else HapticFeedback.notificationError()
  } catch (e) { traceActivity(`buzz(${kind}) threw ${reasonOf(e)}`) }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

// 灵动岛从 start()/update() 返回到真正画到屏幕上，中间还有一段系统弹出动画（约 1.5 秒）。
// 所以震动不能紧跟 API 返回，要再等一档，才能和“看到岛”同一下。
// 这一档由使用者在「组件设置 › 灵动岛设置 › 震动延时」里调（默认 1500ms），每次动作开始时读一次。
const ISLAND_APPEAR_DELAY_FALLBACK = ISLAND_DELAY_DEFAULT
const ISLAND_UPDATE_DELAY = 250
function islandAppearDelay(): number {
  try {
    const value = readSettings().islandDelay
    return typeof value === 'number' && Number.isFinite(value) ? value : ISLAND_APPEAR_DELAY_FALLBACK
  } catch (e) {
    traceActivity(`delay read threw ${reasonOf(e)}`)
    return ISLAND_APPEAR_DELAY_FALLBACK
  }
}

// 用定时器而不是 await：这段延迟绝不能拖慢指令下发。
function buzzLater(kind: 'start' | 'ok' | 'fail', delay: number): void {
  try { setTimeout(() => buzz(kind), delay) } catch (e) { traceActivity(`buzzLater(${kind}) threw ${reasonOf(e)}`) }
}

function stateOf(stage: ActionStage, phase: ActionState['phase'], detail: string): ActionState {
  return { phase, title: phase === 'running' ? stage.running : phase === 'done' ? stage.done : stage.failed, detail }
}

/** 记住我们自己创建过的活动 id，收尾时按 id 逐个兜底清理。 */
function rememberId(id: string): void {
  try {
    const raw = Storage.get<string>(HISTORY_KEY)
    const list: string[] = raw ? JSON.parse(raw) : []
    const next = [id, ...list.filter((x) => x !== id)].slice(0, 6)
    Storage.set(HISTORY_KEY, JSON.stringify(next))
  } catch (e) {
    traceActivity(`remember threw ${reasonOf(e)}`)
  }
}

/** 上一次动作遗留的灵动岛（多半是进程中途被杀）先收掉，免得同时挂两个。 */
async function dismissStale(): Promise<void> {
  const id = Storage.get<string>(ID_KEY)
  if (!id) return
  Storage.set(ID_KEY, '')
  try {
    const stale = await LiveActivity.from<ActionState>(id, NAME)
    const state = await stale?.getActivityState()
    if (stale && (state === 'active' || state === 'stale')) {
      await stale.end(stateOf({ running: '', done: '', failed: '操作已中断' }, 'failed', ''), { dismissTimeInterval: 0 })
    }
  } catch (e) { traceActivity(`stale failed ${reasonOf(e)}`) }
}

/**
 * 收岛兜底：只清我们自己创建过的活动（按历史 id 逐个查）。
 * 不用 endAllActivities —— 那是 App 级的，会把智能体等其他活动一起干掉。
 */
async function sweepLeftovers(): Promise<void> {
  try {
    const raw = Storage.get<string>(HISTORY_KEY)
    if (!raw) return
    const list: string[] = JSON.parse(raw)
    for (const oldId of list) {
      try {
        const act = await LiveActivity.from<ActionState>(oldId, NAME)
        if (!act) continue
        const st = await act.getActivityState()
        if (st === 'active' || st === 'stale') {
          traceActivity(`sweep ${oldId.slice(0, 8)} ${String(st)}`)
          await act.end(stateOf({ running: '', done: '', failed: '操作已结束' }, 'failed', ''), { dismissTimeInterval: 0 })
        }
      } catch (e) {
        traceActivity(`sweep one threw ${reasonOf(e)}`)
      }
    }
    Storage.set(HISTORY_KEY, '')
  } catch (e) {
    traceActivity(`sweep threw ${reasonOf(e)}`)
  }
}

/** 恢复默认时用：先把遗留的岛收掉（不按 App 全量清，只收自己的），再清空活动记录。 */
export async function endLeftoverActivities(): Promise<void> {
  await dismissStale()
  await sweepLeftovers()
}

/**
 * 岛的两条来源，各有一个开关：
 * direct = 点下去直接执行的组件按钮（含车辆图片刷新）；confirm = 组件里二次确认后才执行的按钮。
 */
export type IslandChannel = 'direct' | 'confirm'

/** 读一次开关；设置读坏了就当做开着，宁可有提示也别默默不响。 */
function islandEnabledFor(channel: IslandChannel): boolean {
  try {
    const s = readSettings()
    return channel === 'confirm' ? s.islandConfirmEnabled !== false : s.islandEnabled !== false
  } catch (e) {
    traceActivity(`switch read threw ${reasonOf(e)}`)
    return true
  }
}

/**
 * 组件动作开始时把灵动岛挂出来，并在岛出现的那一下振动，两者同步。
 * 开关关闭、用户关掉了实时活动权限、或系统拒绝创建时返回 null——动作照常进行（不建活动也不震，
 * 开关关闭时连震动也不要：没有岛的时候单独震一下会让人以为出了问题）。
 */
export async function beginActionActivity(stage: ActionStage, channel: IslandChannel = 'direct'): Promise<ActionActivity | null> {
  // 开关判断放在最前面：关掉就完全不碰 LiveActivity（也不读权限、不清残留）。
  if (!islandEnabledFor(channel)) {
    traceActivity(`${stage.running} island off (${channel})`)
    return null
  }
  actionStart = Date.now()
  // 岛起不来时的退路：先震一下再放弃，保证点击总有触感。（正常路径不会走到这里）
  const bail = (): null => { buzz('start'); return null }

  let enabled = false
  try {
    enabled = await LiveActivity.areActivitiesEnabled()
  } catch (e) {
    traceActivity(`areActivitiesEnabled threw ${reasonOf(e)}`)
    return bail()
  }
  if (!enabled) return bail()

  await dismissStale()

  let activity: ReturnType<typeof CarLinkActionActivity>
  try {
    activity = CarLinkActionActivity()
  } catch (e) {
    traceActivity(`factory threw ${reasonOf(e)}`)
    return bail()
  }

  try {
    const started = await activity.start(stateOf(stage, 'running', '正在连接车辆…'))
    if (!started) return bail()
  } catch (e) {
    traceActivity(`${stage.running} start threw ${reasonOf(e)}`)
    return bail()
  }
  // 震动排在这里：等系统把岛画出来那一档延迟之后再震，不是紧跟 start() 返回。
  traceActivity(`${stage.running} start=true +${Date.now() - actionStart}ms`)
  buzzLater('start', islandAppearDelay())

  const id = activity.activityId
  if (id) {
    Storage.set(ID_KEY, id)
    rememberId(id)
  }
  let finished = false
  return {
    async finish(ok: boolean, detail: string): Promise<void> {
      if (finished) return
      finished = true
      const state = stateOf(stage, ok ? 'done' : 'failed', detail)
      let buzzed = false
      try {
        // 先把结果推到岛上，等文字真的变了再震——跟开头一样：震动永远晩于画面变化。
        await activity.update(state)
        buzzLater(ok ? 'ok' : 'fail', ISLAND_UPDATE_DELAY)
        buzzed = true
        // 停一下让人看见，再 end（dismissTimeInterval 0 = 让系统立刻移除）。
        await sleep(ok ? 1200 : 2200)
        await activity.end(state, { dismissTimeInterval: 0 })
      } catch (e) {
        traceActivity(`finish threw ${reasonOf(e)}`)
        // 更新/收岛出错时也补一下触感，别让人以为没反应；已经震过就不重复震。
        if (!buzzed) buzz(ok ? 'ok' : 'fail')
      }
      if (id && Storage.get<string>(ID_KEY) === id) Storage.set(ID_KEY, '')
      await sweepLeftovers()
    },
  }
}
