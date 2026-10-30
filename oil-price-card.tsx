// 车辆中心里的油价卡片：现价 + 下期调价预测。数据来自中石化公布的各省指导价。
import {
  Button,
  Circle,
  HStack,
  Image,
  Rectangle,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useState
} from 'scripting'
import { updateText } from './credentials'
import {
  areaOptionOf,
  companyOf,
  directionTextOf,
  fillLitersOf,
  gradeRowsOf,
  loadOilSnapshot,
  moneyText,
  netPriceOf,
  oilTypeOptionOf,
  predictedPriceOf,
  readOilSettings,
  refuelCostOf,
  refuelGradeOf,
  trendColorOf,
  trendSymbolOf,
  zoneOf,
  type OilForecast,
  type OilSettings,
  type OilSnapshot
} from './oil-price'

// 只采用最后一次请求的结果，避免快速切换地区时旧数据覆盖新数据。
let requestSeq = 0

function forecastLine(forecast: OilForecast | null): string {
  if (!forecast) return '调价信息获取中…'
  const head = directionTextOf(forecast)
  // 未知态只留一句文案：金额和调价日都是上次抓取的残留字段，拼在后面会让人以为是新数据。
  if (forecast.unknown) return head
  const amount = forecast.direction === 'stranded' || !forecast.change ? '' : ` ¥${moneyText(forecast.change)}/升`
  const when = forecast.adjustDate ? ` · ${forecast.adjustDate}调价` : ''
  return `${head}${amount}${when}`
}

// 字体尺度与上方「车况数据」面板（Metric）保持一致：标题 15 / 标签 10.5 / 数值 21 / 单位 11 / 正文 12。
// 整表导出给「油价设置」的预览区复用，改一次两处一起变，不会各改各的。
export const OIL_CARD_FONT = { title: 15, label: 10.5, value: 21, unit: 11, body: 12 }
const F_TITLE = OIL_CARD_FONT.title
const F_LABEL = OIL_CARD_FONT.label
const F_VALUE = OIL_CARD_FONT.value
const F_UNIT = OIL_CARD_FONT.unit
const F_BODY = OIL_CARD_FONT.body
// 油号列宽（表头与行必须用同一个值，否则列会错位）
const LABEL_WIDTH = 62
// 左上角油价图标方块边长（和下面两行字的总高对齐；改大改小时两行字自动居中）
const ICON_BOX = 40

function ColumnLabel({ text, align }: { text: string; align: 'leading' | 'trailing' }) {
  return (
    <Text
      font={F_LABEL}
      foregroundStyle="#7B879B"
      lineLimit={1}
      frame={align === 'leading' ? { width: LABEL_WIDTH, alignment: 'leading' } : { maxWidth: 'infinity', alignment: 'trailing' }}
    >
      {text}
    </Text>
  )
}

// 「油价是否变了」的判定依据：地区 + 各油号价格 + 调价预测 + 是否离线缓存 + 抓取时间。
// 抓取时间也算内容（卡片右上角就显示它），所以重抓一次即使价格没变也要刷新时间；
// 命中本地缓存时 updatedAt 还是当初写入的那个值，不会因此多重建一次。
function oilStampOf(snapshot: OilSnapshot | null): string {
  if (!snapshot) return ''
  const prices = snapshot.zones
    .map(zone => `${zone.name}:${zone.grades.map(grade => `${grade.type}=${grade.price}`).join(',')}`)
    .join('|')
  const f = snapshot.forecast
  const forecast = f ? `${f.direction}/${f.change}/${f.adjustDate}/${f.unknown ? 1 : 0}` : ''
  return `${snapshot.areaType}/${snapshot.region}#${prices}#${forecast}#${snapshot.stale ? 1 : 0}#${snapshot.updatedAt}`
}

export function OilPriceCard({
  reloadToken,
  remainingLiters = null,
  tankLiters = null,
  timeStyle = 'absolute',
  onRefuelPrice
}: {
  reloadToken: number
  /** 车机上报的剩余油量（升）；未上报传 null */
  remainingLiters?: number | null
  /** 油箱容量（升）；未知传 null */
  tankLiters?: number | null
  /** 抓取时间的展示口径，跟「通用设置 › 刷新时间显示」保持一致 */
  timeStyle?: 'absolute' | 'relative' | 'full'
  /** 加油油号折后单价（元/升）变化时回传，供车辆中心算每公里油费；拿不到传 null */
  onRefuelPrice?: (price: number | null) => void
}) {
  const [settings, setSettings] = useState<OilSettings>(readOilSettings)
  const [snapshot, setSnapshot] = useState<OilSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function refresh(next: OilSettings, force: boolean): Promise<void> {
    if (!next.enabled) {
      setLoading(false)
      return
    }
    requestSeq += 1
    const seq = requestSeq
    // 已经有（属于同一个地区的）数据显示时，自动重抓走静默通道：不切加载态，内容没变就整张卡片保持原样（卡片记忆）。
    const quiet = !force && snapshot !== null && snapshot.areaType === next.areaType
    if (!quiet) setLoading(true)
    setError('')
    try {
      const value = await loadOilSnapshot(next, force)
      if (seq !== requestSeq) return
      // 内容没变就把上一次的对象原样退回去，React 会跳过这次更新，卡片不重建。
      setSnapshot(prev => (oilStampOf(prev) === oilStampOf(value) ? prev : value))
      // 清态交给“最后一个完成的请求”（seq 闸门已经把更早的挡掉了）：
      // 静默刷新一旦丢弃了手动刷新的 loading，不在这里清就会让刷新图标一直转。
      setLoading(false)
    } catch (e: any) {
      if (seq !== requestSeq) return
      setError(e?.message || String(e))
      setLoading(false)
    }
  }

  useEffect(() => {
    const next = readOilSettings()
    // 设置没改动就沿用旧对象：进了设置页又原样退出，也不该算一次卡片重建。
    // readOilSettings 返回内存缓存的那个对象，只有 saveOilSettings 落盘后才换身份，
    // 所以直接比身份即可，不用每次重载都跑一次 JSON.stringify。
    setSettings(prev => (prev === next ? prev : next))
    refresh(next, false)
  }, [reloadToken])

  // 把「加油油号折后单价」报给车辆中心算每公里油费：卡片自己不展示这项，
  // 但上层为免重复拉一次油价，直接借用卡片已经拿到的数据。
  useEffect(() => {
    if (!onRefuelPrice) return
    const snap = snapshot && snapshot.areaType === settings.areaType ? snapshot : null
    const grade = refuelGradeOf(zoneOf(snap, settings), settings)
    onRefuelPrice(grade ? netPriceOf(grade, settings) : null)
  }, [snapshot, settings, onRefuelPrice])

  if (!settings.enabled) return null

  // 切地区后 snapshot 还停在上一地区（新数据要等下一次刷新才回来），直接拿它算价区与加满一箱
  // 会出现「新地区标题 + 旧地区价格」。地区对不上就先当没有数据。
  const current = snapshot && snapshot.areaType === settings.areaType ? snapshot : null
  const zone = zoneOf(current, settings)
  const rows = gradeRowsOf(zone, settings)
  const forecast = current?.forecast ?? null
  const tint = trendColorOf(forecast)
  const company = companyOf(settings.company)
  const areaLabel = areaOptionOf(settings.areaType).label
  const zoneName = zone?.name ? zone.name.replace(/^(汽油|柴油)价格[:：]/, '') : ''
  const placeText = zoneName ? `${areaLabel} · ${zoneName}` : `${areaLabel} · 全省`
  // 抓取时间：口径跟「通用设置 › 刷新时间显示」走，与车况面板、组件上的时间一致。
  const fetchedText = current ? updateText(current.updatedAt, Date.now(), timeStyle) : ''
  const footNotes = [
    settings.discount > 0 ? `已按每升优惠 ¥${moneyText(settings.discount)} 计算` : '',
    current?.stale ? '离线缓存' : ''
  ].filter(Boolean)

  // 加满一箱：还需加的升数 × 加油油号折后单价。数据不全时显示 -- 并说明原因。
  const refuelGrade = refuelGradeOf(zone, settings)
  const refuelPrice = refuelGrade ? netPriceOf(refuelGrade, settings) : 0
  const refuelShort = oilTypeOptionOf(settings.refuelType).shortLabel
  // 油箱容量：设置里手动指定优先，否则用车机上报值。
  const tankValue = settings.tankLiters > 0 ? settings.tankLiters : tankLiters
  const needLiters = fillLitersOf(tankValue, remainingLiters)
  const refuelCost = refuelCostOf(needLiters, refuelPrice)
  // 下一期差价：用同一升数乘预测单价再减一次，就是「等下次调价再加会多花（+）/少花（-）的钱」。
  // 预测未知或搁浅时没有参考价，直接不显示，不拿 0 充数。
  const nextRefuelCost = refuelPrice > 0 ? refuelCostOf(needLiters, predictedPriceOf(refuelPrice, forecast)) : null
  const refuelDelta =
    refuelCost != null && nextRefuelCost != null && forecast && !forecast.unknown && forecast.direction !== 'stranded'
      ? Math.round((nextRefuelCost - refuelCost) * 100) / 100
      : 0
  let refuelNote = ''
  if (zone && !refuelGrade) refuelNote = `本地区未公布 ${refuelShort}，可在油价设置里换一个加油油号`
  else if (needLiters == null) refuelNote = '车机暂未上报剩余油量，无法估算加满金额'
  else if (needLiters === 0) refuelNote = '油箱已满，无需加油'
  else refuelNote = `还需 ${needLiters.toFixed(1)} L × ¥${moneyText(refuelPrice)}/升`

  return (
    <ZStack frame={{ maxWidth: 'infinity' }}>
      <RoundedRectangle cornerRadius={20} fill="white" />
      <VStack alignment="leading" spacing={12} padding={18} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
        <HStack spacing={10} alignment="center">
          <ZStack frame={{ width: ICON_BOX, height: ICON_BOX }}>
            <RoundedRectangle cornerRadius={13} fill="#EDF3FD" />
            <Image systemName="fuelpump.fill" resizable scaleToFit foregroundStyle={company.tint} frame={{ width: 21, height: 21 }} />
          </ZStack>
          {/* 标题、预测两行放在同一列，整列与图标垂直居中：图标上下边跟着字走，不会一边虚一边实。 */}
          <VStack alignment="leading" spacing={3} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <HStack spacing={6} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
              <Text font={F_TITLE} fontWeight="semibold" foregroundStyle="#17243B">油价</Text>
              <Text font={F_UNIT} foregroundStyle="#8792A5" lineLimit={1} minScaleFactor={0.9}>{placeText}</Text>
              <Spacer minLength={8} />
              <Button action={() => refresh(settings, true)} buttonStyle="plain">
                <ZStack frame={{ width: 26, height: 26 }}>
                  <Circle fill="#F1F5FD" />
                  <Image
                    systemName="arrow.triangle.2.circlepath"
                    resizable
                    scaleToFit
                    foregroundStyle={loading ? '#9FB3D4' : '#426FC5'}
                    frame={{ width: 12, height: 12 }}
                  />
                </ZStack>
              </Button>
            </HStack>
            {/* 预测文案与抓取时间同一行、下边对齐：估算左对齐地区名，时间正好在刷新按钮正下方。 */}
            <HStack alignment="bottom" spacing={10} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
              <Text font={F_UNIT} foregroundStyle={tint} lineLimit={1} minScaleFactor={0.85} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>{forecastLine(forecast)}</Text>
              {fetchedText ? <Text font={F_LABEL} foregroundStyle="#9AA6B8" lineLimit={1}>{fetchedText}</Text> : null}
            </HStack>
          </VStack>
        </HStack>

        {error ? (
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <Text font={F_BODY} foregroundStyle="#B94C4C" lineLimit={2}>油价获取失败：{error}</Text>
            <Text font={F_LABEL} foregroundStyle="#9AA6B8" lineLimit={2}>可在「设置 · 通用设置 · 油价设置」更换地区后重试</Text>
          </VStack>
        ) : rows.length === 0 ? (
          <Text font={F_BODY} foregroundStyle="#7B879B" lineLimit={2}>
            {loading ? '正在获取油价…' : '该价区暂未公布所选油号，可在油价设置中调整油号'}
          </Text>
        ) : (
          <VStack alignment="leading" spacing={10} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <HStack spacing={0}>
              <ColumnLabel text="油号" align="leading" />
              <ColumnLabel text="现价（元/升）" align="trailing" />
              <ColumnLabel text="下期预测" align="trailing" />
            </HStack>
            {rows.map(grade => {
              const price = netPriceOf(grade, settings)
              const predicted = predictedPriceOf(price, forecast)
              return (
                <HStack key={grade.type} spacing={0}>
                  <Text font={F_VALUE} fontWeight="medium" foregroundStyle="#5A6A85" lineLimit={1} frame={{ width: LABEL_WIDTH, alignment: 'leading' }}>{grade.shortLabel}</Text>
                  <Text font={F_VALUE} fontWeight="semibold" foregroundStyle="#17243B" lineLimit={1} frame={{ maxWidth: 'infinity', alignment: 'trailing' }}>
                    {moneyText(price)}
                  </Text>
                  <HStack spacing={4} frame={{ maxWidth: 'infinity', alignment: 'trailing' }}>
                    <Text font={F_BODY} foregroundStyle={tint}>{trendSymbolOf(forecast)}</Text>
                    <Text font={F_VALUE} fontWeight="semibold" foregroundStyle={tint} lineLimit={1}>{moneyText(predicted)}</Text>
                  </HStack>
                </HStack>
              )
            })}
          </VStack>
        )}

        {zone ? (
          <ZStack frame={{ maxWidth: 'infinity' }}>
            <RoundedRectangle cornerRadius={14} fill="#F4F8FE" />
            <HStack alignment="center" spacing={10} padding={12} frame={{ maxWidth: 'infinity' }}>
              <VStack alignment="leading" spacing={3} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
                <Text font={F_LABEL} foregroundStyle="#7B879B" lineLimit={1}>{`加满一箱 · ${refuelShort}`}</Text>
                <Text font={F_LABEL} foregroundStyle="#8A97A8" lineLimit={2}>{refuelNote}</Text>
              </VStack>
              {refuelCost == null ? (
                <Text font={F_VALUE} fontWeight="semibold" foregroundStyle="#A9B3C3">--</Text>
              ) : (
                <HStack alignment="firstTextBaseline" spacing={3}>
                  <Text font={F_VALUE} fontWeight="semibold" foregroundStyle="#1F4FBF" lineLimit={1}>{`¥${moneyText(refuelCost)}`}</Text>
                  {refuelDelta !== 0 ? (
                    <Text font={F_BODY} fontWeight="medium" foregroundStyle={tint} lineLimit={1} minScaleFactor={0.8}>
                      {`${refuelDelta > 0 ? '+' : '-'}${moneyText(Math.abs(refuelDelta))}`}
                    </Text>
                  ) : null}
                </HStack>
              )}
            </HStack>
          </ZStack>
        ) : null}

        {footNotes.length > 0 ? (
          <VStack alignment="leading" spacing={8} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
            <Rectangle fill="#EEF1F6" frame={{ maxWidth: 'infinity', minHeight: 1, maxHeight: 1 }} />
            <Text font={F_LABEL} foregroundStyle="#9AA6B8" lineLimit={2}>
              {footNotes.join(' · ')}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    </ZStack>
  )
}
