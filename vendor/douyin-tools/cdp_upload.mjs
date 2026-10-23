#!/usr/bin/env node
// CDP 上传本地文件到页面里的 input[type=file]（按索引）
// 用法: node cdp_upload.mjs 9222 <文件绝对路径> <input索引,默认0>
const port = process.argv[2] || '9222'
const file = process.argv[3]
const index = Number(process.argv[4] ?? '0')
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

await send('DOM.enable')
const { root } = await send('DOM.getDocument', { depth: 1 })
const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' })
if (!nodeIds.length) {
  console.error('没找到 file input')
  process.exit(1)
}
const nodeId = nodeIds[Math.min(index, nodeIds.length - 1)]
await send('DOM.setFileInputFiles', { files: [file], nodeId })
console.log('uploaded', file, 'input#', index, 'of', nodeIds.length)
ws.close()
