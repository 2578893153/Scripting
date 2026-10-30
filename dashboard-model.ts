import { bits, type CarData } from './api'
import { panelOpen, doorsOpen } from './vehicle-state'

export type StateItem = { label: string; value: string; alert: boolean }
type InfoItem = { label: string; value: string; unit: string; alert: boolean }

/** 该字段是否真的被车辆上报过（availability 由 api.loadCar 依据原始返回计算）。 */
export function known(d: CarData, key: string): boolean {
  return d.availability?.[key] === true
}

/** 位图字段里是否有任意一位被置起。原实现用 includes('1') 判断，遇到 10、12 之类数值会误报。 */
export function anyBitSet(value: unknown): boolean {
  const values = bits(value)
  return !!values && values.some(v => v > 0)
}

function closedState(label: string, value: unknown, available: boolean): StateItem {
  const values = available ? bits(value) : null
  if (!values) return { label, value: '未知', alert: false }
  const active = values.some(v => v > 0)
  return { label, value: active ? '未关闭' : '全部关闭', alert: active }
}

const TIRE_LABELS = ['左前胎压', '右前胎压', '左后胎压', '右后胎压']
const METRIC_KEYS = ['mileage', 'oil', 'fuelPct', 'battery']
const STATE_KEYS = ['windows', 'carDoor', 'carLamp', 'acOn', 'waterTemperature', 'heatSeat']

/** 单个里程 / 油量 / 电压指标，字段未上报时用 '--' 占位而不是 0。 */
function metricItem(d: CarData, key: string): InfoItem {
  switch (key) {
    case 'mileage': return { label: '累计里程', value: known(d, 'mileage') ? d.mileage.toFixed(0) : '--', unit: 'km', alert: false }
    case 'oil': return { label: '剩余油量', value: known(d, 'oil') ? d.oil.toFixed(0) : '--', unit: 'L', alert: known(d, 'fuelPct') && d.fuelPct < 10 }
    case 'fuelPct': return { label: '燃油余量', value: known(d, 'fuelPct') ? d.fuelPct.toFixed(0) : '--', unit: '%', alert: known(d, 'fuelPct') && d.fuelPct < 10 }
    default: return { label: '蓄电池', value: known(d, 'battery') ? d.battery.toFixed(1) : '--', unit: 'V', alert: known(d, 'battery') && d.battery > 0 && d.battery < 11.8 }
  }
}

/** 单个车身状态项（车窗、车门、车灯、空调、水温、座椅加热）。 */
function stateItem(d: CarData, key: string): StateItem {
  switch (key) {
    case 'windows': return closedState('车窗', d.windows, known(d, 'windows'))
    case 'carDoor': { const open = doorsOpen(d); return { label: '车门', value: open === null ? '未知' : open ? '未关闭' : '全部关闭', alert: open === true } }
    case 'carLamp': {
      const lamp = closedState('车灯', d.carLamp, known(d, 'carLamp'))
      // 车灯只有开 / 关，没有“全部关闭”的说法。
      if (lamp.value === '全部关闭') lamp.value = '已关闭'
      return lamp
    }
    case 'acOn': return { label: '空调', value: known(d, 'acOn') ? d.acOn ? '运行中' : '已关闭' : '未知', alert: false }
    case 'waterTemperature': return {
      label: '水温', value: known(d, 'waterTemperature') ? d.waterTemperature.toFixed(0) + '°C' : '未知',
      alert: known(d, 'waterTemperature') && d.waterTemperature > 110 && d.engineOn,
    }
    default: {
      const heat = known(d, 'heatSeat') ? bits(d.heatSeat) : null
      return { label: '座椅加热', value: heat ? anyBitSet(d.heatSeat) ? '已开启' : '已关闭' : '未知', alert: false }
    }
  }
}

export function parkingText(d: CarData): string { return known(d, 'locked') ? d.locked ? '已锁车' : '未锁车' : '车锁未知' }
export function engineText(d: CarData): string { return known(d, 'engineOn') ? d.engineOn ? '发动机运行中' : '发动机已熄火' : '发动机状态未知' }

export function tireItems(d: CarData) {
  return TIRE_LABELS.map((label, index) => {
    const value = d.tirePressures?.[index]
    return { label, value: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) + ' bar' : '未知' }
  })
}

function tireItem(d: CarData, index: number): InfoItem {
  const value = d.tirePressures?.[index]
  const available = typeof value === 'number' && Number.isFinite(value) && value >= 0
  return { label: TIRE_LABELS[index], value: available ? value!.toFixed(1) : '未知', unit: available ? 'bar' : '', alert: false }
}

function extraItem(d: CarData, id: string): InfoItem {
  switch (id) {
    case 'outsideTemp': return { label: '车外温度', value: known(d, 'outsideTemp') ? d.outsideTemp.toFixed(0) : '--', unit: '°C', alert: false }
    case 'locked': return { label: '车锁状态', value: known(d, 'locked') ? d.locked ? '已锁车' : '未锁车' : '未知', unit: '', alert: known(d, 'locked') && !d.locked }
    case 'engineOn': return { label: '发动机状态', value: known(d, 'engineOn') ? d.engineOn ? '运行中' : '已熄火' : '未知', unit: '', alert: known(d, 'engineOn') && d.engineOn }
    default: return { label: '在线状态', value: known(d, 'online') ? d.online ? '在线' : '离线' : '未知', unit: '', alert: false }
  }
}

/** 按用户选择的槽位顺序，只构造被选中的项（不再每次都算满 12 项）。 */
function itemById(d: CarData, id: string): InfoItem | null {
  if (id === 'trunkStatus' || id === 'hoodStatus') { const open = panelOpen(d, id === 'trunkStatus' ? 'trunk' : 'hood'); return { label: id === 'trunkStatus' ? '尾门状态' : '车盖状态', value: open === null ? '未知' : open ? '未关闭' : '已关闭', unit: '', alert: open === true } }
  if (METRIC_KEYS.includes(id)) return metricItem(d, id)
  if (STATE_KEYS.includes(id)) return { ...stateItem(d, id), unit: '' }
  const tireIndex = ['tireLF', 'tireRF', 'tireLR', 'tireRR'].indexOf(id)
  if (tireIndex >= 0) return d.provider === 'aojie' ? tireItem(d, tireIndex) : null
  if (id === 'outsideTemp' || id === 'locked' || id === 'engineOn' || id === 'online') return extraItem(d, id)
  return null
}

function selectedInfoItems(d: CarData, slots: string[]): InfoItem[] {
  const items: InfoItem[] = []
  for (const id of slots) {
    if (id === 'blank') continue
    const item = itemById(d, id)
    if (item) items.push(item)
  }
  return items
}

export function metricItems(d: CarData, slots: string[]): InfoItem[] {
  return selectedInfoItems(d, slots)
}

/** 车身状态行没有单位（itemById 里 unit 恒为空），取完直接用，不再拼一次空单位。 */
export function stateItems(d: CarData, slots: string[]): StateItem[] {
  return selectedInfoItems(d, slots)
}

/**
 * 大尺寸卡片的分区高度分配。
 * 高度魔法数字来自实测：header / metric / states / location / reminder / buttons
 * 都是各分区的最小可用高度，剩余空间全部给 hero（车图区域）。
 */
export function dashboardLayout(width: number, height: number, hasReminders: boolean, sections: { metricCount?: number; stateCount?: number; tires?: boolean; location?: boolean; buttonHeight?: number } = {}) {
  const wide = width / height >= 1.45 && width >= 500
  const compact = height < 430
  const pad = compact ? 12 : 18
  const gap = compact ? 5 : 10
  const header = compact ? 32 : 42
  const metric = sections.metricCount === 0 ? 0 : compact ? 42 : 60
  const stateRows = Math.ceil((sections.stateCount ?? 6) / 3)
  const stateBase = compact ? 62 : 96
  const states = stateRows ? 16 + ((stateBase - 20) / 2) * stateRows + 4 * (stateRows - 1) : 0
  const tires = sections.tires === false ? 0 : compact ? 26 : 34
  const location = sections.location === false ? 0 : compact ? 26 : 60
  const reminder = hasReminders ? compact ? 24 : 48 : 0
  // 按钮条高度直接跟“按钮高度”设置走，只受可用空间（车图至少留 20）夹一下。
  const buttonsBase = Math.max(20, Math.round(sections.buttonHeight ?? (compact ? 32 : 44)))
  const fixedHeight = header + metric + states + tires + location + reminder
  const gaps = [header, 1, metric, states, tires, location, reminder, buttonsBase].filter(value => value > 0).length - 1
  const buttonsCap = height - 2 * pad - fixedHeight - gap * gaps - 20
  const buttons = Math.max(20, Math.min(buttonsBase, buttonsCap))
  const hero = height - 2 * pad - header - metric - states - tires - location - reminder - buttons - gap * gaps
  return { wide, pad, gap, header, metric, states, tires, location, reminder, buttons, hero: Math.max(20, hero) }
}
