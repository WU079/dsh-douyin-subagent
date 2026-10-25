/**
 * lib/mcpVersion.mjs —— 外部 douyin-mcp 的「版本闸」
 * ============================================================================
 * 🔴 为什么要有它（2026-10-25 上游 awesome 列表 maintainer 的 review 建议）：
 *   插件把 douyin-mcp 当**外部可执行文件**用，但没锁版本 —— 上游一改接口/参数，
 *   我们这边就会静默地坏掉（报的错还看不出是版本问题）。
 *   所以：
 *     ① README 里写明**测试过的那个构建**（tag + 资产名 + SHA-256）；
 *     ② 运行时先比哈希、再比 `initialize` 回的 `serverInfo.version`，不符就**明确报错**，
 *        报错里直接给出「测试过的版本 / 实际版本 / 去哪儿下 / 怎么临时放行」。
 *
 * ⚠️ 坑：上游 `serverInfo.version` 是代码里写死的 `1.0.0`，跟 release tag（`v0.1.0`）**无关**，
 *   所以光比版本号锁不住 —— **真正的锁是 exe 的 SHA-256**。版本号只当辅助信号。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'

/** 本插件**实际测过**的 douyin-mcp 构建（Windows 上按字节锁死） */
export const TESTED_MCP = {
  repo: 'yunsur/douyin-mcp',
  tag: 'v0.1.0',
  releasedAt: '2026-10-07',
  asset: 'douyin-mcp-windows-amd64.exe',
  url: 'https://github.com/yunsur/douyin-mcp/releases/download/v0.1.0/douyin-mcp-windows-amd64.exe',
  size: 38575616,
  sha256: '0795584ff1343ff3d6c963a23ec2098b96cc9cea7bfd73eac4c33149b9963134',
  serverVersion: '1.0.0', // initialize → result.serverInfo.version（上游写死，不代表 tag）
}

const POLICIES = ['strict', 'warn', 'off']

/** `mcpVersionCheck` 只认 strict / warn / off，其它一律 fallback 到 strict */
export function normalizePolicy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return POLICIES.includes(s) ? s : 'strict'
}

/** 「测试过的版本」人话一行，报错和状态页都用它 */
export function describeTested() {
  return `${TESTED_MCP.repo} ${TESTED_MCP.tag}（${TESTED_MCP.asset}，sha256 ${TESTED_MCP.sha256.slice(0, 12)}…，${TESTED_MCP.size} 字节）`
}

/** 哈希缓存：按 path + size + mtime 记，同一个 exe 不用每次都重算 38MB */
const hashCache = new Map()

/**
 * 算一个文件的 sha256（流式，失败返回 null）
 * @returns {Promise<string|null>}
 */
export async function sha256Of(file) {
  let st
  try { st = statSync(file) } catch { return null }
  const key = `${file}|${st.size}|${st.mtimeMs}`
  const hit = hashCache.get(key)
  if (hit) return hit
  const sha = await new Promise((resolve) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', () => resolve(null))
    s.on('end', () => resolve(h.digest('hex')))
  })
  if (sha) {
    hashCache.set(key, sha)
    // 顺手清掉同一个文件的历史版本，别让缓存无限长
    for (const k of hashCache.keys()) if (k.startsWith(file + '|') && k !== key) hashCache.delete(k)
  }
  return sha
}

/**
 * 版本闸的核心（纯函数，方便单测）：只看「哈希 / serverInfo / 策略」，不碰 IO。
 * level 的语义：ok = 对得上；warn = 有疑点但放行；error = 拦住（strict 下 ok=false）。
 * @param {{policy?:string, platform?:string, sha256?:string|null, size?:number|null,
 *          serverVersion?:string|null, file?:string}} p
 * @returns {{ok:boolean, level:'ok'|'warn'|'error'|'off', code:string, message:string,
 *            tested:object, detected:object, policy:string}}
 */
export function evaluateMcpVersion({ policy, platform = process.platform, sha256 = null, size = null, serverVersion = null, file = '' } = {}) {
  const pol = normalizePolicy(policy)
  const strict = pol === 'strict'
  const detected = { file, size, sha256, serverVersion }
  const base = { tested: TESTED_MCP, detected, policy: pol }
  const where = file ? `（${file}）` : ''

  if (pol === 'off') {
    return { ...base, ok: true, level: 'off', code: 'off', message: '版本闸已关（mcpVersionCheck=off），不检查 douyin-mcp 版本' }
  }

  const winTested = platform === 'win32'
  const shaOk = Boolean(sha256) && sha256.toLowerCase() === TESTED_MCP.sha256

  // ① 字节级对上 —— 就是测试过的那个构建，最放心
  if (shaOk) {
    return {
      ...base, ok: true, level: 'ok', code: 'match',
      message: `douyin-mcp 版本对得上：${describeTested()}`,
    }
  }

  // ② 非 Windows（darwin/linux 资产哈希本来就不一样）→ 只比 serverInfo.version
  if (!winTested) {
    if (serverVersion && serverVersion === TESTED_MCP.serverVersion) {
      return {
        ...base, ok: true, level: 'warn', code: 'hash-unverified',
        message: `douyin-mcp 在 ${platform} 上没法按哈希锁（只测过 Windows 资产），serverInfo.version=${serverVersion} 与测试一致，按可用处理`,
      }
    }
    return {
      ...base, ok: !strict, level: strict ? 'error' : 'warn', code: 'server-version-mismatch',
      message: `douyin-mcp 版本对不上：测试过的是 ${describeTested()}，实际 serverInfo.version=${serverVersion ?? '(拿不到)'}${where}。`
        + '上游改过接口的话这里就会坏 —— 按 README「版本锁定」换回测试过的构建；'
        + '确实要用新版就把 mcpVersionCheck 设成 "warn"（只警告）或 "off"（不检查）。',
    }
  }

  // ③ Windows 但哈希不同 —— 问题多半在这
  const got = sha256 ? `sha256 ${sha256.slice(0, 12)}…` : '算不出 sha256'
  const ver = serverVersion ? `，serverInfo.version=${serverVersion}` : ''
  const sameVer = Boolean(serverVersion) && serverVersion === TESTED_MCP.serverVersion

  return {
    ...base,
    ok: !strict,
    level: strict ? 'error' : 'warn',
    code: sameVer ? 'hash-mismatch' : 'server-version-mismatch',
    message: `douyin-mcp 不是测试过的那个构建：测试过的是 ${describeTested()}；`
      + `你这个是 ${got}${size ? `、${size} 字节` : ''}${ver}${where}。`
      + (sameVer
        ? '版本号碰巧一样但二进制不同（重编过 / 被替换 / 非官方来源）。'
        : '上游改过接口的话，插件这部分就会失效。')
      + `改法：从 ${TESTED_MCP.url} 下回测试过的那个 exe；`
      + '或者把 mcpVersionCheck 设成 "warn"（只警告、照常用）/"off"（完全不检查）。',
  }
}

/**
 * 查一个真实 exe + 一个真实 serverInfo，走完 version gate。
 * @returns {Promise<ReturnType<typeof evaluateMcpVersion>>}
 */
export async function verifyMcp({ exe, serverInfo = null, policy = 'strict', log = () => {} } = {}) {
  const pol = normalizePolicy(policy)
  const serverVersion = serverInfo?.version ? String(serverInfo.version) : null
  if (pol === 'off') return evaluateMcpVersion({ policy: pol, serverVersion, file: exe })

  let stat = null
  try { stat = statSync(exe) } catch { /* 文件不在 —— 交给调用方前面那步报「找不到 exe」 */ }
  const sha256 = stat ? await sha256Of(exe) : null
  const verdict = evaluateMcpVersion({
    policy: pol,
    platform: process.platform,
    sha256,
    size: stat ? stat.size : null,
    serverVersion,
    file: exe,
  })
  if (verdict.level !== 'ok' && verdict.level !== 'off') log(`[version] ${verdict.level}: ${verdict.message}`)
  return verdict
}
