import { Image, SVG } from 'scripting'
import { buttonIconSVG } from './button-icons'

// 「刷新车况」这枚不自绘：车辆中心顶部那两枚刷新按钮用的是系统符号 arrow.triangle.2.circlepath
// （index.tsx 里的状态图标与 CircleButton），自绘再像也不是同一副箭头 —— 系统符号的箭头是实心三角。
// 这里直接改用同一枚系统符号，两处放到一起看才是真的一样。
const SYSTEM_GLYPHS: Record<string, string> = { refresh: 'arrow.triangle.2.circlepath' }
// 系统符号自带的留白比自绘 SVG 的 24 格小，框给满会比旁边的图标大一圈：
// 实测 pointSize 120 时布局框 145×140、墨迹 143×119（两侧箭头探出去），圆形本体直径 ≈ 119。
// 按 0.78 收一格，圆 ≈ 框的 0.66，跟自绘图标墨迹 17/24 ≈ 0.71 的观感齐平。
const SYSTEM_GLYPH_SCALE = 0.78
// 系统符号不能逐点改线宽，只能换字重：把「图标线条粗细」（0.8 – 3.2）分成 9 档，
// 默认 1.7 落在 regular，跟自绘图标 1.7 的描边看起来一样粗。
const WEIGHTS = ['ultraLight', 'thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'heavy', 'black'] as const
const WEIGHT_STEPS = [1.2, 1.45, 1.7, 1.95, 2.2, 2.45, 2.7, 3.0]
function weightOf(lineWidth: number) {
  let i = 0
  while (i < WEIGHT_STEPS.length && lineWidth >= WEIGHT_STEPS[i]) i++
  return WEIGHTS[i]
}

/**
 * 按钮图标：Refresh 走系统符号，其余走自绘 SVG。
 * 两种画法共用同一个 size 口径（= 自绘 SVG 的那个方框），调用方只管给边长。
 */
export function ButtonGlyph({ id, state, color, lineWidth = 1.7, size }: {
  id: string
  state: boolean
  color: any
  lineWidth?: number
  size: number
}) {
  const systemName = SYSTEM_GLYPHS[id]
  if (systemName) {
    const box = Math.round(size * SYSTEM_GLYPH_SCALE * 10) / 10
    return <Image systemName={systemName} resizable scaleToFit fontWeight={weightOf(lineWidth)} foregroundStyle={color} frame={{ width: box, height: box }} />
  }
  return <SVG code={buttonIconSVG(id, state, color, lineWidth)} resizable renderingMode="original" frame={{ width: size, height: size }} />
}
