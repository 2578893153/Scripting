import { Path, Script } from 'scripting'
import { DEFAULTS, normalizeProfiles, normalizeSettings, readSettings, saveSettings, type Settings } from './settings'
import { normalizeOilSettings, readOilCache, readOilCacheAll, readOilSettings, restoreOilCache, restoreOilCacheAll, saveOilSettings, clearOilCache } from './oil-price'
import { importAccount, accountIdentity, readAMapKey, readAccount, saveAMapKey } from './credentials'
import { readWeatherCache, restoreWeatherCache, clearWeatherCache } from './weather'
import { readCache, writeCache, clearCache } from './api'
import { readFuelState, writeFuelState } from './fuel-economy'
import { exportFuelReferenceState, restoreFuelReferenceState, clearFuelReferenceState } from './fuel-reference'
import { clearAllConfirmations } from './widget-confirmation'
import { assetDirectory } from './image-assets'

/**
 * 备份文件是一个 zip：根目录的 carlink-settings.json 保存所有设置、
 * 以及组件显示要用的缓存（车况、油价卡片、天气）与油耗样本 / 车系加权参考值，
 * images/ 里放自定义车图与背景图。
 * 恢复时把图写回当前设备的图片目录，并把设置里的图片路径换成本机路径，所以换设备也能用；
 * 缓存也一并写回，换机后不用等下一次联网就能看到和备份时一样的车况与油价卡片。
 */
const FORMAT = 'carlink.backup'
const FORMAT_VERSION = 1
const DATA_FILE = 'carlink-settings.json'
const IMAGE_DIR = 'images'
const LAST_KEY = 'carlink.backup.last.v1'
const IMAGE_EXT = /\.(?:png|jpe?g|heic|webp)$/i
const AMAP_KEY_PATTERN = /^[a-f0-9]{32}$/i

export type BackupResult = { name: string; images: number; hasAccount: boolean; hasAMapKey: boolean; savedAt: number }
// profiles = 恢复了几种尺寸的独立配置；kept = 备份里没有、因此保留本机值的新参数个数；hasData = 是否恢复回组件显示用的缓存。
// oilAreas = 恢复回几个地区的油价缓存；hasFuelRef = 油耗的车系加权参考值与开关是否跟着恢复了。
export type RestoreResult = { images: number; hasOil: boolean; hasAccount: boolean; hasAMapKey: boolean; hasData: boolean; hasFuelRef: boolean; oilAreas: number; profiles: number; kept: number }

export function lastBackupAt(): number {
  try {
    const value = Number(Storage.get<number>(LAST_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch { return 0 }
}

/**
 * 恢复默认时清掉的东西：显示设置、油价设置、油耗参考（开关 / 关键字 / 缓存）、
 * 组件显示用的缓存（车况 / 天气 / 油价卡片）与二次确认票。
 * Token、高德 Key、加油记录、自定义图片都不动 —— 那些要么要重新拿，要么找不回来。
 */
export function resetAllData(): void {
  saveSettings({ ...DEFAULTS })
  saveOilSettings(normalizeOilSettings({}))
  clearFuelReferenceState()
  clearCache()
  clearWeatherCache()
  clearOilCache()
  clearAllConfirmations()
}

function stampText(now = Date.now()): string {
  const d = new Date(now)
  const pad = (v: number) => String(v).padStart(2, '0')
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes())
}

/** 递归找设置里引用到的图片：只认绝对路径 + 图片后缀，不含脚本自带的 car.png 之类以外的误判风险。 */
function collectImages(value: any, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.charAt(0) === '/' && IMAGE_EXT.test(value)) out.add(value)
    return
  }
  if (Array.isArray(value)) { value.forEach(item => collectImages(item, out)); return }
  if (value && typeof value === 'object') { for (const key of Object.keys(value)) collectImages((value as any)[key], out) }
}

/** 把设置里指向旧图片路径的字符串换成本机新路径；按文件名匹配，命不中就原样保留。 */
function rewritePaths(value: any, map: Map<string, string>): any {
  if (typeof value === 'string') return map.get(Path.basename(value)) || value
  if (Array.isArray(value)) return value.map(item => rewritePaths(item, map))
  if (value && typeof value === 'object') {
    const out: any = {}
    for (const key of Object.keys(value)) out[key] = rewritePaths(value[key], map)
    return out
  }
  return value
}

async function removeQuietly(path: string): Promise<void> {
  try { await FileManager.remove(path) } catch { /* 临时目录清理失败不影响结果 */ }
}

/**
 * 备份里到底“存过”这个键没有。
 * 值为 null 也算没存：除了 infoBackgroundTransparency（null 是它的合法值），
 * 其余字段都有非 null 的默认值，而 normalizeSettings 里有十几个字段只做宽松取值、
 * 不再校验（name / theme / carImage 等），手工改坏或旧版遗留的 null 不该写进设置。
 */
function provided(raw: any, key: string): boolean {
  if (!raw || typeof raw !== 'object') return false
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return false
  return raw[key] !== null || (DEFAULTS as any)[key] === null
}

/**
 * 恢复时按“键”合并，而不是整包覆盖：
 * - 备份里真正存过的键才覆盖（存过但是 null 的算没存，见 provided），并且先过一遍归一化（按钮高度、图标下方文字说明、圆角、颜色等新参数都按合法范围校验）；
 * - 旧备份里没有的键保留本机当前值，避免“恢复一次把新设置打回默认”；
 * - 四种尺寸的独立配置按尺寸逐个合并，同样缺什么留什么。
 */
export function mergeRestored(current: Settings, raw: any): { settings: Settings; profiles: number; kept: number } {
  const incoming = normalizeSettings(raw)
  const merged: any = { ...current }
  let kept = 0
  for (const key of Object.keys(DEFAULTS)) {
    if (provided(raw, key)) merged[key] = (incoming as any)[key]
    else kept += 1
  }
  const profiles: any = { ...(current.profiles ?? {}) }
  const normalized = normalizeProfiles(raw.profiles)
  const restored: string[] = Object.keys(normalized ?? {})
  for (const size of restored) {
    profiles[size] = { ...((current.profiles as any)?.[size] ?? {}), ...(normalized as any)[size] }
  }
  // 备份与本机都没有独立配置时不要凭空建一个空对象，避免凭空改动存储。
  if (restored.length || current.profiles) merged.profiles = profiles
  else delete merged.profiles
  return { settings: normalizeSettings(merged), profiles: restored.length, kept }
}

/**
 * 组装备份内容。除了设置本身，还带上组件显示要用的缓存：
 * 车况（readCache 已校验 provider / 授权，没授权就是 null）、油价卡片快照与预测、天气。
 * 这样换设备恢复后，车况与油价卡片不用等下一次联网就有内容。
 */
export function buildPayload(account: any = readAccount()): any {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    script: Script.metadata.version || '',
    exportedAt: Date.now(),
    settings: readSettings(),
    oil: readOilSettings(),
    account,
    amapKey: readAMapKey(),
    // 油耗是几百公里累积出来的样本，丢了要重新跑很久才能攒回来，跟着备份一起走。
    fuel: readFuelState(),
    // 车系加权参考值本身是抓来的、可以重查，但它带着“开关 + 手动关键字”两项设置，
    // 换机后不恢复就要重新填一遍，所以连着缓存一起带上（体积只有几 KB）。
    fuelReference: exportFuelReferenceState(),
    // 各地区都带上：换机后切到别省看价，就不用等联网重抓；没缓存的地区不占体积。
    data: { car: readCache(), oil: { ...readOilCache(), areas: readOilCacheAll() }, weather: readWeatherCache() },
    images: [] as string[],
  }
}

export async function backupToFile(): Promise<BackupResult | null> {
  const account = readAccount()
  const payload = buildPayload(account)
  const workspace = Path.join(FileManager.temporaryDirectory, 'carlink-backup-' + Date.now())
  const imagesDir = Path.join(workspace, IMAGE_DIR)
  // 导出面板报错或用户取消时也要把临时 zip 删掉，否则每失败一次就在临时目录里留一份。
  let zipPath = ''
  try {
    await FileManager.createDirectory(imagesDir, true)
    // 整个 payload（设置、油价、车图/背景图路径）都扫一遍，以后新加的字段带图也能自动带上。
    const sources = new Set<string>()
    collectImages(payload, sources)
    for (const source of sources) {
      if (!FileManager.existsSync(source)) continue
      const name = Path.basename(source)
      if (payload.images.includes(name)) continue
      await FileManager.copyFile(source, Path.join(imagesDir, name))
      payload.images.push(name)
    }
    await FileManager.writeAsString(Path.join(workspace, DATA_FILE), JSON.stringify(payload, null, 2))

    zipPath = Path.join(FileManager.temporaryDirectory, 'carlink-backup-' + Date.now() + '.zip')
    await FileManager.zip(workspace, zipPath, false)
    const data = Data.fromFile(zipPath)
    if (!data) throw new Error('备份文件生成失败，请重试')
    const name = '车联备份-' + stampText() + '.zip'
    await DocumentPicker.exportFiles({ files: [{ data, name }] })
    const savedAt = Date.now()
    Storage.set(LAST_KEY, savedAt)
    return { name, images: payload.images.length, hasAccount: !!account, hasAMapKey: !!payload.amapKey, savedAt }
  } finally {
    if (zipPath) await removeQuietly(zipPath)
    await removeQuietly(workspace)
  }
}

function findDataFile(directory: string): string | null {
  const direct = Path.join(directory, DATA_FILE)
  if (FileManager.existsSync(direct)) return direct
  // 用户重新打包时可能把内容套了一层文件夹，递归再找一次（readDirectory 返回的是相对路径）。
  const relative = FileManager.readDirectorySync(directory, true)
    .find(path => Path.basename(path) === DATA_FILE)
  if (!relative) return null
  return relative.charAt(0) === '/' ? relative : Path.join(directory, relative)
}

/** 选文件并恢复；用户取消返回 null，文件不合规时抛错（不写入任何数据）。 */
export async function restoreFromFile(): Promise<RestoreResult | null> {
  const picked = await DocumentPicker.pickFiles()
  if (!picked || !picked.length) return null
  return restoreFromArchive(picked[0])
}

/** 从 zip（或裸 json）备份里恢复；只在文件校验通过后才写设置。 */
export async function restoreFromArchive(source: string): Promise<RestoreResult> {
  const workspace = Path.join(FileManager.temporaryDirectory, 'carlink-restore-' + Date.now())
  try {
    await FileManager.createDirectory(workspace, true)
    let dataPath: string | null = null
    if (/\.json$/i.test(source)) {
      dataPath = source
    } else {
      try { await FileManager.unzip(source, workspace) }
      catch { throw new Error('无法解开这个文件，请选择本脚本导出的备份（.zip）') }
      dataPath = findDataFile(workspace)
    }
    if (!dataPath) throw new Error('这个文件里没有备份数据，请选择本脚本导出的备份文件')

    let payload: any
    try { payload = JSON.parse(await FileManager.readAsString(dataPath)) }
    catch { throw new Error('备份文件内容已损坏，无法读取') }
    if (!payload || typeof payload !== 'object' || payload.format !== FORMAT) throw new Error('这不是「小组件车联」的备份文件')
    if (Number(payload.version) > FORMAT_VERSION) throw new Error('备份文件来自更新版本的脚本，请先更新脚本再恢复')
    if (!payload.settings || typeof payload.settings !== 'object') throw new Error('备份里没有组件设置数据')

    // 先把图片落到本机目录，再把设置里的路径改过去，最后才落盘设置。
    const map = new Map<string, string>()
    const names: string[] = Array.isArray(payload.images) ? payload.images.filter((name: any) => typeof name === 'string' && !!name) : []
    if (names.length) {
      const folder = Path.join(Path.dirname(dataPath), IMAGE_DIR)
      const target = assetDirectory()
      await FileManager.createDirectory(target, true)
      for (const raw of names) {
        // 备份里的文件名来自外部文件，必须先压成纯文件名：否则 ../../ 会写到图片目录之外。
        const name = Path.basename(raw)
        if (!name || name === '.' || name === '..' || name.indexOf('/') >= 0) continue
        if (map.has(name)) continue
        const from = Path.join(folder, name)
        const to = Path.join(target, name)
        if (!FileManager.existsSync(from)) continue
        if (!FileManager.existsSync(to)) await FileManager.copyFile(from, to)
        map.set(name, to)
      }
    }

    const result = mergeRestored(readSettings(), rewritePaths(payload.settings, map))
    saveSettings(result.settings)
    // 油价设置、授权、高德 Key 各自独立：某项不合法只跳过它，已经恢复的设置不会被牵连。
    let hasOil = false, hasAccount = false
    if (payload.oil && typeof payload.oil === 'object') {
      try { saveOilSettings(normalizeOilSettings(payload.oil)); hasOil = true } catch { hasOil = false }
    }
    if (payload.account && typeof payload.account === 'object') {
      try { importAccount(payload.account); hasAccount = true } catch { hasAccount = false }
    }
    // 油耗样本与账号无关，校验通过就写回；不合法时 writeFuelState 自己忽略，保留本机已积累的。
    if (payload.fuel && typeof payload.fuel === 'object') writeFuelState(payload.fuel)
    // 油耗参考：开关与手动关键字按“备份里有的才覆盖”，参考值过校验才写。
    const hasFuelRef = payload.fuelReference && typeof payload.fuelReference === 'object' ? restoreFuelReferenceState(payload.fuelReference) : false
    let hasAMapKey = false
    if (typeof payload.amapKey === 'string') {
      const key = payload.amapKey.trim()
      if (!key || AMAP_KEY_PATTERN.test(key)) { saveAMapKey(key); hasAMapKey = !!key }
    }
    // 显示缓存最后写：车况缓存要求授权已经恢复（writeCache 会校验 provider 与账号）。
    // 任何一项不合法只跳过它，不会影响已经恢复的设置。
    let hasData = false
    let oilAreas = 0
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null
    if (data) {
      if (data.car && typeof data.car === 'object') {
        // 备份里的车况带着当时的授权代次，而 importAccount 恢复账号时会重新生成代次，
        // 直接写回会被 writeCache 的账号校验直接丢掉。只有备份里的账号确实恢复成功
        // （同一部车、同一个 Token）才把账号换成本机的当前值再写，避免把别的车的数据写进来。
        const account = hasAccount ? readAccount() : null
        if (account && data.car.provider === account.provider) {
          if (writeCache({ ...data.car, accountId: accountIdentity(account) })) hasData = true
        }
      }
      if (data.oil && typeof data.oil === 'object') {
        // 先按旧版结构恢复当前地区，再把各地区的那份补上（旧备份里没有 areas，自然跳过）。
        if (restoreOilCache(data.oil.snapshot, data.oil.forecast)) hasData = true
        const areas = restoreOilCacheAll(data.oil.areas)
        if (areas) { hasData = true; oilAreas = areas }
      }
      if (restoreWeatherCache(data.weather)) hasData = true
    }
    return { images: map.size, hasOil, hasAccount, hasAMapKey, hasData, hasFuelRef, oilAreas, profiles: result.profiles, kept: result.kept }
  } finally {
    await removeQuietly(workspace)
  }
}
