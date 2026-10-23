/**
 * dsh-douyin-subagent —— host 半端
 * ============================================================================
 * 它是什么：把「刷抖音」做成和刷 B站 一样的插件。
 *   1. 插件内部把 douyin 的 MCP（yunsur/douyin-mcp，Go）当外部服务用：
 *      没起就拉起来，然后把它的能力包成 `dy_*` 工具（搜 / 作品详情 / 评论 / 发评论 / 发布）。
 *   2. 谷时定时器：中午 13:00–15:00、夜里 19:00–次日 10:00（`lib/state.mjs` 的 WINDOWS），
 *      到点往「目标会话」递一句触发语 —— 洛洛自己用 `dy_scan` 派子代理去刷。
 *   3. `dy_scan` = 起一个子代理（`subagents.startActivation`），照 `prompts/duty.md` 的章程
 *      搜视频、读详情、翻评论、挑值得的，把报告交回来；报告同时落盘到 `<家>/out/<日期>.md`。
 *   4. 登录态：受控 Edge（--remote-debugging-port）里主人扫官方码，`dy_login` 把 cookie
 *      从 CDP 导出来写进 `<家>/cookies.txt`，MCP 进程读的也是这份。
 *
 * 家目录（`$DSH_HOME/douyin-duty/`）：config.json / state.json / cookies.txt / tools/ /
 *   out/（每天的报告）/ duty.md（值班章程）/ duty.log / mcp.log。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { McpHttp } from './lib/mcpHttp.mjs'
import { WINDOWS, dayKey, inValley, inWindow, readJson, stateDirOf, writeJson } from './lib/state.mjs'
import { ensureBrowser, ensureMcpServer, exportCookies, mcpUrlOf } from './lib/douyin.mjs'

export const name = 'douyin-scroll'
export const inject = ['tools', 'subagents', 'agents']

const DEFAULTS = {
  enabled: true,
  // 谷时
  autoMode: 'valley',            // manual = 只手动 / valley = 只在谷时 / always = 全天
  noon: true,
  night: true,
  perDay: 2,                     // 每天自动刷几轮（不是几条）
  gapMin: 180,                   // 两轮之间至少隔几分钟
  direction: '',                 // 想看的方向，留空自动从 keywords/默认来
  keywords: [],                  // 方向候选，逗号串也可
  perScan: 1,                    // 每轮挑几条
  ownerName: '主人',
  // 服务（留空 = 用环境变量 / 插件家目录下的默认位置）
  mcpExe: '',                    // 指向 douyin-mcp-windows-amd64.exe；也可用 DOUYIN_MCP_EXE
  mcpPort: 18080,
  mcpToken: '',                  // 留空 = 首次运行随机生成并存进家目录 config.json
  browserPort: 9222,
  browserProfile: '',            // 留空 = <家目录>/browser
  cookieFile: '',                // 留空 = <家目录>/cookies.txt
  // 投递
  targetSession: '',             // 留空 = 自动挑最近聊过的会话
  triggerPrompt: '（到谷时啦，去抖音帮我刷一轮吧～方向：{direction}。用 dy_scan 就行；刷完按设置该评论就评论、该发作品就发作品。）',
  reportLevel: 'full',           // full / brief / off
}

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  autoMode: z.string().default('valley').extra('volatile', true),
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  perDay: z.natural().default(2).extra('volatile', true),
  gapMin: z.natural().default(180).extra('volatile', true),
  direction: z.string().default('').extra('volatile', true),
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  perScan: z.natural().default(1).extra('volatile', true),
  ownerName: z.string().default('主人').extra('volatile', true),
  mcpExe: z.string().default(DEFAULTS.mcpExe).extra('volatile', true),
  mcpPort: z.natural().default(18080).extra('volatile', true),
  mcpToken: z.string().default('').extra('volatile', true),
  browserPort: z.natural().default(9222).extra('volatile', true),
  browserProfile: z.string().default(DEFAULTS.browserProfile).extra('volatile', true),
  cookieFile: z.string().default(DEFAULTS.cookieFile).extra('volatile', true),
  targetSession: z.string().default('').extra('volatile', true),
  triggerPrompt: z.string().default(DEFAULTS.triggerPrompt).extra('volatile', true),
  reportLevel: z.string().default('full').extra('volatile', true),
})

export function apply(ctx, rawConfig) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const stateDir = stateDirOf(ctx)
  const toolsDir = join(stateDir, 'tools')
  const outDir = join(stateDir, 'out')
  const cfgFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')
  const logFile = join(stateDir, 'duty.log')
  mkdirSync(toolsDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  const log = (m) => {
    try { appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`, 'utf8') } catch { /* 日志失败不影响主流程 */ }
  }

  // 家里没有配置文件就铺一份默认（合并插件 config 里的默认值）
  let fileCfg = readJson(cfgFile, null)
  if (!fileCfg) { fileCfg = {}; writeJson(cfgFile, fileCfg) }
  const cfg = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}), ...fileCfg }
  const refresh = () => Object.assign(cfg, DEFAULTS, readJson(cfgFile, {}))

  // 把工具脚本、值班章程铺进家目录（脚本变了就覆盖；章程不动用户在用的那份）
  const copyInto = (from, to) => {
    try {
      if (!existsSync(from)) return
      if (existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) return
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
  try {
    const src = join(pluginDir, 'vendor', 'douyin-tools')
    for (const f of readdirSync(src)) copyInto(join(src, f), join(toolsDir, f))
    const dutyHome = join(stateDir, 'duty.md')
    if (!existsSync(dutyHome)) copyInto(join(pluginDir, 'prompts', 'duty.md'), dutyHome)
  } catch (e) { log(`铺家目录文件失败：${e?.message ?? e}`) }

  const resolveRuntime = () => {
    let token = String(cfg.mcpToken || '').trim()
    if (!token) {
      token = randomBytes(16).toString('hex')
      cfg.mcpToken = token
      try { writeJson(cfgFile, { ...readJson(cfgFile, {}), mcpToken: token }) } catch (e) { log(`写 token 失败：${e?.message ?? e}`) }
    }
    return {
      exe: String(cfg.mcpExe || process.env.DOUYIN_MCP_EXE || '').trim(),
      token,
      profile: String(cfg.browserProfile || '').trim() || join(stateDir, 'browser'),
    }
  }
  const cookieFile = String(cfg.cookieFile || '').trim() || join(stateDir, 'cookies.txt')
  let runtime = resolveRuntime()
  const mcp = new McpHttp({ url: mcpUrlOf(cfg.mcpPort), token: runtime.token, log })
  const syncMcp = () => {
    runtime = resolveRuntime()
    mcp.url = mcpUrlOf(cfg.mcpPort)
    mcp.token = runtime.token
    mcp.sessionId = null
    mcp.inited = false
  }
  const ensureServer = async () => {
    if (!cfg.enabled) return { ok: false, error: '插件已关闭（config.enabled=false）' }
    syncMcp()
    const r = await ensureMcpServer({
      exe: runtime.exe, port: cfg.mcpPort, token: runtime.token, stateDir, cookieFile, log,
    })
    if (!r.ok) return r
    try { await mcp.initialize() } catch (e) { return { ...r, ok: false, error: String(e?.message ?? e) } }
    return r
  }
  const callTool = async (name, args) => {
    const s = await ensureServer()
    if (!s.ok) throw new Error(s.error || '抖音 MCP 起不来')
    return mcp.call(name, args || {})
  }

  const now = () => new Date()
  const st = () => readJson(stateFile, {})
  const bumpState = (patch) => { const cur = st(); writeJson(stateFile, { ...cur, ...patch }); return { ...cur, ...patch } }

  const sessionIdOf = (s) => (typeof s === 'string' ? s : (s?.id || s?.sessionId || ''))
  const pickAgent = (target) => {
    const list = (() => { try { return ctx.agents?.list?.() || [] } catch { return [] } })()
    if (target) {
      let a = null
      try { a = ctx.agents?.get?.(target) } catch { /* ignore */ }
      if (!a) a = list.find((x) => sessionIdOf(x.session) === target)
      return a || null
    }
    // 没指定 → 最近聊过的那个
    return list.find((x) => typeof x?.followup === 'function' && x?.session) || null
  }

  const dayOf = () => {
    const cur = st()
    if (cur.day !== dayKey(now())) return bumpState({ day: dayKey(now()), count: 0, windows: {}, lastRunAt: null })
    return cur
  }
  const openWindows = () => Object.entries(WINDOWS).filter(([k]) => cfg[k] !== false)

  /** 到谷时了 → 往目标会话递一句触发语。返回是否递出去了 */
  const triggerRound = async (why) => {
    const dir = String(cfg.direction || '').trim()
      || (Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean).join(' ') : '')
      || '最近有什么值得看的'
    const agent = pickAgent(String(cfg.targetSession || '').trim())
    if (!agent) { log(`自动刷：找不到可用会话（${why}）`); return false }
    if (typeof agent.followup !== 'function') { log('自动刷：目标 agent 没有 followup'); return false }
    const text = String(cfg.triggerPrompt || DEFAULTS.triggerPrompt)
      .split('{direction}').join(dir)
      .split('{owner}').join(String(cfg.ownerName || '主人'))
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'douyin-duty-scan', why },
      })
      log(`自动刷：已递触发语（${why}）`)
      return true
    } catch (e) { log(`自动刷：递触发语失败 ${e?.message ?? e}`); return false }
  }

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'dy_status',
    description: '看抖音插件现在的状态：MCP 服务在不在、登录的是谁、今天的自动轮次、谷时窗口与下次可跑时间、最近一份报告。',
    parameters: {},
    async execute() {
      refresh(); dayOf()
      let server = { ok: false }
      try { server = await ensureServer() } catch (e) { server = { ok: false, error: String(e?.message ?? e) } }
      let profile = null
      if (server.ok) {
        try { profile = await mcp.call('get_my_profile', {}) } catch (e) { profile = { error: String(e?.message ?? e) } }
      }
      const cur = st()
      const out = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.md')).sort().pop() : null
      return {
        ok: true,
        plugin: { version: (() => { try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version } catch { return '' } })(), stateDir },
        mcp: { ...server, url: mcp.url },
        loggedIn: Boolean(existsSync(cookieFile)),
        profile: profile && profile.status_code === 0
          ? {
              nickname: profile.user?.nickname,
              uid: profile.user?.uid,
              uniqueId: profile.user?.unique_id,
              avatar: profile.user?.avatar_thumb?.url_list?.[0],
            }
          : profile,
        today: { day: cur.day || dayKey(now()), rounds: cur.count || 0, perDay: cfg.perDay, windows: cur.windows || {} },
        windows: Object.fromEntries(openWindows().map(([k, w]) => [k, { label: w.label, start: w.start, end: w.end, open: inWindow(now(), w) }])),
        autoMode: cfg.autoMode,
        lastRunAt: cur.lastRunAt || null,
        lastReport: out ? join(outDir, out) : null,
      }
    },
  })

  tool({
    name: 'dy_config',
    description: '读 / 改抖音插件的配置（写进家目录的 config.json）。不给 patch 就是读。可改：perDay、gapMin、autoMode(manual/valley/always)、noon、night、direction、keywords、perScan、ownerName、targetSession、mcpExe、mcpPort、mcpToken、browserPort、cookieFile。',
    parameters: {
      patch: { type: 'object', description: '要改的字段（可省）', additionalProperties: true },
    },
    async execute(args) {
      const patch = args?.patch && typeof args.patch === 'object' ? args.patch : null
      if (patch) {
        const next = { ...readJson(cfgFile, {}), ...patch }
        writeJson(cfgFile, next)
        Object.assign(cfg, DEFAULTS, next)
        syncMcp()
        log('配置已改：' + Object.keys(patch).join(','))
      }
      refresh()
      return { ok: true, config: { ...cfg }, configFile: cfgFile }
    },
  })

  tool({
    name: 'dy_login',
    description: '抖音登录态。action=open（打开受控 Edge 到抖音首页，主人扫码登录）/ save（登录后把 cookie 从浏览器导出来，MCP 才能干活）/ status（看现在登的是谁）。',
    parameters: {
      action: { type: 'string', description: 'open / save / status（默认 status）' },
      url: { type: 'string', description: 'open 时打开的网址，默认抖音首页' },
    },
    async execute(args) {
      refresh()
      const action = String(args?.action || 'status').trim()
      if (action === 'open') {
        syncMcp()
        const r = await ensureBrowser({
          browserPort: cfg.browserPort,
          profileDir: runtime.profile,
          url: String(args?.url || 'https://www.douyin.com/'),
          log,
        })
        return { ok: r.ok, ...r, hint: r.ok ? '在弹出的 Edge 里扫码登录抖音，登好后调 dy_login {action:"save"}' : undefined }
      }
      if (action === 'save') {
        const r = await exportCookies({ toolsDir, browserPort: cfg.browserPort, cookieFile, log })
        if (r.ok) { syncMcp(); log(`cookie 已更新（${r.count} 条）`) }
        return r
      }
      try {
        const p = await callTool('get_my_profile', {})
        const ok = Boolean(p && p.status_code === 0)
        return {
          ok,
          profile: ok
            ? { nickname: p.user?.nickname, uid: p.user?.uid, uniqueId: p.user?.unique_id, avatar: p.user?.avatar_thumb?.url_list?.[0] }
            : p,
        }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },
  })

  tool({
    name: 'dy_search',
    description: '搜抖音视频（返回标题/作者/点赞/时长等）。刷一轮时的标准用法：按方向搜，挑几条再 `dy_video` 看详情、`dy_comments` 翻评论。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      count: { type: 'number', description: '返回几条（默认 10）' },
      sort: { type: 'string', description: '排序（可省，见 MCP 参数：综合/最多点赞/最新）' },
    },
    async execute(args) {
      const kw = String(args?.keyword || '').trim()
      if (!kw) return { ok: false, error: '缺少 keyword' }
      const raw = await callTool('search_videos', {
        keyword: kw,
        count: Math.max(1, Math.min(Number(args?.count) || 10, 30)),
        ...(args?.sort ? { sort_type: args.sort } : {}),
      })
      // 只留有用的字段：原始响应每条几 KB，全塞回来又贵又读不动
      const list = Array.isArray(raw) ? raw : (raw?.data || raw?.aweme_list || [])
      const items = (Array.isArray(list) ? list : []).map((it) => {
        const a = it?.aweme_info || it
        const st = a?.statistics || {}
        return {
          aweme_id: a?.aweme_id,
          desc: String(a?.desc || '').slice(0, 120),
          author: a?.author?.nickname,
          digg: st.digg_count, comment: st.comment_count, collect: st.collect_count, share: st.share_count,
          create_time: a?.create_time,
          images: Array.isArray(a?.images) && a.images.length ? a.images.length : undefined,
          url: a?.aweme_id ? `https://www.douyin.com/${a?.images?.length ? 'note' : 'video'}/${a.aweme_id}` : undefined,
        }
      })
      return { ok: true, keyword: kw, count: items.length, items }
    },
  })

  tool({
    name: 'dy_video',
    description: '看一条抖音作品的详情（标题、作者、数据、图文图片/视频直链）。参数 aweme_id 可以是作品链接或 id。',
    parameters: {
      aweme_id: { type: 'string', description: '作品 id 或链接（https://www.douyin.com/video/xxx、/note/xxx）' },
    },
    async execute(args) {
      const id = String(args?.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺少 aweme_id' }
      return { ok: true, result: await callTool('get_video_detail', { aweme_id: id }) }
    },
  })

  tool({
    name: 'dy_comments',
    description: '读一条抖音作品的评论（默认一级评论 + 热门回复），用来判断大家真实在说什么。',
    parameters: {
      aweme_id: { type: 'string', description: '作品 id 或链接' },
      count: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      const id = String(args?.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺少 aweme_id' }
      return { ok: true, result: await callTool('get_video_comments', { aweme_id: id, count: Math.max(1, Number(args?.count) || 30) }) }
    },
  })

  tool({
    name: 'dy_comment',
    description: '在抖音作品下发一条评论（或回复某条评论）。写操作 —— 只在自己确认要发时用；回复别人不要手打 @。',
    parameters: {
      aweme_id: { type: 'string', description: '作品 id 或链接' },
      content: { type: 'string', description: '评论正文（短、干净、像人说的话）' },
      reply_id: { type: 'string', description: '可选：要回复的评论 id（楼中楼）' },
    },
    async execute(args) {
      const id = String(args?.aweme_id || '').trim()
      const content = String(args?.content || '').trim()
      if (!id || !content) return { ok: false, error: '缺少 aweme_id 或 content' }
      const r = await callTool('post_video_comment', {
        aweme_id: id, content, ...(args?.reply_id ? { reply_id: String(args.reply_id) } : {}),
      })
      log(`已发评论（aweme=${id}）`)
      return { ok: true, result: r }
    },
  })

  tool({
    name: 'dy_publish',
    description: '发布抖音作品（图文或视频）。默认走 MCP 的 publish_content/publish_with_video；缺 DY_TICKET 一类发布凭据时会报错，那种情况改走受控浏览器（dy_scan 里说明）。',
    parameters: {
      kind: { type: 'string', description: 'image（图文，默认）或 video' },
      title: { type: 'string', description: '标题/描述' },
      images: { type: 'array', description: '图文：图片本地路径或 URL 列表', items: { type: 'string' } },
      video: { type: 'string', description: '视频：本地路径或 URL' },
      tags: { type: 'array', description: '话题标签', items: { type: 'string' } },
      visibility: { type: 'string', description: 'public / friends / private（默认 public）' },
    },
    async execute(args) {
      const kind = String(args?.kind || 'image').trim()
      const title = String(args?.title || '').trim()
      if (!title) return { ok: false, error: '缺少 title' }
      const base = {
        title, desc: title,
        ...(Array.isArray(args?.tags) && args.tags.length ? { tags: args.tags } : {}),
        ...(args?.visibility ? { visibility: args.visibility } : {}),
      }
      if (kind === 'video') {
        if (!args?.video) return { ok: false, error: '缺少 video 路径' }
        return { ok: true, result: await callTool('publish_with_video', { ...base, video: String(args.video) }) }
      }
      const images = Array.isArray(args?.images) ? args.images.filter(Boolean).map(String) : []
      if (!images.length) return { ok: false, error: '缺少 images' }
      return { ok: true, result: await callTool('publish_content', { ...base, images }) }
    },
  })

  // 子代理刷一轮：报告 = 子代理最后那段话；同时落盘
  const scanRound = async (direction, n) => {
    const parent = (() => { try { return ctx.agents?.currentInitiator?.() } catch { return null } })()
    const dir = String(direction || '').trim()
      || String(cfg.direction || '').trim()
      || (Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean).join(' ') : '')
      || '最近有什么值得看的'
    const perScan = Math.max(1, Number(n) || Number(cfg.perScan) || 1)
    const dutyHome = join(stateDir, 'duty.md')
    let charter = ''
    try { charter = readFileSync(dutyHome, 'utf8') } catch { /* 没铺上也照跑 */ }
    const prompt = charter
      .split('{direction}').join(dir)
      .split('{owner}').join(String(cfg.ownerName || '主人'))
      .split('{n}').join(String(perScan))
      + (cfg.reportLevel === 'brief' ? '\n\n⚠️ 报告形态：**薄** —— 每条一两行就够。' : '')
    let run
    try {
      run = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: '刷抖音：' + dir.slice(0, 20),
        request: { prompt: [{ type: 'text', text: prompt }], parent },
        signal: new AbortController().signal,
        delivery: 'caller',
      })
    } catch (e) { return { ok: false, error: '派子代理失败：' + (e?.message ?? e) } }
    let result
    try { result = await run.result } catch (e) {
      try { await run.dispose() } catch { /* ignore */ }
      return { ok: false, error: '子代理跑失败：' + (e?.message ?? e) }
    }
    const output = (result?.output || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    try { await run.dispose() } catch { /* ignore */ }
    if (result?.stopReason !== 'completed') {
      return { ok: false, error: '子代理没正常跑完（' + (result?.stopReason || '未知') + '）', partial: output }
    }
    const file = join(outDir, dayKey(now()) + '.md')
    try {
      appendFileSync(file, `\n\n---\n# ${dayKey(now())} · ${dir}（${perScan} 条）\n\n${output}\n`, 'utf8')
      log(`报告已写入 ${file}`)
    } catch (e) { log(`写报告失败：${e?.message ?? e}`) }
    return { ok: true, direction: dir, report: output, file }
  }

  tool({
    name: 'dy_scan',
    description: '派一个子代理去刷抖音：按方向搜视频、看详情、翻评论，挑出值得的并汇报。\n直接说「帮我刷下 XX」就能用；自动谷时轮次也是调这个工具。',
    parameters: {
      direction: { type: 'string', description: '想看什么方向 / 关键词，一句话' },
      n: { type: 'number', description: '这一轮最多挑几条（默认 1）' },
    },
    async execute(args) { refresh(); return scanRound(args?.direction, args?.n) },
  })

  tool({
    name: 'dy_tools',
    description: '看底层抖音 MCP 暴露的全部工具（133 个），需要冷门能力时先查名字，再用 dy_mcp 直调。',
    parameters: {},
    async execute() {
      const list = await (async () => { await ensureServer(); return mcp.listTools() })()
      return { ok: true, count: list.length, tools: list.map((t) => ({ name: t.name, description: t.description })) }
    },
  })

  tool({
    name: 'dy_mcp',
    description: '直调底层抖音 MCP 的任意工具（先用 dy_tools 查名字）。写操作慎用。',
    parameters: {
      tool: { type: 'string', description: 'MCP 工具名' },
      args: { type: 'object', description: '工具参数', additionalProperties: true },
    },
    async execute(args) {
      const name2 = String(args?.tool || '').trim()
      if (!name2) return { ok: false, error: '缺少 tool' }
      return { ok: true, result: await callTool(name2, args?.args && typeof args.args === 'object' ? args.args : {}) }
    },
  })

  /* ─────────────── 谷时定时器 ─────────────── */

  const tick = async () => {
    try {
      refresh()
      if (!cfg.enabled) return
      const mode = String(cfg.autoMode || 'manual')
      if (mode === 'manual') return
      const cur = dayOf()
      const rounds = Number(cur.count || 0)
      if (rounds >= Math.max(0, Number(cfg.perDay) || 0)) return
      const last = cur.lastRunAt ? new Date(cur.lastRunAt).getTime() : 0
      if (last && Date.now() - last < Math.max(0, Number(cfg.gapMin) || 0) * 60_000) return
      const open = openWindows().filter(([k, w]) => {
        if (mode === 'always') return true
        return inValley(now(), w)
      })
      if (!open.length) return
      const key = open[0][0]
      if (cur.windows && cur.windows[key]) return   // 这个窗口今天已经跑过一轮
      const before = { count: cur.count || 0, windows: { ...(cur.windows || {}) }, lastRunAt: cur.lastRunAt || null }
      bumpState({ count: rounds + 1, windows: { ...(cur.windows || {}), [key]: true }, lastRunAt: now().toISOString() })
      const sent = await triggerRound('window:' + key)
      if (!sent) { bumpState(before); log('自动刷：没递出去，额度已退回') }
    } catch (e) { log(`定时器这一跳出错（已兜住）：${e?.stack ?? e}`) }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 谷时定时器')
    setTimeout(tick, 15_000).unref?.()
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  log(`douyin-scroll 已加载（家目录 ${stateDir}）`)
}
