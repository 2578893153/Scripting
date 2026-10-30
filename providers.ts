import { fetch } from 'scripting'

export type ProviderId = 'aozhilian' | 'aojie'
export type ProviderChoice = 'auto' | ProviderId
export const PROVIDERS = {
  aozhilian: { label: '奥智联', host: 'kds.askdwl.com', tires: false },
  aojie: { label: '奥捷智行', host: 'ck.shjza.cn', tires: true },
} as const
export function isProvider(value: unknown): value is ProviderId { return value === 'aozhilian' || value === 'aojie' }
type Probe = { provider: ProviderId; status: 'valid' | 'rejected' | 'unknown' | 'noVehicle' }
function deviceId(value: unknown): boolean {
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return false
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const id = String(value).trim()
  return !!id && id !== '0' && id.length <= 200
}
async function inspect(provider: ProviderId, token: string): Promise<Probe> {
  async function get(path: string): Promise<{ status: Probe['status']; data?: any }> {
    try {
      const response = await fetch('https://' + PROVIDERS[provider].host + path, {
        timeout: 8, headers: { Accept: 'application/json', Authorization: token },
      })
      if (response.status === 401 || response.status === 403) return { status: 'rejected' }
      if (!response.ok) return { status: 'unknown' }
      const result: any = await response.json()
      if (String(result?.status) === '401' || String(result?.status) === '403') return { status: 'rejected' }
      // Do not mistake a temporary server failure for an authorization rejection.
      if (String(result?.status) !== '200') return { status: /token|登录|授权|认证|过期|unauthoriz|invalid.*credential/i.test(String(result?.message || '')) ? 'rejected' : 'unknown' }
      return { status: 'valid', data: result?.data }
    } catch { return { status: 'unknown' } }
  }
  // Only these two read-only endpoints participate in detection. No commands or location requests.
  const car = await get('/api/car/getNowCar')
  if (car.status !== 'valid') return { provider, status: car.status }
  const vehicle = car.data?.carInfo ?? car.data
  if (deviceId(vehicle?.machineId)) return { provider, status: 'valid' }
  const obd = await get('/api/car/getCarOBD')
  return { provider, status: obd.status === 'valid' ? deviceId(obd.data?.machineId) ? 'valid' : 'noVehicle' : obd.status }
}
/**
 * 两个服务并发探测，谁先给出可用结果就采用谁；都没成功时等两边都结束，把各自的结论留作报错依据。
 * 传 `probe` 而不是写死 fetch，方便在脚本里用假结果验证先后顺序。
 */
async function raceValid(probe: (provider: ProviderId) => Promise<Probe>): Promise<{ winner: ProviderId | null; results: Probe[] }> {
  const results: Probe[] = []
  const winner = await new Promise<ProviderId | null>(resolve => {
    let pending = 2
    // probe 理论上不会 reject（inspect 内部全部 catch），但一旦 reject 而没接住，
    // pending 就永远减不到 0，授权页会永久卡在“识别中”。所以两个分支都显式收尾。
    const settle = (provider: ProviderId, result: Probe) => {
      results.push(result)
      pending--
      if (result.status === 'valid') resolve(provider)
      else if (pending === 0) resolve(null)
    }
    for (const provider of ['aozhilian', 'aojie'] as const) {
      probe(provider).then(result => settle(provider, result),
        () => settle(provider, { provider, status: 'unknown' }))
    }
  })
  return { winner, results }
}
export async function detectProvider(token: string, choice: ProviderChoice = 'auto'): Promise<ProviderId> {
  if (choice !== 'auto' && !isProvider(choice)) throw new Error('请选择有效的服务')
  if (choice !== 'auto') {
    const result = await inspect(choice, token)
    if (result.status === 'valid') return choice
    if (result.status === 'unknown') throw new Error('暂时无法连接' + PROVIDERS[choice].label + '，请稍后重试')
    if (result.status === 'noVehicle') throw new Error('当前账号没有可用车辆，请核对 Token')
    throw new Error('Token 无效或已过期，请核对完整 Authorization 值')
  }
  // 两个服务同时探测：谁先返回可用（且能查到车辆）就采用谁，另一个的请求结果直接丢弃。
  const { winner, results } = await raceValid(provider => inspect(provider, token))
  if (winner) return winner
  if (results.some(result => result.status === 'unknown')) throw new Error('网络异常，两个服务都没连上。原配置已保留，请稍后重试')
  if (results.some(result => result.status === 'noVehicle')) throw new Error('当前账号没有可用车辆，请核对 Token')
  throw new Error('Token 无效或已过期，请核对完整 Authorization 值')
}
