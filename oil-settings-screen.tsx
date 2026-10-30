// 「通用设置 · 油价设置」：地区 / 价区 / 石油公司 / 展示油号 / 每升优惠 + 实时预览。
import { Button, HStack, List, Picker, Section, Spacer, Text, Toggle, VStack, useEffect, useState } from 'scripting'
import {
  MAX_CARD_TYPES,
  areaOptionOf,
  areaOptions,
  clearOilCache,
  companyOf,
  companyOptions,
  directionTextOf,
  loadForecast,
  loadZones,
  moneyText,
  netPriceOf,
  oilTypeOptions,
  predictedPriceOf,
  readOilSettings,
  saveOilSettings,
  trendColorOf,
  trendSymbolOf,
  type OilForecast,
  type OilSettings,
  type OilTypeId,
  type OilZone
} from './oil-price'
// 预测源清单与说明都在数据源模块里，设置页只负责展示和切换。
import { forecastSourceOptions, forecastSourceOf, type ForecastSourceId } from './oil-forecast-sources'
// 预览区字号直接取车辆中心油价卡片那一套，两处永远一致。
import { OIL_CARD_FONT } from './oil-price-card'

const DISCOUNT_PRESETS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1]
const CUSTOM_DISCOUNT = '__custom_discount__'
// 油箱容量预设（升）；0 = 跟随车机上报
const TANK_PRESETS = [0, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 100]
const CUSTOM_TANK = '__custom_tank__'

function errText(error: any): string {
  return error?.message || String(error)
}

/** 回显这次预测到底由哪个源产出：auto 可能落到估算上，以 estimated 为准。 */
function usedSourceLabel(forecast: OilForecast | null): string {
  if (!forecast) return '暂无结果'
  if (forecast.unknown) return '暂无结果'
  if (forecast.estimated || forecast.source === 'crude') return '原油变化率估算'
  return '汽油价格网'
}

// 「弹框输数字 + 范围校验」：取消或输错都返回 null，调用方只需要判断这一个值。
async function promptNumber(options: { title: string; defaultValue: string; placeholder: string; min: number; max: number; invalid: string }): Promise<number | null> {
  const text = await Dialog.prompt({ title: options.title, defaultValue: options.defaultValue, placeholder: options.placeholder })
  if (text == null) return null
  const value = Number(String(text).trim())
  if (!String(text).trim() || !Number.isFinite(value) || value < options.min || value > options.max) {
    await Dialog.alert({ title: '数值超出范围', message: options.invalid })
    return null
  }
  return value
}

// 切换地区是连点场景：先发后到会把上一轮的 zones / forecast 盖回来，只认最后一次请求。
let requestSeq = 0

export function OilPriceSettingsScreen() {
  const [settings, setSettings] = useState<OilSettings>(readOilSettings)
  const [zones, setZones] = useState<OilZone[]>([])
  const [zonesArea, setZonesArea] = useState('')
  const [forecast, setForecast] = useState<OilForecast | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /** 每次都基于落盘的设置合并，避免连续操作时用到旧的 state。 */
  function apply(patch: Partial<OilSettings>) {
    try {
      setSettings(saveOilSettings({ ...readOilSettings(), ...patch }))
    } catch (e: any) {
      void Dialog.alert({ title: '保存失败', message: errText(e) })
    }
  }

  async function fetchAll(areaType: string, force: boolean) {
    const seq = ++requestSeq
    setLoading(true)
    setError('')
    let failed = ''
    try {
      const list = await loadZones(areaType, force)
      if (seq !== requestSeq) return
      setZones(list)
      setZonesArea(areaType)
      const current = readOilSettings()
      if (current.areaType === areaType && current.areaZone >= list.length) apply({ areaZone: 0 })
    } catch (e: any) {
      if (seq !== requestSeq) return
      setZones([])
      setZonesArea(areaType)
      failed = errText(e)
    }
    try {
      const next = await loadForecast(areaType, force)
      if (seq !== requestSeq) return
      setForecast(next)
    } catch {
      if (seq !== requestSeq) return
      setForecast(null)
    }
    if (seq !== requestSeq) return
    setError(failed)
    setLoading(false)
  }

  useEffect(() => {
    fetchAll(readOilSettings().areaType, false)
  }, [])

  /** 换预测源：先落盘，再清掉该地区的预测与快照——快照里嵌着旧源的预测，不清会一直显示上一源的结果。 */
  function changeSource(next: ForecastSourceId) {
    apply({ forecastSource: next })
    clearOilCache(settings.areaType)
    void fetchAll(settings.areaType, true)
  }

  const ready = !loading && zonesArea === settings.areaType && zones.length > 0
  const zone = ready ? zones[Math.min(settings.areaZone, zones.length - 1)] : null
  const areaLabel = areaOptionOf(settings.areaType).label
  const company = companyOf(settings.company)
  const discountCustom = !DISCOUNT_PRESETS.includes(settings.discount)
  const tankCustom = settings.tankLiters > 0 && !TANK_PRESETS.includes(settings.tankLiters)
  const rows = zone
    ? settings.oilTypes
        .map(type => zone.grades.find(grade => grade.type === type))
        .filter((grade): grade is NonNullable<typeof grade> => Boolean(grade))
    : []
  // 一次算出本地区公布的油号，下面四处选项判断共用，不再逐项扫一遍 grades。
  const have = new Set(zone ? zone.grades.map(grade => grade.type) : [])
  const missing = settings.oilTypes.filter(type => !have.has(type))

  function changeArea(value: string) {
    apply({ areaType: value, areaZone: 0 })
    setLoading(true)
    fetchAll(value, false)
  }

  async function inputDiscount() {
    const value = await promptNumber({ title: '每升优惠（元）', defaultValue: settings.discount ? String(settings.discount) : '', placeholder: '0 – 2，最多两位小数', min: 0, max: 2, invalid: '请输入 0 – 2 之间的数字，最多两位小数' })
    if (value == null) return
    apply({ discount: Math.round(value * 100) / 100 })
  }

  async function inputTank() {
    const value = await promptNumber({ title: '油箱容量（升）', defaultValue: settings.tankLiters > 0 ? String(settings.tankLiters) : '', placeholder: '1 – 200，最多一位小数', min: 1, max: 200, invalid: '请输入 1 – 200 之间的升数，最多一位小数' })
    if (value == null) return
    apply({ tankLiters: Math.round(value * 10) / 10 })
  }

  function toggleType(type: OilTypeId, on: boolean) {
    // 以落盘的设置为基准：同一帧连点两次时 state 还是旧的，会互相覆盖。
    const current = readOilSettings().oilTypes
    if (on) {
      if (current.includes(type)) return
      if (current.length >= MAX_CARD_TYPES) {
        void Dialog.alert({ title: '最多选择 3 个油号', message: '卡片一行一个油号，选多了会显示不全。' })
        return
      }
      apply({ oilTypes: [...current, type] })
      return
    }
    if (!current.includes(type)) return
    if (current.length <= 1) {
      void Dialog.alert({ title: '至少保留一个油号', message: '全部取消后卡片就没有可展示的价格了。' })
      return
    }
    apply({ oilTypes: current.filter(item => item !== type) })
  }

  async function refreshNow() {
    // 只清当前地区：全量清理要同步写六十多次存储，而其它地区本来就有 TTL。
    clearOilCache(settings.areaType)
    await fetchAll(settings.areaType, true)
  }

  return (
    <List navigationTitle="油价设置">
      <Section
        header={<Text>显示</Text>}
        footer={<Text>关闭后车辆中心不显示油价卡片，这里的选择保留。</Text>}
      >
        <Toggle title="显示油价卡片" value={settings.enabled} onChanged={v => apply({ enabled: v })} />
      </Section>

      <Section
        header={<Text>地区与公司</Text>}
        footer={<Text>{`取${company.name}省级最高零售指导价；“石油公司”只影响配色与提示。`}</Text>}
      >
        <Picker title="地区" value={settings.areaType} onChanged={changeArea}>
          {areaOptions.map(area => <Text key={area.value} tag={area.value}>{area.label}</Text>)}
        </Picker>
        {ready && zones.length > 1 ? (
          <Picker title="价区" value={settings.areaZone} onChanged={(v: any) => apply({ areaZone: Number(v) })}>
            {zones.map(item => (
              <Text key={item.index} tag={item.index}>{item.name || `价区 ${item.index + 1}`}</Text>
            ))}
          </Picker>
        ) : null}
        <Picker title="石油公司" value={settings.company} onChanged={(v: any) => apply({ company: v })}>
          {companyOptions.map(item => <Text key={item.id} tag={item.id}>{item.name}</Text>)}
        </Picker>
        <Picker title="每升优惠" value={String(settings.discount)} onChanged={(v: any) => {
          if (v === CUSTOM_DISCOUNT) { void inputDiscount(); return }
          apply({ discount: Number(v) })
        }}>
          {DISCOUNT_PRESETS.map(value => (
            <Text key={String(value)} tag={String(value)}>{value === 0 ? '无优惠' : `优惠 ¥${moneyText(value)} / 升`}</Text>
          ))}
          {/* 自定义值单独一行回显（tag 用数值本身），末项「自定义…」才会一直可选可点。 */}
          {discountCustom ? <Text key="custom-discount" tag={String(settings.discount)}>{`自定义 ¥${moneyText(settings.discount)} / 升`}</Text> : null}
          <Text tag={CUSTOM_DISCOUNT}>{'自定义…（0 – 2 元）'}</Text>
        </Picker>
      </Section>

      <Section
        header={<Text>展示油号</Text>}
        footer={
          <Text>
            {`最多同时展示 ${MAX_CARD_TYPES} 个油号，按此顺序排列；本地区未公布的不会显示。`}
          </Text>
        }
      >
        {oilTypeOptions.map(option => {
          const available = have.has(option.value)
          return (
            <Toggle
              key={option.value}
              title={available ? option.label : `${option.label}（本地区未公布）`}
              value={settings.oilTypes.includes(option.value)}
              onChanged={v => toggleType(option.value, v)}
            />
          )
        })}
      </Section>

      <Section
        header={<Text>加油</Text>}
        footer={
          <Text>
            {'加满一箱 ≈ 还需升数 × 该油号现价（含优惠）；车机不报油量时只给提示。'}
          </Text>
        }
      >
        <Picker title="加油油号" value={settings.refuelType} onChanged={(v: any) => apply({ refuelType: v })}>
          {oilTypeOptions.map(option => {
            const available = have.has(option.value)
            return <Text key={option.value} tag={option.value}>{available ? option.label : `${option.label}（本地区未公布）`}</Text>
          })}
        </Picker>
        <Picker title="油箱容量" value={String(settings.tankLiters)} onChanged={(v: any) => {
          if (v === CUSTOM_TANK) { void inputTank(); return }
          apply({ tankLiters: Number(v) })
        }}>
          {TANK_PRESETS.map(liters => (
            <Text key={String(liters)} tag={String(liters)}>{liters === 0 ? '跟随车机' : `${liters} 升`}</Text>
          ))}
          {tankCustom ? <Text key="custom-tank" tag={String(settings.tankLiters)}>{`自定义 ${settings.tankLiters} 升`}</Text> : null}
          <Text tag={CUSTOM_TANK}>{'自定义…（1 – 200 升）'}</Text>
        </Picker>
      </Section>

      <Section
        header={<Text>调价预测</Text>}
        footer={<Text>{`${forecastSourceOf(settings.forecastSource).hint}\n带「估算」的结果仅供参考，最终以发改委公告为准。`}</Text>}
      >
        <Picker title="预测来源" value={settings.forecastSource} onChanged={(v: any) => changeSource(v as ForecastSourceId)}>
          {forecastSourceOptions.map(option => (
            <Text key={option.id} tag={option.id}>{option.label}</Text>
          ))}
        </Picker>
        <HStack spacing={8}>
          <Text font={OIL_CARD_FONT.body} foregroundStyle="#7A8494">本次结果</Text>
          <Spacer />
          <Text font={OIL_CARD_FONT.body} foregroundStyle="#4A566B">{usedSourceLabel(forecast)}</Text>
        </HStack>
      </Section>

      <Section
        header={<Text>预览</Text>}
        footer={
          <Text>
            {`预测来自第三方或原油推算，仅供参考。\n现价公布日${zone?.startDate ? `（${zone.startDate}）` : ''}，每 10 个工作日调价一次。`}
          </Text>
        }
      >
        {loading ? (
          <Text font={OIL_CARD_FONT.body} foregroundStyle="#7A8494">正在获取 {areaLabel} 油价…</Text>
        ) : error ? (
          <Text font={OIL_CARD_FONT.body} foregroundStyle="#B94C4C">获取失败：{error}</Text>
        ) : (
          <>
            <VStack alignment="leading" spacing={4}>
              <Text font={OIL_CARD_FONT.title} fontWeight="semibold">{`${areaLabel}${zone?.name ? ` · ${zone.name}` : ''} · ${company.short}`}</Text>
              <Text font={OIL_CARD_FONT.unit} foregroundStyle={trendColorOf(forecast)} lineLimit={2}>
                {forecast
                  ? `${directionTextOf(forecast)}${forecast.change ? ` ¥${moneyText(forecast.change)}/升` : ''}${forecast.adjustDate ? ` · ${forecast.adjustDate}调价` : ''}`
                  : '暂无调价预测'}
              </Text>
            </VStack>
            {rows.map(grade => {
              const price = netPriceOf(grade, settings)
              const predicted = predictedPriceOf(price, forecast)
              return (
                <HStack key={grade.type} spacing={8}>
                  <Text font={OIL_CARD_FONT.value} foregroundStyle="#4A566B">{grade.shortLabel}</Text>
                  <Spacer />
                  <Text font={OIL_CARD_FONT.value} fontWeight="semibold">{moneyText(price)}</Text>
                  <HStack spacing={4}>
                    <Text font={OIL_CARD_FONT.body} foregroundStyle={trendColorOf(forecast)}>{trendSymbolOf(forecast)}</Text>
                    <Text font={OIL_CARD_FONT.value} foregroundStyle={trendColorOf(forecast)}>{moneyText(predicted)}</Text>
                  </HStack>
                </HStack>
              )
            })}
            {missing.length ? (
              <Text font={OIL_CARD_FONT.body} foregroundStyle="#9A7B24" lineLimit={2}>
                {`本地区未公布：${missing.map(type => oilTypeOptions.find(o => o.value === type)?.shortLabel ?? type).join('、')}`}
              </Text>
            ) : null}
          </>
        )}
        <Button title={loading ? '正在刷新…' : '刷新油价数据'} action={() => { void refreshNow() }} />
      </Section>
    </List>
  )
}
