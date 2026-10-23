#!/usr/bin/env node
// CDP 在页面里聚焦某个元素并模拟输入文本
// 用法: node cdp_type.mjs 9222 "<要输入的文字>" [selector]
const port = process.argv[2] || '9222'
const text = process.argv[3]
const selector = process.argv[4] || '[contenteditable=true]'
const filter = process.env.CDP_MATCH || 'douyin'

const getJSON = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json())
const targets = (await getJSON('/json/list')).filter((t) => t.type === 'page' && t.url.includes(filter))
if (!targets.length) {
  console.error('没有匹配的页面')
  process.exit(1)
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

await send('Runtime.evaluate', {
  expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.focus(); el.scrollIntoView({block:'center'}); return 'focused' })()`,
})
await new Promise((r) => setTimeout(r, 500))
await send('Input.insertText', { text })
await new Promise((r) => setTimeout(r, 500))
const out = await send('Runtime.evaluate', {
  expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : 'missing' })()`,
  returnByValue: true,
})
console.log('now:', String(out.result?.value ?? '').slice(0, 200))
ws.close()
