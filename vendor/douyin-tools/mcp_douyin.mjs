#!/usr/bin/env node
// yunsur/douyin-mcp 客户端（宿主机直连 http://127.0.0.1:18080/mcp）
// 用法：
//   node mcp_douyin.mjs --list
//   node mcp_douyin.mjs check_login_status
//   node mcp_douyin.mjs search_videos '{"keyword":"蓝色鲸鱼"}'
// 需要环境变量 DOUYIN_MCP_TOKEN（和插件启动 MCP 时用的 token 一致）
const URL = process.env.DOUYIN_MCP_URL || 'http://127.0.0.1:18080/mcp'
const TOKEN = process.env.DOUYIN_MCP_TOKEN || ''
if (!TOKEN) {
  console.error('缺少 DOUYIN_MCP_TOKEN（和插件启动 MCP 时用的 token 一致）')
  process.exit(2)
}

const argv = process.argv.slice(2)
const list = argv.includes('--list')
const tool = argv.find((a) => !a.startsWith('--') && !a.trim().startsWith('{'))
const raw = argv.find((a) => a.trim().startsWith('{'))
const args = raw ? JSON.parse(raw) : {}

let sessionId = null

async function rpc(method, params, id = null) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const body = { jsonrpc: '2.0', method, params }
  if (id !== null) body.id = id
  const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  if (!text.trim() || text.trim() === 'null') return null
  let payload = text
  const m = text.match(/^data:\s*(.*)$/m)
  if (m) payload = m[1]
  const msg = JSON.parse(payload)
  if (msg === null || msg === undefined) return null
  if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
  return msg.result
}

async function main() {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dafeiyu-douyin', version: '0.1.0' },
  }, 1)
  await rpc('notifications/initialized', {})
  if (list) {
    const r = await rpc('tools/list', {}, 2)
    console.log(JSON.stringify(r.tools.map((t) => ({ name: t.name, description: t.description })), null, 2))
    return
  }
  if (!tool) {
    console.error('用法: node mcp_douyin.mjs --list | <tool> [jsonArgs]')
    process.exit(2)
  }
  const r = await rpc('tools/call', { name: tool, arguments: args }, 3)
  const text = (r?.content ?? []).map((c) => c?.text ?? '').join('\n')
  if (r?.isError) {
    console.error(text)
    process.exit(1)
  }
  if (!text) return
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
