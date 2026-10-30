/**
 * 油耗参考设置页：查什么车系、当前参考值是多少、数据从哪来、什么时候拉的。
 * 本机实测样本永远优先，这一页只是让样本不足时也有个能看懂来源的兜底值。
 */
import { Button, HStack, List, Section, Text, TextField, Toggle, VStack, useState } from 'scripting'
import { readCache } from './api'
import { fuelStats } from './fuel-economy'
import { ensureFuelReference, readFuelReferenceState, referenceKeyword, saveFuelReferenceState, type FuelReferenceState } from './fuel-reference'

function stamp(at: number): string {
  if (!at) return '--'
  const d = new Date(at)
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function line(title: string, value: string) {
  return (
    <HStack>
      <Text font={13} foregroundStyle="#7A8494">{title}</Text>
      <VStack alignment="trailing" frame={{ maxWidth: 'infinity' }}><Text font={13} lineLimit={2}>{value}</Text></VStack>
    </HStack>
  )
}

export function FuelReferenceScreen() {
  const car = readCache()
  const model = car?.model || ''
  const autoKeyword = referenceKeyword(model)
  const [state, setState] = useState<FuelReferenceState>(readFuelReferenceState)
  const [input, setInput] = useState(() => state.keyword)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const reference = state.reference
  // 自己窗口样本：用来解释“为什么现在用的是参考值”。
  const own = fuelStats(null, model)

  // 关键字改了要立刻落盘：ensureFuelReference 从这里读手动关键字。
  function setKeyword(value: string): void {
    setInput(value)
    setState(saveFuelReferenceState({ keyword: value.trim(), error: '', failedAt: 0 }))
  }

  async function run(): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote('正在查询小熊油耗…')
    try {
      const updated = await ensureFuelReference(model, true)
      const next = readFuelReferenceState()
      setState(next)
      setNote(updated ? '已更新参考值' : next.error || '查询失败，稍后再试')
    } catch (e: any) {
      setNote(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <List navigationTitle="油耗参考">
      <Section
        header={<Text>数据来源</Text>}
        footer={<Text>平均油耗优先用本机实测（满 20 km 才显示），样本不足时用小熊车系加权参考值。</Text>}
      >
        <Toggle
          title="样本不足时使用车系加权参考"
          value={state.enabled}
          onChanged={value => setState(saveFuelReferenceState({ enabled: value }))}
        />
        {line('车机车型', model || '未获取到')}
        {line('查询关键字', state.keyword || autoKeyword || '--')}
      </Section>

      <Section header={<Text>查询关键字</Text>} footer={<Text>留空按车机车型自动推断；对不上时手动填车系名，如“奥迪A6L”。</Text>}>
        <TextField title="手动指定" value={input} onChanged={setKeyword} prompt={autoKeyword ? `留空使用「${autoKeyword}」` : '例如 奥迪A6L'} />
        <Button title={busy ? '查询中…' : '立即查询'} action={run} />
      </Section>

      <Section
        header={<Text>当前参考值</Text>}
        footer={reference
          ? <Text>{`按车主样本数加权，不是小熊官方车系均值。${reference.partial ? '\n车型数触到接口上限，加权值可能不完整。' : ''}`}</Text>
          : <Text>还没有参考值，点“立即查询”或等下次刷新。</Text>}
      >
        {reference ? (
          <VStack alignment="leading" spacing={8} padding={{ top: 4, bottom: 4 }}>
            {line('来源', reference.kind === 'series' ? '车系加权' : '同款车型')}
            {line('名称', reference.name)}
            {line('油耗', `${reference.l100km.toFixed(2)} L/100km`)}
            {line('车主样本', `${reference.samples} 位`)}
            {line('参与车型', `${reference.models} 个`)}
            {reference.yearFrom > 0 ? line('覆盖年款', reference.yearFrom === reference.yearTo ? `${reference.yearFrom}` : `${reference.yearFrom} – ${reference.yearTo}`) : null}
            {line('拉取时间', stamp(reference.fetchedAt))}
            {reference.keyword !== (state.keyword || autoKeyword) ? line('关键字', reference.keyword) : null}
          </VStack>
        ) : null}
        {note ? <Text font={12} foregroundStyle="#7A8494">{note}</Text> : null}
        {reference ? <Button title="在小熊油耗查看" action={() => { void Safari.openURL(reference.url) }} /> : null}
        <Button
          title="清除参考值"
          action={() => {
            setState(saveFuelReferenceState({ reference: null, error: '', failedAt: 0 }))
            setNote('已清除，下次刷新车况会重新查询')
          }}
        />
      </Section>

      <Section
        header={<Text>本机实测样本</Text>}
        footer={<Text>累计超 500 km 时按比例缩小，近期数据权重更大；加油不清空已累积值。</Text>}
      >
        {own.sampledL100km !== null
          ? line('实测油耗', `${own.sampledL100km.toFixed(2)} L/100km`)
          : line('实测油耗', '样本不足')}
        {line('累计里程', `${own.sampleKm.toFixed(1)} km`)}
        {line('累计油量', `${own.sampleLiters.toFixed(2)} L`)}
        {line('当前采用', own.source === 'sampled' ? '本机实测' : own.source === 'reference' ? '车系加权参考' : '暂无')}
      </Section>
    </List>
  )
}
