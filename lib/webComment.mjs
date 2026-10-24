/**
 * lib/webComment.mjs —— 借浏览器页面“签名直发”抖音评论
 * ============================================================================
 * 为什么不用 MCP 的 post_video_comment：那个接口要 ticket/ts_sign（IM 会话签名），
 * 纯 cookie 登录拿不到，调了必报 “评论发布需要与当前 Cookie 同会话的 ticket/ts_sign”。
 *
 * 这里的做法：连一个已经登录 douyin.com 的 Chromium 的 CDP 端口（默认 9333），
 * 在页面上下文里调 `window.byted_acrawler.frontierSign` 拿 X-Bogus，
 * 再用页面自己的 fetch 发 POST /aweme/v1/web/comment/publish —— cookie、指纹、签名
 * 都是真的，等同于网页自己发评论。
 *
 * 前置：任意 Chromium/Edge 以 --remote-debugging-port=<port> 打开并登录 douyin.com。
 *   Windows 例子：
 *   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9333 ^
 *     --user-data-dir=F:\douyin-browser https://www.douyin.com/
 */
const DEFAULT_TIMEOUT = 20000

/** 列出 CDP 端口上的页面，挑 douyin.com 的标签 */
export async function listPages(port = 9333, timeoutMs = 4000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctl.signal })
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`)
    const list = await res.json()
    return list.filter((p) => p.type === 'page' && /douyin\.com/.test(p.url || ''))
  } finally {
    clearTimeout(timer)
  }
}

/** 在页面里执行一段表达式，返回结果值 */
export async function evaluateInPage({ port = 9333, expression, timeoutMs = DEFAULT_TIMEOUT }) {
  const pages = await listPages(port)
  const target = pages.find((p) => /^https:\/\/www\.douyin\.com\//.test(p.url)) || pages[0]
  if (!target?.webSocketDebuggerUrl) throw new Error(`CDP :${port} 上没有打开 douyin.com 的页面`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')) }, { once: true })
    })
    const id = 1
    const reply = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP evaluate 超时')), timeoutMs)
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        if (msg.id !== id) return
        clearTimeout(t)
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'))
        else resolve(msg.result?.result?.value)
      })
    })
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    }))
    return await reply
  } finally {
    try { ws.close() } catch {}
  }
}

/**
 * 发一条评论/回复。
 * @param {{port?:number, awemeId:string, text:string, replyId?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, cid:string, raw:any}>} 失败抛异常
 */
export async function publishComment({ port = 9333, awemeId, text, replyId, timeoutMs = DEFAULT_TIMEOUT }) {
  const expression = `(async () => {
    const awemeId = ${JSON.stringify(String(awemeId))};
    const replyId = ${JSON.stringify(String(replyId || '0'))};
    const text = ${JSON.stringify(String(text))};
    if (!window.byted_acrawler?.frontierSign) throw new Error('页面里没有 byted_acrawler，确认标签页是 douyin.com');
    const base = 'https://www.douyin.com/aweme/v1/web/comment/publish';
    const q = new URLSearchParams({ device_platform: 'webapp', aid: '6383', aweme_id: awemeId, reply_id: replyId });
    const sig = window.byted_acrawler.frontierSign({ url: base + '?' + q.toString() });
    if (sig && sig['X-Bogus']) q.set('X-Bogus', sig['X-Bogus']);
    const body = new URLSearchParams({ aweme_id: awemeId, text, text_extra: '[]' });
    if (replyId !== '0') body.set('reply_id', replyId);
    const r = await fetch(base + '?' + q.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      credentials: 'include',
    });
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt) } catch {}
    const cid = data?.comment?.cid || data?.cid || '';
    return { status: r.status, cid: String(cid), snippet: txt.slice(0, 160) };
  })()`
  const out = await evaluateInPage({ port, expression, timeoutMs })
  const status = Number(out?.status || 0)
  if (status !== 200 || !out?.cid) {
    throw new Error(`评论接口返回异常（HTTP ${status}）：${out?.snippet || '无返回'}`)
  }
  return { ok: true, cid: String(out.cid), raw: out }
}
