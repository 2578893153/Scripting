// 「数据管理 · 日志」：按钮指令、参数修改与组件报错的最新记录。
// 记录本身在事件发生的那一下写入（见 log.ts 的调用点），这一页只负责读出来看，不改任何设置。
import { Button, HStack, List, Picker, Section, Spacer, Text, VStack, useState } from 'scripting'
import { clearLog, readLog, type LogEntry, type LogKind } from './log'

const KIND_NAMES: Record<LogKind, string> = { command: '指令', settings: '设置', error: '报错' }
// 分类标签用中深色调：早期那套浅色在白色列表背景上几乎看不清。
const KIND_COLORS: Record<LogKind, string> = { command: '#0B69A3', settings: '#067A5B', error: '#B42341' }
const FILTERS: { id: string; name: string }[] = [
  { id: 'all', name: '全部' },
  { id: 'command', name: '指令' },
  { id: 'settings', name: '设置' },
  { id: 'error', name: '报错' },
]

/** 同一天只显示 时:分，更早的带上月/日。 */
function timeText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  const clock = pad(d.getHours()) + ':' + pad(d.getMinutes())
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? clock : d.getMonth() + 1 + '/' + d.getDate() + ' ' + clock
}

export function LogScreen() {
  const [filter, setFilter] = useState('all')
  const [entries, setEntries] = useState<LogEntry[]>(readLog)
  const shown = filter === 'all' ? entries : entries.filter(entry => entry.kind === filter)
  async function clear() {
    const ok = await Dialog.confirm({
      title: '清空日志？',
      message: '只清空这份记录，不影响设置和缓存。',
      confirmLabel: '清空',
      cancelLabel: '取消',
    })
    if (!ok) return
    clearLog()
    setEntries([])
  }
  return <List navigationTitle="日志" navigationBarTitleDisplayMode="inline">
    <Section footer={<Text>最多保留 300 条，重复的报错十分钟内合并。</Text>}>
      <Picker title="筛选" value={filter} onChanged={(v: any) => setFilter(String(v))}>
        {FILTERS.map(item => <Text key={item.id} tag={item.id}>{item.name}</Text>)}
      </Picker>
    </Section>
    <Section>
      {shown.length
        ? shown.map((entry, index) => <VStack key={entry.at + '-' + index} alignment="leading" spacing={3} padding={{ top: 3, bottom: 3 }}>
          <HStack spacing={6}>
            <Text font={10} foregroundStyle={KIND_COLORS[entry.kind] as any}>{KIND_NAMES[entry.kind]}</Text>
            <Text font={15}>{entry.title}</Text>
            <Spacer />
            <Text font={10} foregroundStyle="#7A8494">{timeText(entry.at)}</Text>
          </HStack>
          {entry.detail ? <Text font={11} foregroundStyle="#7A8494">{entry.detail}</Text> : null}
        </VStack>)
        : <Text font={12} foregroundStyle="#7A8494">{filter === 'all' ? '还没有记录。' : '这一类还没有记录。'}</Text>}
    </Section>
    {entries.length ? <Section>
      <Button title="清空日志" action={clear} />
    </Section> : null}
  </List>
}
