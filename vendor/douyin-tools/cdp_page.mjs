#!/usr/bin/env node
// 连到指定页面 target，执行一段 JS（默认打印 body 文本前 N 字），或 --shot 保存截图
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 9222)
const expr = process.argv[3] || 'document.body.innerText.slice(0,300)'
const shot = process.argv[4] === '--shot'

const getJSON = (path) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(s))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })

function wsConnect(wsUrl) {
  const u = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const sock = net.connect(Number(u.port || 80), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    let handshake = false
    let buf = Buffer.alloc(0)
    const pending = new Map()
    let nextId = 1
    const api = {
      send(method, params = {}) {
        const id = nextId++
        const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8')
        const mask = crypto.randomBytes(4)
        const masked = Buffer.alloc(payload.length)
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
        let header
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
        else {
          header = Buffer.alloc(4)
          header[0] = 0x81
          header[1] = 0x80 | 126
          header.writeUInt16BE(payload.length, 2)
        }
        sock.write(Buffer.concat([header, mask, masked]))
        return new Promise((res, rej) => pending.set(id, { res, rej }))
      },
      close() {
        try {
          sock.end()
        } catch {}
      },
    }
    const onFrame = (data) => {
      if (data.length < 2) return
      const opcode = data[0] & 0x0f
      let len = data[1] & 0x7f
      let off = 2
      if (len === 126) {
        len = data.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        len = Number(data.readBigUInt64BE(2))
        off = 10
      }
      if (opcode === 8) return api.close()
      const text = data.subarray(off, off + len).toString('utf8')
      try {
        const msg = JSON.parse(text)
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) p.rej(new Error(JSON.stringify(msg.error)))
          else p.res(msg.result)
        }
      } catch {}
    }
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!handshake) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = buf.subarray(0, idx).toString('latin1')
        if (!/^HTTP\/1\.1 101/i.test(head)) return reject(new Error('WS 握手失败: ' + head.split('\r\n')[0]))
        handshake = true
        buf = buf.subarray(idx + 4)
        resolve(api)
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        if (buf.length < off + len) return
        const frame = buf.subarray(0, off + len)
        buf = buf.subarray(off + len)
        onFrame(frame)
      }
    })
    sock.on('error', reject)
  })
}

const filter = (process.env.CDP_MATCH || 'douyin')
const targets = (await getJSON('/json/list')).filter((t) => t.type === 'page' && t.url.includes(filter))
if (!targets.length) {
  console.error('no douyin page target')
  process.exit(1)
}
const cli = await wsConnect(targets[0].webSocketDebuggerUrl)
if (expr.startsWith('goto:')) {
  const url = expr.slice(5)
  await cli.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, Number(process.env.CDP_WAIT || 5000)))
  const r = await cli.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0,800)',
    returnByValue: true,
  })
  console.log(url)
  console.log(String(r.result?.value ?? ''))
  cli.close()
  process.exit(0)
}
if (shot) {
  const r = await cli.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(process.argv[5] || 'page.png', Buffer.from(r.data, 'base64'))
  console.log('saved', process.argv[5] || 'page.png')
} else {
  const r = await cli.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 1).slice(0, 2000))
}
cli.close()
