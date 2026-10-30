import type { Color } from 'scripting'

/**
 * 把运行时已经校验过的颜色字符串收窄成 Color。
 *
 * scripting 的 Color 是模板字面量联合类型（`#${string}`、rgb()/hsl()、clear 等关键字），
 * 从设置里读出来的颜色在类型上只是宽泛的 string，直接塞给 fill / foregroundStyle 会报类型错。
 * 合法性由 settings.ts 的 normalizeColor 负责，这里只做类型收窄，运行时不改变任何值。
 */
export function asColor(value: string): Color {
  return value as Color
}
