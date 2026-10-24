/**
 * dsh-douyin-subagent —— 浏览器半端：设置里的一页「刷抖音」
 * ============================================================================
 * 约定（抄 dsh-bili-subagent）：
 *   · client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 *   · id 必须等于 package.json 的 name
 *   · 进设置：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 *   · 数据走插件自己挂的 `/api/douyin-duty/*`（同源 fetch，credentials: same-origin）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-subagent',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const API = '/api/douyin-duty'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（没登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:660px;}
[data-dy-sec]{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:12px;}
[data-dy-h]{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#8b9096);}
[data-dy-row]{display:flex;align-items:center;gap:10px;}
[data-dy-row][data-wrap]{flex-wrap:wrap;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-label]{font-size:13px;color:var(--dsw-alias-label-primary,#e6e7e9);}
[data-dy-desc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-input]{width:88px;padding:5px 8px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:inherit;}
[data-dy-input][data-wide]{width:100%;}
[data-dy-select]{padding:5px 8px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:inherit;}
[data-dy-sw]{width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:rgba(127,127,127,.22);position:relative;cursor:pointer;padding:0;flex:none;}
[data-dy-sw][data-on]{background:#3b82f6;border-color:#3b82f6;}
[data-dy-knob]{position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:999px;background:#fff;transition:left .15s;}
[data-dy-sw][data-on] [data-dy-knob]{left:17px;}
[data-dy-btn]{padding:7px 16px;font-size:13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:#3b82f6;color:#fff;border:0;cursor:pointer;}
[data-dy-btn][data-ghost]{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-note]{font-size:12px;line-height:18px;}
[data-dy-note][data-ok]{color:#3fb950;}
[data-dy-note][data-bad]{color:#e5534b;}
[data-dy-chips]{display:flex;gap:6px;flex-wrap:wrap;}
[data-dy-chip]{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.16);}
`

    const MODES = [
      { v: 'manual', t: '只手动（我不自己刷）' },
      { v: 'valley', t: '只在谷时自己刷' },
      { v: 'always', t: '全天都可以刷' },
    ]
    const LEVELS = [
      { v: 'full', t: '完整报告' },
      { v: 'brief', t: '只给结论' },
      { v: 'off', t: '只看不报' },
    ]

    const Row = ({ label, desc, children }) => h('div', { 'data-dy-row': '', 'data-wrap': true },
      h('div', { 'data-dy-grow': '' },
        h('div', { 'data-dy-label': '' }, label),
        desc ? h('div', { 'data-dy-desc': '' }, desc) : null),
      children)

    const Switch = ({ on, onChange }) => h('button', {
      'data-dy-sw': '', 'data-on': on ? '' : undefined, type: 'button',
      onClick: () => onChange(!on), 'aria-pressed': Boolean(on),
    }, h('span', { 'data-dy-knob': '' }))

    const Num = ({ value, onChange, min = 0, max = 999 }) => h('input', {
      'data-dy-input': '', type: 'number', value: String(value ?? 0), min, max,
      onChange: (e) => onChange(Number(e.target.value)),
    })

    function Panel() {
      const [cfg, setCfg] = useState(null)
      const [status, setStatus] = useState(null)
      const [err, setErr] = useState('')
      const [note, setNote] = useState(null)
      const [saving, setSaving] = useState(false)
      const [kwText, setKwText] = useState('')

      const load = useCallback(async () => {
        try {
          const [c, s] = await Promise.all([jget('/config'), jget('/status')])
          setCfg(c.config)
          setKwText((c.config?.keywords || []).join('、'))
          setStatus(s)
          setErr('')
        } catch (e) { setErr(String(e?.message ?? e)) }
      }, [])

      useEffect(() => { load() }, [load])

      const patch = (p) => setCfg((cur) => ({ ...cur, ...p }))

      const save = async () => {
        if (!cfg) return
        setSaving(true); setNote(null)
        try {
          const body = {
            enabled: cfg.enabled, autoMode: cfg.autoMode, noon: cfg.noon, night: cfg.night,
            perDay: cfg.perDay, gapMin: cfg.gapMin, perScan: cfg.perScan,
            direction: cfg.direction, keywords: kwText, ownerName: cfg.ownerName, reportLevel: cfg.reportLevel,
          }
          const r = await jpost('/config', body)
          setCfg(r.config)
          setKwText((r.config?.keywords || []).join('、'))
          setNote({ ok: true, text: '存好了，下一跳就按这个跑。' })
          const s = await jget('/status').catch(() => null)
          if (s) setStatus(s)
        } catch (e) {
          setNote({ ok: false, text: '没存上：' + String(e?.message ?? e) })
        } finally { setSaving(false) }
      }

      if (err) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '', 'data-bad': '' }, '读不到配置：' + err))
      if (!cfg) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '' }, '读取中…'))

      const on = Boolean(cfg.enabled)
      const wid = cfg.windows || {}
      const today = status?.today || {}

      return h('div', { 'data-dy-page': '' },
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '总开关'),
          h(Row, { label: '让它在谷时自己刷抖音', desc: '关掉之后定时器不动，dy_* 工具和手动 /刷 还是能用。' },
            h(Switch, { on, onChange: (v) => patch({ enabled: v }) }))),

        on ? h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '什么时候刷'),
          h(Row, { label: '自动模式' },
            h('select', {
              'data-dy-select': '', value: cfg.autoMode || 'valley',
              onChange: (e) => patch({ autoMode: e.target.value }),
            }, MODES.map((m) => h('option', { key: m.v, value: m.v }, m.t)))),
          cfg.autoMode === 'valley' ? h('div', { 'data-dy-row': '', 'data-wrap': true },
            h(Row, { label: '中午谷时', desc: (wid.noon ? wid.noon.start + '–' + wid.noon.end : '13:00–15:00') + '（周末整天都算）' },
              h(Switch, { on: Boolean(cfg.noon), onChange: (v) => patch({ noon: v }) })),
            h(Row, { label: '晚上谷时', desc: wid.night ? wid.night.start + '–次日 ' + wid.night.end : '19:00–次日 10:00' },
              h(Switch, { on: Boolean(cfg.night), onChange: (v) => patch({ night: v }) }))) : null,
          h(Row, { label: '每天最多刷几轮', desc: '不是条数；一轮里挑几条由下面的「每条挑几个」决定。' },
            h(Num, { value: cfg.perDay, min: 0, max: 10, onChange: (v) => patch({ perDay: v }) })),
          h(Row, { label: '两轮之间至少隔多少分钟', desc: '防止一醒来就连续刷。' },
            h(Num, { value: cfg.gapMin, min: 0, max: 1440, onChange: (v) => patch({ gapMin: v }) })),
          h(Row, { label: '每轮挑几条', desc: '交给子代理的挑选上限。' },
            h(Num, { value: cfg.perScan, min: 1, max: 5, onChange: (v) => patch({ perScan: v }) }))) : null,

        on ? h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '刷什么'),
          h(Row, { label: '方向', desc: '留空就用「关键词」里随机挑一个，或者干脆让它自己定。' },
            h('input', {
              'data-dy-input': '', 'data-wide': '', type: 'text', value: cfg.direction || '',
              placeholder: '例：独立小游戏、AI 相关的新东西', style: { width: '100%' },
              onChange: (e) => patch({ direction: e.target.value }),
            })),
          h(Row, { label: '关键词候选', desc: '用顿号或逗号隔开；direction 空的时候从这里挑。' },
            h('input', {
              'data-dy-input': '', 'data-wide': '', type: 'text', value: kwText,
              placeholder: '例：独立游戏、技术折腾、赛博蓝鲸', style: { width: '100%' },
              onChange: (e) => setKwText(e.target.value),
            })),
          h(Row, { label: '叫你什么', desc: '报告里对你的称呼。' },
            h('input', {
              'data-dy-input': '', type: 'text', value: cfg.ownerName || '',
              onChange: (e) => patch({ ownerName: e.target.value }),
            })),
          h(Row, { label: '报告详细程度' },
            h('select', {
              'data-dy-select': '', value: cfg.reportLevel || 'full',
              onChange: (e) => patch({ reportLevel: e.target.value }),
            }, LEVELS.map((m) => h('option', { key: m.v, value: m.v }, m.t))))) : null,

        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '现在的状态'),
          h('div', { 'data-dy-row': '', 'data-wrap': true },
            h('span', { 'data-dy-chip': '' }, '今天第 ' + (today.rounds ?? 0) + ' / ' + (today.perDay ?? cfg.perDay) + ' 轮'),
            h('span', { 'data-dy-chip': '' }, 'MCP ' + (status?.mcp?.ok ? '在线' : '没起') + ' :' + cfg.mcpPort),
            h('span', { 'data-dy-chip': '' }, status?.loggedIn ? '登录态在' : '还没登录'),
            h('span', { 'data-dy-chip': '' }, '上次刷：' + (status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '还没'))),
          status?.windows ? h('div', { 'data-dy-chips': '' }, Object.entries(status.windows).map(([k, w]) =>
            h('span', { key: k, 'data-dy-chip': '', style: w.open ? { color: '#3fb950' } : undefined },
              w.label + ' ' + w.start + '–' + w.end + (w.open ? '（现在开着）' : '')))) : null,
          status?.lastReport ? h('div', { 'data-dy-desc': '' }, '最近报告：' + status.lastReport) : null),

        h('div', { 'data-dy-row': '' },
          h('button', { 'data-dy-btn': '', type: 'button', disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
          h('button', { 'data-dy-btn': '', 'data-ghost': '', type: 'button', onClick: load }, '重新读'),
          note ? h('span', { 'data-dy-note': '', 'data-ok': note.ok ? '' : undefined, 'data-bad': note.ok ? undefined : '' }, note.text) : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-subagent')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-subagent: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
          () => h(Panel),
        ))
      },
    }
  },
})
