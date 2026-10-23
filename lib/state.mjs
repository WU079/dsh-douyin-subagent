/**
 * lib/state.mjs —— 插件的"家"（$DSH_HOME/douyin-duty）与谷时判定
 * ============================================================================
 * 抄 dsh-bili-subagent 的同名实现（MIT），只把家目录名换成 douyin-duty。
 * 规矩一样：**配置、cookie、报告、日志都放家目录**，绝不写进插件包（升级会被覆盖）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 谷时窗口（本地时间）—— 想改就改这一处；DSH 设置/配置里的 noon、night 只是开关 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '13:00', end: '15:00' },
  night: { label: '晚上/夜间谷时', start: '19:00', end: '10:00' },
}

/** ⚠️ ctx.get('dshHomePath') 返回的是**函数**（传目录名进去），不是字符串 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('douyin-duty')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'douyin-duty')
    }
  } catch { /* 拿不到就兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 19:00–10:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

export function isWeekend(now) {
  const d = now.getDay()
  return d === 0 || d === 6
}

/** 谷时判定：周末整天算谷时；工作日按窗口算 */
export function inValley(now, win) {
  if (isWeekend(now)) return true
  return inWindow(now, win)
}

export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 兜底目录是否已经铺好工具脚本 */
export function toolsDirOf(stateDir) {
  return join(stateDir, 'tools')
}
