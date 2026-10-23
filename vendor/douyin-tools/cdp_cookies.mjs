#!/usr/bin/env node
// 通过 Chrome DevTools Protocol 从正在运行的浏览器里取 douyin.com 的全部 cookie
// （包括 httpOnly 的 sessionid —— 浏览器自己解密好，不用碰加密）
// 用法：node cdp_cookies.mjs [9222]  → 打印 "k=v; k=v; ..." 单行 cookie 头
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

const PORT = Number(process.argv[2] || 9222)

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
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
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
        const header = payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : payload.length < 65536
            ? Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 255, payload.length & 255])
            : (() => {
                const b = Buffer.alloc(10)
                b[0] = 0x81
                b[1] = 0x80 | 127
                b.writeBigUInt64BE(BigInt(payload.length), 2)
                return b
              })()
        sock.write(Buffer.concat([header, mask, masked]))
        return new Promise((res, rej) => pending.set(id, { res, rej }))
      },
      close() {
        try {
          sock.end()
        } catch {}
      },
    }
    function onFrame(data) {
      // 只处理单帧文本消息
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
      if ((data[0] & 0x80) === 0) return // 分片暂不处理
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
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          reject(new Error('WS 握手失败: ' + head.split('\r\n')[0]))
          return
        }
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

const version = await getJSON('/json/version')
const cli = await wsConnect(version.webSocketDebuggerUrl)
// browser 级 target 也支持 Storage.getCookies
try {
  await cli.send('Storage.enable', {})
} catch {}
const result = await cli.send('Storage.getCookies', {})
cli.close()

const cookies = (result.cookies || []).filter(
  (c) => /(^|\.)douyin\.com$/.test(c.domain) && c.value,
)
const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
console.log(JSON.stringify({ count: cookies.length, names: cookies.map((c) => c.name) }, null, 0), '\n')
console.log(header)
