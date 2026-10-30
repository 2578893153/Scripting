import type { Color } from 'scripting'
import type { CarData } from './api'
import { asColor } from './color-utils'
import { logEvent, summarize } from './log'
import { defaultCarPath } from './car-asset'

export type WidgetSize = 'small' | 'medium' | 'large' | 'extraLarge'
// 座椅加热挡位是字符串（'1' / '2' / '3'），统一用这一份枚举，避免各处写死数字。
export const SEAT_LEVELS = ['1', '2', '3'] as const
export type SeatLevel = typeof SEAT_LEVELS[number]
export type WidgetOptions = {
  metricSlots: string[]; stateSlots: string[]
  showMetrics: boolean; showStates: boolean; showTires: boolean; showLocationCard: boolean; showReminders: boolean
  theme: string; name: string; plate: string; showPlate: boolean
  // 自定义主题配色：theme === 'custom' 时用这三个色，渐变起始 / 结束 + 强调色。
  themeColor1: string; themeColor2: string; themeAccent: string
  showAddress: boolean; quote: string; showIcons: boolean; showStateText: boolean; showTemp: boolean; showWeather: boolean
  buttonBackgroundTransparency: number | null
  infoBackgroundTransparency: number | null
  infoBackgroundColor: string; extraLargeBackground: string
  fontScale: number; updateTimeStyle: 'absolute' | 'relative' | 'full'
  buttonConfirmations: boolean[]
  buttonIconOnColor: string; buttonIconOffColor: string; buttonHeight: number
  showButtonLabels: boolean
  // 按钮图标线条粗细：在 PROFILE_KEYS 里，四个尺寸各存一份（各尺寸「快捷按钮」里单独调）。
  // 根级这份只作为没单独设置过的尺寸的兜底（旧版全局值升级后自动变成四个尺寸的初值）。
  // 只影响按钮图标：描边图标（锁车 / 启动 / 寻车 / 刷新 / 热车）直接改描边宽度；
  // 实心剪影（尾门 / 车窗 / 空调 / 冷车）用同色描边把厚片向外长一圈来对齐粗细。
  buttonIconLineWidth: number
  // 按钮图标大小：百分比，100 = 原来的大小，同样按尺寸分别保存（根级同样是兜底值）。
  // 只缩放开算出来的图标边长（组件与设置页预览同一套公式），再夹回按钮内部，放大不会溢到边框外。
  buttonIconSize: number
  // 座椅加热挡位：每个按钮槽位各存一份（第 i 项对应第 i 个按钮），与 buttons 一样按尺寸分别保存。
  // 开启时下发 CMD_HEATSEAT 的 type 就是它；关闭时固定 flag 0 / type 0（type 0 表示不带挡位）。
  seatLevels: SeatLevel[]
  // 启动 / 冷车 / 热车的运行时长（分钟）：同样每个按钮槽位存一份，按尺寸分别保存。
  // 下发时写进 CMD_ENGINE 的 engine_time；没设置过的槽位跟按钮功能的出厂时长走（启动 10、冷车 / 热车 30）。
  engineTimes: number[]
  fontColor: string; buttonBackgroundColor: string
  carScale: number; backgroundDim: number; buttonCount: number; buttons: string[]
  barWidth: number; barHeight: number
  buttonRadius: number
  useAudiLogo: boolean; showCenterAddress: boolean; hideLocationRow: boolean
  centerCarScale: number; centerLogoScale: number
  // 车辆中心页按钮图标大小（百分比，100 = 原始）：与组件里四个尺寸各一份的 buttonIconSize 互不影响，单独存。
  centerIconSize: number
  // 车辆中心页按钮图标线条粗细：同样只给这一页用（与四个尺寸各自那份互不影响）。粗细从根页面搬进尺寸页后，
  // 这一页没有别的地方能调，所以单独存一份，默认 1.7 与尺寸页一致。
  centerIconLineWidth: number
  // 车辆中心页面里启动 / 冷车 / 热车三个固定按钮的运行时长（分钟）：页面按钮没有槽位，
  // 所以不跟 engineTimes 走，单独存一份全局值（不放进 PROFILE_KEYS）。
  centerEngineMinutes: number; centerCoolMinutes: number; centerHotMinutes: number
  // 灵动岛：两个开关 + 一个延时，全局各一份（不跟尺寸）。
  // islandEnabled：点下去直接执行的按钮（含车辆图片刷新）要不要挂灵动岛。
  // islandConfirmEnabled：组件里选了二次确认的按钮，在确认页点「确认」后要不要挂灵动岛。
  islandEnabled: boolean
  islandConfirmEnabled: boolean
  islandDelay: number
  smallStyle: string; smallRingInfo: string; lastButton: string; refreshMinutes: number; autoRefresh: boolean
  carImage: string; centerCarImage: string; smallBackground: string; mediumBackground: string; largeBackground: string
  maintenanceDate: string; insuranceDate: string; inspectionDate: string; maintenanceKm: string
}
export type Settings = WidgetOptions & { profiles?: Partial<Record<WidgetSize, Partial<WidgetOptions>>> }
/** 图标两档默认色：未激活白色，激活橙色（与调色盘里的“橙色”同值）。 */
export const ICON_IDLE_COLOR = '#FFFFFF'
export const ICON_ACTIVE_COLOR = '#FB923C'
/** 未激活色以前的默认值：旧配置里存到它就等于“没改过”，统一跟着新默认（白色）走。 */
const LEGACY_ICON_IDLE_COLOR = '#7DD3FC'
/** 按钮底的默认色与默认透明度：白色 + 90%（0 不透明，90 几乎全透）。透明度是“有多透明”。 */
export const BUTTON_BG_COLOR = '#FFFFFF'
export const BUTTON_BG_TRANSPARENCY = 90
/** 灵动岛延时：默认 1500ms，可调范围 200 – 4000ms。 */
export const ISLAND_DELAY_DEFAULT = 1500
export const ISLAND_DELAY_MIN = 200
export const ISLAND_DELAY_MAX = 4000
export const DEFAULTS: Settings = {
  metricSlots: ['mileage', 'oil', 'fuelPct', 'battery'],
  stateSlots: ['windows', 'carDoor', 'carLamp', 'acOn', 'waterTemperature', 'heatSeat'],
  showMetrics: true, showStates: true, showTires: true, showLocationCard: true, showReminders: true,
  theme: 'navy', name: '', plate: '', showPlate: true, showAddress: true,
  themeColor1: '', themeColor2: '', themeAccent: '',
  quote: '每一次出发，都平安抵达', showIcons: true, showStateText: true, showTemp: true, showWeather: true,
  buttonBackgroundTransparency: BUTTON_BG_TRANSPARENCY,
  infoBackgroundTransparency: null,
  infoBackgroundColor: '', extraLargeBackground: '',
  fontScale: 100, updateTimeStyle: 'absolute',
  buttonConfirmations: [false, false, false, false, false, false, false],
  buttonIconOnColor: ICON_IDLE_COLOR, buttonIconOffColor: ICON_ACTIVE_COLOR, buttonHeight: 31, showButtonLabels: true, buttonIconLineWidth: 1.7, buttonIconSize: 100,
  // 挡位长度与按钮槽位数对齐，新增槽位时一起加。
  seatLevels: ['1', '1', '1', '1', '1', '1', '1'],
  engineTimes: [],
  fontColor: '', buttonBackgroundColor: BUTTON_BG_COLOR,
  carScale: 100, backgroundDim: 0, buttonCount: 7,
  // 7 个按钮槽位：前 6 个是原有默认，第 7 个是座椅加热（新按钮，四个尺寸共用同一份默认值）。
  // 「刷新车况」不再是可绑定的功能（组件里点车辆图片就刷新，车辆中心页也有刷新按钮），默认值里换成了尾门。
  buttons: ['lock', 'window', 'engine', 'find', 'ac', 'seat', 'trunk'],
  barWidth: 94, barHeight: 3,
  buttonRadius: -1,
  useAudiLogo: true, showCenterAddress: true, hideLocationRow: false, centerCarScale: 100, centerLogoScale: 80, centerIconSize: 100, centerIconLineWidth: 1.7,
  centerEngineMinutes: 10, centerCoolMinutes: 30, centerHotMinutes: 30,
  islandEnabled: true, islandConfirmEnabled: true,
  islandDelay: ISLAND_DELAY_DEFAULT,
  smallStyle: 'classic', smallRingInfo: 'oil', lastButton: 'engine', refreshMinutes: 30, autoRefresh: true,
  carImage: '', centerCarImage: '', smallBackground: '', mediumBackground: '', largeBackground: '',
  maintenanceDate: '', insuranceDate: '', inspectionDate: '', maintenanceKm: '',
}
// 运行时长默认值直接由 buttons 槽位推出：改了 DEFAULTS.buttons 也不用再同步一份硬编码数组。
DEFAULTS.engineTimes = DEFAULTS.buttons.map(defaultEngineTimeFor)
declare const Storage: { get<T>(key: string): T | null; set<T>(key: string, value: T): boolean }
const KEY = 'carlink.car.customization.v1'
// 设置只在本进程内由 saveSettings 写入，所以内存里缓存一份归一化结果是安全的：
// 设置页一次渲染里 current() 会被抽几十次，每次重新读存储 + 归一化四个尺寸的 profiles 很贵。
let settingsMemo: Settings | null = null
export function readSettings(): Settings {
  if (settingsMemo) return settingsMemo
  try { settingsMemo = normalizeSettings(Storage.get<Partial<Settings>>(KEY) || {}) }
  catch { settingsMemo = normalizeSettings({}) }
  return settingsMemo
}
export function normalizeSettings(saved: Partial<Settings>): Settings {
  const settings = { ...DEFAULTS, ...saved }
  settings.infoBackgroundColor = normalizeColor(settings.infoBackgroundColor, true)
  settings.infoBackgroundTransparency = typeof settings.infoBackgroundTransparency === 'number' && Number.isFinite(settings.infoBackgroundTransparency) ? bounded(settings.infoBackgroundTransparency, 0, 100, 0) : null
  settings.fontColor = normalizeColor(settings.fontColor)
  settings.buttonBackgroundColor = normalizeColor(settings.buttonBackgroundColor, true) || BUTTON_BG_COLOR
  // 按钮底默认白 + 90% 透明：旧配置存的是空串 / null（没选过），升级后按新默认走；'clear' 是显式选的“透明背景”，要保留。
  settings.buttonBackgroundTransparency = typeof settings.buttonBackgroundTransparency === 'number' && Number.isFinite(settings.buttonBackgroundTransparency) ? bounded(settings.buttonBackgroundTransparency, 0, 100, BUTTON_BG_TRANSPARENCY) : BUTTON_BG_TRANSPARENCY
  // 未激活色默认从浅蓝 #7DD3FC 改成白色：旧配置里存下来的旧默认值当作“没设置”，回落到新默认，
  // 否则改色之后所有老用户看到的还是旧的浅蓝（存量设置里已经固化了老默认值）。
  const idleIcon = normalizeColor(settings.buttonIconOnColor)
  settings.buttonIconOnColor = idleIcon === LEGACY_ICON_IDLE_COLOR ? '' : idleIcon
  settings.buttonIconOffColor = normalizeColor(settings.buttonIconOffColor)
  settings.themeColor1 = normalizeColor(settings.themeColor1)
  settings.themeColor2 = normalizeColor(settings.themeColor2)
  settings.themeAccent = normalizeColor(settings.themeAccent)
  // 下面各数值的上/下限与设置页“自定义数值”的可输入范围保持一致，否则自定义值会被静默夹回。
  settings.buttonHeight = Math.round(bounded(settings.buttonHeight, 14, 80, 31))
  // 线条粗细保留一位小数，上下限与设置页「图标线条粗细」的可输入范围一致（0.8 – 3.2）。
  settings.buttonIconLineWidth = Math.round(bounded(settings.buttonIconLineWidth, 0.8, 3.2, 1.7) * 10) / 10
  // 图标大小是整数百分比，上下限与设置页「图标大小」的可输入范围一致（50 – 200%）。
  settings.buttonIconSize = Math.round(bounded(settings.buttonIconSize, 50, 200, 100))
  // 加热挡位只允许 '1' / '2' / '3'，每个槽位各一份；脏值（0、小数、空串）一律回到 1 挡。
  // 旧版本只在根上存过一个全局数字 seatHeatLevel，升级时按它填满各槽位，别把用户选过的挡位打回 1 挡。
  const savedLevels = Array.isArray(saved.seatLevels) ? saved.seatLevels : DEFAULTS.buttons.map(() => (saved as any).seatHeatLevel)
  settings.seatLevels = DEFAULTS.buttons.map((_, i) => asSeatLevel(savedLevels[i]))
  settings.useAudiLogo = typeof settings.useAudiLogo === 'boolean' ? settings.useAudiLogo : DEFAULTS.useAudiLogo
  settings.showCenterAddress = typeof settings.showCenterAddress === 'boolean' ? settings.showCenterAddress : true
  settings.centerCarScale = Math.round(bounded(settings.centerCarScale, 30, 300, 100))
  settings.centerLogoScale = Math.round(bounded(settings.centerLogoScale, 30, 300, DEFAULTS.centerLogoScale))
  // 车辆中心页按钮图标大小：全局一份，50 – 200%，与组件设置里的图标大小无关。
  settings.centerIconSize = Math.round(bounded(settings.centerIconSize, 50, 200, 100))
  // 车辆中心页按钮图标线条粗细：升级时没单独存过（旧版这一页跟着根级“图标线条粗细”走）就沿用根级那个值，视觉不变。
  const centerWidth = typeof (saved as any).centerIconLineWidth === 'number' ? (saved as any).centerIconLineWidth : settings.buttonIconLineWidth
  settings.centerIconLineWidth = Math.round(bounded(centerWidth, 0.8, 3.2, 1.7) * 10) / 10
  // 车辆中心页面的启动 / 冷车 / 热车时长：全局一份，越界夹回 1 – 30 分钟（车机上限）。
  settings.centerEngineMinutes = asEngineTime(settings.centerEngineMinutes, DEFAULTS.centerEngineMinutes)
  settings.centerCoolMinutes = asEngineTime(settings.centerCoolMinutes, DEFAULTS.centerCoolMinutes)
  settings.centerHotMinutes = asEngineTime(settings.centerHotMinutes, DEFAULTS.centerHotMinutes)
  // 灵动岛：两个开关默认开（旧备份里没这两个键，也用默认值）；延时越界 / 脏值一律回 1500ms。
  settings.islandEnabled = typeof settings.islandEnabled === 'boolean' ? settings.islandEnabled : true
  settings.islandConfirmEnabled = typeof settings.islandConfirmEnabled === 'boolean' ? settings.islandConfirmEnabled : true
  settings.islandDelay = Math.round(bounded(settings.islandDelay, ISLAND_DELAY_MIN, ISLAND_DELAY_MAX, ISLAND_DELAY_DEFAULT))
  settings.buttonConfirmations = DEFAULTS.buttons.map((_, i) => Array.isArray(saved.buttonConfirmations) && saved.buttonConfirmations[i] === true)
  settings.fontScale = bounded(settings.fontScale, 60, 200, 100)
  settings.updateTimeStyle = settings.updateTimeStyle === 'relative' ? 'relative' : settings.updateTimeStyle === 'full' ? 'full' : 'absolute'
  // 主题 id 必须是内置主题之一（或 'custom'）：备份文件里可能带着已删除的主题，不收敛的话
  // 渲染回落深海蓝，而设置页的 Picker 三个选项都不选中（主题项显示为空）。
  settings.theme = settings.theme === CUSTOM_THEME_ID || THEMES.some(theme => theme.id === settings.theme) ? settings.theme : DEFAULTS.theme
  settings.carScale = bounded(settings.carScale, 30, 300, 100)
  settings.barWidth = Math.round(bounded(settings.barWidth, 20, 400, DEFAULTS.barWidth))
  settings.barHeight = Math.round(bounded(settings.barHeight, 1, 40, DEFAULTS.barHeight))
  settings.buttonRadius = Math.round(bounded(settings.buttonRadius, -1, 60, DEFAULTS.buttonRadius))
  const slotCount = DEFAULTS.buttons.length
  settings.buttonCount = Math.round(bounded(settings.buttonCount, 1, slotCount, slotCount))
  // 旧版本按钮槽位更少（5 个 → 6 个 → 7 个，7 个是新增的座椅加热）。
  // 只有“原来就把槽位全显出来”的配置才跟着自动扩到最新槽位数；
  // 用户主动收起的（数量少于槽位的）保持原数量，新按钮去设置里把数量调大就能出来。
  const legacySlots = Array.isArray(saved.buttons) ? saved.buttons.length : 0
  if (legacySlots > 0 && legacySlots < slotCount && settings.buttonCount >= legacySlots) settings.buttonCount = slotCount
  settings.smallRingInfo = INFO_OPTIONS.some(option => option.id === settings.smallRingInfo) ? settings.smallRingInfo : 'oil'
  settings.backgroundDim = bounded(settings.backgroundDim, 0, 100, 0)
  settings.refreshMinutes = Math.round(bounded(settings.refreshMinutes, 5, 1440, DEFAULTS.refreshMinutes))
  const buttons = Array.isArray(saved.buttons) ? saved.buttons : ['lock', 'window', saved.lastButton || 'engine', 'find']
  // 槽位值必须是 ACTIONS 里存在的功能；认不出来的（旧版本删过又加回的功能、手改的脏值）回落到默认功能。
  settings.buttons = DEFAULTS.buttons.map((fallback, i) => ACTIONS.some(a => a.id === buttons[i]) ? buttons[i] : fallback)
  // 运行时长同样是每个槽位一份；没存过的槽位取该按钮功能的出厂时长，脏值 / 越界（车机最多 30）夹回 1 – 30 分钟。
  const savedTimes = Array.isArray(saved.engineTimes) ? saved.engineTimes : []
  settings.engineTimes = DEFAULTS.buttons.map((_, i) => asEngineTime(savedTimes[i], defaultEngineTimeFor(settings.buttons[i])))
  // hideLocationRow：开启后地址/短句整行不渲染，优先级高于 showAddress 与 showLocationCard。
  for (const key of ['showMetrics', 'showStates', 'showTires', 'showLocationCard', 'showReminders', 'hideLocationRow', 'showButtonLabels', 'showStateText', 'showPlate', 'showAddress', 'showIcons', 'showTemp', 'showWeather', 'autoRefresh'] as const) {
    settings[key] = typeof settings[key] === 'boolean' ? settings[key] : DEFAULTS[key]
  }
  for (const key of ['metricSlots', 'stateSlots'] as const) {
    const slots = Array.isArray(saved[key]) ? saved[key]! : []
    settings[key] = DEFAULTS[key].map((fallback, i) => INFO_OPTIONS.some(option => option.id === slots[i]) ? slots[i] : fallback)
  }
  // 四种尺寸的独立配置也走一遍归一：旧备份里缺的新参数（按钮高度、图标下方文字等）在这里补上默认值。
  if (saved.profiles !== undefined) settings.profiles = normalizeProfiles(saved.profiles)
  return settings
}
/** 按尺寸配置的归一化：只保留 PROFILE_KEYS 里真正存过的键，并逐项夹到合法范围。 */
export function normalizeProfiles(value: unknown): Settings['profiles'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Partial<Record<WidgetSize, Partial<WidgetOptions>>> = {}
  for (const { id } of WIDGET_SIZES) {
    const keys = profileOnly((value as any)[id])
    if (!Object.keys(keys).length) continue
    const normalized = normalizeSettings({ ...DEFAULTS, ...keys })
    const rebuilt: any = {}
    for (const key of Object.keys(keys)) rebuilt[key] = (normalized as any)[key]
    out[id] = rebuilt
  }
  return out
}
export const ACTIONS = [
  { id: 'blank', name: '空白' },
  { id: 'lock', name: '锁车 / 解锁' },
  { id: 'window', name: '开窗 / 关窗' }, { id: 'engine', name: '启动 / 熄火' },
  { id: 'find', name: '鸣笛寻车' }, { id: 'cool', name: '冷车' },
  { id: 'hot', name: '热车' }, { id: 'ac', name: '空调开启 / 关闭' },
  { id: 'trunk', name: '尾门开启 / 关闭' },
  { id: 'seat', name: '座椅加热 开 / 关' },
  // 一键类：只发一次刷新请求，没有开关两态（图标固定用未点亮那一格）。
  { id: 'refresh', name: '刷新车况' },
]
// 可放进组件的指标/状态/胎压候选项，与 dashboard-model 的 itemById 一一对应。
export const INFO_OPTIONS = [
  { id: 'blank', name: '不显示' },
  { id: 'mileage', name: '累计里程' }, { id: 'oil', name: '剩余油量' },
  { id: 'fuelPct', name: '燃油余量' }, { id: 'battery', name: '蓄电池' },
  { id: 'outsideTemp', name: '车外温度' }, { id: 'locked', name: '车锁状态' },
  { id: 'engineOn', name: '发动机状态' }, { id: 'online', name: '在线状态' },
  { id: 'windows', name: '车窗' }, { id: 'carDoor', name: '车门' }, { id: 'trunkStatus', name: '尾门状态' }, { id: 'hoodStatus', name: '车盖状态' },
  { id: 'carLamp', name: '车灯' }, { id: 'acOn', name: '空调' },
  { id: 'waterTemperature', name: '水温' }, { id: 'heatSeat', name: '座椅加热' },
  { id: 'tireLF', name: '左前胎压' }, { id: 'tireRF', name: '右前胎压' },
  { id: 'tireLR', name: '左后胎压' }, { id: 'tireRR', name: '右后胎压' },
]
export const WIDGET_SIZES: { id: WidgetSize; name: string }[] = [
  { id: 'small', name: '小号组件' }, { id: 'medium', name: '中号组件' },
  { id: 'large', name: '大号组件' }, { id: 'extraLarge', name: '超大号组件' },
]
const PROFILE_KEYS = [
  'theme', 'themeColor1', 'themeColor2', 'themeAccent', 'name', 'plate', 'showPlate', 'showAddress', 'hideLocationRow', 'quote', 'showIcons', 'showStateText', 'showTemp', 'showWeather',
  'fontScale', 'fontColor', 'infoBackgroundColor', 'infoBackgroundTransparency',
  'buttonBackgroundColor', 'buttonBackgroundTransparency', 'buttonConfirmations', 'seatLevels', 'engineTimes',
  // useAudiLogo 只影响车辆中心主页，已移入根级设置，不再按尺寸保存。
  'buttonIconOnColor', 'buttonIconOffColor', 'buttonIconSize', 'buttonIconLineWidth', 'buttonHeight', 'buttonRadius', 'showButtonLabels',
  'carScale', 'barWidth', 'barHeight', 'backgroundDim', 'buttonCount', 'buttons', 'smallStyle', 'smallRingInfo', 'lastButton',
  'refreshMinutes', 'autoRefresh', 'updateTimeStyle', 'carImage', 'smallBackground',
  'mediumBackground', 'largeBackground', 'extraLargeBackground', 'metricSlots', 'stateSlots',
  'showMetrics', 'showStates', 'showTires', 'showLocationCard', 'showReminders',
] as const
/**
 * 挑出某个尺寸真正存过的键。
 * 值为 null 的一律当作“没设过”：只有 infoBackgroundTransparency 的合法值就是 null（关闭信息背景），单独放行；
 * 其余字段在 normalizeSettings 里只做宽松取值、不再校验，手工改坏的备份或旧版遗留的 null
 * 不该把一个 null 写进该尺寸的配置（根级取值同理，见 backup.ts 的 provided）。
 */
function profileOnly(value: unknown): Partial<WidgetOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as any
  return Object.fromEntries(PROFILE_KEYS
    .filter(key => Object.prototype.hasOwnProperty.call(source, key) && (source[key] !== null || (DEFAULTS as any)[key] === null))
    .map(key => [key, source[key]])) as Partial<WidgetOptions>
}
// 按 root 对象身份 × 尺寸缓存：同一份设置重渲染时返回同一个对象，
// 下游那些 WeakMap 记忆的取色 / 图片路径才能命中，不再每帧重算。
const sizeCache = new WeakMap<Settings, Partial<Record<WidgetSize, Settings>>>()
/** 把某个尺寸的独立配置叠到根配置上并归一化；settingsForSize 与 readSettingsForSize 共用。 */
function mergeForSize(source: Partial<Settings>, size: WidgetSize): Settings {
  const profile = profileOnly((source as any)?.profiles?.[size])
  // 去掉 profiles 再归一，避免每渲染一次就递归校验四份独立配置。
  const flat: any = { ...source }
  delete flat.profiles
  const merged = normalizeSettings({ ...flat, ...profile })
  // 大号 / 超大号的默认按钮更高；用户没单独给这个尺寸设过高度、根配置也还是默认高度时才用这份默认值。
  // 旧版本的按钮高度只存在根配置里：这里必须尊重根配置的自定义值，不能拿尺寸默认值把它盖掉。
  if (!Object.prototype.hasOwnProperty.call(profile, 'buttonHeight') && merged.buttonHeight === DEFAULTS.buttonHeight) merged.buttonHeight = defaultButtonHeightFor(size)
  return merged
}
export function settingsForSize(root: Settings, size: WidgetSize): Settings {
  let cache = sizeCache.get(root)
  if (!cache) { cache = {}; sizeCache.set(root, cache) }
  const hit = cache[size]
  if (hit) return hit
  cache[size] = mergeForSize(root, size)
  return cache[size]!
}
// 一次渲染里这份配置会被读两次（入口取 settings、校验确认票时 allowed 再取一次），
// 每次都是「读一遍存储 + 整份归一化」。渲染期间配置不会变，按尺寸存一份就够；
// saveSettings 落盘时会连这份一起清空，设置页改完照常生效。
const sizeMemo: Partial<Record<WidgetSize, Settings>> = {}
/**
 * 组件渲染热路径专用：直接读存储，只归一化「本尺寸」这一份配置。
 * 原来的 readSettings() + settingsForSize() 会归一化 6 遍（根 1 遍 + 四个尺寸的 profiles 各 1 遍 + 合并后再 1 遍），
 * 而组件一次渲染只用到自己那一份，这里合成 1 遍，结果与 settingsForSize(readSettings(), size) 完全等价。
 */
export function readSettingsForSize(size: WidgetSize): Settings {
  const hit = sizeMemo[size]
  if (hit) return hit
  let saved: Partial<Settings> = {}
  try { saved = Storage.get<Partial<Settings>>(KEY) || {} } catch { saved = {} }
  return (sizeMemo[size] = mergeForSize(saved, size))
}
/** 该尺寸没单独设置过按钮高度时的默认值：大号 / 超大号 44，小号 / 中号沿用根默认 31。 */
export const defaultButtonHeightFor = (size: WidgetSize): number =>
  ({ large: 44, extraLarge: 44 } as Partial<Record<WidgetSize, number>>)[size] ?? DEFAULTS.buttonHeight
export function withWidgetSettings(root: Settings, size: WidgetSize, patch: Partial<WidgetOptions>): Settings {
  const previous = profileOnly(root.profiles?.[size])
  return { ...root, profiles: { ...root.profiles, [size]: { ...previous, ...profileOnly(patch) } } }
}
export function withoutWidgetSettings(root: Settings, size: WidgetSize): Settings {
  const profiles = { ...root.profiles }; delete profiles[size]
  return { ...root, profiles }
}
export function widgetSizeFor(family: string, width: number, height: number): WidgetSize {
  const name = family.toLowerCase()
  const dashboard = name.includes('large') || height >= width * 1.15 || (width >= 500 && height >= 250)
  if (dashboard) return name.includes('extralarge') || height > 430 || width >= 500 ? 'extraLarge' : 'large'
  return name === 'systemsmall' || name === 'small' ? 'small' : 'medium'
}
function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
/** 挡位统一成字符串 '1' / '2' / '3'：数字和数字字符串都认，其余（含 0、小数、空串）回到 1 挡。 */
export function asSeatLevel(value: unknown): SeatLevel {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value))
    : typeof value === 'string' ? value.trim() : ''
  return SEAT_LEVELS.find(level => level === text) ?? '1'
}
// 一次渲染里 settings 始终是同一个对象，而这些取色/尺寸函数会被每个文本、每个按钮各调一次
// （fontColorOf 单独就要跑近 50 次）。这里按对象身份缓存纯计算结果：缓存随模块销毁而消失，
// 不会读到过期配置；设置变了对象也就换了身份，自然重算。
function memoized<T>(compute: (s: Settings) => T): (s: Settings) => T {
  const cache = new WeakMap<Settings, T>()
  return (s: Settings): T => {
    if (cache.has(s)) return cache.get(s) as T
    const value = compute(s)
    cache.set(s, value)
    return value
  }
}
export const visibleButtons = memoized((s: Settings) => s.buttons.slice(0, Math.round(bounded(s.buttonCount, 1, DEFAULTS.buttons.length, DEFAULTS.buttons.length))))
export const buttonHeightOf = memoized((s: Settings) => Math.round(bounded(s.buttonHeight, 14, 80, 31)))
// 图标线条粗细：按尺寸各一份（s 一般是 settingsForSize / readSettingsForSize 的结果），保留一位小数；
// 与 normalizeSettings 的范围、设置页输入范围保持一致。
export const buttonIconLineWidthOf = memoized((s: Settings) => Math.round(bounded(s.buttonIconLineWidth, 0.8, 3.2, 1.7) * 10) / 10)
// 图标大小：按尺寸各一份的百分比（50 – 200，100 = 原始大小），与线宽一样随尺寸分别保存。
export const buttonIconSizeOf = memoized((s: Settings) => Math.round(bounded(s.buttonIconSize, 50, 200, 100)))
// 座椅加热挡位：按按钮槽位取（每个按钮各一份），槽位没设置过或越界时回到 1 挡。
export function seatLevelOf(s: Settings, slot: number): SeatLevel { return s.seatLevels[slot] ?? '1' }
/** 启动 / 冷车 / 热车下发的运行时长范围（分钟，车机最多只接受 30），与设置页输入范围保持一致。 */
export const ENGINE_TIME_MIN = 1
export const ENGINE_TIME_MAX = 30
/** 该功能的出厂运行时长：启动 10 分钟，冷车 / 热车 30 分钟（与车机原来的固定值一致）。 */
export function defaultEngineTimeFor(action: string | undefined): number {
  return action === 'cool' || action === 'hot' ? 30 : 10
}
export function asEngineTime(value: unknown, fallback: number): number {
  return Math.round(bounded(value, ENGINE_TIME_MIN, ENGINE_TIME_MAX, fallback))
}
// 运行时长：按按钮槽位取（每个按钮各一份），旧配置缺这个字段时回到该功能的默认时长。
export function engineTimeOf(s: Settings, slot: number): number {
  return asEngineTime(s.engineTimes?.[slot], defaultEngineTimeFor(s.buttons[slot]))
}
/** 车辆中心页面里启动 / 冷车 / 热车按钮的运行时长：全局一份，在“组件设置 › 车辆中心”里调。 */
export function centerEngineTimeOf(s: Settings, action: 'engine' | 'cool' | 'hot'): number {
  const value = action === 'cool' ? s.centerCoolMinutes : action === 'hot' ? s.centerHotMinutes : s.centerEngineMinutes
  return asEngineTime(value, defaultEngineTimeFor(action))
}
const buttonRadiusBase = memoized((s: Settings) => Math.round(bounded(s.buttonRadius, -1, 60, DEFAULTS.buttonRadius)))
// 控制按钮圆角：-1 表示随高度自动（原有观感），其余按设定值，最大不超过高度的一半。
export function buttonRadiusOf(s: Settings, height: number, autoMax = 10): number {
  const value = buttonRadiusBase(s)
  return value < 0 ? Math.min(autoMax, height / 3) : Math.min(value, height / 2)
}
export function useAudiLogoOf(s: Settings): boolean { return s.useAudiLogo !== false }
// 车辆中心页面的位置卡片开关：全局生效（不分尺寸），默认显示。
export function centerAddressOf(s: Settings): boolean { return s.showCenterAddress !== false }
export const carScaleOf = memoized((s: Settings) => bounded(s.carScale, 30, 300, 100) / 100)
// 车辆中心中卡片的车辆大小：独立设置，不跟任何尺寸的“车图大小”联动。
export const centerCarScaleOf = memoized((s: Settings) => bounded(s.centerCarScale, 30, 300, 100) / 100)
// 奥迪车标的大小：与车辆图片大小拆开，两套数值互不影响（只在开启 Logo 时生效）。
export const centerLogoScaleOf = memoized((s: Settings) => bounded(s.centerLogoScale, 30, 300, DEFAULTS.centerLogoScale) / 100)
// 车辆中心页按钮图标大小：百分比（50 – 200，100 = 原始），只给 index.tsx 的按钮用，不进 PROFILE_KEYS。
export const centerIconSizeOf = memoized((s: Settings) => Math.round(bounded(s.centerIconSize, 50, 200, 100)))
// 车辆中心页按钮图标线条粗细：只给 index.tsx 的页面按钮用，不进 PROFILE_KEYS。
export const centerIconLineWidthOf = memoized((s: Settings) => Math.round(bounded(s.centerIconLineWidth, 0.8, 3.2, 1.7) * 10) / 10)
// 组件里的油量/电量进度条：长宽都可自定义，长度不超过内容宽度。
export const barSizeOf = memoized((s: Settings) => ({
  width: Math.round(bounded(s.barWidth, 20, 400, DEFAULTS.barWidth)),
  height: Math.round(bounded(s.barHeight, 1, 40, DEFAULTS.barHeight)),
}))
export const backgroundDimOf = memoized((s: Settings) => bounded(s.backgroundDim, 0, 100, 0) / 100)
export const COLOR_PRESETS = [
  { value: '', name: '默认颜色' }, { value: '#FFFFFF', name: '白色' },
  { value: '#111827', name: '黑色' }, { value: '#94A3B8', name: '灰色' },
  { value: '#38BDF8', name: '天蓝' }, { value: '#2563EB', name: '蓝色' },
  { value: '#34D399', name: '绿色' }, { value: '#FB923C', name: '橙色' },
  { value: '#F87171', name: '红色' }, { value: '#C4B5FD', name: '紫色' },
]
// 颜色字符串重复率极高（每个文本都拿同一个 fontColor 去解析），正则只跑一次就够。
const colorCache = new Map<string, string>()
export function normalizeColor(value: unknown, allowClear = false): string {
  if (typeof value !== 'string') return ''
  const key = (allowClear ? '1' : '0') + value
  const hit = colorCache.get(key)
  if (hit !== undefined) return hit
  let result = ''
  const color = value.trim()
  if (allowClear && color === 'clear') result = color
  else if (/^#[0-9a-f]{6}$/i.test(color)) result = color.toUpperCase()
  else if (/^#[0-9a-f]{3}$/i.test(color)) result = '#' + color.slice(1).split('').map(v => v + v).join('').toUpperCase()
  if (colorCache.size < 512) colorCache.set(key, result)
  return result
}
const fontScaleOf = memoized((s: Settings) => bounded(s.fontScale, 60, 200, 100))
export function fontSizeOf(s: Settings, base: number): number { return Math.round(base * fontScaleOf(s)) / 100 }
const customFontColor = memoized((s: Settings) => normalizeColor(s.fontColor))
export function fontColorOf(s: Settings, fallback: string): Color { return asColor(customFontColor(s) || fallback) }
function backgroundWithTransparency(value: string, transparency: number | null, fallbackRGB: number[], fallbackAlpha: number): Color {
  const color = normalizeColor(value, true)
  if (color === 'clear') return 'clear'
  // 旧配置没选过透明度时，沿用原始填充色。
  if (typeof transparency !== 'number' || !Number.isFinite(transparency)) return asColor(color || 'rgba(' + fallbackRGB.join(',') + ',' + fallbackAlpha + ')')
  const alpha = Math.round(100 - bounded(transparency, 0, 100, 0)) / 100
  if (alpha === 0) return 'clear'
  if (alpha === 1 && color) return asColor(color)
  const rgb = color ? [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16)) : fallbackRGB
  return asColor('rgba(' + rgb.join(',') + ',' + alpha + ')')
}
export const infoBackgroundOf = memoized((s: Settings) =>
  backgroundWithTransparency(s.infoBackgroundColor, s.infoBackgroundTransparency, [38, 61, 88], 0.8))
export const buttonBackgroundOf = memoized((s: Settings) =>
  backgroundWithTransparency(s.buttonBackgroundColor, s.buttonBackgroundTransparency, [2, 7, 18], 0.72))
// 图标颜色只有「未激活 / 激活」两档，和设置页那两个颜色框一一对应：
// 未激活 = 功能未生效那一档（buttonIconOnColor，默认白）；
// 激活 = 功能已经开启 / 已锁 / 已运行那一档（buttonIconOffColor，默认橙）。
// 字段名的 on / off 是历史命名，别按字面理解；这里留空也回落到默认色，旧配置（存空串）直接生效。
// 调用方直接传车辆真实状态（那枚按钮的 state）；寻车 / 冷车 / 热车没有开关两态、state 恒为 false，所以永远是未激活色。
const iconIdleColor = memoized((s: Settings) => normalizeColor(s.buttonIconOnColor))
const iconActiveColor = memoized((s: Settings) => normalizeColor(s.buttonIconOffColor))
export function buttonIconColorOf(s: Settings, active: boolean): string {
  return (active ? iconActiveColor(s) : iconIdleColor(s)) || (active ? ICON_ACTIVE_COLOR : ICON_IDLE_COLOR)
}
export function saveSettings(value: Settings): void {
  // 改之前那一份留着写日志：一次保存可能同时改好几个键（主题 + 三个配色、整个尺寸复位）。
  const before = readSettings()
  if (Storage.set(KEY, value) === false) throw new Error('设置保存失败，请重试')
  // 落盘后丢掉内存副本，下一次 readSettings / settingsForSize 拿到的就是新值。
  settingsMemo = null
  // 组件渲染热路径那份按尺寸的副本同样要失效，否则设置页保存后本轮仍读旧值。
  for (const size of Object.keys(sizeMemo) as WidgetSize[]) delete sizeMemo[size]
  logSettingsChange(before, value)
}
// 设置键 → 日志里的中文短名；缺省回落原始键名（新加的键忘了登记也能看出改了什么）。
const LABELS: Partial<Record<keyof WidgetOptions, string>> = {
  metricSlots: '信息卡片指标', stateSlots: '状态卡片项目',
  showMetrics: '显示指标区', showStates: '显示状态区', showTires: '显示胎压', showLocationCard: '位置卡片', showReminders: '用车提醒',
  theme: '主题', name: '名称', plate: '车牌', showPlate: '显示车牌',
  themeColor1: '主题起始色', themeColor2: '主题结束色', themeAccent: '主题强调色',
  showAddress: '显示地址', quote: '短句', showIcons: '显示图标', showStateText: '状态文字', showTemp: '车外温度', showWeather: '天气图标',
  buttonBackgroundTransparency: '按钮底透明度', infoBackgroundTransparency: '信息区透明度', infoBackgroundColor: '信息区底色',
  extraLargeBackground: '超大号背景图', fontScale: '字体大小', updateTimeStyle: '时间显示',
  buttonConfirmations: '二次确认', buttonIconOnColor: '图标未激活色', buttonIconOffColor: '图标激活色',
  buttonHeight: '按钮高度', showButtonLabels: '按钮文字', buttonIconLineWidth: '图标粗细', buttonIconSize: '图标大小',
  seatLevels: '座椅挡位', engineTimes: '运行时长', fontColor: '文字颜色', buttonBackgroundColor: '按钮底色',
  carScale: '车图大小', backgroundDim: '背景压暗', buttonCount: '按钮数量', buttons: '快捷按钮',
  barWidth: '进度条宽度', barHeight: '进度条高度', buttonRadius: '按钮圆角',
  useAudiLogo: '四环 Logo', showCenterAddress: '车辆中心地址', hideLocationRow: '隐藏位置行',
  centerCarScale: '中心车图大小', centerLogoScale: 'Logo 大小', centerIconSize: '中心图标大小', centerIconLineWidth: '中心图标粗细',
  centerEngineMinutes: '启动时长', centerCoolMinutes: '冷车时长', centerHotMinutes: '热车时长',
  islandEnabled: '灵动岛开关', islandConfirmEnabled: '二次确认灵动岛', islandDelay: '灵动岛延时',
  smallStyle: '小号样式', smallRingInfo: '圆环指标', lastButton: '最后一项指标',
  refreshMinutes: '刷新间隔', autoRefresh: '自动刷新',
  carImage: '车辆图片', centerCarImage: '中心车图', smallBackground: '小号背景图', mediumBackground: '中号背景图', largeBackground: '大号背景图',
  maintenanceDate: '保养日期', insuranceDate: '保险日期', inspectionDate: '年检日期', maintenanceKm: '保养里程',
}
/** 日志里的取值：布尔写成开/关，槽位数组翻译成功能名，图片路径只留尾部文件名。 */
function logValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (Array.isArray(value)) {
    if (key === 'buttons') return value.map(id => ACTIONS.find(a => a.id === id)?.name || String(id)).join(' / ')
    if (key === 'metricSlots' || key === 'stateSlots') return value.map(id => INFO_OPTIONS.find(o => o.id === id)?.name || String(id)).join(' / ')
    return value.join(' / ')
  }
  if (value === null || value === undefined || value === '') return '空'
  const text = String(value)
  return text.length > 18 ? '…' + text.slice(-14) : text
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : false
}
/** 顶层键逐项比对（只比 DEFAULTS 里登记过的键，profiles 单独比）。 */
function diffKeys(before: any, after: any, prefix: string): string[] {
  const out: string[] = []
  for (const key of Object.keys(DEFAULTS) as (keyof WidgetOptions)[]) {
    if (sameValue(before[key], after[key])) continue
    out.push(prefix + (LABELS[key] || String(key)) + ' ' + logValue(String(key), before[key]) + '→' + logValue(String(key), after[key]))
  }
  return out
}
function logSettingsChange(before: Settings, after: Settings): void {
  const changes = diffKeys(before, after, '')
  // 按尺寸各自的配置：日志里带上尺寸名，否则「字体大小 90→100」看不出改的是哪一个。
  for (const { id, name } of WIDGET_SIZES) {
    const prev = (before.profiles?.[id] || {}) as any
    const next = (after.profiles?.[id] || {}) as any
    changes.push(...diffKeys(prev, next, name + ' · '))
  }
  if (!changes.length) return
  logEvent('settings', changes.length === 1 ? '修改设置' : '修改设置（' + changes.length + ' 项）', summarize(changes))
}
export const THEMES = [
  { id: 'navy', name: '深海蓝', colors: ['#213A68', '#081426'], accent: '#7DD3FC' },
  { id: 'forest', name: '墨绿', colors: ['#184D47', '#071E20'], accent: '#6EE7B7' },
  { id: 'violet', name: '暮光紫', colors: ['#493566', '#171129'], accent: '#C4B5FD' },
  { id: 'graphite', name: '石墨黑', colors: ['#3B414A', '#101317'], accent: '#E2E8F0' },
  { id: 'wine', name: '酒红', colors: ['#643345', '#210E19'], accent: '#FDA4AF' },
]
// 主题是「渐变起始色 → 结束色 + 强调色」三件套；theme 为 'custom' 时改读用户自己存的三个色，
// 任一项没存或非法就退回深海蓝的对应色，避免整块背景变黑。
export const CUSTOM_THEME_ID = 'custom'
export const themeOf = memoized((s: Settings) => {
  const base = THEMES.find(t => t.id === s.theme) || THEMES[0]
  if (s.theme !== CUSTOM_THEME_ID) return base
  return {
    id: CUSTOM_THEME_ID, name: '自定义',
    colors: [normalizeColor(s.themeColor1) || base.colors[0], normalizeColor(s.themeColor2) || base.colors[1]],
    accent: normalizeColor(s.themeAccent) || base.accent,
  }
})
// 渐变对象每次渲染都要传给同一个 ZStack，缓存后不再重复建对象。
export const gradientOf = memoized((s: Settings) =>
  ({ gradient: themeOf(s).colors.map(asColor).map((color, i) => ({ color, location: i })), startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }))
// 缺省车图不再读脚本目录的 car.png，而是 `car-asset.ts` 从 Gitee 下好的缓存路径；
// 缓存是异步准备的（App 启动 / 组件渲染前），这里只负责给出路径。
export const imagePath = memoized((s: Settings) => s.carImage || defaultCarPath())
export const centerImagePath = memoized((s: Settings) => s.centerCarImage || defaultCarPath())
export function plateText(d: CarData, s: Settings): string { return s.showPlate ? s.plate.trim() || d.plate : '' }
export function dateValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, day] = value.split('-').map(Number)
  const date = new Date(y, m - 1, day)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day ? date.getTime() : null
}
/** 时间戳 → 设置里存的 YYYY-MM-DD（本地时区，日期选择的回写格式）。 */
export function dateText(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
export function reminderLines(s: Settings, d: CarData | null, now = Date.now()): string[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const lines: string[] = []
  for (const [label, value] of [['保养', s.maintenanceDate], ['保险', s.insuranceDate], ['年检', s.inspectionDate]]) {
    const due = dateValue(value)
    if (due === null) continue
    const days = Math.round((due - today.getTime()) / 86400000)
    lines.push(days < 0 ? label + '已逾期 ' + -days + ' 天' : days === 0 ? label + '今天到期' : label + '剩余 ' + days + ' 天')
  }
  const target = Number(s.maintenanceKm)
  if (d && d.mileage > 0 && target > 0) {
    const km = Math.round(target - d.mileage)
    lines.push(km > 0 ? '距下次保养 ' + km + ' km' : '已达保养里程（超出 ' + -km + ' km）')
  }
  return lines
}

