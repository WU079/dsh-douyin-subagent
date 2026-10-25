/**
 * lib/notices.mjs —— 抖音「通知」：评论 / @我的 / 点赞 / 新粉丝 / 弹幕
 * ============================================================================
 * 为什么单独一层：网页端的「消息」里才有收件箱，很多人（尤其没有收件箱的号、
 * 或者干脆没开网页版的自动化）根本看不到 @ 和评论提醒。但 MCP 有接口：
 *   get_all_notices({ notice_group }) → 数组
 *     notice_group: '700' 全部 | '401' 粉丝 | '601' @我的 | '2' 评论 | '3' 点赞 | '520' 弹幕
 *
 * 坑：返回的每条通知是「按类型分叉」的嵌套结构，正文和评论 id 都埋在很深的地方
 * （评论 → it.comment.comment.text / .cid，点赞 → it.digg.from_user[]，粉丝 →
 * it.follow.from_user），直接看顶层只有 nid_str / type / aweme_id 三个看得懂。
 * 这里统一拍平：谁、说了什么、什么时候、在哪个作品下、comment_id 是多少
 * （comment_id 可以直接当 dy_comment 的 reply_id 用）。
 * ============================================================================
 */

/** 分组别名 → { key, code, label } */
const GROUPS = {
  all: { key: 'all', code: '700', label: '全部通知' },
  comment: { key: 'comment', code: '2', label: '评论' },
  mention: { key: 'mention', code: '601', label: '@我的' },
  digg: { key: 'digg', code: '3', label: '点赞' },
  follow: { key: 'follow', code: '401', label: '新粉丝' },
  danmaku: { key: 'danmaku', code: '520', label: '弹幕' },
}

const ALIASES = {
  all: 'all', '700': 'all', 全部: 'all',
  comment: 'comment', comments: 'comment', '2': 'comment', 评论: 'comment',
  mention: 'mention', mentions: 'mention', at: 'mention', '@': 'mention', '601': 'mention', '@我的': 'mention', 提到: 'mention',
  digg: 'digg', like: 'digg', likes: 'digg', '3': 'digg', 点赞: 'digg', 赞: 'digg',
  follow: 'follow', follower: 'follow', fans: 'follow', '401': 'follow', 粉丝: 'follow', 关注: 'follow',
  danmaku: 'danmaku', '520': 'danmaku', 弹幕: 'danmaku',
}

/** 归一化分组参数；认不出的按「全部」处理 */
export function normalizeGroup(v) {
  const k = String(v ?? '').trim().toLowerCase()
  const hit = ALIASES[k] || ALIASES[String(v ?? '').trim()] || 'all'
  return { ...GROUPS[hit] }
}

/** 通知类型数字 → 语义（抖音的 interactive 通知码） */
export function noticeKind(type, group) {
  const t = Number(type) || 0
  if (t === 31) return 'comment'
  if (t === 33) return 'follow'
  if (t === 41) return 'digg'
  if (t === 61 || t === 62) return 'mention'
  if (group === 'mention') return 'mention'
  if (group === 'comment') return 'comment'
  if (group === 'digg') return 'digg'
  if (group === 'follow') return 'follow'
  return 'other'
}

/** 秒级时间戳 → 毫秒（接口给的是秒，偶尔已经带毫秒） */
function toMs(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? n : n * 1000
}

const AWEME_URL = 'https://www.douyin.com/video/'

/**
 * 把一条通知拍平。
 * @param {any} it get_all_notices 返回的单项
 * @param {{group?:string}} [opts]
 */
export function normalizeNotice(it, opts = {}) {
  if (!it || typeof it !== 'object') return null
  const group = opts.group || 'all'
  const kind = noticeKind(it.type, group)

  const c = it.comment?.comment || it.mention?.comment || null
  const diggUsers = Array.isArray(it.digg?.from_user) ? it.digg.from_user : []
  const followUser = it.follow?.from_user || null

  const from = c?.user || diggUsers[0] || followUser || null
  const fromUser = from
    ? { nickname: String(from.nickname || ''), uid: from.uid != null ? String(from.uid) : '', sec_uid: String(from.sec_uid || '') }
    : null

  const rawId = String(it.aweme_id || it.comment?.aweme?.aweme_id || it.digg?.aweme?.aweme_id || '')
  const awemeId = rawId && rawId !== '0' ? rawId : ''
  const desc = String(it.comment?.aweme?.desc || it.digg?.aweme?.desc || '')

  return {
    nid: String(it.nid_str || it.nid || ''),
    kind,
    at: toMs(it.create_time),
    read: it.has_read === true ? true : it.has_read === false ? false : null,
    from: fromUser,
    others: diggUsers.length > 1 ? diggUsers.length - 1 : 0,
    text: String(c?.text || ''),
    comment_id: c?.cid ? String(c.cid) : '',
    reply_to: String(it.comment?.reply_comment?.text || ''),
    aweme: awemeId ? { id: awemeId, desc, url: AWEME_URL + awemeId } : null,
  }
}

/** 用一句话描述一条通知（日志、状态页、报告里用） */
export function noticeLine(n) {
  if (!n) return ''
  const who = n.from?.nickname || '（未知用户）'
  const extra = n.others ? ` 等 ${n.others + 1} 人` : ''
  if (n.kind === 'comment') return `${who} 评论：${n.text}`
  if (n.kind === 'mention') return `${who} @了你：${n.text}`
  if (n.kind === 'digg') return `${who}${extra} 赞了你的作品`
  if (n.kind === 'follow') return `${who} 关注了你`
  if (n.kind === 'danmaku') return `${who} 发了弹幕`
  return who
}

/**
 * 读通知。
 * @param {{callTool:Function, group?:string, limit?:number, unreadOnly?:boolean}} opts
 */
export async function listNotices({ callTool, group = 'all', limit = 20, unreadOnly = false } = {}) {
  const g = normalizeGroup(group)
  const raw = await callTool('get_all_notices', { notice_group: g.code, limit: Math.max(1, Math.min(100, Number(limit) || 20)) })
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.notice_list) ? raw.notice_list : []
  const all = arr.map((it) => normalizeNotice(it, { group: g.key })).filter(Boolean)
  const notices = unreadOnly ? all.filter((n) => n.read === false) : all
  const out = {
    group: { key: g.key, label: g.label },
    count: notices.length,
    unread: all.filter((n) => n.read === false).length,
    notices,
  }
  if (!notices.length) {
    out.note = unreadOnly
      ? `${g.label}：没有未读的通知。`
      : g.key === 'mention'
        ? '@我的这个分组是空的 —— 最近没人 @ 你。抖音的 @ 提醒就是这里读的，不需要网页端「消息」里的收件箱。'
        : `${g.label}：没有通知。`
  }
  return out
}
