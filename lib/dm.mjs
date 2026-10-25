/**
 * 私信（抖音「消息」tab）—— 底层 MCP 的几个坑在这里补上
 * ============================================================================
 * douyin-mcp v0.1.0 在私信这块有三处反直觉（实测）：
 *   1. `list_conversations` 每条会话的 `name` 字段不是名字，是**参与者 protobuf 的原始字节**
 *      （JSON 里是一串乱码/替换字符）。群聊才有真名字；私聊的昵称得拿 sec_uid 去
 *      `get_im_user_info` 换。
 *   2. `get_im_messages` 在 v0.1.0 上**恒返回空数组**（就算会话里明明有消息，listen 开着也一样）——
 *      想读聊天记录必须用 `get_conversation_history`。
 *   3. `get_conversation_list` 不是「列表」，是「按 to_user_id 查单个会话」，缺参数直接校验错。
 *
 * 所以这一层做的事：会话列表 → 解析出对方 uid/sec_uid → 批量换昵称 → 排好序；
 * 读消息 → 走 history 并给每条消息标上「我 / 对方」。
 * 纯函数都单独导出，方便脱离 MCP 单测。
 * ============================================================================
 */

/** sec_uid 长得都这样，且是纯 ASCII —— protobuf 乱码也不影响正则把它抠出来 */
export const SEC_UID_RE = /MS4wLjABAAAA[\w-]{20,}/g

const TYPE_GROUP = 2

/** 控制字符 / 替换字符：出现就说明这串是二进制被当字符串了，不是真名字 */
const BINARYISH = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/

const pad2 = (n) => String(n).padStart(2, '0')

/** 毫秒时间戳 → `2026-10-25 18:07`（本地时区，给人看的） */
export const fmtTime = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 从任意字符串（含乱码）里抠出所有 sec_uid */
export const secUidsIn = (text) => String(text ?? '').match(SEC_UID_RE) || []

/** 群聊的真名字：干净、不是 protobuf 字节才认 */
export const readableName = (text) => {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (s.includes('MS4wLjABAAAA') || BINARYISH.test(s)) return null
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/** 一条消息能显示出来的字；没有就返回空串（调用方再用 messageLabel 兜底） */
export const messageText = (m) => {
  const c = m?.content || {}
  for (const k of ['text', 'tips', 'description']) {
    const v = String(c[k] ?? '').trim()
    if (v) return v
  }
  const shared = c.related_share_video || c.external_reference || c.share || null
  const title = String(shared?.aweme_title ?? shared?.content_title ?? shared?.title ?? '').trim()
  if (title) return title
  return ''
}

/** 消息种类：text / system / image / card / other（只用来决定占位标签） */
export const messageKind = (m) => {
  const c = m?.content || {}
  if (String(c.text ?? '').trim()) return 'text'
  if (String(c.tips ?? '').trim()) return 'system'
  if (c.resource_url || c.cover_url) return 'image'
  if (c.description || c.template) return 'card'
  if (c.related_share_video || c.external_reference) return 'share'
  const t = Number(m?.message_type)
  if (t === 2) return 'image'
  if (t === 3) return 'voice'
  if (t === 4) return 'video'
  if (t === 5) return 'emoji'
  return 'other'
}

const KIND_LABEL = {
  text: '', system: '[系统提示]', image: '[图片]', voice: '[语音]', video: '[视频]',
  emoji: '[表情]', card: '[卡片]', share: '[分享]', other: '[消息]',
}

/** 给人看的一行：有正文就正文，没有就 `[图片]` 这种 */
export const messageLine = (m) => messageText(m) || KIND_LABEL[messageKind(m)] || '[消息]'

/** 会话 id `0:1:<uidA>:<uidB>` → [uidA, uidB]；群会话是纯数字，拿不到 */
export const uidsInConversationId = (id) => {
  const parts = String(id ?? '').split(':')
  if (parts.length < 4) return []
  return parts.slice(2, 4).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
}

/** `0:1:a:b` / 纯数字群 id 都算「已经是 id 了」 */
export const looksLikeConversationId = (s) => /^0:\d+:\d+:\d+$/.test(String(s ?? '').trim()) || /^\d{10,}$/.test(String(s ?? '').trim())

/** 取最近一条：按 timestamp_ms 最大 */
const pickLast = (list) => {
  const arr = Array.isArray(list) ? list.filter(Boolean) : []
  let best = null
  for (const m of arr) {
    const ms = Number(m?.timestamp_ms) || 0
    if (!best || ms >= best.ms) best = { m, ms }
  }
  if (!best) return null
  return {
    ms: best.ms,
    at: fmtTime(best.ms),
    text: messageLine(best.m),
    kind: messageKind(best.m),
  }
}

/** 我是谁（uid / sec_uid / 昵称）。拿不到就抛，别让上层拿到半截数据 */
export async function selfIdentity(callTool) {
  const p = await callTool('get_my_profile', {})
  const u = p?.user
  if (!u?.uid) throw new Error('拿不到登录身份：' + JSON.stringify(p).slice(0, 200))
  return {
    uid: Number(u.uid),
    secUid: String(u.sec_uid || ''),
    nickname: String(u.nickname || ''),
    uniqueId: String(u.unique_id || ''),
  }
}

/** sec_uid 批量 → 用户信息（昵称/uid）。返回 Map：sec_uid → {nickname, uid}，顺带 uid → 同一份 */
async function userInfoMap(callTool, secUids) {
  const map = new Map()
  const list = [...new Set(secUids.filter(Boolean))].slice(0, 60)
  if (!list.length) return map
  let raw
  try { raw = await callTool('get_im_user_info', { sec_uids: list }) } catch { return map }
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
  for (const u of arr) {
    if (!u) continue
    const rec = { nickname: String(u.nickname || ''), uid: Number(u.uid) || null }
    if (u.sec_uid) map.set(String(u.sec_uid), rec)
  }
  return map
}

/**
 * 会话列表（已解析昵称）
 * @param {{callTool: Function, self: object, type?: number, limit?: number, names?: boolean}} o
 */
export async function listInbox({ callTool, self, type = 0, limit = 20, names = true }) {
  const args = Number(type) ? { type: Number(type) } : {}
  const raw = await callTool('list_conversations', args)
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
  if (!arr.length) {
    return {
      self, count: 0, conversations: [],
      note: '会话列表是空的。常见三种原因：① 这个号确实还没人私信过（让对方先发一条，会话出现后再读）；'
        + '② cookie 过期/不带 IM 权限（dy_login 重新 save 一次）；③ 被风控限流（get_stranger_conversations 会报 409）。',
    }
  }

  const convs = arr.map((c) => {
    const id = String(c?.conversation_id ?? '')
    const ctype = Number(c?.conversation_type) || 0
    const uids = uidsInConversationId(id)
    const peerUid = uids.find((u) => u !== self.uid) || Number(c?.owner_uid) || null
    const secs = [...new Set([
      ...secUidsIn(c?.name),
      c?.owner_sec_uid,
      ...(Array.isArray(c?.last_messages) ? c.last_messages.map((m) => m?.sender_sec_uid) : []),
    ].filter(Boolean))].filter((s) => s !== self.secUid)
    return {
      conversationId: id,
      shortId: c?.conversation_short_id ? String(c.conversation_short_id) : '',
      type: ctype === TYPE_GROUP ? 'group' : 'private',
      groupName: readableName(c?.name),
      peerUid,
      secUids: secs,
      last: pickLast(c?.last_messages),
    }
  })

  const info = names ? await userInfoMap(callTool, convs.flatMap((c) => c.secUids)) : new Map()
  const out = convs.map((c) => {
    const peerSecUid = c.secUids.find((s) => info.get(s)?.uid === c.peerUid) || c.secUids[0] || ''
    const nickname = c.groupName || info.get(peerSecUid)?.nickname || ''
    const last = c.last ? {
      ...c.last,
      side: c.last.kind === 'system' ? 'system' : undefined,
    } : null
    return {
      conversation_id: c.conversationId,
      short_id: c.shortId || undefined,
      type: c.type,
      name: nickname || (c.peerUid ? `用户${c.peerUid}` : '未命名会话'),
      uid: c.peerUid || undefined,
      sec_uid: peerSecUid || undefined,
      last,
    }
  })
  // 最后一条消息是「我说的」还是「对方说的」得看 sender —— pickLast 只留了文本，这里回填
  const byId = new Map(convs.map((c, i) => [c.conversationId, i]))
  for (const c of arr) {
    const i = byId.get(String(c?.conversation_id ?? ''))
    if (i === undefined) continue
    const msgs = Array.isArray(c?.last_messages) ? c.last_messages.filter(Boolean) : []
    let best = null
    for (const m of msgs) {
      const ms = Number(m?.timestamp_ms) || 0
      if (!best || ms >= best.ms) best = { m, ms }
    }
    if (!best || !out[i].last) continue
    out[i].last.side = messageKind(best.m) === 'system'
      ? 'system'
      : (Number(best.m?.sender) === self.uid ? 'me' : 'them')
  }
  out.sort((a, b) => (b.last?.ms || 0) - (a.last?.ms || 0))
  return { self, count: out.length, conversations: out.slice(0, Math.max(1, Number(limit) || 20)) }
}

/**
 * 把「会话 id / 昵称 / 昵称片段」统一解析成一个会话
 * @returns {Promise<{conversationId: string, name: string, type: string, uid?: number}>}
 */
export async function resolveConversation({ callTool, self, conversation }) {
  const key = String(conversation ?? '').trim()
  if (!key) throw new Error('缺少 conversation')
  if (looksLikeConversationId(key)) {
    const base = {
      conversationId: key,
      name: '',
      type: key.startsWith('0:1:') ? 'private' : 'group',
      uid: uidsInConversationId(key).find((u) => u !== self.uid) || undefined,
    }
    // 顺手从列表里把昵称补上（列表挂了也不影响读消息，只是名字退化成「用户xxx」）
    try {
      const inbox = await listInbox({ callTool, self, limit: 50 })
      const hit = inbox.conversations.find((c) => c.conversation_id === key)
      if (hit) { base.name = hit.name; base.type = hit.type; base.uid = hit.uid || base.uid }
    } catch { /* 补名字失败就算了 */ }
    return base
  }
  const inbox = await listInbox({ callTool, self, limit: 50 })
  const exact = inbox.conversations.find((c) => c.name === key)
  const fuzzy = exact || inbox.conversations.find((c) => c.name.includes(key)) || inbox.conversations.find((c) => String(c.uid) === key)
  if (!fuzzy) {
    const names = inbox.conversations.map((c) => c.name).join('、') || '（没有会话）'
    throw new Error(`找不到会话「${key}」。现在的会话有：${names}`)
  }
  return { conversationId: fuzzy.conversation_id, name: fuzzy.name, type: fuzzy.type, uid: fuzzy.uid }
}

/**
 * 读一个会话的聊天记录（走 get_conversation_history —— get_im_messages 在 v0.1.0 上是空的）
 */
export async function readMessages({ callTool, self, conversation, count = 30, cursor = 0, unreadOnly = false }) {
  const target = await resolveConversation({ callTool, self, conversation })
  const args = { conversation: target.conversationId, count: Math.max(1, Math.min(Number(count) || 30, 50)) }
  if (Number(cursor) > 0) args.cursor = Number(cursor)
  if (unreadOnly) args.unread_only = true
  const raw = await callTool('get_conversation_history', args)
  const list = Array.isArray(raw?.messages) ? raw.messages.filter(Boolean) : []

  const peerUid = target.uid || uidsInConversationId(target.conversationId).find((u) => u !== self.uid) || null
  const otherSecs = [...new Set(list.map((m) => m?.sender_sec_uid).filter(Boolean))].filter((s) => s !== self.secUid)
  const info = await userInfoMap(callTool, otherSecs)
  const nameOf = (m) => {
    const uid = Number(m?.sender) || null
    if (uid && uid === self.uid) return self.nickname || '我'
    if (messageKind(m) === 'system') return '系统'
    const bySec = info.get(String(m?.sender_sec_uid || ''))?.nickname
    if (bySec) return bySec
    if (target.name) return target.name
    return uid ? `用户${uid}` : '未知'
  }

  const messages = list.map((m) => {
    const uid = Number(m?.sender) || null
    const kind = messageKind(m)
    return {
      from: kind === 'system' ? 'system' : (uid === self.uid ? 'me' : 'them'),
      name: nameOf(m),
      kind,
      text: messageLine(m),
      at: fmtTime(m?.timestamp_ms),
      ms: Number(m?.timestamp_ms) || 0,
    }
  })
  messages.sort((a, b) => a.ms - b.ms)
  return {
    conversation: { id: target.conversationId, name: target.name || (peerUid ? `用户${peerUid}` : ''), type: target.type, uid: peerUid || undefined },
    count: messages.length,
    messages,
    nextCursor: raw?.next_cursor ?? null,
  }
}

/**
 * 发私信（写操作）。to = 数字 uid / 昵称 / 昵称片段
 */
export async function sendDm({ callTool, self, to, content }) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('缺少 content')
  const key = String(to ?? '').trim()
  if (!key) throw new Error('缺少 to（uid 或昵称）')
  let uid = /^\d{5,}$/.test(key) ? Number(key) : null
  let name = ''
  if (!uid) {
    const inbox = await listInbox({ callTool, self, limit: 50 })
    const hit = inbox.conversations.find((c) => c.name === key)
      || inbox.conversations.find((c) => c.name.includes(key))
    if (!hit?.uid) throw new Error(`找不到「${key}」的 uid，先 dy_inbox 看看会话`)
    uid = hit.uid
    name = hit.name
  }
  const raw = await callTool('send_dm', { to_user_id: uid, content: text })
  const statusCode = Number(raw?.status_code)
  const ok = !Number.isFinite(statusCode) || statusCode === 0
  return {
    ok,
    to: { uid, name: name || undefined },
    text,
    result: raw,
    error: ok ? undefined : `发送失败（status_code=${statusCode}）：${JSON.stringify(raw).slice(0, 200)}`,
  }
}
