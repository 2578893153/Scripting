import {
  Widget,
  SVG,
  VStack,
  HStack,
  ZStack,
  Text,
  Image,
  Spacer,
  Capsule,
  RoundedRectangle,
  Button,
  Link,
  Script,
} from 'scripting'
import type { Color } from 'scripting'
import { loadCar, writeCache, readCache, type CarData } from './api'
import { BeginConfirmationIntent, CancelConfirmationIntent, SubmitConfirmationIntent, ACIntent, SeatIntent, TrunkIntent, CoolIntent, HotIntent, FindIntent, EngineIntent, LockIntent, RefreshIntent, WindowIntent } from './app_intents'

import { readSettingsForSize, widgetSizeFor, infoBackgroundOf, visibleButtons, fontSizeOf, fontColorOf, buttonBackgroundOf, buttonHeightOf, buttonIconColorOf, buttonIconLineWidthOf, buttonIconSizeOf, carScaleOf, backgroundDimOf, barSizeOf, buttonRadiusOf, imagePath, gradientOf, plateText, reminderLines, themeOf } from './settings'
import { prepareDefaultCar } from './car-asset'
import { buttonIconSVG, isButtonLit, isVehicleIcon } from './button-icons'
import { ButtonGlyph } from './button-glyph'
import { weatherAt, readWeatherCache, type WeatherInfo } from './weather'
import { updateText, supportsTires } from './credentials'
import { armConfirmationWindow, CONFIRM_SECONDS, readWidgetConfirmation, recentlyFinishedConfirmation, type WidgetConfirmation } from './widget-confirmation'
import { requestedCommand } from './command-confirmation'
import { statusTint, needsAttention, trunkOpen, bodyWarnings } from './vehicle-state'
import { dashboardLayout, known, anyBitSet, metricItems, stateItems, tireItems, parkingText, engineText } from './dashboard-model'
import { logError } from './log'
// Widget.displaySize 在一次渲染内是常量，读一次缓存起来，
// 避免各个分区反复访问原生属性、也避免多处的默认值分叉。
const DISPLAY = (() => {
  const s: any = Widget.displaySize
  return { width: s?.width || 338, height: s?.height || 158 }
})()
function displaySize() {
  return DISPLAY
}
const widgetSize = widgetSizeFor(String(Widget.family), DISPLAY.width, DISPLAY.height)
// 只读一次存储、只归一化本尺寸这一份配置（原来是 6 遍）。
const settings = readSettingsForSize(widgetSize)
const BUTTONS = visibleButtons(settings)
// 读钥匙串是本组件渲染里最慢的一步，而确认页、小号都不显示胎压：改成用到时才读一次
// （同一进程内仍然只读一次，与原行为一致）。
let tiresSupported: boolean | undefined
function hasTires() {
  if (tiresSupported === undefined) tiresSupported = supportsTires()
  return tiresSupported
}
let CAR_IMAGE_PATH = imagePath(settings)
// 小号右上角的天气（iOS 自带天气的当前状况），在 main 里取好后供 smallBody 使用。
let WEATHER: WeatherInfo | null = null
const OPEN_URL = Script.createRunSingleURLScheme(Script.name)
// 一次渲染只取一次当前时间：各处计时与指令时间戳复用同一基准。
const NOW = Date.now()
// 关掉自动刷新后依然按 refreshMinutes 请求下一次重载，是最耗电的一步：
// 每次重载都要把整个 JS 模块从头跑一遍（读设置、查文件、建视图树）。
// 这里改成 6 小时兜底一次，App 内改设置 / 点刷新都会立刻 Widget.reloadAll()，不会被拖慢。
const IDLE_RELOAD_MINUTES = 6 * 60
const REFRESH_TOLERANCE = 2 * 60 * 1000
// 组件渲染有时间预算：自动刷新一旦碰上慢网（单请求超时就 12 秒），系统会直接放弃这一帧，
// 用户看到的是白屏或旧占位。给网络刷新封一个上限，超时就用现有快照画，不让白屏。
const REFRESH_BUDGET_MS = 5000
// 天气只画一枚图标和一个温度：缓存过期要重新请求时最多再等这么久，
// 赶不上就先用手上这份旧值出画面（下一轮重载再更新），不让 WeatherKit 把整屏拖住。
const WEATHER_WAIT_MS = 700
function weatherWithin(task: Promise<WeatherInfo | null>, fallback: WeatherInfo | null): Promise<WeatherInfo | null> {
  let timer: any
  const limit = new Promise<WeatherInfo | null>(resolve => { timer = setTimeout(() => resolve(fallback), WEATHER_WAIT_MS) })
  return Promise.race([task, limit]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
function loadCarWithin(ms: number): Promise<CarData> {
  let timer: any
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('refresh timeout')), ms)
  })
  return Promise.race([loadCar(), timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
const NEXT_RELOAD = new Date(NOW + (settings.autoRefresh ? settings.refreshMinutes : IDLE_RELOAD_MINUTES) * 60 * 1000)
const BG = 'clear'
// 车名只 trim 一次（settings 是本进程内的常量），不再每次绘制都新建字符串。
const CAR_NAME = settings.name.trim()
const accent = themeOf(settings).accent
const BUTTON_H = buttonHeightOf(settings)

function title(d: CarData): string {
  return CAR_NAME || d.model || d.plate || '我的座驾'
}

function statsText(d: CarData): string {
  // 0 也是真实数据（里程归零 / 油箱见底），只有字段没上报时才用 --。
  const km = known(d, 'mileage') ? `${d.mileage.toFixed(0)}km` : '--km'
  const oil = known(d, 'oil') ? `${d.oil.toFixed(0)}L` : '--L'
  const volt = known(d, 'battery') ? `${d.battery.toFixed(1)}V` : '--V'
  return `${km} ￨ ${oil} ￨ ${volt}`
}

// 小尺寸卡片的状态行：字段没上报时明说“未知”，不要把默认 false 说成“未锁车 / 已熄火”。
function stateText(d: CarData): string {
  const lock = known(d, 'locked') ? d.locked ? '已锁车' : '未锁车' : '车锁未知'
  const engine = known(d, 'engineOn') ? d.engineOn ? '发动机运行' : '已熄火' : '启动未知'
  return `${lock} · ${engine}`
}

function addressText(d: CarData): string {
  return settings.showAddress ? d.addressShort || d.address || '位置待刷新' : settings.quote
}

function windowsOpen(d: CarData): boolean {
  return Array.isArray(d.windows) && d.windows.some(v => v !== 0)
}
type WarningItem = { icon: string; label: string; tint: Color }

function warningItems(d: CarData): WarningItem[] {
  const items: WarningItem[] = []
  // 位图字段统一解析：原来的 includes('1') 会把 10、12 这类数值误判成“已开启”。
  if (known(d, 'carLamp') && anyBitSet(d.carLamp)) items.push({ icon: 'headlight.low.beam', label: '车灯未关', tint: '#FBBF24' })
  // 车门、尾门、机盖分别解析，避免把尾门 / 机盖误报成乘员车门。
  items.push(...bodyWarnings(d))
  if (known(d, 'windows') && windowsOpen(d)) items.push({ icon: 'car.window.right.badge.exclamationmark', label: '车窗未关', tint: '#FB923C' })
  if (known(d, 'heatSeat') && anyBitSet(d.heatSeat)) items.push({ icon: 'carseat.left.and.heat.waves', label: '座椅加热', tint: '#F97316' })
  if (known(d, 'waterTemperature') && d.waterTemperature > 110 && d.engineOn) items.push({ icon: 'thermometer.and.liquid.waves', label: '水温偏高', tint: '#EF4444' })
  if (known(d, 'fuelPct') && d.fuelPct < 10) items.push({ icon: 'fuelpump', label: '油量过低', tint: '#FBBF24' })
  if (known(d, 'battery') && d.battery > 0 && d.battery < 11.8) items.push({ icon: 'minus.plus.batteryblock.exclamationmark', label: '电压偏低', tint: '#EF4444' })
  return items
}

// 告警行里自绘 SVG 与 SF Symbol 必须占同一个正方形：
// SVG 用 tight 视框（图形铺满方框），SF Symbol 用 scaleToFit 吃满同一 frame。
// 告警行的 9 枚图标要看起来粗细一致：7 枚是 SF Symbol（系统粗细固定，不跟设置走），
// 所以 2 枚自绘（车门 / 尾门）也必须用固定线宽，不能读「图标线条粗细」设置，否则一改设置就对不上。
const WARNING_ICON_LINE_WIDTH = 1.7
// 告警行里 SF Symbol / 自绘 SVG 的内边距各不相同，框一样大也不等于视觉一样大。
// 用户逐枚盯出来的：第 1 枚（车灯）、第 2 枚（车门）、第 5 枚（车窗）放大到 108%；
// 第 3 枚（尾门）、第 4 枚（机盖）、第 8 枚（油量）缩小到 90%。未列出的图标保持 1。
// 只缩放图形本身，外层 frame 跟看最大的一边，整行间距 / 对齐不受影响。
const WARNING_ICON_SCALE: Record<string, number> = {
  'headlight.low.beam': 1.16,
  door: 1.08,
  'car.window.right.badge.exclamationmark': 1.08,
  trunk: 0.9,
  'car.side.front.open.crop': 0.9,
  fuelpump: 0.9,
}
function warningIcon(item: WarningItem, size: number) {
  const scale = WARNING_ICON_SCALE[item.icon] || 1
  // 放大时外层也跟着长，避开固定方框把图形裁掉一辮的风险。
  const slot = size * Math.max(1, scale)
  const box = { width: slot, height: slot }
  const glyph = { width: size * scale, height: size * scale }
  return <HStack frame={box}>
    {isVehicleIcon(item.icon)
      ? <SVG code={buttonIconSVG(item.icon, true, String(item.tint), WARNING_ICON_LINE_WIDTH, true)} resizable renderingMode="original" frame={glyph} />
      : <Image systemName={item.icon} resizable scaleToFit fontWeight="regular" foregroundStyle={item.tint} frame={glyph} />}
  </HStack>
}
function warningRow(items: WarningItem[], compact = false) {
  if (!settings.showIcons || items.length === 0) return null
  // 9 条告警全部显示：中号图标 12pt、小号经典 10pt，实拍均不溢出（间距 5 就是留的余量）。
  return (
    <HStack spacing={5} padding={{ top: compact ? 2 : 4 }} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
      {items.map(item => (
        <HStack spacing={2} key={item.label}>
          {warningIcon(item, compact ? 10 : 12)}
          {!compact && settings.showStateText && items.length === 1 ? <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={item.tint} lineLimit={1}>{item.label}</Text> : null}
        </HStack>
      ))}
    </HStack>
  )
}

// 同一份 CarData 在一次渲染里会被好几个分区读取（车窗 / 尾门 / 告警行），
// 以对象身份为键缓存，只算一次；模块随每次渲染重建，缓存跟着一起消失。
// 三项各用一枚缓存：只画告警行的尺寸不必顺带算车窗和尾门。
const windowsCache = new WeakMap<CarData, boolean>()
const trunkCache = new WeakMap<CarData, boolean>()
const warningsCache = new WeakMap<CarData, WarningItem[]>()
function windowsOf(d: CarData): boolean {
  const hit = windowsCache.get(d)
  if (hit !== undefined) return hit
  const value = windowsOpen(d)
  windowsCache.set(d, value)
  return value
}
function trunkOf(d: CarData): boolean {
  const hit = trunkCache.get(d)
  if (hit !== undefined) return hit
  const value = trunkOpen(d)
  trunkCache.set(d, value)
  return value
}
function warningsOf(d: CarData): WarningItem[] {
  const hit = warningsCache.get(d)
  if (hit) return hit
  const value = warningItems(d)
  warningsCache.set(d, value)
  return value
}

// 同步判断文件是否存在：渲染前只需一次本地查证，同步版本可省掉两次 async 往返。
function fileExists(path: string): boolean {
  try { return !!FileManager.existsSync(path) } catch { return false }
}

function fuelBar(d: CarData, width: number, height: number) {
  const w = Math.max(8, width), h = Math.max(2, height)
  // 字段没上报时不画绿色进度：默认值 0 会画出一小截假油量。
  if (!known(d, 'fuelPct') || !Number.isFinite(d.fuelPct)) {
    return (
      <ZStack alignment="leading" frame={{ width: w, height: h }}>
        <Capsule fill="rgba(255,255,255,0.18)" frame={{ width: w, height: h }} />
      </ZStack>
    )
  }
  const pct = Math.max(0.025, Math.min(1, d.fuelPct / 100))
  return (
    <ZStack alignment="leading" frame={{ width: w, height: h }}>
      <Capsule fill="rgba(255,255,255,0.18)" frame={{ width: w, height: h }} />
      <Capsule fill="#5CD98F" frame={{ width: w * pct, height: h }} />
    </ZStack>
  )
}

function ControlButton({ intent, confirmationIntent, frame, children }: { intent: any; confirmationIntent?: any; frame: any; children: any }) {
  return <Button intent={confirmationIntent || intent} buttonStyle="plain" frame={frame}>{children}</Button>
}
// 图标边长：先按按钮可用空间算出基准（11–20），再乘本尺寸的“图标大小”百分比；
// 放大后仍夹在按钮里（上下留 6pt、左右留 8pt），所以拉到 200% 也不会顶出边框。
function iconSizeOf(height: number, width: number) {
  const base = Math.min(20, Math.max(11, Math.min(height * 0.6, width - 9))) * buttonIconSizeOf(settings) / 100
  return Math.round(Math.min(Math.max(base, 9), height - 6, width - 8))
}
function actionIcon(id: string, state: boolean, size: number) {
  // 未激活 = 白，激活 = 橙，都在设置里可改（默认值见 settings.ts 的 ICON_IDLE_COLOR / ICON_ACTIVE_COLOR）。
  // 一键动作（寻车 / 刷新 / 冷车 / 热车）只有一枚图标、没有开关两态，state 恒为 false，所以永远是未激活色。
  // 颜色是否点亮走 isButtonLit（锁车反着来：没锁才点亮），形状仍由 state 决定，两者分开。
  return <ButtonGlyph id={id} state={state} color={buttonIconColorOf(settings, isButtonLit(id, state))} lineWidth={buttonIconLineWidthOf(settings)} size={size} />
}
// 车辆图片：组件里始终显示所选车辆照片（奥迪 Logo 只用在车辆中心主页）。
function carMark(width: number, height: number, offsetY = 0) {
  return <Image filePath={CAR_IMAGE_PATH} resizable scaleToFit frame={{ width, height }} offset={{ x: 0, y: offsetY }} shadow={{ color: 'rgba(0,0,0,0.34)', radius: 4, x: 0, y: 2 }} />
}
// 车辆图片：点一下直接更新车况（刷新），不跳转
function refreshTap(d: CarData, children: any) {
  return <Button intent={RefreshIntent({ accountId: d.accountId, machineId: d.machineId, size: widgetSize })} buttonStyle="plain">{children}</Button>
}
// 除车辆图片以外的区域：正常跳转进 App 的车辆中心页面
function tapToApp(children: any) {
  return <Link url={OPEN_URL}>{children}</Link>
}
// 小 / 中尺寸共用的底部控制按钮（原来 mediumButton 与 smallButton 完全相同，已合并）。
function controlButton(width: number, id: string, state: boolean, intent: any, confirmationIntent?: any) {
  const height = BUTTON_H
  return (
    <ControlButton intent={intent} confirmationIntent={confirmationIntent} frame={{ width, height }}>
      <ZStack frame={{ width, height }}>
        <RoundedRectangle cornerRadius={buttonRadiusOf(settings, height)} fill={buttonBackgroundOf(settings)} frame={{ width, height }} />
        {actionIcon(id, state, iconSizeOf(height, width))}
      </ZStack>
    </ControlButton>
  )
}
// 小 / 中 / 环形三种尺寸的底部按钮行完全同构，抽出来只写一次。
function controlRow(d: CarData, gap: number, buttonWidth: number, frame: any = { maxWidth: 'infinity' }) {
  return (
    <HStack spacing={gap} frame={frame}>
      {BUTTONS.map((id, index) => {
        if (id === 'blank') return <Spacer key={index} frame={{ width: buttonWidth, height: BUTTON_H }} />
        const action = buttonAction(id, d, index)
        return <HStack key={index} spacing={0}>{controlButton(buttonWidth, id, action.state, action.intent, action.confirmationIntent)}</HStack>
      })}
    </HStack>
  )
}


function mediumBody(d: CarData) {
  const widgetWidth = displaySize().width
  const onlineKnown = known(d, 'online')
  const buttonGap = BUTTONS.length >= 6 ? 5 : 6
  const buttonWidth = (widgetWidth - 26 - buttonGap * (BUTTONS.length - 1)) / BUTTONS.length
  const scale = carScaleOf(settings)
  const carWidth = Math.min(104 * scale, widgetWidth * 0.43)
  const contentWidth = widgetWidth - 26 - carWidth - 8
  const bar = barSizeOf(settings)
  const barWidth = Math.min(bar.width, contentWidth)
  const warnings = warningsOf(d)
  return (
    <VStack alignment="leading" spacing={0} padding={{ horizontal: 13, top: 12, bottom: 10 }} background={BG} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
      <HStack alignment="top" spacing={8} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
        {tapToApp(
          <VStack alignment="leading" spacing={4} frame={{ width: contentWidth, alignment: 'leading' }}>
            <HStack spacing={8} frame={{ width: contentWidth, alignment: 'leading' }}>
              <Text font={fontSizeOf(settings, 19)} fontWeight="bold" foregroundStyle={fontColorOf(settings, 'white')} lineLimit={1} minScaleFactor={0.72}>{title(d)}</Text>
              <Text font={fontSizeOf(settings, 9)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.58)')} lineLimit={1}>{plateText(d, settings)}</Text>
            </HStack>
            {settings.hideLocationRow ? null : <Text font={fontSizeOf(settings, 10)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.9)')} lineLimit={1} minScaleFactor={0.8}>{addressText(d)}</Text>}
            <Text font={fontSizeOf(settings, 11)} fontWeight="semibold" foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.98)')} lineLimit={1} minScaleFactor={0.7}>{statsText(d)}</Text>
            <HStack padding={{ top: Math.max(1, Math.round((bar.height - 3) / 2)) }}>
              {fuelBar(d, barWidth, bar.height)}
            </HStack>
            <Text font={fontSizeOf(settings, 9.5)} fontWeight="medium" foregroundStyle={statusTint(d, onlineKnown && !d.online ? '#FCA5A5' : fontColorOf(settings, 'rgba(255,255,255,0.7)'))} lineLimit={1}>{stateText(d)}</Text>
            {warningRow(warnings)}
          </VStack>
        )}
        <VStack alignment="trailing" spacing={scale > 1 ? 4 : 12} frame={{ width: carWidth, alignment: 'trailing' }}>
          {settings.showWeather || settings.showTemp ? <HStack spacing={6}>
            {settings.showWeather ? weatherIcon(10, 'rgba(255,255,255,0.68)') : null}
            {settings.showTemp ? <Text font={fontSizeOf(settings, 9)} fontWeight="medium" foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.82)')}>{outsideTempText(d)}</Text> : null}
          </HStack> : null}
          {refreshTap(d, carMark(carWidth, Math.min(56 * scale, 72), 6))}
          <Text font={fontSizeOf(settings, 7.5)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.55)')} lineLimit={1} minScaleFactor={0.65}>{updateText(d.updatedAt, NOW, settings.updateTimeStyle)}</Text>
        </VStack>
      </HStack>

      <Spacer />

      {controlRow(d, buttonGap, buttonWidth)}
    </VStack>
  )
}

// 车外温度优先（车机上报的才是车实际所处的温度）；拿不到时退回手机天气的温度，别留空。
// 必须判 known：车机没上报时 outsideTemp 是 0（有限数），直接用 isFinite 会永远显示 0°C。
function outsideTempText(d: CarData): string {
  if (known(d, 'outsideTemp') && Number.isFinite(d.outsideTemp)) return `${d.outsideTemp.toFixed(0)}°C`
  if (WEATHER && Number.isFinite(WEATHER.temp)) return `${WEATHER.temp.toFixed(0)}°C`
  return ''
}
// 天气图标：符号随 iOS 天气变化；尺寸按各组件排版权重微调。
function weatherIcon(size: number, color: string) {
  return <Image systemName={WEATHER?.symbol || 'cloud.fill'} resizable scaleToFit foregroundStyle={fontColorOf(settings, color)} frame={{ width: size, height: size }} />
}
// 天气图标 + 车外温度：小号与环形两套排版共用这一行（同一套字号与颜色）。
function weatherRow(d: CarData) {
  if (!settings.showWeather && !settings.showTemp) return null
  return <HStack alignment="center" spacing={3}>
    {settings.showWeather ? weatherIcon(9, 'rgba(255,255,255,0.78)') : null}
    {settings.showTemp ? <Text font={fontSizeOf(settings, 10)} fontWeight="medium" foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.84)')}>{outsideTempText(d).replace(/°C$/, '°')}</Text> : null}
  </HStack>
}
function smallBody(d: CarData) {
  const { width: widgetWidth, height: widgetHeight } = displaySize()
  const onlineKnown = known(d, 'online')
  const buttonGap = BUTTONS.length >= 6 ? 3 : 4
  const plate = plateText(d, settings)
  const buttonWidth = (widgetWidth - 22 - buttonGap * (BUTTONS.length - 1)) / BUTTONS.length
  const warnings = warningsOf(d)
  const hasWarnings = warnings.length > 0 && settings.showIcons
  const scale = carScaleOf(settings)
  const enlarged = scale > 1
  const imageHeight = Math.min((hasWarnings ? 22 : 35) * scale, (hasWarnings ? 34 : 48) + Math.max(0, widgetHeight - 158))
  return (
    <VStack alignment="leading" spacing={0} padding={{ horizontal: 11, top: enlarged ? 8 : 10, bottom: enlarged ? 7 : 9 }} background={BG} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
      {tapToApp(
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: 'infinity' }}>
          <HStack alignment="center" spacing={5} frame={{ maxWidth: 'infinity' }}>
            <VStack alignment="leading" spacing={1} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
              <Text font={fontSizeOf(settings, 15.5)} fontWeight="bold" foregroundStyle={fontColorOf(settings, 'white')} lineLimit={1} minScaleFactor={0.76} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{title(d)}</Text>
              <HStack spacing={4} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
                {plate ? <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.52)')} lineLimit={1}>{plate}</Text> : null}
                <Text font={fontSizeOf(settings, 8)} foregroundStyle={!onlineKnown ? fontColorOf(settings, '#A3B4CD') : d.online ? fontColorOf(settings, '#86EFAC') : '#FCA5A5'} lineLimit={1}>{!onlineKnown ? '状态未知' : d.online ? '在线' : '离线'}</Text>
              </HStack>
            </VStack>
            {weatherRow(d)}
          </HStack>
          {settings.hideLocationRow ? null : <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.76)')} padding={{ top: enlarged ? 2 : 4 }} lineLimit={1} minScaleFactor={0.62} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{addressText(d)}</Text>}
          <HStack spacing={3} padding={{ top: 2 }} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <Text font={fontSizeOf(settings, 8)} foregroundStyle={statusTint(d, !onlineKnown ? fontColorOf(settings, 'rgba(255,255,255,0.7)') : d.online ? fontColorOf(settings, 'rgba(134,239,172,0.86)') : '#FCA5A5')} lineLimit={1} minScaleFactor={0.65} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{stateText(d)}</Text>
            <Text font={fontSizeOf(settings, 7)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.5)')} lineLimit={1} minScaleFactor={0.65}>{updateText(d.updatedAt, NOW, settings.updateTimeStyle)}</Text>
          </HStack>
          <Text font={fontSizeOf(settings, 9.5)} fontWeight="semibold" foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.94)')} padding={{ top: enlarged ? 1 : 3 }} lineLimit={1} minScaleFactor={0.62} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{statsText(d)}</Text>
          {warningRow(warnings, true)}
        </VStack>
      )}
      {refreshTap(d,
        <ZStack alignment="bottom" frame={{ width: widgetWidth - 22, height: imageHeight + 3 }} padding={{ top: enlarged ? 1 : 3 }}>
          {carMark(Math.min(90 * scale, widgetWidth - 22), imageHeight)}
        </ZStack>
      )}

      <Spacer />

      {controlRow(d, buttonGap, buttonWidth)}
    </VStack>
  )
}

function EmptyView() {
  return (
    <VStack alignment="leading" spacing={7} padding={14} background={BG} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
      <Text font={fontSizeOf(settings, 17)} fontWeight="bold" foregroundStyle={fontColorOf(settings, 'white')}>车况</Text>
      <Text font={fontSizeOf(settings, 11)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.72)')} lineLimit={3}>
        还没有数据。点这里打开控制页，在个性化设置中填写 Token 后刷新车况。
      </Text>
      <Spacer />
      <Image systemName="chevron.right.circle.fill" foregroundStyle="rgba(255,255,255,0.5)" frame={{ width: 18, height: 18 }} />
    </VStack>
  )
}


function buttonAction(id: string, d: CarData, slot: number) {
  const action = directButtonAction(id, d, slot)
  const confirmationIntent = settings.buttonConfirmations[slot] === true ? BeginConfirmationIntent({
    confirmAccount: d.accountId, confirmAction: id, confirmTarget: action.target ? '1' : '0', confirmVehicle: d.machineId || '', confirmSize: widgetSize,
    confirmSlot: slot, id: NOW.toString(36) + '-' + Math.random().toString(36).slice(2), issuedAt: NOW,
  }) : undefined
  return { ...action, confirmationIntent }
}
/** 每个按钮的当前状态、下一步目标值、标题与意图；target 与 intent 里的入参必须一致。 */
function directButtonAction(id: string, d: CarData, slot: number) {
  // slot 跟着意图走：座椅加热的挡位是按按钮槽位各存一份的，不传就取不到这个按钮的挡位。
  const binding = { accountId: d.accountId, machineId: d.machineId, size: widgetSize, slot }
  const windowsAreOpen = windowsOf(d), trunkIsOpen = trunkOf(d)
  switch (id) {
    case 'lock': return { state: d.locked === true, target: !d.locked, label: d.locked ? '解锁' : '锁车', intent: LockIntent({ ...binding, locked: !d.locked }) }
    case 'window': return { state: windowsAreOpen, target: !windowsAreOpen, label: windowsAreOpen ? '关窗' : '开窗', intent: WindowIntent({ ...binding, open: !windowsAreOpen }) }
    case 'engine': return { state: d.engineOn === true, target: !d.engineOn, label: d.engineOn ? '熄火' : '启动', intent: EngineIntent({ ...binding, start: !d.engineOn }) }
    case 'find': return { state: false, target: false, label: '寻车', intent: FindIntent(binding) }
    case 'cool': return { state: false, target: false, label: '冷车', intent: CoolIntent(binding) }
    case 'hot': return { state: false, target: false, label: '热车', intent: HotIntent(binding) }
    case 'ac': return { state: d.acOn === true, target: !d.acOn, label: d.acOn ? '关空调' : '开空调', intent: ACIntent({ ...binding, on: !d.acOn }) }
    // 座椅加热：heatSeat 位串只要有一位非 0 就算已开启；下发 CMD_HEATSEAT（开启 flag 1 + 设置里的挡位，关闭 flag 0 + type 0）。
    case 'seat': { const heatOn = anyBitSet(d.heatSeat); return { state: heatOn, target: !heatOn, label: heatOn ? '关加热' : '开加热', intent: SeatIntent({ ...binding, on: !heatOn }) } }
    // 尾门：carDoor 第 9 位为 1 表示已开。
    case 'trunk': return { state: trunkIsOpen, target: !trunkIsOpen, label: trunkIsOpen ? '关尾门' : '开尾门', intent: TrunkIntent({ ...binding, open: !trunkIsOpen }) }
    default: return { state: false, target: false, label: '刷新', intent: RefreshIntent(binding) }
  }
}
function ringBody(d: CarData) {
  const { width, height } = displaySize()
  const pad = 9, gap = 3, innerWidth = width - pad * 2
  const titleHeight = Math.ceil(fontSizeOf(settings, 14) * 1.25)
  const stateHeight = Math.ceil(fontSizeOf(settings, 8) * 1.3)
  const timeHeight = Math.ceil(fontSizeOf(settings, 7) * 1.3)
  const detailsHeight = stateHeight + timeHeight + 2
  const buttonHeight = BUTTON_H
  const mainHeight = Math.max(1, height - pad * 2 - titleHeight - detailsHeight - buttonHeight - gap * 3)
  const diameter = Math.min(mainHeight, innerWidth * 0.47, 88)
  const carWidth = innerWidth - diameter - 7
  const buttonWidth = (innerWidth - 4 * (BUTTONS.length - 1)) / BUTTONS.length
  const scale = carScaleOf(settings)
  const available = known(d, 'fuelPct') && Number.isFinite(d.fuelPct)
  const pct = available ? Math.max(0, Math.min(100, d.fuelPct)) : 0
  const length = 2 * Math.PI * 44
  const color = available && pct < 20 ? '#FBBF24' : accent
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="5"/>' + (available && pct > 0 ? '<circle cx="50" cy="50" r="44" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + (length * pct / 100) + ' ' + length + '" transform="rotate(-90 50 50)"/>' : '') + '</svg>'
  const info = metricItems(d, [settings.smallRingInfo])[0]
  const infoText = info ? `${settings.smallRingInfo === 'oil' ? '剩余' : info.label} ${info.value}${info.unit ? ' ' + info.unit : ''}` : ''
  return <VStack spacing={gap} padding={pad} frame={{ width, height }}>
    {tapToApp(<HStack spacing={4} frame={{ width: innerWidth, height: titleHeight }}>
      <Text font={fontSizeOf(settings, 14)} fontWeight="bold" foregroundStyle={fontColorOf(settings, 'white')} lineLimit={1} minScaleFactor={0.65} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{title(d)}</Text>
      {weatherRow(d)}
    </HStack>)}
    <HStack spacing={7} frame={{ width: innerWidth, height: mainHeight }}>
      {tapToApp(<ZStack frame={{ width: diameter, height: diameter }}>
        <SVG code={svg} resizable renderingMode="original" frame={{ width: diameter, height: diameter }} />
        <VStack spacing={1} frame={{ width: diameter * 0.7 }}>
          <Text font={fontSizeOf(settings, 17)} fontWeight="semibold" foregroundStyle={fontColorOf(settings, color)} lineLimit={1} minScaleFactor={0.55}>{available ? `${pct.toFixed(0)}%` : '--'}</Text>
          <Text font={fontSizeOf(settings, 6.5)} foregroundStyle={fontColorOf(settings, '#A3B4CD')} lineLimit={1} minScaleFactor={0.6}>燃油余量</Text>
        </VStack>
      </ZStack>)}
      <VStack spacing={4} frame={{ width: carWidth, height: mainHeight }}>
        {refreshTap(d, carMark(Math.min(carWidth, carWidth * 0.94 * scale), Math.min(mainHeight * 0.65, mainHeight * 0.48 * scale)))}
        {info ? tapToApp(<Text font={fontSizeOf(settings, 8)} foregroundStyle={info.alert ? '#FB923C' : fontColorOf(settings, '#C3D1E4')} lineLimit={1} minScaleFactor={0.65}>{infoText}</Text>) : null}
      </VStack>
    </HStack>
    {tapToApp(<VStack spacing={2} frame={{ width: innerWidth, height: detailsHeight }}>
      <HStack spacing={4} frame={{ width: innerWidth, height: stateHeight }}>
        <Text font={fontSizeOf(settings, 8)} foregroundStyle={statusTint(d, fontColorOf(settings, 'rgba(255,255,255,0.76)'))} lineLimit={1} minScaleFactor={0.65}>{stateText(d)}</Text>
        {settings.showIcons ? warningsOf(d).slice(0, 2).map(item => <HStack key={item.label} spacing={0}>{warningIcon(item, 9)}</HStack>) : null}
      </HStack>
      <Text font={fontSizeOf(settings, 7)} foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.5)')} lineLimit={1} minScaleFactor={0.65} frame={{ width: innerWidth, height: timeHeight }}>{updateText(d.updatedAt, NOW, settings.updateTimeStyle)}</Text>
    </VStack>)}
    {controlRow(d, 4, buttonWidth, { width: innerWidth, height: buttonHeight })}
  </VStack>
}
function dashboardPanel(children: any, width: number, height: number, padding = 10) {
  return <ZStack frame={{ width, height }}>
    <RoundedRectangle cornerRadius={12} fill={infoBackgroundOf(settings)} frame={{ width, height }} />
    <VStack alignment="center" spacing={3} padding={padding} frame={{ width, height, alignment: 'center' }}>{children}</VStack>
  </ZStack>
}
function dashboardHeader(d: CarData, width: number, height: number) {
  const plate = plateText(d, settings)
  // 在线状态未上报时用灰色 + “未知”，不能当成离线报红。
  const onlineKnown = known(d, 'online')
  const onlineText = onlineKnown ? d.online ? '车辆在线' : '车辆离线' : '在线状态未知'
  const onlineColor = onlineKnown ? d.online ? fontColorOf(settings, '#9AE6CB') : '#FCA5A5' : fontColorOf(settings, '#A3B4CD')
  return tapToApp(<HStack spacing={6} frame={{ width, height }}>
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
      <Text font={fontSizeOf(settings, height < 40 ? 19 : 23)} fontWeight="bold" foregroundStyle={fontColorOf(settings, 'white')} lineLimit={1} minScaleFactor={0.7}>{title(d)}</Text>
      {plate ? <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={fontColorOf(settings, '#A3B4CD')} lineLimit={1}>{plate}</Text> : null}
    </VStack>
    <VStack alignment="trailing" spacing={2}>
      <Text font={fontSizeOf(settings, 9)} foregroundStyle={onlineColor}>{onlineText}</Text>
      {settings.showWeather || settings.showTemp ? <HStack spacing={3}>
        {settings.showWeather ? weatherIcon(10, '#D7E4F7') : null}
        {settings.showTemp ? <Text font={fontSizeOf(settings, 9)} foregroundStyle={fontColorOf(settings, '#D7E4F7')}>{outsideTempText(d) || '--°C'}</Text> : null}
      </HStack> : null}
    </VStack>
  </HStack>)
}
function dashboardHero(d: CarData, width: number, height: number) {
  const summaryWidth = Math.min(100, width * 0.3)
  const imageArea = width - summaryWidth - 6
  const timeHeight = fontSizeOf(settings, 7.5) * 1.35
  const imageHeight = Math.max(1, height - timeHeight - 2)
  const color = needsAttention(d) ? '#FB923C' : fontColorOf(settings, '#9AE6CB')
  return <HStack spacing={6} frame={{ width, height }}><Link url={OPEN_URL}>
    <VStack alignment="leading" spacing={4} frame={{ width: summaryWidth, alignment: 'leading' }}>
      {height >= 65 ? <Text font={fontSizeOf(settings, 8)} foregroundStyle={fontColorOf(settings, '#91A8C7')}>驻车状态</Text> : null}
      <Text font={fontSizeOf(settings, height < 65 ? 13 : 17)} fontWeight="semibold" foregroundStyle={color} lineLimit={1} minScaleFactor={0.6}>{parkingText(d)}</Text>
      <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={color} lineLimit={2} minScaleFactor={0.7}>{engineText(d)}</Text>
    </VStack></Link>
    <VStack alignment="trailing" spacing={2} frame={{ width: imageArea, height }}>
      {refreshTap(d, <ZStack frame={{ width: imageArea, height: imageHeight }}>
        {carMark(Math.min(imageArea, imageArea * 0.82 * carScaleOf(settings)), Math.min(imageHeight, imageHeight * 0.8 * carScaleOf(settings)))}
      </ZStack>)}
      <Text font={fontSizeOf(settings, 7.5)} foregroundStyle={fontColorOf(settings, '#8CA1BC')} lineLimit={1} minScaleFactor={0.65} frame={{ width: imageArea, height: timeHeight, alignment: 'trailing' }}>{updateText(d.updatedAt, NOW, settings.updateTimeStyle)}</Text>
    </VStack>
  </HStack>
}
function dashboardMetrics(metrics: any[], width: number, height: number, grid = false) {
  if (!metrics.length) return null
  const gap = 7, columns = grid ? Math.min(2, metrics.length) : metrics.length
  const rows = Math.ceil(metrics.length / columns)
  const tileWidth = (width - gap * (columns - 1)) / columns
  const tileHeight = (height - gap * (rows - 1)) / rows
  function row(items: typeof metrics, rowIndex: number) {
    return <HStack key={rowIndex} spacing={gap} frame={{ width, height: tileHeight, alignment: 'leading' }}>{items.map((item, index) => <HStack key={index} spacing={0}>{dashboardPanel(<>
      <Text multilineTextAlignment="center" font={fontSizeOf(settings, tileHeight < 50 ? 7.5 : 9)} foregroundStyle={fontColorOf(settings, '#A3B7D0')} lineLimit={1}>{item.label}</Text>
      <HStack alignment="firstTextBaseline" spacing={2} frame={{ maxWidth: 'infinity', alignment: 'center' }}>
        <Text multilineTextAlignment="center" font={fontSizeOf(settings, tileWidth < 80 ? 15 : 21)} fontWeight="semibold" foregroundStyle={item.alert ? '#FB923C' : fontColorOf(settings, 'white')} lineLimit={1} minScaleFactor={0.5}>{item.value}</Text>
        {item.unit ? <Text multilineTextAlignment="center" font={fontSizeOf(settings, 7)} foregroundStyle={fontColorOf(settings, '#A3B7D0')}>{item.unit}</Text> : null}
      </HStack>
    </>, tileWidth, tileHeight, tileHeight < 50 ? settings.fontScale > 100 ? 5 : 7 : 10)}</HStack>)}</HStack>
  }
  return rows > 1 ? <VStack spacing={gap} frame={{ width, height }}>{Array.from({ length: rows }, (_, i) => row(metrics.slice(i * columns, (i + 1) * columns), i))}</VStack> : row(metrics, 0)
}
function dashboardStates(items: any[], width: number, height: number) {
  if (!items.length) return null
  const columns = Math.min(3, items.length), rows = Math.ceil(items.length / columns)
  const cellWidth = (width - 16 - 6 * (columns - 1)) / columns
  const rowHeight = (height - 16 - 4 * (rows - 1)) / rows
  const compact = height / rows < 40
  function row(index: number) {
    return <HStack key={index} spacing={6} frame={{ width: width - 16, height: rowHeight, alignment: 'leading' }}>{items.slice(index * columns, (index + 1) * columns).map((item, i) => <VStack key={i} alignment="center" spacing={1} frame={{ width: cellWidth, height: rowHeight, alignment: 'center' }}>
      <Text multilineTextAlignment="center" font={fontSizeOf(settings, compact ? 7 : 8.5)} foregroundStyle={fontColorOf(settings, '#90A8C6')} lineLimit={1}>{item.label}</Text>
      <Text multilineTextAlignment="center" font={fontSizeOf(settings, compact ? 9 : 11)} fontWeight="medium" foregroundStyle={item.alert ? '#FB923C' : fontColorOf(settings, item.value === '未知' ? '#90A8C6' : '#C9E2DC')} lineLimit={1} minScaleFactor={0.6}>{item.value}</Text>
    </VStack>)}</HStack>
  }
  return dashboardPanel(<VStack spacing={4}>{Array.from({ length: rows }, (_, i) => row(i))}</VStack>, width, height, 8)
}
function dashboardTires(items: any[], width: number, height: number) {
  if (!items.length) return null
  const padding = height < 30 ? 2 : 6
  const cellWidth = (width - padding * 2 - 18) / 4
  return dashboardPanel(<HStack spacing={6} frame={{ width: width - padding * 2, height: height - padding * 2 }}>{items.map(item => <VStack key={item.label} alignment="center" spacing={1} frame={{ width: cellWidth }}>
    <Text multilineTextAlignment="center" font={fontSizeOf(settings, 7.5)} foregroundStyle={fontColorOf(settings, '#90A8C6')} lineLimit={1}>{item.label}</Text>
    <Text multilineTextAlignment="center" font={fontSizeOf(settings, height < 30 ? 9 : 10)} fontWeight="medium" foregroundStyle={fontColorOf(settings, '#C9E2DC')} lineLimit={1} minScaleFactor={0.7}>{item.value}</Text>
  </VStack>)}</HStack>, width, height, padding)
}
function dashboardLocation(d: CarData, width: number, height: number) {
  return tapToApp(dashboardPanel(<>
    {height >= 54 ? <Text multilineTextAlignment="center" font={fontSizeOf(settings, 8)} foregroundStyle={fontColorOf(settings, '#90A8C6')}>{settings.showAddress ? '车辆位置' : '随行短句'}</Text> : null}
    <Text multilineTextAlignment="center" font={fontSizeOf(settings, height > 40 ? 11 : 9)} foregroundStyle={fontColorOf(settings, '#CDD9E9')} lineLimit={height >= 54 ? 2 : 1} minScaleFactor={0.65}>{addressText(d)}</Text>
  </>, width, height, height >= 54 ? 10 : 7))
}
function dashboardReminders(d: CarData, lines: string[], width: number, height: number) {
  if (!lines.length) return null
  const visible = lines.slice(0, height < 35 ? 1 : 2)
  return tapToApp(dashboardPanel(<VStack alignment="center" spacing={2}>{visible.map((line, index) => <Text multilineTextAlignment="center" key={index} font={fontSizeOf(settings, height < 35 ? 8.5 : 10)} foregroundStyle={fontColorOf(settings, '#E8D6B1')} lineLimit={1} minScaleFactor={0.65}>{line}</Text>)}</VStack>, width, height, 7))
}
function dashboardButtons(d: CarData, width: number, height: number) {
  const gap = 7
  // 大 / 超大号可以给图标加两字说明：文字排在图标下方，图标相应缩一点给文字让位。
  const labels = settings.showButtonLabels
  const rowHeight = Math.max(labels ? 28 : 20, height)
  const buttonWidth = (width - gap * (BUTTONS.length - 1)) / BUTTONS.length
  const labelFont = fontSizeOf(settings, rowHeight < 36 ? 8 : 9)
  const labelHeight = Math.ceil(labelFont * 1.25)
  // 按钮变高时图标也跟着长，上限 30；开文字时把文字高度扣掉；最后乘本尺寸的“图标大小”百分比，并夹回按钮内。
  const iconRoom = labels ? rowHeight - labelHeight - 4 : Math.round(rowHeight * 0.6)
  const iconSize = Math.round(Math.min(Math.max(Math.min(iconRoom, buttonWidth - 10, 30) * buttonIconSizeOf(settings) / 100, 9), labels ? rowHeight - labelHeight - 2 : rowHeight - 4, buttonWidth - 8))
  return <HStack spacing={gap} frame={{ width, height: rowHeight }}>{BUTTONS.map((id, index) => {
    if (id === 'blank') return <Spacer key={index} frame={{ width: buttonWidth, height: rowHeight }} />
    const action = buttonAction(id, d, index)
    return <ControlButton key={index} intent={action.intent} confirmationIntent={action.confirmationIntent} frame={{ width: buttonWidth, height: rowHeight }}>
      <ZStack frame={{ width: buttonWidth, height: rowHeight }}>
        <RoundedRectangle cornerRadius={buttonRadiusOf(settings, rowHeight, 11)} fill={buttonBackgroundOf(settings)} frame={{ width: buttonWidth, height: rowHeight }} />
        {labels
          ? <VStack alignment="center" spacing={1} frame={{ width: buttonWidth, height: rowHeight }}>
              {actionIcon(id, action.state, iconSize)}
              <Text font={labelFont} fontWeight="medium" foregroundStyle={fontColorOf(settings, 'rgba(255,255,255,0.82)')} lineLimit={1} minScaleFactor={0.6} frame={{ height: labelHeight }}>{buttonCaption(action.label)}</Text>
            </VStack>
          : actionIcon(id, action.state, iconSize)}
      </ZStack>
    </ControlButton>
  })}</HStack>
}
// 按钮下方的说明固定两个字：“开空调/关空调”取后两字 -> 空调，“开尾门” -> 尾门，其余本身就是两字。
function buttonCaption(label: string) {
  const chars = Array.from(label)
  return chars.length > 2 ? chars.slice(-2).join('') : label
}
function largeBody(d: CarData) {
  const { width, height } = displaySize()
  const reminders = settings.showReminders ? reminderLines(settings, d, NOW) : []
  // 指标 / 状态 / 胎压均只算一次：布局只需长度，渲染直接用同一份列表，避开位图二次解析。
  const metrics = settings.showMetrics ? metricItems(d, settings.metricSlots) : []
  const states = settings.showStates ? stateItems(d, settings.stateSlots) : []
  const showTires = settings.showTires && hasTires()
  const tires = showTires ? tireItems(d) : []
  const metricCount = metrics.length, stateCount = states.length
  // “隐藏地址一行”优先级高于信息卡片里的位置卡片开关。
  const showLocation = settings.showLocationCard && !settings.hideLocationRow
  // “按钮下方文字”开着时一行至少 28（图标 + 一行 9pt 文字）。这个下限必须提前交给布局：
  // dashboardButtons 内部会把行高抬到 28，如果布局只按 20 分配空间，整列会顶出可用高度被裁。
  const buttonHeight = settings.showButtonLabels ? Math.max(28, BUTTON_H) : BUTTON_H
  const l = dashboardLayout(width, height, reminders.length > 0, { metricCount, stateCount, tires: showTires, location: showLocation, buttonHeight })
  const innerWidth = width - l.pad * 2
  if (l.wide) {
    // 宽幅（超大号横屏）采用左右两栏：左栏车图+位置+提醒，右栏指标+状态+胎压+按钮。
    // 下面的常量都是各分区实测的固定高度，剩余高度全部给车图（hero）。
    const gap = 20
    const leftWidth = Math.round((innerWidth - gap) * 0.49), rightWidth = innerWidth - gap - leftWidth
    const innerHeight = height - l.pad * 2, sectionGap = 8, header = 34
    const location = showLocation ? 44 : 0, reminder = reminders.length ? 36 : 0
    const leftGaps = [header, 1, location, reminder].filter(value => value > 0).length - 1
    const hero = Math.max(24, innerHeight - header - location - reminder - sectionGap * leftGaps)
    const stateRows = Math.ceil(stateCount / 3), stateBase = Math.min(90, Math.floor(innerHeight * 0.3))
    const statesHeight = stateRows ? 16 + ((stateBase - 20) / 2) * stateRows + 4 * (stateRows - 1) : 0
    const tiresHeight = tires.length ? 34 : 0
    // 右栏按钮高度同样跟“按钮高度”设置走，但至少给指标卡留一条空间。
    const buttonsCap = innerHeight - statesHeight - tiresHeight - (metricCount ? 52 : 0) - sectionGap * 3
    const buttons = Math.max(20, Math.min(BUTTON_H, buttonsCap))
    const rightGaps = [metricCount ? 1 : 0, statesHeight, tiresHeight, buttons].filter(value => value > 0).length - 1
    // 高度被挤成负值时不再直接当 frame，至少留一条可读行高。
    const metricHeight = metricCount ? Math.max(30, innerHeight - statesHeight - tiresHeight - buttons - sectionGap * rightGaps) : 0
    return <HStack alignment="top" spacing={gap} padding={l.pad} frame={{ width, height }}>
      <VStack spacing={sectionGap} frame={{ width: leftWidth, height: innerHeight }}>
        {dashboardHeader(d, leftWidth, header)}
        {dashboardHero(d, leftWidth, hero)}
        {location ? dashboardLocation(d, leftWidth, location) : null}
        {reminder ? dashboardReminders(d, reminders, leftWidth, reminder) : null}
      </VStack>
      <VStack spacing={sectionGap} frame={{ width: rightWidth, height: innerHeight, alignment: 'top' }}>
        {metricCount ? dashboardMetrics(metrics, rightWidth, metricHeight, true) : null}
        {statesHeight ? dashboardStates(states, rightWidth, statesHeight) : null}
        {tiresHeight ? dashboardTires(tires, rightWidth, tiresHeight) : null}
        {dashboardButtons(d, rightWidth, buttons)}
      </VStack>
    </HStack>
  }
  return <VStack spacing={l.gap} padding={l.pad} frame={{ width, height }}>
    {dashboardHeader(d, innerWidth, l.header)}
    {dashboardHero(d, innerWidth, l.hero)}
    {l.metric ? dashboardMetrics(metrics, innerWidth, l.metric) : null}
    {l.states ? dashboardStates(states, innerWidth, l.states) : null}
    {l.tires ? dashboardTires(tires, innerWidth, l.tires) : null}
    {l.location ? dashboardLocation(d, innerWidth, l.location) : null}
    {l.reminder ? dashboardReminders(d, reminders, innerWidth, l.reminder) : null}
    {dashboardButtons(d, innerWidth, l.buttons)}
  </VStack>
}
function Body({ data }: { data: CarData }) {
  // 直接用 module 级 widgetSize（已按 family + 实际尺寸算好），不再各处重复判断。
  if (widgetSize === 'large' || widgetSize === 'extraLarge') return largeBody(data)
  return widgetSize === 'small'
    ? settings.smallStyle === 'ring' ? ringBody(data) : smallBody(data)
    : mediumBody(data)
}
function ConfirmationBody({ state, data }: { state: WidgetConfirmation; data: CarData }) {
  const { width, height } = displaySize()
  const compact = width < 200, horizontal = !compact && height < 220
  // running 相位已经取消：要么待确认，要么失败，二选一。
  const pending = state.phase === 'pending', failed = !pending
  const params = { size: widgetSize, id: state.id }
  // 主色只有一种：待确认和失败都用同一橙色，整个确认页（图标底色、提示文字、主按钮）同源。
  const tint = '#F5C982'
  const heading = pending ? '请确认操作' : '操作未完成'
  const label = requestedCommand(state).label
  const vehicle = title(data), plate = plateText(data, settings)
  const identity = vehicle + (plate && plate !== vehicle ? ' · ' + plate : '')
  const hint = pending ? `确认后发送指令 · ${CONFIRM_SECONDS} 秒内有效`
    : state.message || '操作未完成，可返回车况重试'
  const buttonState = ['lock', 'window', 'engine', 'ac', 'seat', 'trunk'].includes(state.action) ? !state.target : false
  const iconTint = buttonIconColorOf(settings, isButtonLit(state.action, buttonState))
  function icon(size: number) {
    // 图标底色就是主色 tint（待确认 / 失败完全相同）。
    return <ZStack frame={{ width: size, height: size }}>
      <RoundedRectangle cornerRadius={size * 0.3} fill={tint} frame={{ width: size, height: size }} />
      <ButtonGlyph id={state.action} state={buttonState} color={iconTint} lineWidth={buttonIconLineWidthOf(settings)} size={size * 0.55} />
    </ZStack>
  }
  function actionButton(text: string, intent: any, w: number, h: number, primary = false) {
    return <Button intent={intent} buttonStyle="plain" frame={{ width: w, height: h }}>
      <ZStack frame={{ width: w, height: h }}>
        <RoundedRectangle cornerRadius={compact ? 11 : 13} fill={primary ? tint : '#344259'} frame={{ width: w, height: h }} />
        {!primary ? <RoundedRectangle cornerRadius={compact ? 10 : 12} fill="#202F45" frame={{ width: w - 2, height: h - 2 }} /> : null}
        <Text font={fontSizeOf(settings, compact ? 11 : 13)} fontWeight="semibold" foregroundStyle={primary ? '#30271C' : '#D8E3F1'} lineLimit={1} minScaleFactor={0.75}>{text}</Text>
      </ZStack>
    </Button>
  }
  // 点「取消」/「返回车况」都直接收票并重绘，组件立刻回到车况首页（不做任何自动回落）。
  // 失败页只有一个按钮，也用主按钮样式（底色 tint + 深色字），跟待确认页的「确认执行」完全一致。
  function footer(w: number, h: number) {
    if (!pending) return actionButton('返回车况', CancelConfirmationIntent(params), w, h, true)
    const gap = compact ? 8 : 10, buttonWidth = (w - gap) / 2
    return <HStack spacing={gap} frame={{ width: w, height: h }}>
      {actionButton('取消', CancelConfirmationIntent(params), buttonWidth, h)}
      {actionButton(compact ? '确认' : '确认执行', SubmitConfirmationIntent(params), buttonWidth, h, true)}
    </HStack>
  }
  const pad = compact ? 12 : horizontal ? 16 : 22
  const innerWidth = width - pad * 2, innerHeight = height - pad * 2
  let content: any
  if (compact) {
    const gap = 5, detailHeight = innerHeight - 18 - 24 - 14 - 32 - 4 * gap
    content = <VStack alignment="leading" spacing={gap} frame={{ width: innerWidth, height: innerHeight }}>
      <HStack spacing={6} frame={{ width: innerWidth, height: 18, alignment: 'leading' }}>
        <ButtonGlyph id={state.action} state={buttonState} color={iconTint} lineWidth={buttonIconLineWidthOf(settings)} size={18} />
        <Text font={fontSizeOf(settings, 10)} foregroundStyle="#B3C3D8" lineLimit={1}>{heading}</Text>
      </HStack>
      <Text font={fontSizeOf(settings, 18)} fontWeight="semibold" foregroundStyle="#F2F6FC" lineLimit={1} minScaleFactor={0.55} frame={{ width: innerWidth, height: 24, alignment: 'leading' }}>{label}</Text>
      <Text font={fontSizeOf(settings, 10)} foregroundStyle="#B3C3D8" lineLimit={1} minScaleFactor={0.65} frame={{ width: innerWidth, height: 14, alignment: 'leading' }}>{identity}</Text>
      <Text font={fontSizeOf(settings, 8.5)} foregroundStyle={failed ? tint : '#8198B5'} lineLimit={2} minScaleFactor={0.7} frame={{ width: innerWidth, height: detailHeight, alignment: 'topLeading' }}>{hint}</Text>
      {footer(innerWidth, 32)}
    </VStack>
  } else if (horizontal) {
    const gap = 8, buttonHeight = 36, detailHeight = 32, headerHeight = innerHeight - buttonHeight - detailHeight - gap * 2
    const textWidth = innerWidth - 52
    content = <VStack alignment="leading" spacing={gap} frame={{ width: innerWidth, height: innerHeight }}>
      <HStack spacing={12} frame={{ width: innerWidth, height: headerHeight, alignment: 'leading' }}>
        {icon(40)}
        <VStack alignment="leading" spacing={3} frame={{ width: textWidth, height: headerHeight, alignment: 'leading' }}>
          <Text font={fontSizeOf(settings, 10)} foregroundStyle="#A5B9D2" lineLimit={1} minScaleFactor={0.8} frame={{ width: textWidth, height: 12, alignment: 'leading' }}>{heading}</Text>
          <Text font={fontSizeOf(settings, 20)} fontWeight="semibold" foregroundStyle="#F2F6FC" lineLimit={1} minScaleFactor={0.6} frame={{ width: textWidth, height: headerHeight - 15, alignment: 'leading' }}>{label}</Text>
        </VStack>
      </HStack>
      <VStack alignment="leading" spacing={3} frame={{ width: innerWidth, height: detailHeight, alignment: 'leading' }}>
        <Text font={fontSizeOf(settings, 11)} foregroundStyle="#C1CEE0" lineLimit={1} minScaleFactor={0.65}>{identity}</Text>
        <Text font={fontSizeOf(settings, 9)} foregroundStyle={failed ? tint : '#8198B5'} lineLimit={1} minScaleFactor={0.65}>{hint}</Text>
      </VStack>
      {footer(innerWidth, buttonHeight)}
    </VStack>
  } else {
    const gap = 14, buttonHeight = 46, panelHeight = innerHeight - 20 - buttonHeight - gap * 2
    content = <VStack spacing={gap} frame={{ width: innerWidth, height: innerHeight }}>
      <HStack frame={{ width: innerWidth, height: 20 }}>
        <Text font={fontSizeOf(settings, 12)} fontWeight="medium" foregroundStyle="#BACAE0">{heading}</Text>
        <Spacer />
        <Text font={fontSizeOf(settings, 10)} foregroundStyle={tint}>{pending ? '等待确认' : '请重新操作'}</Text>
      </HStack>
      <ZStack frame={{ width: innerWidth, height: panelHeight }}>
        <RoundedRectangle cornerRadius={20} fill="#1A2A40" frame={{ width: innerWidth, height: panelHeight }} />
        <VStack spacing={12} frame={{ width: innerWidth - 28, height: panelHeight - 24 }}>
          {icon(52)}
          <Text font={fontSizeOf(settings, 25)} fontWeight="semibold" foregroundStyle="#F2F6FC" lineLimit={1} minScaleFactor={0.6}>{label}</Text>
          <Text font={fontSizeOf(settings, 13)} foregroundStyle="#C1CEE0" lineLimit={1} minScaleFactor={0.65}>{identity}</Text>
          <Text font={fontSizeOf(settings, 11)} foregroundStyle={failed ? tint : '#8198B5'} lineLimit={2} minScaleFactor={0.7}>{hint}</Text>
        </VStack>
      </ZStack>
      {footer(innerWidth, buttonHeight)}
    </VStack>
  }
  return <ZStack frame={{ width, height }}>
    <RoundedRectangle cornerRadius={26} fill="#111E33" frame={{ width, height }} />
    {content}
  </ZStack>
}
function presentContent(content: any, path = '', exists = false) {
  // Keep the same background and outer view when entering or leaving confirmation.
  const size = displaySize()
  const dim = backgroundDimOf(settings)
  Widget.present(<ZStack background={gradientOf(settings)} frame={{ width: size.width, height: size.height }}>
    {exists ? <Image filePath={path} resizable scaleToFill clipped frame={{ width: size.width, height: size.height }} /> : null}
    {exists && dim > 0 ? <RoundedRectangle cornerRadius={0} fill={`rgba(0,0,0,${dim})`} frame={{ width: size.width, height: size.height }} /> : null}
    {content}
  </ZStack>, { policy: 'after', date: NEXT_RELOAD })
}
// 车图丢失时的兜底路径：只算一次，且不回写模块级 settings（否则后续读取会拿到被清空的 carImage）。
let fallbackImagePath: string | undefined
function carImageFallbackPath(): string {
  if (fallbackImagePath === undefined) fallbackImagePath = imagePath({ ...settings, carImage: '' })
  return fallbackImagePath
}
async function main() {
  // 内置车图现在从 Gitee 下到临时目录：与查缓存/刷新车况并行启动，画之前再等它。
  const carTask = prepareDefaultCar()
  let cached = readCache()
  let confirmation = readWidgetConfirmation(widgetSize, Date.now(), settings)
  // 天气图标 / 车外温度在四个尺寸都有显示，与车况刷新并行取，命中缓存时零延迟。
  // 位置不确定（还没车况快照）时先不请求，等下面刷新完拿坐标再补。
  // 温度开关也依赖天气：只开“车外温度”、关掉天气图标时，车机没上报温度还得靠手机天气兜底。
  // 确认页（ConfirmationBody）根本不画天气，这种时侯就别为它白等最多 2.5 秒。
  const wantWeather = (settings.showWeather || settings.showTemp) && !confirmation
  let weatherTask = wantWeather && cached ? weatherAt(cached.lat, cached.lng) : null
  // 失败提示页走快路径：不查背景图，直接用缓存画出来。
  if (confirmation && confirmation.phase === 'error' && cached) {
    presentContent(<ConfirmationBody state={confirmation} data={cached} />)
    return
  }
  // 系统实际重载可能早于预定时间（甚至只早几秒）。如果严格按 refreshMinutes 比较，
  // 这次就会判定“还没到点”而不拉数据，下一次重载又要再等一整个间隔，
  // 实际数据会陈旧到两倍间隔。这里给 2 分钟宽容（远小于最小间隔 5 分钟）。
  const dueAt = Math.max(0, settings.refreshMinutes * 60000 - REFRESH_TOLERANCE)
  if (!confirmation && !recentlyFinishedConfirmation(widgetSize) && settings.autoRefresh && (!cached || NOW - cached.updatedAt >= dueAt)) {
    try { cached = await loadCarWithin(REFRESH_BUDGET_MS); writeCache(cached) } catch (e) {
      // 网络失败或超时：保留上次成功快照，但记一条，否则“数据一直是旧的”无从查起。
      logError('组件刷新车况失败', e)
    }
    // 等待网络期间可能又点了按钮而产生新的确认单，重新读一次再决定展示什么。
    confirmation = readWidgetConfirmation(widgetSize, Date.now(), settings)
  }
  // 首装时还没有车况快照，坐标要等刷新回来才有；这时再补一次（其余情况上面已经在并行取了）。
  if (wantWeather && !weatherTask && cached) weatherTask = weatherAt(cached.lat, cached.lng)
  if (weatherTask && !confirmation) WEATHER = await weatherWithin(weatherTask, readWeatherCache())
  const dashboard = widgetSize === 'large' || widgetSize === 'extraLarge'
  const extraLarge = widgetSize === 'extraLarge'
  const path = dashboard ? extraLarge ? settings.extraLargeBackground || settings.largeBackground : settings.largeBackground
    : widgetSize === 'small' ? settings.smallBackground : settings.mediumBackground
  // 背景图与车图是否存在只用同步检测。车图丢失时只改本次渲染的显示路径，
  // 不回写模块级 settings（否则后续读取会拿到被清空的 carImage）。
  const exists = path ? fileExists(path) : false
  // 确认页（ConfirmationBody）不画车图，别为它多做一次同步文件检测（iCloud 上要几十毫秒）。
  if (!confirmation && settings.carImage && !fileExists(settings.carImage)) CAR_IMAGE_PATH = carImageFallbackPath()
  // 确认页只在真正画出来的那一刻开始计 10 秒（hideAt）；到期这票就作废，不再执行指令。
  // 不做任何“自动返回”的排期：那在 iOS 上兑现不了，点确认/取消才是唯一可靠的返回路径。
  // 车图落到本地才能画（`Image filePath` 只认本地文件）；下载失败不报错，顶多少一张车图。
  await carTask
  if (cached) confirmation = armConfirmationWindow(confirmation)
  const content = cached ? confirmation ? <ConfirmationBody state={confirmation} data={cached} /> : <Body data={cached} /> : <Link url={OPEN_URL}><EmptyView /></Link>
  presentContent(content, path, exists)
}
main().catch(e => {
  // 任何未预料的异常都不能让组件留一片空白：至少把空状态（点了进 App）呈现出来。
  logError('组件渲染失败', e)
  try { presentContent(<Link url={OPEN_URL}><EmptyView /></Link>) } catch { /* 彻底失败时交给系统占位 */ }
})
