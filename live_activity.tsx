import {
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  HStack,
  VStack,
  Text,
  Image,
} from 'scripting'
import type { Color, LiveActivityUIBuilder } from 'scripting'

// 组件里点按钮（刷新车况、锁车、开空调……）执行时，灵动岛 / 锁屏上显示的内容。
// 三段式：执行中 → 成功 / 失败，最后由执行流程调用 end() 自动收掉。
export type ActionPhase = 'running' | 'done' | 'failed'

export type ActionState = {
  phase: ActionPhase
  title: string
  detail: string
}

// 三种阶段的底色。写成 Color 而不是 string：string 太宽，塞给 foregroundStyle 会报类型错。
const TINT: Record<ActionPhase, Color> = { running: '#3B82F6', done: '#22C55E', failed: '#EF4444' }
const SYMBOL: Record<ActionPhase, string> = {
  running: 'arrow.triangle.2.circlepath',
  done: 'checkmark.circle.fill',
  failed: 'exclamationmark.triangle.fill',
}
// 灵动岛右上角只有两三个字的宽度，放最短的词。
const BADGE: Record<ActionPhase, string> = { running: '执行中', done: '已完成', failed: '失败' }

/** 锁屏正文与展开后的中间区：图标 + 标题 + 一句细节。 */
function Card(state: ActionState) {
  return (
    <HStack alignment="center" spacing={9} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
      <Image systemName={SYMBOL[state.phase]} resizable scaleToFit foregroundStyle={TINT[state.phase]} frame={{ width: 20, height: 20 }} />
      <VStack alignment="leading" spacing={1} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
        <Text font={14} fontWeight="semibold" lineLimit={1}>{state.title}</Text>
        {state.detail ? <Text font={11.5} foregroundStyle="secondaryLabel" lineLimit={1}>{state.detail}</Text> : null}
      </VStack>
    </HStack>
  )
}

const builder: LiveActivityUIBuilder<ActionState> = (state) => {
  const tint = TINT[state.phase]
  return (
    <LiveActivityUI
      content={<Card {...state} />}
      compactLeading={<Image systemName="car.fill" resizable scaleToFit foregroundStyle={tint} frame={{ width: 17, height: 17 }} />}
      compactTrailing={<Text font={10.5} fontWeight="semibold" foregroundStyle={tint} lineLimit={1}>{BADGE[state.phase]}</Text>}
      minimal={<Image systemName={SYMBOL[state.phase]} resizable scaleToFit foregroundStyle={tint} frame={{ width: 16, height: 16 }} />}>
      <LiveActivityUIExpandedCenter>
        <Card {...state} />
      </LiveActivityUIExpandedCenter>
      <LiveActivityUIExpandedBottom>
        <Text font={10.5} foregroundStyle="secondaryLabel" lineLimit={1}>
          {state.phase === 'running' ? '完成后自动收起' : '灵动岛即将自动收起'}
        </Text>
      </LiveActivityUIExpandedBottom>
    </LiveActivityUI>
  )
}

// 名字要跟 action-activity.ts 里的 NAME 一致：重新拿回旧活动时按这个名字查找。
export const CarLinkActionActivity = LiveActivity.register<ActionState>('CarLinkAction', builder)
