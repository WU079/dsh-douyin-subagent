/**
 * lib/mcpHttp.mjs —— 极简 MCP over HTTP（Streamable HTTP）客户端
 * ============================================================================
 * 为什么要它：doumcp 那条路（Xposed 模块）已经放弃，现在走 yunsur/douyin-mcp —— 一个
 * 独立 Go 进程，把 133 个抖音工具挂在 `http://127.0.0.1:<port>/mcp` 上。
 * 协议就是 JSON-RPC：initialize → notifications/initialized → tools/list / tools/call，
 * 响应可能是 application/json，也可能是 text/event-stream（一行一个 `data: {...}`）。
 * ============================================================================
 */
export class McpHttp {
  constructor({ url, token = '', log = () => {} }) {
    this.url = url
    this.token = token
    this.log = log
    this.sessionId = null
    this.nextId = 1
    this.inited = false
    /** 上游 initialize 回的 serverInfo（{name,version}）——版本闸要看它 */
    this.serverInfo = null
  }

  #headers() {
    const h = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  async #post(body) {
    const res = await fetch(this.url, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await res.text()
    if (!res.ok && !text.trim()) throw new Error(`MCP HTTP ${res.status}`)
    return { status: res.status, text, ctype: res.headers.get('content-type') || '' }
  }

  static #pickMessage(text, ctype, id) {
    const candidates = []
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const datas = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
        for (const d of datas) if (d) candidates.push(d)
      }
    } else {
      candidates.push(text.trim())
    }
    for (const c of candidates) {
      try {
        const msg = JSON.parse(c)
        if (msg && (id === undefined || msg.id === id)) return msg
      } catch { /* 不是 JSON 就跳过 */ }
    }
    // 没带 id 的（比如服务端把结果包在 result 里）也认一次
    for (const c of candidates) {
      try { return JSON.parse(c) } catch { /* ignore */ }
    }
    return null
  }

  async #rpc(method, params, { id = null, timeoutMs = 60000 } = {}) {
    const body = { jsonrpc: '2.0', method, params }
    if (id !== null) body.id = id
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`MCP ${method} 超时（${timeoutMs}ms）`)), timeoutMs)
    try {
      const { status, text, ctype } = await (async () => {
        try {
          const res = await fetch(this.url, {
            method: 'POST',
            headers: this.#headers(),
            body: JSON.stringify(body),
            signal: ac.signal,
          })
          const sid = res.headers.get('mcp-session-id')
          if (sid) this.sessionId = sid
          return { status: res.status, text: await res.text(), ctype: res.headers.get('content-type') || '' }
        } catch (e) {
          throw new Error(`连不上抖音 MCP（${this.url}）：${e?.message ?? e}`)
        }
      })()
      if (id === null) return null
      if (status === 401 || status === 403) throw new Error(`抖音 MCP 鉴权失败（HTTP ${status}）—— token 对不上`)
      if (!text.trim()) return null
      const msg = McpHttp.#pickMessage(text, ctype, id)
      if (!msg) return null
      if (msg.error) throw new Error(`MCP error ${msg.error.code ?? ''}: ${msg.error.message ?? JSON.stringify(msg.error)}`)
      return msg.result ?? null
    } finally {
      clearTimeout(timer)
    }
  }

  async initialize({ name = 'dsh-douyin-subagent', version = '0.1.0' } = {}) {
    if (this.inited) return
    const r = await this.#rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name, version },
    }, { id: this.nextId++, timeoutMs: 20000 })
    // 上游 serverInfo.version 是写死的 1.0.0，不能当 release 版本用；但接口变了它通常也会变，留作辅助信号
    this.serverInfo = r?.serverInfo ?? null
    await this.#rpc('notifications/initialized', {}, { id: null }).catch(() => {})
    this.inited = true
    this.log(`抖音 MCP 已就绪（${this.url}${this.serverInfo?.version ? `，serverInfo ${this.serverInfo.name ?? ''} ${this.serverInfo.version}` : ''}）`)
  }

  async listTools() {
    await this.initialize()
    const r = await this.#rpc('tools/list', {}, { id: this.nextId++ })
    return r?.tools ?? []
  }

  async call(name, args = {}, { timeoutMs = 180000 } = {}) {
    await this.initialize()
    const r = await this.#rpc('tools/call', { name, arguments: args }, { id: this.nextId++, timeoutMs })
    const text = (r?.content ?? []).map((c) => c?.text ?? '').join('\n').trim()
    if (r?.isError) throw new Error(text || `抖音 MCP 工具 ${name} 报错`)
    if (!text) return {}
    try { return JSON.parse(text) } catch { return text }
  }
}
