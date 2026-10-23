#!/usr/bin/env node
// 本地扫码登录页面：把 douyin-login 不断刷新的 login_qrcode.png 实时喂给浏览器
// 打开 http://127.0.0.1:8765/ 用手机抖音扫屏幕上的二维码（二维码每 63 秒自动刷新，不会过期）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.DOUYIN_QR_DIR || process.argv[2] || process.cwd()
const PORT = 8765

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>洛洛的抖音登录</title>
<style>
 body{margin:0;background:#0b1220;color:#dbeafe;font-family:system-ui,"Microsoft YaHei",sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}
 h1{font-size:20px;font-weight:600;margin:0 0 6px}
 p{margin:4px 0;color:#93c5fd;font-size:14px}
 .card{background:#111a2e;border:1px solid #1e3a5f;border-radius:16px;padding:24px 32px;display:flex;flex-direction:column;align-items:center;gap:10px}
 img{width:320px;height:320px;image-rendering:pixelated;background:#fff;border-radius:12px}
 #st{font-size:13px;color:#fbbf24;min-height:18px}
 .ok{color:#34d399!important}
</style></head><body>
<div class="card">
  <h1>🐳 用手机抖音扫这个码</h1>
  <img id="qr" alt="登录二维码">
  <div id="st">加载中…</div>
  <p>二维码自动刷新，慢慢扫没关系；扫完在手机上点「确认登录」。</p>
</div>
<script>
 let n = 0
 function tick(){
   const img = document.getElementById('qr')
   img.src = '/qr.png?t=' + (++n) + '_' + Date.now()
   fetch('/status').then(r=>r.json()).then(s=>{
     const el = document.getElementById('st')
     if (s.loggedIn) { el.textContent = '✅ 登录成功！可以关掉这个页面了'; el.className='ok' }
     else if (!s.qrExists) { el.textContent = '等待二维码生成…' }
     else { el.textContent = '二维码已就绪（' + s.qrAgeSec + ' 秒前刷新，会自动更新）' }
   }).catch(()=>{})
 }
 tick(); setInterval(tick, 2000)
</script></body></html>`

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (url === '/qr.png') {
    const p = path.join(DIR, 'login_qrcode.png')
    fs.readFile(p, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('no qr yet')
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache' })
      res.end(buf)
    })
    return
  }
  if (url === '/status') {
    let qr = { exists: false, ageSec: null }
    let loggedIn = fs.existsSync(path.join(DIR, 'cookies.txt'))
    try {
      const st = fs.statSync(path.join(DIR, 'login_qrcode.png'))
      qr = { exists: true, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) }
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ qrExists: qr.exists, qrAgeSec: qr.ageSec, loggedIn }))
    return
  }
  res.writeHead(404); res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`QR 登录页: http://127.0.0.1:${PORT}/`)
})
