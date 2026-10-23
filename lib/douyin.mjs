/**
 * lib/douyin.mjs —— 抖音侧的"运行环境"：MCP 服务、受控浏览器、cookie 导出
 * ============================================================================
 * 三个部件（都放插件家目录里，别写进插件包）：
 *   1. yunsur/douyin-mcp（Go）—— 133 个抖音工具，HTTP MCP 挂在本机端口上；
 *      起进程的命令：`douyin-mcp-windows-amd64.exe -port :18080 -token <token>`；
 *      cookie 文件路径用环境变量 `DOUYIN_COOKIES_FILE` 指到家目录里。
 *   2. 受控 Edge（--remote-debugging-port=9222）—— 登录态、发布都靠它；用户扫官方码登录。
 *   3. CDP 工具脚本（vendor/douyin-tools/*.mjs）—— 从浏览器里导 cookie、发图文、读页面。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { McpHttp } from './mcpHttp.mjs'

export function mcpUrlOf(port) {
  return `http://127.0.0.1:${Number(port) || 18080}/mcp`
}

/** 起一个分离进程（宿主退出不连坐；日志写文件） */
export function spawnDetached(command, args, { cwd, env, logFile, log = () => {} }) {
  mkdirSync(dirname(logFile), { recursive: true })
  const out = openSync(logFile, 'a')
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  log(`已拉起：${command} ${args.join(' ')}（pid ${child.pid}）`)
  return child
}

async function httpOk(url, { timeoutMs = 1500 } = {}) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const res = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}

export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 1000, label = '等待' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/** MCP 是否活着：用 initialize 探（GET /mcp 会被服务端拒掉，不能拿 GET 当健康检查） */
export async function mcpAlive({ port, token }) {
  try {
    const m = new McpHttp({ url: mcpUrlOf(port), token })
    await m.initialize()
    return true
  } catch { return false }
}

/**
 * 保证 MCP 服务在跑。
 * @returns {Promise<{ok:boolean, started:boolean, error?:string}>}
 */
export async function ensureMcpServer({ exe, port, token, stateDir, cookieFile: cookiePath = '', log = () => {} }) {
  const url = mcpUrlOf(port)
  if (!exe) return { ok: false, started: false, error: '没有配置抖音 MCP 可执行文件：用 dy_config 设置 mcpExe，或设置环境变量 DOUYIN_MCP_EXE（指向 douyin-mcp-windows-amd64.exe）' }
  if (!existsSync(exe)) return { ok: false, started: false, error: '找不到 douyin-mcp 可执行文件：' + exe }
  if (await mcpAlive({ port, token })) return { ok: true, started: false }

  mkdirSync(stateDir, { recursive: true })
  const cookieFile = cookiePath || join(stateDir, 'cookies.txt')
  spawnDetached(exe, ['-port', ':' + Number(port), '-token', String(token)], {
    cwd: stateDir,
    env: { DOUYIN_COOKIES_FILE: cookieFile },
    logFile: join(stateDir, 'mcp.log'),
    log,
  })
  const ok = await waitFor(() => mcpAlive({ port, token }), { timeoutMs: 25000, label: '等抖音 MCP 起来' })
  return ok ? { ok: true, started: true } : { ok: false, started: true, error: '抖音 MCP 25 秒内没起来（看 ' + join(stateDir, 'mcp.log') + '）' }
}

/** 受控 Edge：没开就开，返回 baseUrl */
export async function ensureBrowser({ browserPort = 9222, profileDir, url = 'https://www.douyin.com/', log = () => {} }) {
  const base = `http://127.0.0.1:${Number(browserPort)}`
  if (await httpOk(base + '/json/version')) return { ok: true, started: false, baseUrl: base }
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => existsSync(p))
  if (!edge) return { ok: false, started: false, error: '找不到 msedge.exe' }
  mkdirSync(profileDir, { recursive: true })
  spawnDetached(edge, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${Number(browserPort)}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ], { cwd: profileDir, logFile: join(profileDir, 'edge.log'), log })
  const ok = await waitFor(() => httpOk(base + '/json/version'), { timeoutMs: 20000 })
  return ok ? { ok: true, started: true, baseUrl: base } : { ok: false, started: true, error: 'Edge 20 秒内没开 CDP 端口' }
}

/**
 * 从受控浏览器里导出 cookie，写成 yunsur 认的单行格式。
 * @returns {Promise<{ok:boolean, count?:number, file?:string, error?:string}>}
 */
export async function exportCookies({ toolsDir, browserPort, cookieFile, log = () => {} }) {
  const script = join(toolsDir, 'cdp_cookies.mjs')
  if (!existsSync(script)) return { ok: false, error: '缺工具脚本：' + script }
  const port = String(Number(browserPort) || 9222)
  const line = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, port], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', () => resolve(out.trim().split(/\r?\n/).pop() || ''))
  })
  if (!line || !line.includes('=')) return { ok: false, error: 'CDP 导出没拿到 cookie：' + line.slice(-300) }
  if (!/sessionid=/.test(line)) return { ok: false, error: 'cookie 里没有 sessionid（浏览器可能还没登录）' }
  mkdirSync(dirname(cookieFile), { recursive: true })
  writeFileSync(cookieFile, line, 'utf8')
  const count = line.split(';').length
  log(`cookie 已导出：${count} 条 → ${cookieFile}`)
  return { ok: true, count, file: cookieFile }
}
