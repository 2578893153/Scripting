import { bits, type CarData } from './api'
import type { Color } from 'scripting'
import { asColor } from './color-utils'

/**
 * 车辆是否需要关注（未锁车 / 发动机仍运转）。
 * 必须走 availability：字段没上报时值会被初始化为 false，直接读会误判成“已锁车 / 已熄火”。
 * 这是全项目唯一的判断入口，仪表盘和标题栏都调它。
 */
export function needsAttention(data: CarData | null): boolean {
  if (!data) return false
  const a = data.availability
  return (a?.locked === true && !data.locked) || (a?.engineOn === true && data.engineOn)
}

/** 需要关注时返回橙色提醒色，否则用调用方给的常态色。 */
export function statusTint(data: CarData | null, normal: string): Color {
  return needsAttention(data) ? '#FB923C' : asColor(normal)
}

// 奥捷：第 5 位尾门，第 6 位机盖（2026-10-26 关闭/打开各两次车况抓包验证）。
// 奥智联：保留已验证的第 9 位尾门；机盖尚无该平台的状态证据。
export function panelOpen(data: CarData | null, panel: 'trunk' | 'hood'): boolean | null {
  if (!data || data.availability?.carDoor !== true) return null
  if (panel === 'hood' && data.provider !== 'aojie') return null
  const values = bits(data.carDoor)
  const index = panel === 'hood' ? 5 : data.provider === 'aojie' ? 4 : 8
  const value = values?.[index]
  return value === 1 ? true : value === 0 ? false : null
}
export function trunkOpen(data: CarData | null): boolean { return panelOpen(data, 'trunk') === true }
export function doorsOpen(data: CarData | null): boolean | null {
  if (!data || data.availability?.carDoor !== true) return null
  const doors = bits(data.carDoor)?.slice(0, 4)
  if (!doors || doors.length !== 4 || !doors.every(v => v === 0 || v === 1)) return null
  return doors.some(v => v === 1)
}
export function bodyWarnings(data: CarData | null): { icon: string; label: string; tint: Color }[] {
  const out: { icon: string; label: string; tint: Color }[] = []
  if (doorsOpen(data) === true) out.push({ icon: 'door', label: '车门未关', tint: asColor('#FB923C') })
  if (panelOpen(data, 'trunk') === true) out.push({ icon: 'trunk', label: '尾门未关', tint: asColor('#FB923C') })
  if (panelOpen(data, 'hood') === true) out.push({ icon: 'car.side.front.open.crop', label: '机盖未关', tint: asColor('#FB923C') })
  return out
}
