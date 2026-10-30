import { isButtonLit } from './button-icons'
import { ButtonGlyph } from './button-glyph'
import { Button, Navigation, NavigationStack, List, Section, Text, HStack, Widget, useState } from 'scripting'
import { readCache } from './api'
import { readSettingsForSize, plateText, buttonIconColorOf, buttonIconLineWidthOf } from './settings'
import { parseControlRequest, requestedCommand, createConfirmationExecutor } from './command-confirmation'

export function CommandConfirmation({ parameters }: { parameters: Record<string, unknown> }) {
  const dismiss = Navigation.useDismiss()
  // 参数 / 缓存 / 设置只在首次渲染读一次：后面 setBusy、setMessage 的重渲染没必要再去碰存储。
  const [ctx] = useState(() => {
    const request = parseControlRequest(parameters)
    const cached = readCache()
    const options = request ? readSettingsForSize(request.size) : null
    // 车牌文字只算一次：render 里重复调用会把同一行配置归一化两遍。
    return { request, cached, options, plate: options && cached ? plateText(cached, options) : '' }
  })
  const { request, cached, options, plate } = ctx
  const buttonState = request && ['lock', 'window', 'engine', 'ac', 'seat', 'trunk'].includes(request.action) ? !request.target : false
  const valid = !!request && !!cached?.machineId
  const [execute] = useState(() => request ? createConfirmationExecutor(request) : null)
  const [message, setMessage] = useState('请核对车辆和操作，只有点击“确认执行”才会发送指令。')
  const [finished, setFinished] = useState(false)
  const [busy, setBusy] = useState(false)
  async function confirm() {
    if (!valid || !execute || busy || finished) return
    setBusy(true)
    try {
      setMessage(await execute())
      Widget.reloadAll()
      // 只有成功才锁页：失败（网络/授权）时保留「确认执行」，让用户可以重试。
      setFinished(true)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      // 失败时指令逻辑已经回滚了乐观写入，这里让组件重新渲染成真实状态。
      try { Widget.reloadAll() } catch { /* 组件刷新失败不影响页面 */ }
    }
    setBusy(false)
  }
  return <NavigationStack><List navigationTitle="确认控车操作" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title={finished ? '完成' : '取消'} action={dismiss} /> }}>
    {valid && request && cached ? <>
      <Section header={<Text>操作车辆</Text>}>
        <Text font={20} fontWeight="semibold">{options?.name.trim() || cached.model || '我的座驾'}</Text>
        {plate ? <Text>{plate}</Text> : null}
      </Section>
      <Section header={<Text>即将执行</Text>}><HStack spacing={12}><ButtonGlyph id={request.action} state={buttonState} color={buttonIconColorOf(options!, isButtonLit(request.action, buttonState))} lineWidth={buttonIconLineWidthOf(options!)} size={32} /><Text font={21} fontWeight="semibold" foregroundStyle="#F97316">{requestedCommand(request).label}</Text></HStack></Section>
      <Section><Text>{message}</Text>
        {!finished ? <Button title={busy ? '正在提交…' : '确认执行'} action={confirm} /> : null}
        <Button title={finished ? '完成' : '取消，不执行'} action={dismiss} />
      </Section>
    </> : <Section><Text>无法确认操作车辆。请关闭此页，在车辆中心刷新车况后重新点击组件按钮。</Text><Button title="关闭，不执行" action={dismiss} /></Section>}
  </List></NavigationStack>
}
