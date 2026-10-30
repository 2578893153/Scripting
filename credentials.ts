import { Script } from 'scripting'
import { detectProvider, isProvider, PROVIDERS, type ProviderId, type ProviderChoice } from './providers'

export type Account = { provider: ProviderId; token: string; generation: string }
const ACCOUNT_KEY = 'CarLink.Account.' + Script.name
function accountFromKeychain(): Account | null {
  try {
    const value = Keychain.get(ACCOUNT_KEY)
    if (typeof value !== 'string' || !value) return null
    const record = JSON.parse(value)
    return isProvider(record?.provider) && typeof record.token === 'string' && !!record.token.trim() &&
      !/[\r\n]/.test(record.token) && typeof record.generation === 'string' && !!record.generation ? record : null
  } catch { return null }
}
// 账号记录在一次运行内只会被本模块的 saveToken / importAccount 改写（两者都会清缓存），
// 所以读一次就够：原来组件一次渲染要串着读 4~6 次钥匙串（readCache / readToken /
// supportsTires / requireAccount / readAMapKey 各读一次）。
let accountCache: Account | null | undefined
export function readAccount(): Account | null {
  if (accountCache === undefined) accountCache = accountFromKeychain()
  return accountCache
}
/** 绕过缓存重读钥匙串：用于检测跨 await 的授权变化。 */
export function readAccountFresh(): Account | null {
  accountCache = accountFromKeychain()
  return accountCache
}
export function resetAccountCache(): void { accountCache = undefined }
/** 账号指纹：服务商 + 授权代次（同一份 Token 重存也会变）。 */
export function accountIdentity(account: Account | null): string {
  return account ? account.provider + ':' + account.generation : ''
}
export function readToken(): string { return readAccount()?.token || '' }
export function readAccountIdentity(): string {
  return accountIdentity(readAccount())
}
export function currentProviderLabel(): string { const account = readAccount(); return account ? PROVIDERS[account.provider].label : '尚未识别服务' }
export function supportsTires(): boolean { return readAccount()?.provider === 'aojie' }
export function requireAccount(): Account {
  const account = readAccount()
  if (!account) throw new Error('请先在授权与地图中填写 Token 并自动识别服务')
  return account
}
export function assertCurrentAccount(account: Account): void {
  // 一次读取同时比对服务与 Token：原来分别调 readAccountIdentity / readToken 会读两遍钥匙串。
  // 这里必须重读钥匙串（不能用缓存），否则就无法发现等待网络期间的授权变化。
  const current = readAccountFresh()
  if (!current || accountIdentity(current) !== accountIdentity(account) || current.token !== account.token) throw new Error('授权或服务已变化，请重新刷新车况')
}
let saveAttempt = 0
export async function saveToken(value: string, choice: ProviderChoice = 'auto'): Promise<ProviderId> {
  const attempt = ++saveAttempt
  const token = value.trim()
  if (!token) throw new Error('请输入完整 Authorization Token')
  if (/[\r\n]/.test(token)) throw new Error('Token 中不能包含换行')
  const before = accountIdentity(readAccountFresh())
  const provider = await detectProvider(token, choice)
  if (attempt !== saveAttempt || before !== accountIdentity(readAccountFresh())) throw new Error('授权设置已更新，请重新操作')
  const account: Account = { provider, token, generation: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) }
  // A single Keychain record changes provider and token together. Failed detection never changes it.
  if (Keychain.set(ACCOUNT_KEY, JSON.stringify(account)) === false) throw new Error('Token 保存失败，请重试')
  resetAccountCache()
  if (readAccountIdentity() !== accountIdentity(account)) throw new Error('Token 保存失败，请重试')
  return provider
}
/**
 * 备份恢复入口：直接把备份里的账号记录写回钥匙串，不做接口探测。
 * 备份文件来自本脚本自身，token 与 provider 已在导出时校验过；generation 重新生成，
 * 这样恢复后各地缓存（车况、油价快照）会被视为旧数据自动刷新。
 */
export function importAccount(value: any): void {
  if (!value || typeof value !== 'object' || !isProvider(value.provider)) throw new Error('备份里的账号服务无法识别')
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  if (!token || /[\r\n]/.test(token)) throw new Error('备份里的 Token 不合法')
  const record: Account = { provider: value.provider, token, generation: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) }
  if (Keychain.set(ACCOUNT_KEY, JSON.stringify(record)) === false) throw new Error('Token 恢复失败，请重试')
  resetAccountCache()
  if (readAccountIdentity() !== accountIdentity(record)) throw new Error('Token 恢复失败，请重试')
}

export function updateText(timestamp: number, now = Date.now(), style: 'absolute' | 'relative' | 'full' = 'absolute'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚未更新'
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now)) return '尚未更新'
  if (style === 'relative') {
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
    if (seconds < 60) return '刚刚刷新'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return '刷新于 ' + minutes + ' 分钟前'
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return '刷新于 ' + hours + ' 小时前'
    return '刷新于 ' + Math.floor(hours / 24) + ' 天前'
  }
  // 非相对样式共用时间格式化；full 始终带年月日，absolute 当天省略日期、往年才补年份。
  const pad = (v: number) => String(v).padStart(2, '0')
  const time = pad(date.getHours()) + ':' + pad(date.getMinutes())
  const monthDay = pad(date.getMonth() + 1) + '/' + pad(date.getDate())
  if (style === 'full') return '更新于 ' + date.getFullYear() + '/' + monthDay + ' ' + time
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const year = date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '/'
  return '更新于 ' + (sameDay ? '' : year + monthDay + ' ') + time
}

const AMAP_KEY = 'CarLink.AMap.WebService.' + Script.name
// 高德 Key 同样一次跑里只会被 saveAMapKey 改写：缓存起来，刷车况时不再多读一次钥匙串。
let amapCache: string | undefined
export function readAMapKey(): string {
  if (amapCache === undefined) amapCache = String(Keychain.get(AMAP_KEY) || '').trim()
  return amapCache
}
export function saveAMapKey(value: string): void {
  const key = value.trim()
  if (key && !/^[a-f0-9]{32}$/i.test(key)) throw new Error('请输入完整的高德 Web 服务 Key（32 位字母数字），或留空停用')
  if (Keychain.set(AMAP_KEY, key) === false) throw new Error('高德 Key 保存失败，请重试')
  amapCache = key
}
