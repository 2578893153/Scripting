import {
  Navigation,
  NavigationStack,
  ScrollView,
  VStack,
  HStack,
  ZStack,
  Circle,
  Rectangle,
  RoundedRectangle,
  Text,
  Image,
  SVG,
  Button,
  Link,
  Spacer,
  Widget,
  useState,
  useEffect,
  useMemo,
  Script,
  type Color,
} from 'scripting'
import { readCache, writeCache, loadCar, type CarData } from './api'

import { currentProviderLabel } from './credentials'
import { statusTint, bodyWarnings, trunkOpen } from './vehicle-state'
import { known, anyBitSet } from './dashboard-model'
import { CommandConfirmation } from './confirmation-screen'
import { SettingsScreen } from './settings-screen'
import { readSettings, centerCarScaleOf, centerLogoScaleOf, centerImagePath, plateText, gradientOf, useAudiLogoOf, centerAddressOf, fontColorOf, centerIconLineWidthOf, centerIconSizeOf, centerEngineTimeOf } from './settings'

import { commandFor, performControlAction } from './command-confirmation'
import { audiLogoSVG, audiLogoSize } from './button-icons'
import { ButtonGlyph } from './button-glyph'
import { OilPriceCard } from './oil-price-card'
import { moneyText, oilTypeOptionOf, readOilSettings } from './oil-price'
import { fuelStats } from './fuel-economy'
import { ensureFuelReference } from './fuel-reference'
import { logError } from './log'
import { prepareDefaultCar } from './car-asset'
import { showJoinPage } from './join-screen'

// 车标在卡片里的位置微调：x 往左让出右侧边距，y 上下微调
const LOGO_OFFSET_X = -8
const LOGO_OFFSET_Y = 0



// busy 是渲染状态，同一帧内连点读到的还是旧值；用模块级标记做同步入口锁，
// 避免重复弹确认框和重复下发指令。
// 刷新与控车拆成两把锁：刷车况要跑几个网络请求（几秒），期间点控车不应该被静默丢掉；
// 反之控车进行中不让刷新插队，否则会用旧数据盖掉乐观更新的状态。
let REFRESH_IN_FLIGHT = false
let COMMAND_IN_FLIGHT = false
// 指令 → 需要等待变化的车况字段；寻车 / 尾门 / 冷热车不改这些上报状态，不用等。
const COMMAND_FIELD: Record<string, keyof CarData> = { lock: 'locked', window: 'windows', engine: 'engineOn', ac: 'acOn' }

// 组件重绘统一走这里：重绘失败只影响组件，不该打断页面上的操作。
function reloadWidgets(): void {
  try {
    Widget.reloadAll()
  } catch {
    // 组件刷新失败不影响页面
  }
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 顶部状态行：字段没上报时明说“未知”，不要把默认值当成真实车况。
function statusText(d: CarData): string {
  const parts = [known(d, 'locked') ? d.locked ? '已锁车' : '未锁车' : '车锁未知']
  parts.push(known(d, 'engineOn') ? d.engineOn ? '发动机运行' : '发动机熄火' : '启动状态未知')
  if (known(d, 'windows') && anyBitSet(d.windows)) parts.push('车窗未关')
  return parts.join(' · ')
}

function mapURL(d: CarData): string {
  const query = d.address || `${d.lat},${d.lng}`
  // 必须用 https，http 会被系统当成不安全链接。
  return `https://maps.apple.com/?ll=${d.lat},${d.lng}&q=${encodeURIComponent(query)}`
}

/** 只有拿到有效坐标才能跳地图：0 与 NaN 都视为没有位置。 */
function hasLocation(d: CarData | null): boolean {
  return !!d && Number.isFinite(d.lat) && Number.isFinite(d.lng) && !(d.lat === 0 && d.lng === 0)
}

function warningText(d: CarData): string[] {
  const warnings: string[] = []
  // 位图字段统一解析，且只在车机真的上报过该字段时才提醒。
  if (known(d, 'online') && !d.online) warnings.push('车辆当前离线')
  // 0% 也要提醒：原来写成 > 0 会把油箱见底的情况直接漏掉。
  if (known(d, 'fuelPct') && d.fuelPct < 20) warnings.push(`油量偏低，仅剩 ${d.fuelPct.toFixed(0)}%`)
  if (known(d, 'battery') && d.battery > 0 && d.battery < 11.8) warnings.push(`电瓶电压偏低（${d.battery.toFixed(1)}V）`)
  if (known(d, 'windows') && anyBitSet(d.windows)) warnings.push('检测到车窗未关')
  if (known(d, 'carLamp') && anyBitSet(d.carLamp)) warnings.push('车灯开启')
  warnings.push(...bodyWarnings(d).map(item => item.label))
  if (known(d, 'waterTemperature') && d.engineOn && d.waterTemperature > 110) warnings.push('水温偏高，请检查仪表')
  return warnings
}

function Panel({ children }: { children: any }) {
  return (
    <ZStack frame={{ maxWidth: 'infinity' }}>
      <RoundedRectangle cornerRadius={20} fill="white" />
      {children}
    </ZStack>
  )
}

// 形状底色在组件内部用字面量确定，避免 props 填充色触发矩形渲染。
function CircleButton({ action, tone, icon, tint, size }: { action: () => void; tone: 'tint' | 'solid'; icon: string; tint: Color; size: number }) {
  return (
    <Button action={action} buttonStyle="plain" frame={{ width: 34, height: 34 }} clipShape="circle" contentShape="circle">
      <ZStack frame={{ width: 34, height: 34 }}>
        <Circle fill={tone === 'tint' ? '#E3EBF9' : '#FFFFFF'} frame={{ width: 34, height: 34 }} />
        <Image systemName={icon} resizable scaleToFit foregroundStyle={tint} frame={{ width: size, height: size }} />
      </ZStack>
    </Button>
  )
}

function Metric({ icon, label, value, unit }: { icon: string; label: string; value: string; unit: string }) {
  return (
    <VStack alignment="leading" spacing={7} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
      <HStack spacing={5}>
        <Image systemName={icon} resizable scaleToFit foregroundStyle="#7E8DA6" frame={{ width: 12, height: 12 }} />
        <Text font={10.5} foregroundStyle="#7B879B">{label}</Text>
      </HStack>
      <HStack alignment="firstTextBaseline" spacing={4}>
        <Text font={21} fontWeight="semibold" foregroundStyle="#17243B" lineLimit={1}>{value}</Text>
        <Text font={11} foregroundStyle="#8792A5">{unit}</Text>
      </HStack>
    </VStack>
  )
}

function ActionTile({
  id,
  state,
  label,
  tint,
  settings,
  action,
}: {
  id: string
  state: boolean
  label: string
  tint: Color
  settings: ReturnType<typeof readSettings>
  action: () => void
}) {
  // 本页按钮图标固定每按钮一色（与组件设置里的图标颜色无关），所以用户把未激活色设成白色也不会在这里消失。
  const color = tint
  // 图标大小用车辆中心自己的那一份（50 – 200%），不跟组件设置联动；圆圈只有 34pt，所以夹在 14 – 30 之间。
  const iconSize = Math.round(Math.min(30, Math.max(14, 19 * centerIconSizeOf(settings) / 100)))
  return (
    <Button action={action} buttonStyle="plain" frame={{ maxWidth: 'infinity' }}>
      <ZStack frame={{ maxWidth: 'infinity', minHeight: 86, maxHeight: 86 }}>
        <RoundedRectangle cornerRadius={18} fill="#FFFFFF" />
        <VStack spacing={8}>
          <ZStack frame={{ width: 34, height: 34 }}>
            <Circle fill={{ color, opacity: 0.09 }} />
            <ButtonGlyph id={id} state={state} color={color} lineWidth={centerIconLineWidthOf(settings)} size={iconSize} />
          </ZStack>
          <Text font={12} fontWeight="medium" foregroundStyle="#243149" lineLimit={1}>{label}</Text>
        </VStack>
      </ZStack>
    </Button>
  )
}

/** 主页指标：字段未上报时显示 --，不要拿默认的 0 当真实数据展示。 */
function metricValue(d: CarData | null, key: 'mileage' | 'oil' | 'battery' | 'outsideTemp', digits: number): string {
  if (!d || !known(d, key)) return '--'
  const value = d[key]
  return Number.isFinite(value) ? value.toFixed(digits) : '--'
}

/** 车辆位置卡片：有坐标时整张卡片可点跳地图，否则只做展示（避免两段几乎相同的卡片）。 */
function LocationCard({ data }: { data: CarData | null }) {
  const openable = hasLocation(data)
  const body = (
    <Panel>
      <HStack alignment="top" spacing={12} padding={16} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
        <ZStack frame={{ width: 32, height: 32 }}>
          <RoundedRectangle cornerRadius={10} fill="#EDF3FD" />
          <Image systemName="location" resizable scaleToFit foregroundStyle="#4B78C9" frame={{ width: 15, height: 15 }} />
        </ZStack>
        <VStack alignment="leading" spacing={5} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
          <HStack>
            <Text font={10.5} foregroundStyle="#8792A6">车辆位置</Text>
            <Spacer />
            {openable ? <Text font={10} foregroundStyle="#4B78C9">打开地图</Text> : null}
          </HStack>
          <Text font={12} foregroundStyle="#344159" lineLimit={3}>
            {data?.address || data?.addressShort || (data ? '暂未获取到车辆位置' : '刷新后显示地址')}
          </Text>
        </VStack>
      </HStack>
    </Panel>
  )
  return openable ? <Link url={mapURL(data!)}>{body}</Link> : body
}

function App() {
  const dismiss = Navigation.useDismiss()
  const [data, setData] = useState<CarData | null>(() => readCache())
  const [msg, setMsg] = useState('正在读取车况…')
  // 提示语气显式记录：不再靠 msg 里是否包含“失败”两个字来猜颜色。
  const [tone, setTone] = useState<'ok' | 'error'>('ok')
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState(readSettings)
  // 车辆中心可选择奥迪四环 Logo 或专用车图；车辆大小与 Logo 大小均独立设置。
  // 车辆中心使用独立车图；未设置时使用脚本内置车图，与小组件默认图一致。
  const engineMinutes = (action: 'cool' | 'hot') => centerEngineTimeOf(settings, action)
  const carImagePath = centerImagePath(settings)
  const centerScale = centerCarScaleOf(settings)
  const logoSize = audiLogoSize(Math.min(190 * centerLogoScaleOf(settings), 260))
  // 底部服务商文字只在挂载与设置变更时读一次钥匙串：写在 render 里会随每次 setState 重读。
  const [providerLabel, setProviderLabel] = useState(currentProviderLabel)
  // 油价卡片在设置页改完地区 / 公司后需要重新拉取。
  const [oilToken, setOilToken] = useState(0)
  // 参考油耗是网络拉回来的，拿到后递增这个 token 让油耗重新算一次。
  const [fuelToken, setFuelToken] = useState(0)
  // 加油油号折后单价（元/升），由油价卡片回传；算每公里油费用。
  const [refuelPrice, setRefuelPrice] = useState<number | null>(null)

  // 车系加权参考值不阻塞车况刷新：后台拉一次，只有真的更新了缓存才触发重算。
  function ensureReference(model: string | undefined): void {
    void ensureFuelReference(model)
      .then(updated => { if (updated) setFuelToken(value => value + 1) })
      .catch(() => {})
  }
  async function customize() {
    await Navigation.present({ element: <SettingsScreen />, modalPresentationStyle: 'pageSheet' })
    setSettings(readSettings())
    setProviderLabel(currentProviderLabel())
    setData(readCache())
    setOilToken(value => value + 1)
    // 设置页可能改了油耗参考的关键字或开关，回来重算一次。
    setFuelToken(value => value + 1)
  }

  // 快照签名：忽略 updatedAt（每次刷新都会变），其余字段一致就说明画面上看不出变化。
  function snapshotSig(d: CarData | null): string {
    return d ? JSON.stringify({ ...d, updatedAt: 0 }) : ''
  }

  async function refresh(): Promise<void> {
    if (REFRESH_IN_FLIGHT || COMMAND_IN_FLIGHT) return
    REFRESH_IN_FLIGHT = true
    setBusy(true)
    setMsg('正在刷新…')
    setTone('ok')
    try {
      const before = snapshotSig(data)
      const next = await loadCar()
      writeCache(next)
      setData(next)
      setMsg(`已更新 ${fmtTime(next.updatedAt)}`)
      ensureReference(next.model)
      // 车况完全没变就不重绘组件：页面反复打开时这是最常见的情况，
      // 省掉一次完整的组件进程渲染（建整棵视图树）比什么都省电。
      if (snapshotSig(next) !== before) reloadWidgets()
    } catch (e: any) {
      setTone('error')
      setMsg(`刷新失败：${e?.message || e}`)
      logError('页面刷新车况失败', e)
    } finally {
      setBusy(false)
      REFRESH_IN_FLIGHT = false
    }
  }

  // 只比对与本次指令相关的字段：updatedAt 每次都会变，不能直接比整个对象。
  // 传了 field 就只等这一项变化，避免别的字段抖动导致“刚下发就提前返回”。
  function stateSig(d: CarData | null, field?: keyof CarData): string {
    if (!d) return ''
    if (field) return JSON.stringify(d[field])
    return JSON.stringify([d.locked, d.engineOn, d.acOn, d.windows, d.carDoor])
  }
  // 指令下发成功后立刻拉一次车况，让按钮状态和卡片数据同步。
  // 车机回传有延迟：waitForState 为真且状态还没变时，每隔 1.2 秒重试，最多 3 次。
  // 回读一律走轻量模式：这几秒里车不可能挪位，没必要再拉定位、做逆地理编码
  // （省一整段网络往返，也不会唤醒系统定位）。
  async function syncAfterCommand(before: CarData | null, waitForState: boolean, field?: keyof CarData): Promise<void> {
    const baseline = stateSig(before, field)
    // 完整快照签名：轮询结束时若画面本来就没别处变化，就没必要再完整重绘一次组件。
    const snapshotBaseline = snapshotSig(before)
    // 要等的字段车机从来没上报过（如部分账号缺 window / ac）：等也等不到，
    // 只拉一次就收工，不然白跑两轮 light 请求（4 个 HTTP）还要多占两秒多“执行中”。
    const watchable = waitForState && (!field || (!!before && known(before, field)))
    const attempts = watchable ? 3 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const next = await loadCar({ light: true })
        writeCache(next)
        setData(next)
        if (stateSig(next, field) !== baseline) {
          // 状态确实变了才重绘组件：三次轮询里通常只有一次是真的变化，其余两次不必重载。
          reloadWidgets()
          return
        }
      } catch {
        // 回读失败不覆盖刚显示的执行结果，但缓存里已经是乐观写入后的状态：
        // 重绘一次至少让组件显示“指令已生效”，不然它会停在指令前的画面，直到下一次时间线刷新。
        reloadWidgets()
        return
      }
      if (attempt < attempts - 1) await new Promise<void>(resolve => setTimeout(resolve, 1200))
    }
    // 状态始终没变（车机没上报）：只有快照里别处确实有变化（地址 / 油量 / 胎压…）
    // 才重绘一次，完全没变时重绘出来的还是同一张图，纯浪费一次完整渲染。
    if (snapshotSig(readCache()) !== snapshotBaseline) reloadWidgets()
  }

  // 页面里的所有控车按钮都走这里：二次确认 → 下发指令 → 同步车况。
  // action 是控件动作（与组件意图一致），target 是执行后的目标状态。
  // waitForState：执行后车辆状态预期会变（锁/窗/启动/空调等）；寻车、尾门不会改这些上报状态，不用等。
  async function run(action: string, target: boolean, waitForState = true): Promise<void> {
    if (COMMAND_IN_FLIGHT) return
    // 优先用手里的内存数据：每次点击都去读一次钥匙串没必要（刷新期间也不会重复读）。
    if (!data?.machineId && !readCache()?.machineId) { setTone('error'); setMsg('请先刷新一次车况'); return }
    const command = commandFor(action, target, data?.accountId || readCache()?.accountId || '')
    // 所有车辆控制按钮都走这里，统一先弹二次确认，避免误触下发指令。
    // 确认框弹出期间同样占着入口锁：连点不会弹第二个框、也不会重复下发。
    COMMAND_IN_FLIGHT = true
    let ok = false
    try {
      ok = await Dialog.confirm({
        title: `确认执行「${command.label}」？`,
        message: '指令会立即下发到车辆，请确认车辆周围安全。',
        confirmLabel: '执行',
        cancelLabel: '取消',
      })
    } catch {
      ok = false
    }
    if (!ok) {
      COMMAND_IN_FLIGHT = false
      return
    }
    const before = data
    // 进度提示用去掉括号补充说明的短名（如“启动发动机中…”），弹窗标题仍用完整名称。
    const shortName = command.label.replace(/（[^）]*）/g, '')
    setBusy(true)
    setMsg(`${shortName}中…`)
    setTone('ok')
    try {
      // 复用组件意图的同一套下发逻辑：乐观写入状态、失败自动回滚。
      // 页面按钮没有槽位概念（slot: -1）：座椅加热挡位取 medium 里第一个座椅加热按钮的挡位。
      const text = await performControlAction({ action, target, machineId: '', size: 'medium', accountId: data?.accountId || readCache()?.accountId || '', slot: -1 })
      setMsg(text)
      // 座椅加热的回读已经在下发链路里做过（最多三次 light 轮询并写缓存），这里直接用缓存收尾，
      // 不再多发一轮网络：否则一次座椅加热最坏要跑 10 个 HTTP、占着“执行中”六秒。
      if (action === 'seat') {
        const cached = readCache()
        if (cached) setData(cached)
        if (snapshotSig(cached) !== snapshotSig(before)) reloadWidgets()
        return
      }
      await syncAfterCommand(before, waitForState, COMMAND_FIELD[action])
    } catch (e: any) {
      setTone('error')
      setMsg(`${shortName}失败：${e?.message || e}`)
    } finally {
      setBusy(false)
      COMMAND_IN_FLIGHT = false
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const error = tone === 'error'
  const windowsOpen = !!data && known(data, 'windows') && anyBitSet(data.windows)
  const warnings = data ? warningText(data) : []
  // 加满一箱金额的两个输入：车机上报的剩余油量与油箱容量，缺失时传 null，卡片会显示提示而不是 0。
  const oilLiters = data && known(data, 'oil') && Number.isFinite(data.oil) ? data.oil : null
  const tankLiters = data && Number.isFinite(data.oilBox) && data.oilBox > 0 ? data.oilBox : null
  // 油价卡片记忆：只有油价快照本身变化（卡片内部状态）或油量数据变化才重建卡片，
  // 页面刷新车况（锁车状态、里程、门窗等）时复用同一个元素，卡片保持上次的渲染结果。
  const oilCard = useMemo(
    () => (
      <OilPriceCard
        reloadToken={oilToken}
        remainingLiters={oilLiters}
        tankLiters={tankLiters}
        timeStyle={settings.updateTimeStyle}
        onRefuelPrice={setRefuelPrice}
      />
    ),
    [oilToken, oilLiters, tankLiters, settings.updateTimeStyle]
  )
  // 油耗样本由 fuel-economy 在每次真实采集车况时累积，油量变化或车况刷新后重读一次即可。
  const fuel = useMemo(() => fuelStats(oilLiters, data?.model), [oilLiters, data?.updatedAt, data?.model, fuelToken])
  // 每公里油费 = 百公里油耗 ÷ 100 × 加油油号折后单价（油价卡片回传）。任一项没有就不显示。
  const oilTypeShort = oilTypeOptionOf(readOilSettings().refuelType).shortLabel
  const perKmCost =
    fuel.l100km != null && fuel.l100km > 0 && refuelPrice != null && refuelPrice > 0
      ? (fuel.l100km / 100) * refuelPrice
      : null

  return (
    <NavigationStack>
      {/* 底色单独铺一层并忽略安全区，避免底部安全区露出系统白条（原来那截空白）。 */}
      <ZStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        <Rectangle fill="#F2F5FA" ignoresSafeArea />
        <VStack spacing={0} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        {/* 标题与三个圆形按钮固定在顶部，不随下方内容滚动。 */}
        <HStack alignment="center" spacing={8} padding={{ horizontal: 18, top: 32, bottom: 4 }}>
          <VStack alignment="leading" spacing={5}>
            <Text font={25} fontWeight="bold" foregroundStyle="#17243B">车辆中心</Text>
            <HStack spacing={5}>
              <Image systemName={error ? 'exclamationmark.circle.fill' : busy ? 'arrow.triangle.2.circlepath' : 'checkmark.circle.fill'} resizable scaleToFit foregroundStyle={error ? '#DC5B5B' : busy ? '#426FC5' : '#369A77'} frame={{ width: 11, height: 11 }} />
              <Text font={10.5} foregroundStyle={error ? '#B94C4C' : '#8490A4'} lineLimit={2}>{msg}</Text>
            </HStack>
          </VStack>
          <Spacer />
          {/* 入群 / 设置 / 刷新 / 关闭：入群先问群聊还是公众号。 */}
          <CircleButton action={showJoinPage} tone="tint" icon="person.badge.plus" tint="#426FC5" size={15} />
          <CircleButton action={customize} tone="tint" icon="slider.horizontal.3" tint="#426FC5" size={15} />
          <CircleButton action={() => refresh()} tone="tint" icon="arrow.triangle.2.circlepath" tint="#426FC5" size={15} />
          <CircleButton action={dismiss} tone="solid" icon="xmark" tint="#7E8A9F" size={11} />
        </HStack>

        <ScrollView scrollEdgeEffectHidden>
          <VStack alignment="leading" spacing={14} padding={{ horizontal: 18, top: 10, bottom: 18 }} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <ZStack alignment="topLeading" frame={{ maxWidth: 'infinity', minHeight: 160, maxHeight: 160 }}>
              <RoundedRectangle cornerRadius={22} fill={gradientOf(settings)} />
              <HStack frame={{ maxWidth: 'infinity', maxHeight: 'infinity', alignment: 'bottomTrailing' }} padding={{ trailing: 10, bottom: 30 }}>
                <Spacer />
                {useAudiLogoOf(settings)
                  ? <SVG code={audiLogoSVG(fontColorOf(settings, '#EAF0F8'))} resizable renderingMode="original" frame={logoSize} offset={{ x: LOGO_OFFSET_X, y: LOGO_OFFSET_Y }} />
                  : <Image filePath={carImagePath} resizable scaleToFit frame={{ width: Math.min(190 * centerScale, 260), height: Math.min(120 * centerScale, 140) }} offset={{ x: 0, y: 20 }} shadow={{ color: 'rgba(0,0,0,0.22)', radius: 5, x: 0, y: 3 }} />}
              </HStack>
              <VStack alignment="leading" spacing={0} padding={18} frame={{ maxWidth: 'infinity', maxHeight: 'infinity', alignment: 'topLeading' }}>
                <HStack>
                  <Text font={10} foregroundStyle="#AFBED8">我的座驾</Text>
                  <Spacer />
                  <HStack spacing={5}>
                    <Circle fill={data && known(data, 'online') && data.online ? '#6DDDB0' : '#A7B3CA'} frame={{ width: 5, height: 5 }} />
                    <Text font={10} foregroundStyle="#C9D4E6">{!data ? '待同步' : known(data, 'online') ? data.online ? '在线' : '离线' : '状态未知'}</Text>
                  </HStack>
                </HStack>
                <Text font={23} fontWeight="semibold" foregroundStyle="white" padding={{ top: 8 }} lineLimit={1}>
                  {settings.name.trim() || data?.model || '奥迪 A6L'}
                </Text>
                <Text font={11} foregroundStyle="#BCC9DE" padding={{ top: 5 }}>{data ? plateText(data, settings) : ''}</Text>
                <Spacer />
                <HStack spacing={6}>
                  <Image systemName={data && known(data, 'locked') && !data.locked ? 'lock.open' : 'lock'} resizable scaleToFit foregroundStyle={statusTint(data, '#85E4BC')} frame={{ width: 10, height: 10 }} />
                  <Text font={10} foregroundStyle={statusTint(data, '#C5D1E4')} lineLimit={1}>{data ? statusText(data) : '等待刷新车况'}</Text>
                </HStack>
              </VStack>
            </ZStack>

            <Panel>
              <VStack alignment="leading" spacing={14} padding={18} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
                <HStack spacing={16}>
                  <Metric icon="speedometer" label="累计里程" value={metricValue(data, 'mileage', 0)} unit="km" />
                  <Metric icon="fuelpump" label="剩余油量" value={metricValue(data, 'oil', 0)} unit="L" />
                </HStack>
                <Rectangle fill="#EEF1F6" frame={{ maxWidth: 'infinity', minHeight: 1, maxHeight: 1 }} />
                <HStack spacing={16}>
                  <Metric icon="drop.fill" label={fuel.source === 'reference' ? '参考油耗' : '平均油耗'} value={fuel.l100km === null ? '--' : fuel.l100km.toFixed(1)} unit="L/100km" />
                  <Metric icon="map.fill" label="预计续航" value={fuel.rangeKm === null ? '--' : fuel.rangeKm.toFixed(0)} unit="km" />
                </HStack>
                {perKmCost != null ? (
                  <Text font={9.5} foregroundStyle="#8490A4" lineLimit={2}>
                    {`每公里油费 ¥${moneyText(perKmCost)} · 按 ${oilTypeShort} ¥${moneyText(refuelPrice ?? 0)}/升 估算`}
                  </Text>
                ) : null}
                <Rectangle fill="#EEF1F6" frame={{ maxWidth: 'infinity', minHeight: 1, maxHeight: 1 }} />
                <HStack spacing={16}>
                  <Metric icon="battery.100percent" label="电瓶电压" value={metricValue(data, 'battery', 1)} unit="V" />
                  <Metric icon="thermometer.medium" label="车外温度" value={metricValue(data, 'outsideTemp', 0)} unit="°C" />
                </HStack>
              </VStack>
            </Panel>

            {centerAddressOf(settings) ? <LocationCard data={data} /> : null}

            {warnings.length > 0 ? (
              <Panel>
                <VStack alignment="leading" spacing={7} padding={14} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
                  <HStack spacing={6}>
                    <Image systemName="exclamationmark.triangle.fill" resizable scaleToFit foregroundStyle="#D97706" frame={{ width: 14, height: 14 }} />
                    <Text font={12} fontWeight="semibold" foregroundStyle="#92400E">车辆提醒</Text>
                  </HStack>
                  {warnings.map((warning, index) => (
                    <Text key={index} font={11} foregroundStyle="#7C5A1B" lineLimit={1}>· {warning}</Text>
                  ))}
                </VStack>
              </Panel>
            ) : null}

            {oilCard}

            <VStack alignment="leading" spacing={10} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
              <HStack spacing={10}>
                <ActionTile
                  id="lock"
                  state={data?.locked === true}
                  label={data?.locked ? '解锁' : '锁车'}
                  tint="#2563EB"
                  settings={settings}
                  action={() => run('lock', !data?.locked)}
                />
                <ActionTile
                  id="window"
                  state={windowsOpen}
                  label={windowsOpen ? '关窗' : '开窗'}
                  tint="#0EA5E9"
                  settings={settings}
                  action={() => run('window', !windowsOpen)}
                />
                <ActionTile
                  id="engine"
                  state={data?.engineOn === true}
                  label={data?.engineOn ? '熄火' : '启动'}
                  tint="#16A34A"
                  settings={settings}
                  action={() => run('engine', !data?.engineOn)}
                />
              </HStack>
              <HStack spacing={10}>
                <ActionTile
                  id="find"
                  state={false}
                  label="寻车"
                  tint="#F59E0B"
                  settings={settings}
                  action={() => run('find', false, false)}
                />
                <ActionTile
                  id="ac"
                  state={data?.acOn === true}
                  label={data?.acOn ? '关空调' : '开空调'}
                  tint="#7C3AED"
                  settings={settings}
                  action={() => run('ac', !data?.acOn)}
                />
                <ActionTile
                  id="trunk"
                  state={data ? trunkOpen(data) : false}
                  label="尾门"
                  tint="#4F46E5"
                  settings={settings}
                  action={() => run('trunk', data ? !trunkOpen(data) : true, false)}
                />
              </HStack>
              <HStack spacing={10}>
                <ActionTile
                  id="cool"
                  state={false}
                  label={'冷车 ' + engineMinutes('cool') + ' 分钟'}
                  tint="#0284C7"
                  settings={settings}
                  action={() => run('cool', false)}
                />
                <ActionTile
                  id="hot"
                  state={false}
                  label={'热车 ' + engineMinutes('hot') + ' 分钟'}
                  tint="#EA580C"
                  settings={settings}
                  action={() => run('hot', false)}
                />
              </HStack>
            </VStack>

            <Text font={10} foregroundStyle="#9CA7B8" frame={{ maxWidth: 'infinity', alignment: 'center' }} padding={{ top: 2 }} lineLimit={2}>
              {providerLabel} · 车况与小组件同步更新
            </Text>
          </VStack>
        </ScrollView>
        </VStack>
      </ZStack>
    </NavigationStack>
  )
}

async function main() {
  const parameters = Script.queryParameters || {}
  // 内置车图先下到临时目录再开页：`Image filePath` 只认本地文件，没下完就是空图。
  // 命中缓存（一周内）时不联网，不影响启动速度。
  await prepareDefaultCar()
  await Navigation.present({ element: Object.prototype.hasOwnProperty.call(parameters, 'confirmAction') ? <CommandConfirmation parameters={parameters} /> : <App /> })
  Script.exit()
}

main().catch(e => {
  logError('页面启动失败', e)
  Script.exit(String(e))
})
