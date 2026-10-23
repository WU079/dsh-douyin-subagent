import { readFileSync } from 'node:fs'
const URL = process.env.DOUYIN_MCP_URL || 'http://127.0.0.1:18080/mcp'
const TOKEN = process.env.DOUYIN_MCP_TOKEN || ''
let sessionId = null
async function rpc(method, params, id = null) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const body = { jsonrpc: '2.0', method, params }
  if (id !== null) body.id = id
  const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id'); if (sid) sessionId = sid
  const text = await res.text()
  if (!text.trim()) return null
  const payload = (text.match(/^data:\s*(.*)$/m) || [null, text])[1]
  const msg = JSON.parse(payload)
  if (msg && msg.error) throw new Error(JSON.stringify(msg.error))
  return msg ? msg.result : null
}
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dump', version: '0' } }, 1)
await rpc('notifications/initialized', {})
const tools = (await rpc('tools/list', {}, 2)).tools
const want = process.argv.slice(2)
for (const t of tools) if (!want.length || want.includes(t.name)) console.log(t.name, JSON.stringify(t.inputSchema))
