import { Button, ColorPicker, DatePicker, HStack, List, Navigation, NavigationLink, NavigationStack, Picker, RoundedRectangle, Section, SecureField, Spacer, Text, TextField, Toggle, VStack, ZStack, Widget, useState, Script, useEffect } from 'scripting'
import { DEFAULTS, THEMES, CUSTOM_THEME_ID, ACTIONS, COLOR_PRESETS, INFO_OPTIONS, WIDGET_SIZES, ICON_IDLE_COLOR, ICON_ACTIVE_COLOR, BUTTON_BG_COLOR, BUTTON_BG_TRANSPARENCY, ISLAND_DELAY_DEFAULT, ISLAND_DELAY_MIN, ISLAND_DELAY_MAX, normalizeColor, fontSizeOf, dateValue, dateText, centerAddressOf, useAudiLogoOf, readSettings, saveSettings, settingsForSize, withWidgetSettings, withoutWidgetSettings, buttonBackgroundOf, buttonHeightOf, buttonIconColorOf, buttonIconLineWidthOf, buttonIconSizeOf, seatLevelOf, SEAT_LEVELS, asSeatLevel, engineTimeOf, defaultEngineTimeFor, centerEngineTimeOf, ENGINE_TIME_MIN, ENGINE_TIME_MAX, buttonRadiusOf, defaultButtonHeightFor, themeOf, gradientOf, visibleButtons, type Settings, type WidgetSize, type WidgetOptions } from './settings'
import { isButtonLit } from './button-icons'
import { ButtonGlyph } from './button-glyph'
import { PROVIDERS, type ProviderChoice } from './providers'
import { readToken, saveToken, readAMapKey, saveAMapKey, currentProviderLabel, supportsTires, updateText } from './credentials'
import { backupToFile, restoreFromFile, lastBackupAt, resetAllData } from './backup'
import { endLeftoverActivities } from './action-activity'
import { compactSavedImage, saveWidgetImage, type ImageKey } from './image-assets'
import { OilPriceSettingsScreen } from './oil-settings-screen'
import { FuelReferenceScreen } from './fuel-settings-screen'
import { LogScreen } from './log-screen'

const SIZE_NAMES = Object.fromEntries(WIDGET_SIZES.map(size => [size.id, size.name]))
const BACKGROUND_KEYS = { small: 'smallBackground', medium: 'mediumBackground', large: 'largeBackground', extraLarge: 'extraLargeBackground' } as const
// 「车图资源」「一键抠图」两个入口的地址：四个尺寸的「车图与背景 · 车辆图片」页共用，
// 换地址只改这里。前者是阿里云盘分享（打包好的车图），后者是 remove.bg 在线抠图。
const CAR_ASSET_URL = 'https://www.aliyundrive.com/s/u3ssBhGtqUK'
const CUTOUT_URL = 'https://www.remove.bg/zh'
// 信息卡片选项只跟“是否支持胎压”有关：一页里最多 14 个 Picker 都要用，算一次就够。
let optionCache: { tires: boolean; items: (typeof INFO_OPTIONS)[number][] } | null = null
function cardOptions() {
  const tires = supportsTires()
  if (!optionCache || optionCache.tires !== tires) optionCache = { tires, items: INFO_OPTIONS.filter(item => tires || !item.id.startsWith('tire')) }
  return optionCache.items
}
function usePreferences(size?: WidgetSize) {
  const current = () => size ? settingsForSize(readSettings(), size) : readSettings()
  const [s, setS] = useState(current)
  // pageOnly：只影响本页面显示的键（车辆中心的 Logo / 大小 / 位置 / 冷暖车时长）。
  // 这些值在真正用到时才读盘（点按钮那一瞬），无需重载组件——一次重载等于拉一遍车况再建一整棵视图树。
  /** 只改一个键：直接复用 patch，落盘 / 回显 / 重绘都只有一份实现。 */
  async function update<K extends keyof WidgetOptions>(key: K, value: WidgetOptions[K], pageOnly = false) {
    await patch({ [key]: value } as Partial<WidgetOptions>, pageOnly)
  }
  /** 需要同时写多个键（例如主题 + 三个自定义配色）时用这个：只落一次盘、只刷新一次组件。 */
  async function patch(values: Partial<WidgetOptions>, pageOnly = false) {
    try {
      const root = readSettings()
      saveSettings(size ? withWidgetSettings(root, size, values) : { ...root, ...values })
      setS(current())
      if (!pageOnly) Widget.reloadAll()
    } catch (e) { await Dialog.alert({ title: '保存失败', message: String(e) }) }
  }
  return { s, update, patch }
}
function menu(title: string, subtitle: string, destination: any) {
  return <NavigationLink destination={destination}><VStack alignment="leading" spacing={4} padding={{ top: 4, bottom: 4 }}>
    <Text font={16}>{title}</Text><Text font={11} foregroundStyle="#7A8494">{subtitle}</Text>
  </VStack></NavigationLink>
}
function page(title: string, children: any) {
  return <List navigationTitle={title} navigationBarTitleDisplayMode="inline">{children}</List>
}
/**
 * 数值选择框：预设档位 +「自定义…」选项（不再单独占一行输入按钮）。
 * 1. value 不在预设里时，在预设下方单独回显当前自定义值（tag 用数值本身），
 *    「自定义…」那一行则**始终没被选中** —— 否则 Picker 选中项就是它，用户再点同一个选项不会触发 onChanged，弹窗永远打不开；
 * 2. 选中「自定义…」后弹窗输入，按 min–max 取整收敛，超出范围先提示，不会静默截断；
 * 3. 取消或输入非法时不动原值，Picker 会退回原来的档位（只有 onChanged 才写设置）。
 * 4. decimals > 0 时改用小数收敛（例如线条粗细 1.7），预设值不会被抹成整数。
 */
const CUSTOM_TAG = '__custom__'
function NumberPicker(props: {
  title: string; value: number; options: number[]; min: number; max: number
  label: (value: number) => string; hint: string; onChanged: (value: number) => void
  decimals?: number
}) {
  const { title, value, options, min, max, label, hint, onChanged, decimals = 0 } = props
  const unit = Math.pow(10, decimals)
  const quantize = (n: number) => Math.round(n * unit) / unit
  const custom = !options.includes(value)
  const selection: any = value
  async function input() {
    // 当前值不在可输入范围（例如“默认 / 自动”档）时留空，避免用户误存非法值
    const current = value >= min && value <= max ? String(value) : ''
    const text = await Dialog.prompt({ title: title + '（' + hint + '）', defaultValue: current, placeholder: hint })
    if (text == null) return
    const raw = String(text).trim(), number = Number(raw)
    if (!raw || !Number.isFinite(number)) { await Dialog.alert({ title: '请输入数字', message: hint }); return }
    const next = quantize(number)
    if (next < min || next > max) { await Dialog.alert({ title: '数值超出范围', message: hint }); return }
    onChanged(next)
  }
  return <Picker title={title} value={selection} onChanged={(v: any) => {
    // 选「自定义…」不直接改设置，先问用户要多少；取消就什么都不变
    if (v === CUSTOM_TAG) { input(); return }
    onChanged(quantize(Number(v)))
  }}>
    {options.map(option => <Text key={option} tag={option}>{label(option)}</Text>)}
    {/* 自定义值单独一行回显：tag 用数值本身，与下面「自定义…」的 tag 不同，所以后者永远可选。 */}
    {custom ? <Text key="custom-value" tag={value}>{'自定义 ' + label(value)}</Text> : null}
    <Text tag={CUSTOM_TAG}>{'自定义…（' + hint + '）'}</Text>
  </Picker>
}
const CUSTOM_COLOR_TAG = '__custom_color__'
// 主题已是自定义时，下拉里单独一行回显“当前自定义配色”，吃掉选中状态；
// 否则末项「自定义…」会被选中，再次点它不触发 onChanged（弹窗打不开）。
const CURRENT_THEME_TAG = '__theme_current__'
/**
 * 调色盘回传的值可能是 #RGB / #RRGGBB / #RRGGBBAA / rgba(...)，统一收敛成 #RRGGBB 再存，
 * 否则 normalizeColor 认不出就会退回默认色。认不出时保留原来的颜色。
 */
function colorToHex(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text)
  if (hex) {
    const digits = hex[1]
    if (digits.length <= 4) return ('#' + digits.slice(0, 3).split('').map(v => v + v).join('')).toUpperCase()
    return ('#' + digits.slice(0, 6)).toUpperCase()
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(text)
  if (rgb) return '#' + [1, 2, 3].map(i => Math.max(0, Math.min(255, Math.round(Number(rgb[i])))).toString(16).padStart(2, '0')).join('').toUpperCase()
  return normalizeColor(fallback) || '#FFFFFF'
}
/** 自定义颜色弹窗：调色盘选色 + 预览，点“使用此颜色”才回写，取消则什么都不改。 */
function CustomColorSheet({ initial, onPicked }: { initial: string; onPicked: (color: string | null) => void }) {
  const dismiss = Navigation.useDismiss()
  const [color, setColor] = useState<any>(initial)
  return <NavigationStack><List navigationTitle="自定义颜色">
    <Section footer={<Text>选好颜色后点“使用此颜色”，取消不变。</Text>}>
      <ColorPicker title="调色盘" value={color} onChanged={(v: any) => setColor(v)} supportsOpacity={false} />
      <HStack spacing={10} padding={{ top: 6, bottom: 6 }}>
        <RoundedRectangle cornerRadius={7} fill={color} frame={{ width: 44, height: 28 }} />
        <Text font={15} foregroundStyle={color}>Aa 123</Text>
        <Text font={11} foregroundStyle="#7A8494">{colorToHex(color, initial)}</Text>
      </HStack>
    </Section>
    <Section>
      <Button title="使用此颜色" action={() => { onPicked(colorToHex(color, initial)); dismiss() }} />
      <Button title="取消" action={() => { onPicked(null); dismiss() }} />
    </Section>
  </List></NavigationStack>
}
/**
 * 自定义主题配色弹窗：渐变起始色 / 结束色 + 强调色。
 * 三个颜色只存在本地 state，点“使用此配色”才一次性回写，拖动调色盘不会反复刷组件。
 */
type CustomTheme = { color1: string; color2: string; accent: string }
function CustomThemeSheet({ initial, onPicked }: { initial: { colors: string[]; accent: string }; onPicked: (theme: CustomTheme | null) => void }) {
  const dismiss = Navigation.useDismiss()
  const [color1, setColor1] = useState<any>(initial.colors[0])
  const [color2, setColor2] = useState<any>(initial.colors[1])
  const [accent, setAccent] = useState<any>(initial.accent)
  const preview: any = { gradient: [{ color: color1, location: 0 }, { color: color2, location: 1 }], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }
  const commit = (value: CustomTheme | null) => { onPicked(value); dismiss() }
  return <NavigationStack><List navigationTitle="自定义配色">
    <Section header={<Text>背景渐变</Text>} footer={<Text>左上到右下渐变；点任意一行打开调色盘。</Text>}>
      <ColorPicker title="渐变起始色" value={color1} onChanged={(v: any) => setColor1(v)} supportsOpacity={false} />
      <ColorPicker title="渐变结束色" value={color2} onChanged={(v: any) => setColor2(v)} supportsOpacity={false} />
      <RoundedRectangle cornerRadius={10} fill={preview} frame={{ height: 56 }} />
    </Section>
    <Section header={<Text>强调色</Text>} footer={<Text>用于图标激活态、进度条等，不影响背景。</Text>}>
      <ColorPicker title="强调色" value={accent} onChanged={(v: any) => setAccent(v)} supportsOpacity={false} />
      <HStack spacing={10} padding={{ top: 6, bottom: 6 }}>
        <RoundedRectangle cornerRadius={7} fill={accent} frame={{ width: 44, height: 28 }} />
        <Text font={15} foregroundStyle={accent}>Aa 123</Text>
        <Text font={11} foregroundStyle="#7A8494">{colorToHex(accent, initial.accent)}</Text>
      </HStack>
    </Section>
    <Section>
      <Button title="使用此配色" action={() => commit({ color1: colorToHex(color1, initial.colors[0]), color2: colorToHex(color2, initial.colors[1]), accent: colorToHex(accent, initial.accent) })} />
      <Button title="取消" action={() => commit(null)} />
    </Section>
  </List></NavigationStack>
}
export function SettingsScreen() {
  const dismiss = Navigation.useDismiss()
  // 车辆中心是全局页面，这里的开关写入根配置，不跟尺寸走。
  const { s, update } = usePreferences()
  return <NavigationStack><List navigationTitle="组件设置" toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}>
    <Section header={<Text>按尺寸设置</Text>} footer={<Text>四种尺寸独立保存，改一个不影响其他。</Text>}>
      {WIDGET_SIZES.map(size => <VStack key={size.id}>{menu(size.name, size.id === 'small' ? '信息卡片 / 油量圆环' : size.id === 'medium' ? '横向车况与快捷按钮' : '自定义信息卡片与车辆面板', <SizeSettingsScreen size={size.id} />)}</VStack>)}
    </Section>
    <Section header={<Text>通用设置</Text>}>
      {menu('授权与地图', 'Token、高德 Web 服务 Key', <AuthorizationScreen />)}
      {menu('车辆资料', '默认名称与车牌，供未单独修改的尺寸使用', <VehicleDefaultsScreen />)}
      {menu('用车提醒', '保养、保险、年检与保养里程', <ReminderScreen />)}
      {menu('油价设置', '地区、价区、石油公司与下期油价预测', <OilPriceSettingsScreen />)}
      {menu('油耗参考', '小熊油耗车系加权，本机样本不足时兜底', <FuelReferenceScreen />)}
      {menu('灵动岛设置', '实时活动提示与震动延时', <IslandSettingsScreen />)}
    </Section>
    {/* 图标粗细 / 大小已移进四个尺寸各自的「快捷按钮」页：每一份只作用于那个尺寸的组件。 */}
    <Section header={<Text>车辆中心</Text>} footer={<Text>{`只影响车辆中心页面；这里的 logo、车图、时长与图标大小都和组件设置分开存。`}</Text>}>

      <Toggle title="使用奥迪四环 Logo" value={useAudiLogoOf(s)} onChanged={v => update('useAudiLogo', v, true)} />
      {/* Logo 与车辆图片互斥：开着 Logo 时整个车辆图片设置（大小、选图、恢复内置）都不显示。 */}
      {useAudiLogoOf(s)
        ? <NumberPicker title="Logo 大小" value={s.centerLogoScale} options={[60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 200]} min={30} max={300} hint="30 – 300 %"
          label={v => v + '%' + (v === 80 ? '（默认）' : '')} onChanged={v => update('centerLogoScale', v, true)} />
        : <>
          <NumberPicker title="车辆大小" value={s.centerCarScale} options={[60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 200]} min={30} max={300} hint="30 – 300 %"
            label={v => v + '%' + (v === 100 ? '（默认）' : '')} onChanged={v => update('centerCarScale', v, true)} />
          <Button title={s.centerCarImage ? '更换车辆中心车图' : '选择车辆中心车图'} action={async () => {
            try { const photo = (await Photos.pickPhotos(1))[0]; if (!photo) return; const path = await saveWidgetImage(photo, 'centerCarImage', 'medium'); await update('centerCarImage', path, true) }
            catch (e) { await Dialog.alert({ title: '选择图片失败', message: String(e) }) }
          }} />
          {s.centerCarImage ? <Button title="恢复内置车辆中心车图" action={() => update('centerCarImage', '', true)} /> : null}
        </>}
      <Toggle title="显示车辆位置" value={centerAddressOf(s)} onChanged={v => update('showCenterAddress', v, true)} />
      {/* 车辆中心页的按钮图标大小单独一份：与各尺寸「快捷按钮」里的“图标大小”互不影响，只在本页生效。 */}
      <NumberPicker title="按钮图标大小" value={s.centerIconSize} options={[80, 90, 100, 110, 120, 140]} min={50} max={200}
        hint="50 – 200 %，100 为原始大小" label={v => v + '%' + (v === 100 ? '（默认）' : '')} onChanged={v => update('centerIconSize', v, true)} />
      <NumberPicker title="按钮图标线条粗细" value={s.centerIconLineWidth} options={[1.2, 1.5, 1.7, 2.0, 2.4, 2.8]} min={0.8} max={3.2} decimals={1}
        hint="0.8 – 3.2，可自定义到 0.1" label={v => v.toFixed(1) + (v === 1.7 ? '（默认）' : '')} onChanged={v => update('centerIconLineWidth', v, true)} />
      {/* 车辆中心的启动 / 冷车 / 热车是三个固定按钮，没有槽位，所以时长在这里各存一份（全局，不跟尺寸）。 */}
      <NumberPicker title="启动运行时间" value={centerEngineTimeOf(s, 'engine')} options={[5, 10, 15, 20, 25, 30]} min={ENGINE_TIME_MIN} max={ENGINE_TIME_MAX}
        hint={'1 – ' + ENGINE_TIME_MAX + ' 分钟（车机上限）'} label={v => v + ' 分钟' + (v === 10 ? '（默认）' : '')} onChanged={v => update('centerEngineMinutes', v, true)} />
      <NumberPicker title="冷车运行时间" value={centerEngineTimeOf(s, 'cool')} options={[5, 10, 15, 20, 25, 30]} min={ENGINE_TIME_MIN} max={ENGINE_TIME_MAX}
        hint={'1 – ' + ENGINE_TIME_MAX + ' 分钟（车机上限）'} label={v => v + ' 分钟' + (v === 30 ? '（默认）' : '')} onChanged={v => update('centerCoolMinutes', v, true)} />
      <NumberPicker title="热车运行时间" value={centerEngineTimeOf(s, 'hot')} options={[5, 10, 15, 20, 25, 30]} min={ENGINE_TIME_MIN} max={ENGINE_TIME_MAX}
        hint={'1 – ' + ENGINE_TIME_MAX + ' 分钟（车机上限）'} label={v => v + ' 分钟' + (v === 30 ? '（默认）' : '')} onChanged={v => update('centerHotMinutes', v, true)} />
    </Section>
    <Section header={<Text>数据管理</Text>}>
      {menu('备份/恢复', '备份、恢复与重置全部设置', <BackupScreen />)}
      {menu('日志', '指令、设置变更与报错', <LogScreen />)}
      {/* 名称和版本号都读 script.json（Script.metadata），不手写，避免和清单不一致。 */}
      <Text font={11} foregroundStyle="#7A8494">{`${Script.metadata.name || '小组件车联'} · ${Script.metadata.version || '未知版本'}`}</Text>
    </Section>
  </List></NavigationStack>
}
function SizeSettingsScreen({ size }: { size: WidgetSize }) {
  const dashboard = size === 'large' || size === 'extraLarge'
  async function restore() {
    await Navigation.present({ element: <ResetConfirmation title="恢复此尺寸原配置" detail="只清除当前尺寸，改回沿用根级配置。" onReset={async () => { saveSettings(withoutWidgetSettings(readSettings(), size)) }} /> })
  }
  return page(SIZE_NAMES[size], <>
    <Section header={<Text>内容</Text>}>
      {menu('显示内容与布局', '名称、车牌、位置与状态显示', <DisplayScreen size={size} />)}
      {dashboard ? menu('信息卡片内容', '选择每张卡片的信息，隐藏不需要的区域', <CardContentScreen size={size} />) : null}
    </Section>
    <Section header={<Text>外观</Text>}>
      {menu('字体与配色', '字号、文字颜色、背景颜色与透明度', <AppearanceScreen size={size} />)}
      {menu('车图与背景', '车辆图片、车图大小、背景图片与明暗', <ImagesScreen size={size} />)}
    </Section>
    <Section header={<Text>操作与刷新</Text>}>
      {menu('快捷按钮', '每个按钮的功能与二次确认', <ButtonsScreen size={size} />)}
      {menu('刷新设置', '自动获取、期望间隔与时间显示', <RefreshScreen size={size} />)}
    </Section>
    <Section header={<Text>预览与恢复</Text>}>
      {size !== 'extraLarge' ? <Button title={'预览' + SIZE_NAMES[size]} action={async () => { await Widget.preview({ family: size === 'small' ? 'systemSmall' : size === 'medium' ? 'systemMedium' : 'systemLarge' }) }} /> : <Text font={12} foregroundStyle="#7A8494">超大号请在桌面添加对应尺寸后查看。</Text>}
      <Button title="恢复此尺寸原配置" action={restore} />
    </Section>
  </>)
}
function AuthorizationScreen() {
  const [token, setToken] = useState(''), [amapKey, setAMapKey] = useState('')
  const [hasToken, setHasToken] = useState(() => !!readToken()), [hasAMapKey, setHasAMapKey] = useState(() => !!readAMapKey())
  const [providerLabel, setProviderLabel] = useState(currentProviderLabel)
  const [choice, setChoice] = useState<ProviderChoice>('auto')
  const [busy, setBusy] = useState(false)
  const [guard] = useState(() => ({ busy: false }))
  async function store(kind: 'token' | 'map') {
    if (guard.busy) return
    guard.busy = true; setBusy(true)
    try {
      if (kind === 'token') {
        const provider = await saveToken(token, choice)
        setToken(''); setHasToken(!!readToken()); setProviderLabel(currentProviderLabel())
        Widget.reloadAll()
        await Dialog.alert({ title: '识别成功', message: '已切换为' + PROVIDERS[provider].label + '。返回车辆中心刷新车况后生效。' })
      } else {
        saveAMapKey(amapKey); setAMapKey(''); setHasAMapKey(!!readAMapKey()); Widget.reloadAll()
        await Dialog.alert({ title: '已保存', message: '地图设置已保存。' })
      }
    } catch (e) { await Dialog.alert({ title: '保存失败', message: String(e) }) }
    finally { guard.busy = false; setBusy(false) }
  }
  return page('授权与地图', <>
    <Section header={<Text>账号授权 · 自动识别</Text>} footer={<Text>填 Authorization 完整值；保存时自动选用可用的只读接口，Token 存钥匙串。</Text>}>
      <Text>{hasToken ? '当前服务：' + providerLabel : '尚未配置 Token'}</Text>
      <SecureField title="Authorization Token" value={token} onChanged={setToken} prompt="粘贴完整 Token，自动识别服务" />
      {/* Picker 回传的是裸值（string/number），这里做一次收敛，避免类型报错。 */}
      <Picker title="识别方式" value={choice} onChanged={(value: any) => setChoice(value as ProviderChoice)}>
        <Text tag="auto">自动识别（推荐）</Text><Text tag="aozhilian">仅验证奥智联</Text><Text tag="aojie">仅验证奥捷智行</Text>
      </Picker>
      <Button title={busy ? '正在验证，请稍候…' : '识别并保存 Token'} action={() => store('token')} />
    </Section>
    <Section header={<Text>高德地图（可选）</Text>} footer={<Text>填高德 Web 服务 Key；留空或失败时用系统解析，Key 存钥匙串。</Text>}>
      <Text>{hasAMapKey ? '已配置高德 Key' : '未配置，使用系统地址解析'}</Text>
      <SecureField title="高德 Web 服务 Key" value={amapKey} onChanged={setAMapKey} prompt="填写自己的 Key，留空停用" />
      <Button title="保存 / 清除高德 Key" action={() => store('map')} />
    </Section>
  </>)
}
function VehicleDefaultsScreen() {
  const { s, update } = usePreferences()
  return page('车辆资料', <>
    <Section header={<Text>车辆名称</Text>}>
      <TextField title="默认车型名称" value={s.name} onChanged={v => update('name', v)} prompt="留空使用接口名称" />
    </Section>
    <Section header={<Text>车牌</Text>} footer={<Text>未单独设置的尺寸沿用这里；留空用接口信息。</Text>}>
      <TextField title="默认车牌" value={s.plate} onChanged={v => update('plate', v)} prompt="留空使用接口车牌" />
    </Section>
  </>)
}
function DisplayScreen({ size }: { size: WidgetSize }) {
  const { s, update } = usePreferences(size)
  return page(SIZE_NAMES[size] + ' · 显示内容', <>
    {size === 'small' ? <Section header={<Text>布局</Text>}><Picker title="小号布局" value={s.smallStyle} onChanged={(v: string) => update('smallStyle', v)}><Text tag="classic">信息卡片</Text><Text tag="ring">油量圆环</Text></Picker></Section> : null}
    {size === 'small' && s.smallStyle === 'ring' ? <Section header={<Text>油量圆环</Text>} footer={<Text>选车图下方显示的信息；“不显示”隐藏该行。</Text>}>
      <Picker title="车图下方显示内容" value={!supportsTires() && s.smallRingInfo.startsWith('tire') ? 'blank' : s.smallRingInfo} onChanged={(v: string) => update('smallRingInfo', v)}>
        {cardOptions().map(item => <Text key={item.id} tag={item.id}>{item.name}</Text>)}
      </Picker>
    </Section> : null}
    <Section header={<Text>车辆名称</Text>}>
      <TextField title="自定义车型名称" value={s.name} onChanged={v => update('name', v)} prompt="留空使用接口名称" />
    </Section>
    <Section header={<Text>车辆信息</Text>} footer={<Text>温度优先用车外温度；告警文字开关只在中号生效。</Text>}>
      <Toggle title="显示车牌" value={s.showPlate} onChanged={v => update('showPlate', v)} />
      {s.showPlate ? <TextField title="自定义车牌" value={s.plate} onChanged={v => update('plate', v)} prompt="留空使用接口车牌" /> : null}
      <Toggle title="隐藏地址一行" value={s.hideLocationRow} onChanged={v => update('hideLocationRow', v)} />
      {s.hideLocationRow ? null : <>
        <Toggle title="显示车辆地址" value={s.showAddress} onChanged={v => update('showAddress', v)} />
        {!s.showAddress ? <TextField title="替代短句" value={s.quote} onChanged={v => update('quote', v)} /> : null}
      </>}
      {size === 'small' || size === 'medium' ? <Toggle title="显示状态图标" value={s.showIcons} onChanged={v => update('showIcons', v)} /> : null}
      {size === 'medium' ? <Toggle title="告警文字（仅一条时）" value={s.showStateText} onChanged={v => update('showStateText', v)} /> : null}
      <Toggle title="显示天气图标" value={s.showWeather} onChanged={v => update('showWeather', v)} />
      <Toggle title="显示车外温度" value={s.showTemp} onChanged={v => update('showTemp', v)} />
    </Section>
  </>)
}
function CardContentScreen({ size }: { size: WidgetSize }) {
  const { s, update } = usePreferences(size)
  function slots(key: 'metricSlots' | 'stateSlots') {
    return s[key].map((value, index) => <Picker key={index} title={'第 ' + (index + 1) + ' 个位置'} value={value} onChanged={(v: string) => {
      const latest = settingsForSize(readSettings(), size)
      const values = [...latest[key]]; values[index] = v; update(key, values)
    }}>{cardOptions().map(item => <Text key={item.id} tag={item.id}>{item.name}</Text>)}</Picker>)
  }
  return page(SIZE_NAMES[size] + ' · 信息卡片', <>
    <Section footer={<Text>只改当前尺寸；无读数时显示“未知”或“--”。</Text>} />
    <Section header={<Text>数据卡片 · 最多 4 项</Text>}><Toggle title="显示数据卡片" value={s.showMetrics} onChanged={v => update('showMetrics', v)} />{s.showMetrics ? slots('metricSlots') : null}</Section>
    <Section header={<Text>状态卡片 · 最多 6 项</Text>}><Toggle title="显示状态卡片" value={s.showStates} onChanged={v => update('showStates', v)} />{s.showStates ? slots('stateSlots') : null}</Section>
    <Section header={<Text>其他区域</Text>}>
      {supportsTires() ? <Toggle title="显示四轮胎压栏" value={s.showTires} onChanged={v => update('showTires', v)} /> : null}
      <Toggle title="显示位置 / 短句卡片" value={s.showLocationCard} onChanged={v => update('showLocationCard', v)} />
      <Toggle title="显示用车提醒" value={s.showReminders} onChanged={v => update('showReminders', v)} />
    </Section>
  </>)
}
function AppearanceScreen({ size }: { size: WidgetSize }) {
  const { s, update, patch } = usePreferences(size)
  /**
   * 主题下拉：选预设直接写；选「自定义…」弹调色盘，预填当前主题的三个色，
   * 确认后一次性把 theme + 三个色写进去，取消则什么都不改。
   */
  async function pickTheme(value: string) {
    if (value !== CUSTOM_THEME_ID) { update('theme', value); return }
    const current = themeOf(s)
    const result = { value: null as CustomTheme | null }
    await Navigation.present({ element: <CustomThemeSheet initial={{ colors: current.colors, accent: current.accent }} onPicked={theme => { result.value = theme }} /> })
    const picked = result.value
    if (picked) await patch({ theme: CUSTOM_THEME_ID, themeColor1: picked.color1, themeColor2: picked.color2, themeAccent: picked.accent })
  }
  // 与组件用同一份渐变（gradientOf 已按设置对象缓存），不再手写一遍同样的结构。
  const themePreview: any = gradientOf(s)
  type ColorKey = 'fontColor' | 'buttonBackgroundColor' | 'buttonIconOnColor' | 'buttonIconOffColor' | 'infoBackgroundColor'
  // defaultColor：这个颜色键有内置默认色时传进来。传了就不列「默认颜色」那一项，
  // 空串直接回显成那个默认色、并在它的预设项后面标「（默认）」。
  function colorPicker(key: ColorKey, title: string, defaultColor?: string) {
    const transparencyKey = key === 'infoBackgroundColor' ? 'infoBackgroundTransparency' : key === 'buttonBackgroundColor' ? 'buttonBackgroundTransparency' : null
    const stored = s[key]
    // 'clear'（显式选的透明背景）不是合法色值，别让它被当成“没设置”回显成默认色，否则
    // 页面看起来是不透明的白，而组件其实是全透明。
    const value = stored === 'clear' ? 'clear' : defaultColor && !normalizeColor(stored) ? defaultColor : stored
    // 当前值不在预设里（且不是“透明背景”）就是自定义颜色：单独一行回显它，
    // 「自定义…」那一行因此始终没被选中，再点一次仍会弹调色盘。
    const custom = value !== 'clear' && !COLOR_PRESETS.some(color => color.value === value)
    async function pickCustom() {
      const result = { value: null as string | null }
      await Navigation.present({ element: <CustomColorSheet initial={normalizeColor(value) || '#FFFFFF'} onPicked={color => { result.value = color }} /> })
      if (result.value) await update(key, result.value)
    }
    return <Section header={<Text>{title}</Text>} footer={transparencyKey ? <Text>0% 不透明，100% 全透明；“透明背景”时始终透明。</Text> : undefined}>
      <Picker title="颜色" value={value} onChanged={(v: string) => {
        // 选“自定义…”先弹调色盘，只有确认了才写设置；取消则 Picker 退回原档位。
        if (v === CUSTOM_COLOR_TAG) { pickCustom(); return }
        update(key, v)
      }}>
        {COLOR_PRESETS.filter(color => !(defaultColor && color.value === '')).map(color => <Text key={color.value} tag={color.value}>{color.name + (color.value === defaultColor ? '（默认）' : '')}</Text>)}
        {transparencyKey ? <Text tag="clear">透明背景</Text> : null}
        {custom ? <Text key="custom-color" tag={value}>{'自定义 ' + value}</Text> : null}
        <Text tag={CUSTOM_COLOR_TAG}>{'自定义…（调色盘）'}</Text>
      </Picker>
      {transparencyKey === 'buttonBackgroundTransparency' ? <NumberPicker title="背景透明度" value={s.buttonBackgroundTransparency ?? BUTTON_BG_TRANSPARENCY} options={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]} min={0} max={100}
        hint="0 – 100 %，0 不透明、100 完全透明" label={v => v + '%' + (v === BUTTON_BG_TRANSPARENCY ? '（默认）' : v === 0 ? '（不透明）' : v === 100 ? '（完全透明）' : '')}
        onChanged={v => update('buttonBackgroundTransparency', v)} /> : null}
      {transparencyKey === 'infoBackgroundTransparency' ? <NumberPicker title="背景透明度" value={s.infoBackgroundTransparency ?? -1} options={[-1, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]} min={0} max={100}
        hint="0 – 100 %，0 不透明、100 完全透明" label={v => v < 0 ? '默认（保持原效果）' : v + '%' + (v === 0 ? '（不透明）' : v === 100 ? '（完全透明）' : '')}
        onChanged={v => update('infoBackgroundTransparency', v === -1 ? null : v)} /> : null}
    </Section>
  }
  return page(SIZE_NAMES[size] + ' · 字体与配色', <>
    <Section header={<Text>主题</Text>} footer={<Text>自定义配色按尺寸保存，切回预设也不会丢。</Text>}>
      <Picker title="主题配色" value={s.theme === CUSTOM_THEME_ID ? CURRENT_THEME_TAG : s.theme} onChanged={(v: string) => {
        // “当前自定义配色”只是回显，点它不改任何东西；要改得点下面的「自定义…」。
        if (v === CURRENT_THEME_TAG) return
        pickTheme(v)
      }}>
        {THEMES.map(t => <Text key={t.id} tag={t.id}>{t.name}</Text>)}
        {s.theme === CUSTOM_THEME_ID ? <Text key="current-theme" tag={CURRENT_THEME_TAG}>自定义配色（当前）</Text> : null}
        <Text tag={CUSTOM_THEME_ID}>{'自定义…（调色盘）'}</Text>
      </Picker>
      {s.theme === CUSTOM_THEME_ID ? <Button title="编辑自定义配色" action={() => pickTheme(CUSTOM_THEME_ID)} /> : null}
      <RoundedRectangle cornerRadius={10} fill={themePreview} frame={{ height: 44 }} />
    </Section>
    <Section header={<Text>字体大小</Text>} footer={<Text>只调当前尺寸；未锁车 / 运行时状态文字为橙色。</Text>}>
      <NumberPicker title="组件字体大小" value={s.fontScale} options={[80, 90, 100, 110, 120]} min={60} max={200} hint="60 – 200 %"
        label={v => v + '%' + (v === 100 ? '（默认）' : '')} onChanged={v => update('fontScale', v)} />
      <Text font={fontSizeOf(s, 16)}>{'字号预览 · ' + s.fontScale + '%'}</Text>
    </Section>
    {size === 'medium' ? <Section header={<Text>油量进度条</Text>} footer={<Text>只影响中号；过长时自动收窄，避免顶到车图。</Text>}>
      <NumberPicker title="进度条长度" value={s.barWidth} options={[50, 60, 70, 80, 94, 110, 130, 150, 170, 190, 220]} min={20} max={400} hint="20 – 400 pt"
        label={v => v + ' pt' + (v === 94 ? '（默认）' : '')} onChanged={v => update('barWidth', v)} />
      <NumberPicker title="进度条粗细" value={s.barHeight} options={[2, 3, 4, 5, 6, 8, 10, 12]} min={1} max={40} hint="1 – 40 pt"
        label={v => v + ' pt' + (v === 3 ? '（默认）' : '')} onChanged={v => update('barHeight', v)} />
    </Section> : null}
    {colorPicker('fontColor', '组件字体颜色')}
    {size === 'large' || size === 'extraLarge' ? colorPicker('infoBackgroundColor', '信息卡片背景颜色') : null}
    {colorPicker('buttonBackgroundColor', '按钮背景颜色', BUTTON_BG_COLOR)}
    {colorPicker('buttonIconOnColor', '图标未激活状态颜色', ICON_IDLE_COLOR)}
    {colorPicker('buttonIconOffColor', '图标激活状态颜色', ICON_ACTIVE_COLOR)}
    <Section footer={<Text>{'未激活默认白色，激活默认橙色；寻车 / 冷车 / 热车 / 空调只有一枚图形，只换颜色。'}</Text>}><Text>{'大号 / 超大号可在“快捷按钮”里显示两字说明。'}</Text></Section>
  </>)
}
function ImagesScreen({ size }: { size: WidgetSize }) {
  const { s, update, patch } = usePreferences(size), backgroundKey = BACKGROUND_KEYS[size]
  async function picture(key: 'carImage' | typeof backgroundKey) {
    try {
      const photo = (await Photos.pickPhotos(1))[0]
      if (!photo) return
      // 按组件实际像素缩放后再存：组件解码的内存由图片像素决定，先缩再存最省。
      const path = await saveWidgetImage(photo, key, size)
      await update(key, path)
    } catch (e) { await Dialog.alert({ title: '选择图片失败', message: String(e) }) }
  }
  // 旧版本存的是 1000×1000 PNG，进这个页面时静默重存成按组件像素压过的版本。
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const current = settingsForSize(readSettings(), size)
        const keys: ImageKey[] = current.carImage ? ['carImage', backgroundKey] : [backgroundKey]
        const updates: Record<string, string> = {}
        for (const key of keys) {
          const before = key === 'carImage' ? current.carImage : current[backgroundKey]
          if (!before) continue
          const saved = await compactSavedImage(before, key, size)
          if (!saved) continue
          // 处理期间用户可能刚换了新图，只在原值没变时才回写。
          const latest = settingsForSize(readSettings(), size)
          const now = key === 'carImage' ? latest.carImage : latest[backgroundKey]
          if (now === before) updates[key] = saved
        }
        if (alive && Object.keys(updates).length) await patch(updates as Partial<WidgetOptions>)
      } catch { /* 旧图处理失败就保持原样，不影响设置页 */ }
    })()
    return () => { alive = false }
  }, [])
  return page(SIZE_NAMES[size] + ' · 车图与背景', <>
    <Section header={<Text>车辆图片</Text>} footer={<Text>用于组件内车图；车辆中心页的车图单独设置。</Text>}>
      <NumberPicker title="车图大小" value={s.carScale} options={[60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 200]} min={30} max={300} hint="30 – 300 %"
        label={v => v + '%' + (v === 100 ? '（默认）' : '')} onChanged={v => update('carScale', v)} />
      <Button title={s.carImage ? '更换车辆图片' : '选择车辆图片'} action={() => picture('carImage')} />
      {s.carImage ? <Button title="清除自定义车辆图片" action={() => update('carImage', '')} /> : null}
      <Button title="车图资源" action={() => { void Safari.openURL(CAR_ASSET_URL) }} />
      <Button title="一键抠图" action={() => { void Safari.openURL(CUTOUT_URL) }} />
    </Section>
    <Section header={<Text>组件背景</Text>} footer={size === 'extraLarge' ? <Text>未设置图片时沿用升级前的大号背景。</Text> : undefined}>
      <Button title={s[backgroundKey] ? '更换背景图片' : '选择背景图片'} action={() => picture(backgroundKey)} />
      {s[backgroundKey] ? <Button title="清除背景图片" action={() => update(backgroundKey, '')} /> : null}
      <NumberPicker title="背景压暗程度" value={s.backgroundDim} options={[0, 10, 20, 30, 40, 50, 60, 70]} min={0} max={100} hint="0 – 100 %"
        label={v => v === 0 ? '原图 · 无蒙层' : v + '%'} onChanged={v => update('backgroundDim', v)} />
    </Section>
  </>)
}
// 一键类动作（寻车 / 刷新 / 冷车 / 热车）只有一枚图标、没有开关两态，
// state 恒为 false ⇒ 组件里和预览里都固定用未激活色，只画一格。
const ONE_KEY_ACTIONS = ['find', 'cool', 'hot', 'refresh']
// 会用到「运行时间」的三个功能：都走 CMD_ENGINE，engine_time 可按按钮单独设。
const ENGINE_ACTIONS = ['engine', 'cool', 'hot']
/** 近白判断：白（含纯白、留空回退）算未点亮，其余彩色算点亮。 */
function isWhiteish(color: string) {
  const v = String(color || '').trim().toLowerCase()
  if (!v || v === 'white' || v === '#fff' || v === '#ffffff' || v === 'rgb(255,255,255)') return true
  const hex = /^#([0-9a-f]{6})$/.exec(v)
  if (!hex) return false
  const n = parseInt(hex[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return Math.min(r, g, b) >= 230 && Math.max(r, g, b) - Math.min(r, g, b) <= 14
}
/**
 * 图标下方那两字，与组件 dashboardButtons 的 buttonCaption 一致：[未生效, 已生效]。
 * 已生效时组件画的是“再点一下会发生什么”，所以锁车 / 解锁这类是反的，预览按同样口径。
 */
const BUTTON_CAPTIONS: Record<string, [string, string]> = {
  lock: ['锁车', '解锁'], window: ['开窗', '关窗'],
  engine: ['启动', '熄火'], find: ['寻车', '寻车'], cool: ['冷车', '冷车'],
  hot: ['热车', '热车'], ac: ['空调', '空调'], trunk: ['尾门', '尾门'], seat: ['加热', '加热'],
  refresh: ['刷新', '刷新'],
}
/**
 * 按钮图标预览：形状、尺寸全部复用组件里的规则（ButtonGlyph / buttonIconColorOf），
 * 所以这里看到的就是小组件上真实画出来的图标，改完立刻能对照。
 * 高度、圆角、文字、图标大小与线条粗细全部跟本尺寸的设置同步。
 */
function ButtonIconPreview({ s, id, state, color, caption, widgetSize }: { s: Settings; id: string; state: boolean; color: string; caption?: string; widgetSize: WidgetSize }) {
  // 按钮高度按组件同一口径算，改上方“按钮高度 / 按钮圆角”预览立刻跟着变：
  // 大号 / 超大号按钮至少 20pt（开文字 28pt），小号 / 中号就是设置值本身。
  const setting = buttonHeightOf(s)
  const baseHeight = widgetSize === 'large' || widgetSize === 'extraLarge'
    ? Math.max(caption ? 28 : 20, setting)
    : setting
  const height = caption ? Math.max(28, baseHeight) : baseHeight
  // 宽度跟着高度长，但到 76pt 就封顶：高度再往上只变高不变宽（形状变化更直观，也不会撑破列表行）。
  const width = Math.min(76, Math.round(height * 1.55))
  const radius = buttonRadiusOf(s, height, 11)
  // 与组件 dashboardButtons 同一套算法：先扣掉文字高度，剩下多少给图标。
  const labelFont = fontSizeOf(s, height < 36 ? 8 : 9)
  const labelHeight = Math.ceil(labelFont * 1.25)
  // 图标上限跟组件一致（30）：按钮高到 50–80 时图标也长，而不是停在 20。
  const iconBase = Math.min(30, Math.max(11, Math.min(height * 0.6, width - 9)))
  // 图标大小是本尺寸的设置：和组件同一口径缩放，再按按钮可用高度 / 宽度夹一次。
  const iconScale = buttonIconSizeOf(s) / 100
  const iconRoom = caption ? height - labelHeight - 2 : height - 4
  const size = Math.round(Math.min(Math.max(iconBase * iconScale, caption ? 10 : 9), iconRoom, width - 8))
  // 线条粗细也是本尺寸的设置，预览也跟着变（实心图标无视这个值）。
  const lineWidth = buttonIconLineWidthOf(s)
  // fill 只接受 Color，但同组件里传颜色字符串是既有写法（类型定义比运行时窄）。
  const background: any = buttonBackgroundOf(s)
  const icon = <ButtonGlyph id={id} state={state} color={color} lineWidth={lineWidth} size={size} />
  return <ZStack frame={{ width, height }}>
    <RoundedRectangle cornerRadius={radius} fill="rgba(22,28,40,0.92)" frame={{ width, height }} />
    <RoundedRectangle cornerRadius={radius} fill={background} frame={{ width, height }} />
    {caption
      ? <VStack alignment="center" spacing={1} frame={{ width, height }}>
          {icon}
          <Text font={labelFont} fontWeight="medium" foregroundStyle="rgba(255,255,255,0.82)" lineLimit={1} minScaleFactor={0.6} frame={{ height: labelHeight }}>{caption}</Text>
        </VStack>
      : icon}
  </ZStack>
}
function ButtonIconRow({ s, id, size }: { s: Settings; id: string; size: WidgetSize }) {
  // 白色 = 未点亮（用户口径）：白的那格排左边。
  // 大号 / 超大号开了“图标下方显示文字”时，预览也画出那两字，跟组件上完全一致。
  const captions = s.showButtonLabels && (size === 'large' || size === 'extraLarge') ? BUTTON_CAPTIONS[id] : undefined
  const tiles = (ONE_KEY_ACTIONS.includes(id) ? [false] : [false, true])
    .map(state => ({ state, color: buttonIconColorOf(s, isButtonLit(id, state)) }))
    .map(t => ({ ...t, white: isWhiteish(t.color) }))
    .sort((a, b) => Number(b.white) - Number(a.white))
  return <HStack spacing={10}>
    {tiles.map(t => <ButtonIconPreview key={String(t.state)} s={s} id={id} state={t.state} color={t.color} widgetSize={size} caption={captions?.[t.state ? 1 : 0]} />)}
  </HStack>
}
function ButtonsScreen({ size }: { size: WidgetSize }) {
  const { s, update } = usePreferences(size)
  return page(SIZE_NAMES[size] + ' · 快捷按钮', <>
    <Section>
      <Picker title="显示按钮数量" value={s.buttonCount} onChanged={(v: any) => update('buttonCount', Math.round(Number(v)))}>{DEFAULTS.buttons.map((_, i) => <Text key={i + 1} tag={i + 1}>{i + 1} 个</Text>)}</Picker>
      <NumberPicker title="按钮高度" value={s.buttonHeight} options={[22, 26, 31, 36, 44, 50]} min={14} max={80} hint="14 – 80 pt"
        label={v => v + ' pt' + (v === defaultButtonHeightFor(size) ? '（默认）' : '')} onChanged={v => update('buttonHeight', v)} />
      <NumberPicker title="按钮圆角" value={s.buttonRadius} options={[-1, 0, 3, 6, 8, 10, 12, 14, 16, 20, 24, 30]} min={-1} max={60}
        hint="自动填 -1，自定义 0 – 60 pt" label={v => v < 0 ? '自动（随高度）' : v === 0 ? '直角' : v + ' pt'} onChanged={v => update('buttonRadius', v)} />
      {size === 'large' || size === 'extraLarge' ? <Toggle title="图标下方显示文字" value={s.showButtonLabels} onChanged={v => update('showButtonLabels', v)} /> : null}
    </Section>
    {/* 按钮图标的大小 / 线条粗细：每个尺寸各存一份，只改本尺寸的组件（车辆中心页另有一份，互不影响）。
        预览不在这里重复画：下面每个按钮关联里那一行白 / 亮两格就是它在组件上的真实样子。 */}
    <Section header={<Text>{'按钮图标 · ' + SIZE_NAMES[size]}</Text>}>
      <NumberPicker title="图标大小" value={s.buttonIconSize} options={[80, 90, 100, 110, 120, 140]} min={50} max={200} decimals={0}
        hint="50 – 200 %，100 为原始大小" label={v => v + '%' + (v === 100 ? '（默认）' : '')} onChanged={v => update('buttonIconSize', v)} />
      <NumberPicker title="图标线条粗细" value={s.buttonIconLineWidth} options={[1.2, 1.5, 1.7, 2.0, 2.4, 2.8]} min={0.8} max={3.2} decimals={1}
        hint="0.8 – 3.2，可自定义到 0.1" label={v => v.toFixed(1) + (v === 1.7 ? '（默认）' : '')} onChanged={v => update('buttonIconLineWidth', v)} />
    </Section>
    {/* 只列出当前显示的按钮（前 buttonCount 个），收起的那几个仍原样存在 buttons 里，调回去就恢复。 */}
    {visibleButtons(s).map((value, index) => <Section key={index} header={<Text>{'第 ' + (index + 1) + ' 个按钮'}</Text>}>
      <Picker title="按钮功能" value={value} onChanged={(v: string) => {
        const buttons = [...settingsForSize(readSettings(), size).buttons]; buttons[index] = v; update('buttons', buttons)
      }}>{ACTIONS.map(action => <Text key={action.id} tag={action.id}>{action.name}</Text>)}</Picker>
      {value !== 'blank' ? <ButtonIconRow s={s} id={value} size={size} /> : null}
      {value !== 'blank' ? <Toggle title="二次确认" value={s.buttonConfirmations[index]} onChanged={(v: boolean) => {
        const flags = [...settingsForSize(readSettings(), size).buttonConfirmations]; flags[index] = v; update('buttonConfirmations', flags)
      }} /> : <Text font={11} foregroundStyle="#7A8494">空白位置不执行操作。</Text>}
      {/* 只有功能为「座椅加热」的按钮才出现挡位选择：每个槽位各存一份，写的是本尺寸的设置（跟 buttons 一样）。 */}
      {value === 'seat' ? <Picker title="加热挡位" value={seatLevelOf(s, index)} onChanged={(v: any) => {
        const levels = [...settingsForSize(readSettings(), size).seatLevels]; levels[index] = asSeatLevel(v); update('seatLevels', levels)
      }}>
        {SEAT_LEVELS.map(level => <Text key={level} tag={level}>{level} 挡</Text>)}
      </Picker> : null}
      {/* 启动 / 冷车 / 热车才有运行时长：每个槽位记一份、随尺寸保存，写进 CMD_ENGINE 的 engine_time。
          换功能不改这个值：这一格记住的是“这个位置的运行时间”，不属于某一个功能。 */}
      {ENGINE_ACTIONS.includes(value) ? <NumberPicker title="运行时间" value={engineTimeOf(s, index)}
        options={[5, 10, 15, 20, 25, 30]} min={ENGINE_TIME_MIN} max={ENGINE_TIME_MAX} hint={'1 – ' + ENGINE_TIME_MAX + ' 分钟（车机上限）'}
        label={v => v + ' 分钟' + (v === defaultEngineTimeFor(value) ? '（默认）' : '')} onChanged={v => {
          const times = [...settingsForSize(readSettings(), size).engineTimes]; times[index] = v; update('engineTimes', times)
        }} /> : null}
    </Section>)}
  </>)
}
/**
 * 灵动岛设置：点按钮后要不要在灵动岛上播执行进度（直连按钮 / 二次确认按钮各一个开关），
 * 以及震动与岛弹出动画怎么对齐。三个值都是全局一份（四个尺寸共用），所以放在通用设置里。
 */
function IslandSettingsScreen() {
  const { s, update } = usePreferences()
  return page('灵动岛设置', <>
    <Section footer={<Text>{`两个开关各管一类按钮；二次确认的按钮点「确认」才弹岛，都关则不弹不震。`}</Text>}>
      <Toggle title="直接执行时显示灵动岛" value={s.islandEnabled} onChanged={v => update('islandEnabled', v)} />
      <Toggle title="二次确认后显示灵动岛" value={s.islandConfirmEnabled} onChanged={v => update('islandConfirmEnabled', v)} />
    </Section>
    <Section footer={<Text>{`从岛创建成功到震动的时间；系统动画约 1.5 秒，故默认 1500 毫秒。`}</Text>}>
      <NumberPicker title="震动延时" value={s.islandDelay} options={[800, 1000, 1200, 1500, 1800, 2000, 2500, 3000]} min={ISLAND_DELAY_MIN} max={ISLAND_DELAY_MAX}
        hint={'200 – 4000 毫秒'} label={v => v + ' ms' + (v === ISLAND_DELAY_DEFAULT ? '（默认）' : '')} onChanged={v => update('islandDelay', v)} />
    </Section>
  </>)
}
function RefreshScreen({ size }: { size: WidgetSize }) {
  const { s, update } = usePreferences(size)
  return page(SIZE_NAMES[size] + ' · 刷新设置', <Section footer={<Text>间隔为期望值，实际由系统调度。</Text>}>
    <Picker title="刷新时间显示" value={s.updateTimeStyle} onChanged={(v: any) => update('updateTimeStyle', v as 'absolute' | 'relative' | 'full')}><Text tag="absolute">智能日期 · 更新于 09:05（非当天补日期）</Text><Text tag="full">完整日期 · 更新于 2026/10/23 09:05</Text><Text tag="relative">相对时间 · 刷新于 5 分钟前</Text></Picker>
    <Toggle title="组件自动获取车况" value={s.autoRefresh} onChanged={v => update('autoRefresh', v)} />
    <NumberPicker title="期望刷新间隔" value={s.refreshMinutes} options={[15, 30, 60, 120]} min={5} max={1440} hint="5 – 1440 分钟"
      label={v => v + ' 分钟'} onChanged={v => update('refreshMinutes', v)} />
  </Section>)
}
const REMINDER_KEYS = [
  { key: 'maintenanceDate', label: '保养', fallbackDays: 365 },
  { key: 'insuranceDate', label: '保险', fallbackDays: 365 },
  { key: 'inspectionDate', label: '年检', fallbackDays: 730 }
] as const
function ReminderScreen() {
  const { s, update } = usePreferences()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayTs = today.getTime()
  // 可选范围：往前五年到往后十年（逾期的旧日期仍可选中，不会被夹到今天）
  const startTs = new Date(today.getFullYear() - 5, 0, 1).getTime()
  const endTs = new Date(today.getFullYear() + 10, 11, 31).getTime()
  /** 第一次设置时给个合理默认：从今天往后推（保养 / 保险 1 年，年检 2 年）。 */
  function defaultTs(days: number) { return todayTs + days * 86400000 }
  async function editDate(item: typeof REMINDER_KEYS[number]) {
    const saved = dateValue(s[item.key])
    const draft = saved === null ? defaultTs(item.fallbackDays) : saved
    await Navigation.present({ element: <ReminderDatePicker
      title={item.label + '到期日期'}
      value={draft}
      startTs={startTs}
      endTs={endTs}
      onChange={v => update(item.key, dateText(v))}
      onClear={() => update(item.key, '')}
    /> })
  }
  return page('用车提醒', <>
    <Section footer={<Text>点日期用滚轮调整；清除即不再提醒。</Text>}>
      {REMINDER_KEYS.map(item => (
        <Button key={item.key} title={item.label + '日期：' + (s[item.key] || '未设置')} action={() => editDate(item)} />
      ))}
    </Section>
    <Section footer={<Text>四种尺寸共用；可在信息卡片里开关显示。</Text>}>
      <TextField title="下次保养总里程（km）" value={s.maintenanceKm} keyboardType="numberPad" onChanged={v => update('maintenanceKm', v.replace(/[^0-9]/g, ''))} />
    </Section>
  </>)
}
/** 日期滚轮弹窗：先滚动选，保存才落盘（不保存就不动原值）。 */
function ReminderDatePicker({ title, value, startTs, endTs, onChange, onClear }: {
  title: string; value: number; startTs: number; endTs: number; onChange: (value: number) => void; onClear: () => void
}) {
  const dismiss = Navigation.useDismiss()
  const [draft, setDraft] = useState(value)
  return <NavigationStack><List navigationTitle={title}>
    <Section footer={<Text>{dateText(draft)}</Text>}>
      <DatePicker title="日期" value={draft} startDate={startTs} endDate={endTs} displayedComponents={['date']} datePickerStyle="wheel" onChanged={(v: number) => setDraft(v)} />
    </Section>
    <Section>
      <Button title="保存日期" action={() => { onChange(draft); dismiss() }} />
    </Section>
    <Section>
      <Button title="清除日期（不再提醒）" action={() => { onClear(); dismiss() }} />
      <Button title="取消" action={dismiss} />
    </Section>
  </List></NavigationStack>
}
// 渲染态的 busy 在同一帧连点时读到的还是旧值（重渲染还没发生），另外用一把同步闸门挡重复执行。
let backupBusy = false
function BackupScreen() {
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState(lastBackupAt())
  async function backup() {
    if (backupBusy) return
    backupBusy = true
    setBusy(true)
    try {
      const result = await backupToFile()
      if (!result) return
      setLast(result.savedAt)
      await Dialog.alert({
        title: '备份已导出',
        message: result.name + '\n含四尺寸配置、油价设置、卡片数据与油耗样本' + (result.images ? '、' + result.images + ' 张自定义图片' : '') + (result.hasAccount ? '、授权 Token' : '') + (result.hasAMapKey ? '、高德 Key' : '') + '。\n未导出的话，可在“文件”App 的下载项里重试保存。'
      })
    } catch (e) {
      await Dialog.alert({ title: '备份失败', message: String(e) })
    } finally {
      backupBusy = false
      setBusy(false)
    }
  }
  async function restore() {
    if (backupBusy) return
    const ok = await Dialog.confirm({
      title: '从文件恢复设置',
      message: '会覆盖当前全部设置（含 Token 与高德 Key）并立即刷新组件，建议先备份。',
      confirmLabel: '选择文件',
      cancelLabel: '取消'
    })
    if (!ok) return
    backupBusy = true
    setBusy(true)
    try {
      const result = await restoreFromFile()
      if (!result) return
      Widget.reloadAll()
      await Dialog.alert({
        title: '恢复完成',
        message: '已恢复组件设置' + (result.profiles ? '与 ' + result.profiles + ' 个尺寸的独立配置' : '') + (result.hasOil ? '、油价设置' : '') + (result.hasFuelRef ? '、油耗参考' : '') + (result.hasAccount ? '、授权 Token' : '') + (result.hasAMapKey ? '、高德 Key' : '') + (result.hasData ? '、车况与油价卡片数据' : '') + (result.images ? '，并写入 ' + result.images + ' 张图片' : '') + '。' + (result.kept ? '备份里没有的 ' + result.kept + ' 项设置已保留本机值。' : '') + '\n返回后重新打开组件设置即可看到新的设置值。'
      })
    } catch (e) {
      await Dialog.alert({ title: '恢复失败', message: String(e) })
    } finally {
      backupBusy = false
      setBusy(false)
    }
  }
  async function resetAll() {
    await Navigation.present({ element: <ResetConfirmation title="恢复默认" detail="显示设置、油价设置、油耗参考与显示缓存会清空；Token、高德 Key 与加油记录保留。" onReset={async () => { resetAllData(); await endLeftoverActivities() }} /> })
  }
  return page('备份/恢复', <>
    <Section header={<Text>备份</Text>} footer={<Text>zip 压缩包：四尺寸配置、通用设置、提醒、油价、Token 与高德 Key（明文，注意保管）及图片。</Text>}>
      <Button title={busy ? '正在处理…' : '备份所有设置到文件'} action={backup} />
      <Text>{last ? '上次备份：' + updateText(last).replace('更新于 ', '') : '还没有备份过'}</Text>
    </Section>
    <Section header={<Text>恢复</Text>} footer={<Text>备份里有的项才覆盖，其余保留本机值；文件损坏则不改动任何数据。</Text>}>
      <Button title={busy ? '正在处理…' : '从文件恢复设置'} action={restore} />
    </Section>
    <Section header={<Text>恢复默认</Text>} footer={<Text>清设置、油耗参考与缓存；Token、高德 Key 与加油记录保留。</Text>}>
      <Button title="恢复全部默认设置" action={resetAll} />
    </Section>
  </>)
}
function ResetConfirmation({ title, detail, onReset }: { title: string; detail: string; onReset: () => Promise<void> }) {
  const dismiss = Navigation.useDismiss()
  return <NavigationStack><List navigationTitle={title}><Text>{detail}</Text><Button title="确认恢复" action={async () => {
    try { await onReset(); Widget.reloadAll(); dismiss() } catch (e) { await Dialog.alert({ title: '恢复失败', message: String(e) }) }
  }} /><Button title="取消" action={dismiss} /></List></NavigationStack>
}
