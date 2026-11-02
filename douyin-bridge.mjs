#!/usr/bin/env node
// 抖音直播数据桥：从本机浏览器的直播间页面读取弹幕/点赞/礼物，转发给头像打印机。
// 用法：node douyin-bridge.mjs [房间号] [WS端口]（房间号也可写入 .bridge-room 文件），端口默认 8765
// 浏览器优先级：BrowserOS neo(:9110) → 已开调试端口的 Chromium(:9222) → 自建无头 Chrome(:9223)
// 页面(http://127.0.0.1:8080)会自动连接 ws://127.0.0.1:8765，无需手动操作。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startWSServer } from './bridge-ws.mjs';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOM_RE = /live\.douyin\.com\/(\d+)/;
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

// —— 纯解析函数（供测试） ——

// 弹幕行里昵称后面常紧跟发布时间（“昨天 21”“今天 08:30”“3分钟前”）。整行采集时
// 这些文本会粘进昵称，导致按昵称精确匹配资料卡永远失败，头像只能退化成合成图。
const TIME_SUFFIX = /(?:\s*(?:昨天|今天|前天|刚刚|刚才)\s*\d{0,2}(?:[:：]\d{1,2})?|\s*\d{1,2}\s*(?:秒|分钟|小时|天)前)\s*$/;
export function stripTimeSuffix(name) {
  let s = String(name || '');
  for (let i = 0; i < 2; i++) {
    const next = s.replace(TIME_SUFFIX, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

export function parseChatLine(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/欢迎来到直播间|严禁|未成年人|网络诈骗|理性消费|新功能|三屏|点击体验/.test(text) || /^(新功能|提示|公告|系统)\s*[：:]/.test(text)) return { kind: 'system', text };
  // 昵称与分隔冒号之间夹着的发布时间（“yjg3250昨天 21：15…”“…今天 08:30：…”）先摘掉，
  // 否则冒号会切在时间里，昵称带脏后缀、正文也少一截。
  text = text.replace(/^(.{1,24}?)\s*(?:昨天|今天|前天|刚刚|刚才)\s*\d{0,2}\s*[：:]\s*\d{1,2}\s*(.*)$/, '$1：$2');
  let m = text.match(/^(.{1,24}?)\s*[：:]\s*(.*)$/);
  if (m) {
    const name = stripTimeSuffix(m[1]), body = m[2].trim();
    if (!name || isJunkName(name)) return null;
    const g = body.match(/^(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
    if (g && g[1].trim()) return { kind: 'gift', name, gift: g[1].trim(), count: g[2] ? +g[2] : 1 };
    if (/^(关注了主播|关注了直播间|成为新粉丝)/.test(body)) return { kind: 'follow', name };
    if (!body) return null;
    return { kind: 'comment', name, text: body };
  }
  m = text.match(/^(.{1,24}?)\s*(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
  if (m && m[2].trim() && !isJunkName(stripTimeSuffix(m[1]))) return { kind: 'gift', name: stripTimeSuffix(m[1]), gift: m[2].trim(), count: m[3] ? +m[3] : 1 };
  m = text.match(/^(.{1,20}?)\s*来了$/);
  if (m) return { kind: 'join', name: stripTimeSuffix(m[1]) };
  m = text.match(/^(.{1,24}?)\s*(?:关注了主播|关注了直播间|成为新粉丝|推荐了直播)/);
  if (m) return { kind: 'follow', name: stripTimeSuffix(m[1]) };
  return null;
}

export function mapGift(name) {
  if (/啤酒/.test(name)) return 'beer';
  if (/棒棒糖/.test(name)) return 'lollipop';
  if (/爱心|红心|心心/.test(name)) return 'heart';
  return 'other';
}

// 垃圾名判定：feed卡标签、动作短语等不是观众昵称。
export function isJunkName(n) {
  if (!n) return true;
  const s = String(n);
  if (/充钻石|客户端|壁纸通知|消息投稿|互相关注|粉丝团|账号已在其他地方|进入直播间|扫码登录/.test(s)) return true;
  if (s.length < 1 || s.length > 24) return true;
  if (/^(送出了?|送了|来了|关注|粉丝|评论|分享|关注了.*)$/.test(s)) return true;
  if (/分享\[视频\]|前天分享|小时榜|人气榜|本场点赞|在线观众|贡献/.test(s)) return true;
  // 纯数字昵称（默认 ID 名，如 1072778353584052）是真实观众，不能当垃圾名丢掉；
  // 太短的数字串仍按噪声处理。
  if (!/[\u{4e00}-\u{9fff}a-zA-Z]/u.test(s) && !/^\d{6,20}$/.test(s)) return true;
  return false;
}

// 昵称归一化：去掉空格与装饰 emoji，用于弹幕昵称 ↔ 观众面板头像的模糊匹配。
export function normKey(name) {
  return String(name || '').replace(/[\s\u3000]+/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '');
}

// —— 协议级解码：通用 protobuf 遍历 + 直播间 WebSocket 帧 → 用户(昵称,头像) ——
export function pbDecode(buf) {
  const fields = [];
  let i = 0;
  try {
    while (i < buf.length) {
      let key = 0, shift = 0, byte;
      do { if (i >= buf.length) return fields; byte = buf[i++]; key |= (byte & 0x7f) << shift; shift += 7; if (shift > 35) return fields; } while (byte & 0x80);
      const fieldNum = key >>> 3, wire = key & 7;
      if (fieldNum === 0) return fields;
      if (wire === 0) { let v = 0n, s = 0n; do { if (i >= buf.length) return fields; byte = buf[i++]; v |= BigInt(byte & 0x7f) << s; s += 7n; } while (byte & 0x80); fields.push({ n: fieldNum, wire, num: v }); }
      else if (wire === 1) { if (i + 8 > buf.length) return fields; i += 8; fields.push({ n: fieldNum, wire, buf: buf.subarray(i - 8, i) }); }
      else if (wire === 2) { let len = 0, sh = 0; do { if (i >= buf.length) return fields; byte = buf[i++]; len |= (byte & 0x7f) << sh; sh += 7; } while (byte & 0x80); if (i + len > buf.length) return fields; fields.push({ n: fieldNum, wire, buf: buf.subarray(i, i + len) }); i += len; }
      else if (wire === 5) { if (i + 4 > buf.length) return fields; i += 4; fields.push({ n: fieldNum, wire, buf: buf.subarray(i - 4, i) }); }
      else return fields;
    }
  } catch { }
  return fields;
}

function imageUrl(buf, depth = 0) {
  if (depth > 5) return '';
  const text = buf.toString('utf8');
  if (/^https?:\/\/[^\s]+$/.test(text) && /douyinpic|byteimg|douyinstatic/.test(text)) return text;
  for (const field of pbDecode(buf)) {
    if (field.wire !== 2 || !field.buf) continue;
    const url = imageUrl(field.buf, depth + 1);
    if (url) return url;
  }
  return '';
}

export function extractUser(buf, depth = 0) {
  if (depth > 7) return null;
  const fields = pbDecode(buf);
  // User.nickname is field 3; Image.url_list is nested inside the avatar field.
  const nickname = fields.find(f => f.n === 3 && f.wire === 2)?.buf?.toString('utf8');
  if (nickname && nickname.length <= 40 && !/[\x00-\x1f\ufffd]/.test(nickname)) {
    for (const n of [9, 10, 11, 6]) {
      const field = fields.find(f => f.n === n && f.wire === 2);
      const avatar = field?.buf && imageUrl(field.buf);
      if (avatar) return { name: nickname, avatar };
    }
  }
  for (const f of fields) {
    if (f.wire !== 2 || !f.buf?.length) continue;
    const user = extractUser(f.buf, depth + 1);
    if (user) return user;
  }
  return null;
}

function handleWSFrame(buf) {
  try {
    let payload = buf;
    const idx = buf.indexOf(Buffer.from([0x1f, 0x8b]));
    if (idx >= 0) { try { payload = zlib.gunzipSync(buf.subarray(idx)); } catch { return } }
    for (const f of pbDecode(payload)) {
      if (f.wire !== 2 || !f.buf || f.buf.length < 12) continue;
      const head = f.buf.toString('utf8', 0, Math.min(48, f.buf.length));
      const mt = head.match(/Webcast(Chat|Like|Member|Social|Gift)Message/);
      if (!mt) continue;
      const kind = mt[1];
      let best = null;
      for (const s of pbDecode(f.buf)) {
        if (s.wire !== 2 || !s.buf || s.buf.length < 12) continue;
        const t = s.buf.toString('utf8', 0, Math.min(40, s.buf.length));
        if (/Webcast\w*Message/.test(t)) continue;
        if (!best || s.buf.length > best.buf.length) best = s;
      }
      if (!best) continue;
      const user = extractUser(best.buf);
      if (!user || !user.name) continue;
      feedAvatar(user.name, user.avatar);
      if (kind === 'Chat') {
        // 直播网页版不一定会把弹幕渲染进 DOM（聊天列表常常是空的），
        // 只靠 DOM 抓会让「弹幕数」永远停在 1。这里直接从协议帧取正文。
        const text = chatText(f.buf);
        if (text) emitChat(user, text);
        continue;
      }
      const type = kind === 'Like' ? 'like' : kind === 'Social' ? 'follow' : kind === 'Member' ? 'join' : null;
      if (type === 'like') emitLike(user);
      else if (type === 'follow') emitFollow(user);
      else if (type === 'join') emitJoinWS(user);
    }
  } catch { }
}

// WebcastChatMessage 的正文在字段 3（Content），个别版本在 2 或 5。
function chatText(buf, depth = 0) {
  if (depth > 4) return '';
  let fields;
  try { fields = pbDecode(buf) } catch { return '' }
  for (const n of [3, 2, 5]) {
    const f = fields.find(x => x.n === n && x.wire === 2 && x.buf && x.buf.length >= 1 && x.buf.length <= 300);
    if (!f) continue;
    const s = f.buf.toString('utf8').replace(/\s+/g, ' ').trim();
    if (!s || /[\x00-\x08\x0b-\x1f�]/.test(s)) continue;
    if (/Webcast\w*Message|^https?:\/\//.test(s)) continue;
    return s;
  }
  for (const f of fields) {
    if (f.wire !== 2 || !f.buf?.length || f.buf.length > 300) continue;
    const nested = chatText(f.buf, depth + 1);
    if (nested) return nested;
  }
  return '';
}

// 同一句弹幕 DOM 和协议层可能都报一次，这里用「昵称+正文」在 8 秒内去重。
const recentChat = new Map();
function emitChat(user, text) {
  const key = user.name + '\u0000' + text;
  const now = Date.now();
  if (recentChat.get(key) && now - recentChat.get(key) < 8000) return;
  recentChat.set(key, now);
  if (recentChat.size > 300) { for (const [k, t] of recentChat) if (now - t > 30000) recentChat.delete(k) }
  total.comment++;
  lastEventAt = now;
  broadcast({ type: 'comment', name: user.name, text, avatar: user.avatar || '' });
  console.log('[' + stamp() + '] 💬 %s：%s（协议级）', user.name, text);
}

// 模块级事件出口：emitChat/emitLike/emitFollow/emitJoinWS 都在这里广播。
// 早前它们直接引用 main() 里的局部 hub，协议级事件实际上每次都在抛
// ReferenceError 然后被上层 catch 吞掉——点赞、关注、进场、协议层弹幕一条都发不出去。
let hub = null;
function broadcast(ev) { if (hub) hub.broadcast(ev) }

const normMap = new Map();
function feedAvatar(name, avatar) {
  if (!name || !avatar || isJunkName(name)) return;
  const k = normKey(name);
  if (avatars[name] !== avatar) avatars[name] = avatar;
  if (k) normMap.set(k, avatar);
  if (roster.get(name) !== avatar) {
    if (!roster.has(name)) likeState.used.clear();
    roster.set(name, avatar);
    lastSeen.set(name, Date.now());
  }
}

function emitLike(user) {
  const nowMs = Date.now();
  likeTokens = Math.min(20, likeTokens + (nowMs - likeTokensAt) / 400);
  likeTokensAt = nowMs;
  const allowed = Math.min(3, Math.floor(likeTokens));
  likeTokens -= allowed;
  lastWsLikeAt = nowMs;
  if (allowed <= 0) {
    if (nowMs - lastThrottleLog > 10000) { lastThrottleLog = nowMs; console.log('[' + stamp() + '] ❤️ 点赞高峰限速中'); }
    return;
  }
  total.like += allowed;
  lastEventAt = nowMs;
  broadcast({ type: 'like', name: user.name, avatar: user.avatar || '', count: allowed });
  console.log('[' + stamp() + '] ❤️ %s 点赞 +%d（协议级）', user.name, allowed);
}

function emitFollow(user) {
  if (!user || !user.name) return;
  total.join++;
  lastEventAt = Date.now();
  broadcast({ type: 'follow', name: user.name, avatar: user.avatar || '' });
  console.log('[' + stamp() + '] ⭐ %s 关注了直播间 → 打印头像', user.name);
}

function emitJoinWS(user) {
  if (!user || !user.name) return;
  lastWsJoinAt = Date.now();
  total.join++;
  lastEventAt = Date.now();
  broadcast({ type: 'join', name: user.name, avatar: user.avatar || '' });
  console.log('[' + stamp() + '] 👋 %s 进入直播间（协议级）', user.name);
}

export function parseLike(text) {
  const m = String(text || '').match(/([\d.]+)(万)?\s*本场点赞/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  return Math.round(v * (m[2] ? 10000 : 1));
}

// 从弹幕行列表里找出新行。按「位置重叠」比对而不是按文本查重：
// 同一个人重复发「666」时文本完全相同，按文本去重会把第二次、第三次全部当成旧消息丢掉。
// 弹幕列表是向下追加的滚动窗口，所以只需找「上一屏的末尾 == 这一屏的开头」的最大重叠段。
export function diffNew(lines, seen, cap = 80) {
  const prev = seen.__prev;
  seen.__prev = lines.slice();
  if (!prev || !prev.length) return lines.slice(0, cap);
  const max = Math.min(prev.length, lines.length);
  let overlap = 0;
  for (let i = max; i > 0; i--) {
    let same = true;
    for (let j = 0; j < i; j++) {
      if (prev[prev.length - i + j] !== lines[j]) { same = false; break; }
    }
    if (same) { overlap = i; break; }
  }
  return lines.slice(overlap, overlap + cap);
}

// 点赞无法从页面获知点赞人：在累积观众花名册上公平轮换，同一人最多连续 cap 次，
// 所有人用满后开新一轮；一轮内打不完的点赞直接丢弃（避免同一人刷屏）。
export function allocateLikes(delta, roster, state, cap = 3) {
  const events = [];
  let assigned = 0, passes = 0;
  const capFor = e => (e[1] ? cap : 1);
  const maxScan = roster.reduce((s, e) => s + capFor(e), 0);
  while (assigned < delta && passes < 2 && roster.length) {
    let scanned = 0;
    while (assigned < delta && scanned < maxScan) {
      if (state.idx >= roster.length) state.idx = 0;
      const entry = roster[state.idx];
      state.idx = (state.idx + 1) % roster.length;
      scanned++;
      const used = state.used.get(entry[0]) || 0;
      if (used >= capFor(entry)) continue;
      state.used.set(entry[0], used + 1);
      const last = events[events.length - 1];
      if (last && last.name === entry[0]) last.count++;
      else events.push({ name: entry[0], avatar: entry[1], count: 1 });
      assigned++;
    }
    if (assigned < delta) {
      state.used.clear();
      passes++;
    } else break;
  }
  return events;
}

// —— 页面内采集脚本（不依赖混淆类名，按文本特征定位） ——

const COLLECT = String.raw`(() => {
  const out = { likes: null, lines: [], avatars: {}, owner: '', href: location.href };
  const om = document.title.match(/^(.+?)的抖音直播间/);
  if (om) out.owner = om[1];
  for (const e of document.querySelectorAll('span,div,b,p')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 20 && t.indexOf('本场点赞') >= 0) { const m = t.match(/([\d.]+)(万)?\s*本场点赞/); if (m) out.likes = Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1)); break; }
  }
  const single = t => /^.{1,24}[：:][^：:]{0,80}$/.test(t) || /^.{1,24}(送出|送了)\s*[^：:]{1,20}(\s*[xX×]\s*\d{1,3})?$/.test(t) || /^.{1,20}来了$/.test(t);
  const tick = (window.__scanTick = (window.__scanTick || 0) + 1);
  if (tick % 4 === 1 || !window.__chatRoot || !window.__chatRoot.isConnected) {
    let best = null, bestN = 0;
    // 优先用直播自带聊天室容器：它的类名是稳定的 webcast-chatroom。
    // 早先纯按「子节点像不像弹幕」打分，会误选到私信/通知面板（"陌生人消息""xx分钟前分享[直播]"），
    // 于是弹幕数、观众数都跟直播间对不上。
    const room = document.querySelector('.webcast-chatroom');
    const roomList = room && room.firstElementChild && room.firstElementChild.children.length ? room.firstElementChild : room;
    // 只要聊天室容器在，就只用它，绝不回退到其它面板——
    // 回退会抓到私信/通知列表（"陌生人消息""xx分钟前分享[直播]"），
    // 让弹幕数和观众数完全对不上真实直播间。
    if (roomList && roomList.children.length) { best = roomList; bestN = roomList.children.length; }
    if (!best) {
      for (const c of document.querySelectorAll('div')) {
        if (c.closest('.webcast-chatroom, [class*="conversation"], [class*="Conversation"]')) continue;
        let n = 0;
        for (const k of c.children) { const t = (k.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 90 && single(t)) n++; }
        if (n > bestN) { bestN = n; best = c; }
      }
    }
    window.__chatRoot = best;
  }
  const chatRoot = window.__chatRoot;
  const scope = chatRoot || document;
  const leaves = [...scope.querySelectorAll('span,div')].filter(e => !e.children.length);
  const seeds = leaves.filter(e => { const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); return t && t.length <= 90 && (/[：:]/.test(t) || /(送出|送了)/.test(t) || /来了$/.test(t)); });
  const bestSet = new Set();
  for (const e of seeds) {
    let best = e;
    let n = e.parentElement;
    while (n && n !== document.body && (!chatRoot || chatRoot.contains(n))) {
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 90 && single(t)) { best = n; n = n.parentElement; } else break;
    }
    bestSet.add(best);
  }
  const chosen = [...bestSet].filter(a => ![...bestSet].some(b => b !== a && b.contains(a)));
  out.lines = chosen.map(n => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (tick % 2 === 0 || !window.__avMap) {
    const av = {};
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (src.indexOf('douyinpic.com') < 0) continue;
      if (!/(aweme-avatar|tos-cn-avt|\/aweme\/100x100\/)/.test(src) && !/img\/webcast\/[a-f0-9]{16,}\.(p|png|jpe?g|webp)/i.test(src)) continue;
      if (/grade_level|badge|medal|icon|\.svg|ranklist/i.test(src)) continue;
      let n = img.parentElement, name = '';
      for (let i = 0; i < 5 && n && !name; i++) {
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (/\d+\s*钻|充值|礼物周榜|小时榜|人气榜/.test(t) || t.length > 40) { n = n.parentElement; continue; }
        const m = t.match(/^([^：:\s]{1,24})/);
        if (m && m[1]) {
        const c = m[1].replace(/关注\d*粉丝\d*.*$/, '').replace(/\d{1,2}\/\d{1,2}.*$/, '').replace(/暂不支持.*$/, '').replace(/来了$/, '').replace(/\d+天前.*/, '').replace(/分享\[视频\]/, '').replace(/在线$/, '').trim();
        if (c.length >= 1 && c.length <= 20 && /[\u4e00-\u9fa5A-Za-z]/.test(c) && !/^用户\d{6,}$/.test(c) && !/^(送出了?|送了|来了|关注|粉丝|评论|分享)$/.test(c) && !/分享\[|前天|小时榜|人气榜|本场点赞|在线观众|贡献/.test(c)) name = c;
        }
        n = n.parentElement;
      }
      if (name && !av[name]) av[name] = src;
    }
    window.__avMap = av;
  }
  Object.assign(out.avatars, window.__avMap || {});
  // 在线观众名单：弹幕列表只显示最近几条，光靠它算观众数会严重偏少。
  // 这里从「在线观众」面板逐行取昵称 + 头像，补进同一份 avatars 映射。
  {
    const hdr = [...document.querySelectorAll('div,span')].find(e => /在线观众/.test((e.textContent || '').slice(0, 20)) && (e.textContent || '').length < 40);
    let panel = null;
    if (hdr) {
      let n = hdr;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        const r = n.getBoundingClientRect();
        if (r.height > 150 && n.querySelectorAll('img').length >= 2) { panel = n; break; }
      }
    }
    if (panel) {
      for (const img of panel.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        if (!/douyinpic|byteimg/.test(src) || /grade_level|badge|medal|icon|ranklist|new_user_grade/i.test(src)) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 18 || r.width > 60) continue;
        let n = img.parentElement, name = '';
        for (let i = 0; i < 4 && n && !name; i++, n = n.parentElement) {
          const lines = (n.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
          const cand = lines.find(t => t !== '-' && !/^\d+(钻|万)?$/.test(t) && !/^加入了直播间$/.test(t) && t.length >= 1 && t.length <= 20 && !/在线观众|全部|贡献用户|高等级|加入了/.test(t));
          if (cand) { name = cand.replace(/^-\s*/, '').trim(); break }
        }
        if (name && !(window.__avMap || {})[name]) { window.__avMap = window.__avMap || {}; window.__avMap[name] = src }
        if (name) { out.viewers = out.viewers || []; if (out.viewers.length < 60 && !out.viewers.some(v => v.name === name)) out.viewers.push({ name, avatar: src }) }
      }
      Object.assign(out.avatars, window.__avMap || {});
    }
  }
  // 在线观众面板**不能**自动点开：它是一层覆盖在聊天室上面的抽屉，
  // 打开后弹幕列表就不再渲染新消息（日志里「弹幕永远只有 1 条」就是它造成的）。
  // 这里只读标题上的数字（"在线观众 · 5"），需要抓头像时才由下面 viewer 逻辑就地读取。
  {
    const hdr = [...document.querySelectorAll('div,span')].find(e => /在线观众/.test((e.innerText || '').slice(0, 20)) && (e.innerText || '').length < 40);
    const m = hdr && (hdr.innerText || '').match(/在线观众[\s\S]{0,4}?(\d{1,6})/);
    if (m) out.viewerCount = Number(m[1]);
  }
  if (tick % 8 === 0) {
    for (const d of document.querySelectorAll('div')) {
      if (chatRoot && (chatRoot.contains(d) || d.contains(chatRoot))) continue;
      if (d.scrollHeight > d.clientHeight + 60 && d.clientHeight > 80 && d.querySelectorAll('img').length >= 2) {
        if (!d.__scanDir) d.__scanDir = 1;
        d.scrollTop += d.__scanDir * 300;
        if (d.scrollTop + d.clientHeight >= d.scrollHeight - 4) d.__scanDir = -1;
        else if (d.scrollTop <= 0) d.__scanDir = 1;
      }
    }
  }
  return out;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listPages(port) {
  const list = await getJson('http://127.0.0.1:' + port + '/json/list');
  return (Array.isArray(list) ? list : []).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function openTab(port, url) {
  try {
    await getJson('http://127.0.0.1:' + port + '/json/new?url=' + encodeURIComponent(url), 'PUT');
  } catch {
    await getJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url)).catch(() => { });
  }
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const hit = (await listPages(port)).find(t => (t.url || '').indexOf(url.replace(/^https?:\/\//, '').split('?')[0]) >= 0);
      if (hit) return hit;
    } catch { return null }
  }
  return null;
}

async function findTarget(room) {
  const roomUrl = 'https://live.douyin.com/' + room;
  for (const port of (process.env.PRINTER_CDP_PORT ? [Number(process.env.PRINTER_CDP_PORT)] : [9223, 9110, 9222])) {
    let pages;
    try { pages = await listPages(port) } catch { continue }
    let hit = pages.find(t => { const m = (t.url || '').match(ROOM_RE); return m && m[1] === room });
    if (!hit && process.env.PRINTER_CDP_PORT) continue;
    if (!hit) {
      console.log('[' + stamp() + '] 在 :' + port + ' 没找到房间标签页，新开一个（不动你已开的页面）…');
      hit = await openTab(port, roomUrl);
      if (!hit) continue;
    }
    return { port, target: hit };
  }
  return null;
}

async function launchStandaloneChrome(room) {
  const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('没有可用的 CDP 浏览器，也未找到 Chrome/Edge 可执行文件');
  const dir = path.join(__dirname, '.bridge-profile');
  fs.mkdirSync(dir, { recursive: true });
  console.log('[' + stamp() + '] 弹出直播间窗口(:9223)…可在里面登录抖音，登录后头像抓取更全');
  spawn(exe, [
    '--remote-debugging-port=9223', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    '--window-position=120,90', '--window-size=1180,800',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
    'https://live.douyin.com/' + room
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try { await getJson('http://127.0.0.1:9223/json/version'); return } catch { }
  }
  throw new Error('自建浏览器启动超时');
}

function attachCDP(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let mid = 0;
    const pend = new Map();
    const rpc = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++mid;
      pend.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
    ws.onopen = async () => {
      try {
        await rpc('Runtime.enable');
        await rpc('Network.enable');
        resolve({ ws, rpc });
      } catch (e) { reject(e) }
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result);
        return;
      }
      if (m.method && cdpEventSink) { try { cdpEventSink(m) } catch { } }
    };
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
}

let currentRoom = '';
let cdpRef = null;
export function _injectCdpForTest(ref) { cdpRef = ref; }
let lastLikes = null, clientCount = 0, chatSeen = false, owner = '', liveViewerCount = 0;
const roster = new Map(), likeState = { idx: 0, used: new Map() }, lastSeen = new Map();
const seen = new Set(), avatars = {};
const total = { comment: 0, gift: 0, like: 0, join: 0 };
let likeTokens = 20, likeTokensAt = Date.now(), lastThrottleLog = 0, lastEventAt = 0, lastNavFix = 0, lastWsLikeAt = 0, lastWsJoinAt = 0, cdpEventSink = null, lastFollowerCount = null, lastFollowerPoll = 0;

function resetRoomState() {
  lastLikes = null; chatSeen = false; owner = '';
  roster.clear(); lastSeen.clear(); seen.clear(); seen.__prev = null;
  for (const k of Object.keys(avatars)) delete avatars[k];
  likeState.used.clear(); likeState.idx = 0;
  total.comment = total.gift = total.like = total.join = 0;
}

// 关注检测：轮询登录账号菜单里的粉丝数，涨粉即打印头像（归属最近活跃观众）。
async function pollFollowers() {
  if (!cdpRef || !owner) return;
  if (Date.now() - lastFollowerPoll < 30000) return;
  lastFollowerPoll = Date.now();
  try {
    const posRaw = (await cdpRef.rpc('Runtime.evaluate', {
      expression: `(() => {
        const imgs = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.top < 130 && r.left > innerWidth * 0.55 && r.width >= 22 && r.width <= 90 && r.height >= 22 && /douyinpic/.test(i.currentSrc || i.src || ''); });
        const el = imgs[0];
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
      returnByValue: true
    })).result.value;
    if (!posRaw || posRaw === 'null') return;
    const { x, y } = JSON.parse(posRaw);
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(500);
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 2, y: y + 2 });
    await sleep(700);
    const fansRaw = (await cdpRef.rpc('Runtime.evaluate', {
      expression: `(() => { const m = (document.body.innerText || '').match(/粉丝(\\d{3,9})/); return m ? m[1] : ''; })()`,
      returnByValue: true
    })).result.value;
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }).catch(() => { });
    const fans = fansRaw ? parseInt(fansRaw, 10) : null;
    if (fans == null) return;
    if (lastFollowerCount != null && fans > lastFollowerCount) {
      const n = Math.min(fans - lastFollowerCount, 10);
      const pool = [...roster.entries()].filter(([nm]) => nm !== owner).sort((a, b) => (lastSeen.get(b[0]) || 0) - (lastSeen.get(a[0]) || 0));
      for (let i = 0; i < n && pool.length; i++) {
        const [name, avatar] = pool[i % pool.length];
        total.join++;
        lastEventAt = Date.now();
        broadcast({ type: 'follow', name, avatar: avatar || '' });
        console.log('[' + stamp() + '] ⭐ 新关注（粉丝 ' + lastFollowerCount + '→' + fans + '）→ 打印 ' + name);
      }
    }
    lastFollowerCount = fans;
  } catch { }
}

// 串行悬停，避免多条评论同时移动鼠标导致资料卡串人。
const hoverTried = new Map();
let hoverQueue = Promise.resolve();
function hoverResolveAvatars(names) {
  const room = currentRoom;
  const work = hoverQueue.then(() => room === currentRoom ? resolveHoverBatch(names) : undefined);
  hoverQueue = work.catch(() => {});
  return work;
}
export async function clickNickname(rpc, x, y) {
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
}

const CARD_OPEN = `!![...document.querySelectorAll('[role="dialog"],dialog')].find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; })`;
export async function dismissProfileCard(rpc, force = false) {
  const read = async expression => (await rpc('Runtime.evaluate', {expression,returnByValue:true})).result.value;
  const open = await read(CARD_OPEN);
  if (!open && !force) return true;
  const point = await read(`(() => {
    const editors = [...document.querySelectorAll('[contenteditable="true"],textarea')];
    for (const editor of editors) {
      if (editor.closest('[role="dialog"],dialog')) continue;
      const r=editor.getBoundingClientRect();
      if(r.width<10 || r.height<5 || r.bottom>innerHeight || r.top<0) continue;
      const x=r.left+Math.min(20,r.width/2), y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if(hit && (hit===editor || editor.contains(hit))) return {x,y};
    }
    return null;
  })()`);
  if (!point) return false;
  // Only focus the comment editor; never type, press Enter, or click Send.
  await clickNickname(rpc, point.x, point.y);
  for (let i=0;i<5;i++) {
    await sleep(100);
    if (!await read(CARD_OPEN)) return true;
  }
  return false;
}

export async function resolveHoverBatch(names) {
  if (!cdpRef) return;
  for (const name of names) {
    const last = hoverTried.get(name) || 0;
    if (Date.now() - last < 6000) continue;
    hoverTried.set(name, Date.now());
    let avRaw = '';
    try {
      // 同一昵称最多点3轮，每轮换一个点击位置（靠左 / 靠左起点 / 居中 / 靠右），提高资料卡命中率。
      for (let round = 0; round < 3 && !avRaw; round++) {
      if (!await dismissProfileCard(cdpRef.rpc)) { console.warn('资料卡未关闭，暂停本轮点击，避免误入主页'); return; }
      const posRaw = (await cdpRef.rpc('Runtime.evaluate', {
        expression: `(() => {
          const name = ${JSON.stringify(name)};
          const scope = window.__chatRoot;
          if (!scope || !scope.isConnected) return '[]';
          const norm = s => (s || '').replace(/[\\s\\u3000]+/g, '');
          const key = norm(name);
          const els = [...scope.querySelectorAll('span,a,div')].filter(e => {
            if (e.closest?.('[role="dialog"],dialog,a[href],button')) return false;
            const text = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            const matches = text === name || text === name + '：' || text === name + ':' || (!e.children.length && (text.startsWith(name + '：') || text.startsWith(name + ':'))) || norm(text) === key;
            return matches && r.width > 2 && r.height > 2 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.left < innerWidth;
          });
          const el = els[els.length - 1];
          if (!el) return '[]';
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.top < 40) return '[]';
          const y = Math.round(r.top + r.height / 2);
          const ends = [['左', Math.min(30, r.width / 2)], ['靠左', Math.min(12, r.width / 2)], ['中', r.width / 2], ['右', r.width - Math.min(14, r.width / 3)]];
          const out = [];
          for (const [label, off] of ends) {
            const x = Math.round(r.left + off);
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(hit === el || el.contains(hit))) continue;
            if (out.some(p => p.x === x && p.y === y)) continue;
            out.push({ x, y, label });
          }
          return JSON.stringify(out);
        })()`,
        returnByValue: true
      })).result.value;
      const points = JSON.parse(posRaw || '[]');
      if (!points.length) { console.log('头像补取：未定位到可见昵称 ' + name); break; }
      const spot = points[Math.min(round, points.length - 1)];
      await clickNickname(cdpRef.rpc, spot.x, spot.y);
      // 点击后等待资料卡出现，并持续轮询等头像图片读取完成（卡片开着最多等约4秒）。
      let cardSeen = false;
      for (let attempt = 0; attempt < 16 && !avRaw; attempt++) {
      await sleep(250);
      const rawCard = (await cdpRef.rpc('Runtime.evaluate', {
        expression: `(() => {
          const name = ${JSON.stringify(name)};
          let card = false;
          for (const dialog of document.querySelectorAll('[role="dialog"],dialog')) {
            const heading = [...dialog.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].find(e => (e.textContent || '').trim() === name);
            if (!heading || !dialog.getBoundingClientRect().width) continue;
            card = true;
            const images = [...dialog.querySelectorAll('img')].filter(img => {
              const src = img.currentSrc || img.src || '', r = img.getBoundingClientRect();
              return img.complete && img.naturalWidth > 0 && r.width >= 40 && r.height >= 40 && r.width / r.height > .8 && r.width / r.height < 1.2 && /douyinpic|byteimg/.test(src) && !/badge|medal|grade_level|icon/.test(src);
            }).sort((a,b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            if (images.length) return JSON.stringify({ card: true, avatar: images[0].currentSrc || images[0].src });
          }
          // Require an exact nickname inside a compact card; never scan a broad page ancestor.
          const labels = [...document.querySelectorAll('span,a,div,h1,h2,h3,h4')].filter(e => (e.textContent || '').trim() === name && ![...e.children].some(c => (c.textContent || '').trim() === name));
          const pops = [];
          for (const label of labels) {
            let e = label.parentElement;
            for (let i = 0; i < 5 && e; i++, e = e.parentElement) {
              const t = e.innerText || '', r = e.getBoundingClientRect();
              if (t.length > 300) break;
              if (/粉丝|关注/.test(t) && r.width > 0 && r.height > 0 && e.querySelector('img')) {
                const imgs = [...e.querySelectorAll('img')].filter(img => /aweme-avatar|tos-cn-avt|sc=avatar/.test(img.currentSrc || img.src || ''));
                if (imgs.length === 1) pops.push(e);
                break;
              }
            }
          }
          for (const e of pops) {
            card = true;
            for (const img of e.querySelectorAll('img')) {
              const s = img.currentSrc || img.src || '';
              if (/(aweme-avatar|tos-cn-avt|\\/aweme\\/100x100\\/)/.test(s) || /img\\/webcast\\/[a-f0-9]{16,}\\./i.test(s)) {
                if (img.complete && img.naturalWidth > 0 && !/grade_level|badge|medal|icon|\\.svg/i.test(s)) return JSON.stringify({ card: true, avatar: s });
              }
            }
          }
          return JSON.stringify({ card, avatar: '' });
        })()`,
        returnByValue: true
      })).result.value;
        let read = {}; try { read = JSON.parse(rawCard || '{}') } catch { }
        if (read.avatar) { avRaw = read.avatar; break }
        if (read.card) cardSeen = true;
        else if (!cardSeen && attempt >= 2) break;
      }
      await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }).catch(() => { });
      if (avRaw) {
        feedAvatar(name, avRaw);
        console.log('[' + stamp() + '] 🪪 点击资料卡获取到头像：' + name + '（第' + (round + 1) + '次点击·' + spot.label + '）');
      } else {
        console.log('头像补取：第' + (round + 1) + '次点击（' + spot.label + '）' + (cardSeen ? '头像未读取完成' : '资料卡未出现') + ' ' + name);
        // 到评论区点一下，关闭资料卡或清掉残留弹层，再换位置重试。
        await dismissProfileCard(cdpRef.rpc, true).catch(() => false);
        await sleep(350);
      }
      }
    } catch (err) { console.warn('点击头像补取失败：' + err.message); }
    finally {
      if (!await dismissProfileCard(cdpRef.rpc).catch(() => false)) console.warn('资料卡仍显示，下次获取前将先关闭资料卡');
    }
  }
}

async function run(hub) {
  const room = currentRoom;
  // CDP 端口只是「暂时」连不上（页面正在刷新、直播窗口刚重启、登录页跳转中）时，
  // 绝不能直接抛错让整个数据桥进程退出——那样直播会静默断流。
  // 这里最多重试 20 次（约 40 秒），期间持续打印状态。
  let found = null;
  for (let attempt = 1; attempt <= 20 && !found; attempt++) {
    found = await findTarget(room);
    if (found) break;
    if (attempt === 1 || attempt % 5 === 0) {
      console.log('[' + stamp() + '] ⏳ 暂未找到直播间页面（第 %d 次），2 秒后重试…', attempt);
    }
    await sleep(2000);
  }
  if (!found && !process.env.PRINTER_CDP_PORT) {
    await launchStandaloneChrome(room);
    found = await findTarget(room);
  }
  if (!found) throw new Error('无法获得直播间页面（尝试过 :9110 :9222 :9223）');
  const { port, target } = found;
  console.log('[' + stamp() + '] 已挂接浏览器 :%d → %s', port, target.url);
  const { ws, rpc } = await attachCDP(target);
  cdpRef = { ws, rpc };
  if (((target.url || '').match(ROOM_RE) || [])[1] !== currentRoom) {
    await rpc('Page.navigate', { url: 'https://live.douyin.com/' + currentRoom }).catch(() => { });
    await sleep(4000);
  }
  console.log('[' + stamp() + '] 📺 直播间 https://live.douyin.com/' + currentRoom + ' 采集中，每 0.3 秒刷新 + 协议流解码');
  cdpEventSink = m => {
    if (m.method === 'Target.attachedToTarget' && m.params && m.params.sessionId) {
      const sid = m.params.sessionId;
      cdpRef.rpc('Network.enable', {}, sid).catch(() => { });
      cdpRef.rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => { });
    } else if (m.method === 'Network.webSocketFrameReceived' && m.params && m.params.response && m.params.response.payloadData) {
      const p = m.params.response;
      try {
        if (p.opcode === 2) handleWSFrame(Buffer.from(p.payloadData, 'base64'));
        else if (typeof p.payloadData === 'string' && p.payloadData.length > 40) handleWSFrame(Buffer.from(p.payloadData, 'utf8'));
      } catch { }
    }
  };
  await cdpRef.rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => { });

  const fail = err => {
    clearInterval(timer);
    cdpRef = null;
    console.log('[' + stamp() + '] 连接断开（%s），3 秒后重连…', err.message || err);
    try { ws.close() } catch { }
    setTimeout(() => run(hub).catch(e => {
      console.error('[' + stamp() + '] ❌ ' + (e.message || e));
      setTimeout(() => run(hub), 3000);
    }), 3000);
  };
  ws.onerror = () => { };
  ws.onclose = () => fail(new Error('CDP closed'));

  function emit(ev) {
    lastEventAt = Date.now();
    if (ev.type === 'comment') {
      // 同一条弹幕可能同时来自 DOM 与协议层，8 秒内按「昵称+正文」去重，避免重复打印。
      const key = ev.name + '\u0000' + (ev.text || '');
      const now = Date.now();
      const dup = recentChat.get(key) && now - recentChat.get(key) < 8000;
      recentChat.set(key, now);
      if (dup) return;
    }
    hub.broadcast(ev);
    if (ev.type === 'comment') {
      total.comment++;
      console.log('[' + stamp() + '] 💬 %s：%s', ev.name, ev.text || '');
    }
    else if (ev.type === 'gift') { total.gift++; console.log('[' + stamp() + '] 🎁 %s 送出 %s x%d → %s', ev.name, ev.raw, ev.count, ev.gift) }
    else if (ev.type === 'like') { total.like += ev.count; console.log('[' + stamp() + '] ❤️ %s 点赞 +%d%s', ev.name, ev.count, ev.avatar ? '（带头像）' : '') }
    else if (ev.type === 'join') { total.join++; console.log('[' + stamp() + '] 👋 %s 进入直播间', ev.name) }
  }

  function handle(s) {
    if (s.owner) owner = s.owner;
    if (s.viewerCount > 0) liveViewerCount = s.viewerCount;
    // 在线观众面板里的人是「到场观众」，即使还没发言也应该计入观众数。
    for (const v of (s.viewers || [])) {
      if (!v || !v.name || !v.avatar || v.name === owner || isJunkName(v.name)) continue;
      if (!roster.has(v.name)) likeState.used.clear();
      feedAvatar(v.name, v.avatar);
    }
    for (const [n, a] of Object.entries(s.avatars || {})) {
      if (!a || !n || n === owner || isJunkName(n)) continue;
      if (!roster.has(n) && !(s.lines || []).some(line => parseChatLine(line)?.name === n)) continue;
      if (!roster.has(n)) likeState.used.clear();
      feedAvatar(n, a);
    }
    const normAvatars = {};
    for (const [n, a] of Object.entries(s.avatars || {})) { const k = normKey(n); if (k && a && !normAvatars[k]) normAvatars[k] = a; }
    if (s.likes != null) {
      if (lastLikes == null) lastLikes = s.likes;
      else if (s.likes > lastLikes && Date.now() - lastWsLikeAt > 30000) {
        const delta = Math.min(s.likes - lastLikes, 100);
        const pool = [...roster.entries()].sort((x, y) => (Number(!!y[1]) - Number(!!x[1])) || ((lastSeen.get(y[0]) || 0) - (lastSeen.get(x[0]) || 0)));
        const events = allocateLikes(delta, pool, likeState);
        const nowMs = Date.now();
        likeTokens = Math.min(20, likeTokens + (nowMs - likeTokensAt) / 400);
        likeTokensAt = nowMs;
        const budget = Math.floor(likeTokens);
        const allowed = Math.min(events.length, budget);
        likeTokens -= allowed;
        if (events.length > allowed && nowMs - lastThrottleLog > 10000) {
          lastThrottleLog = nowMs;
          console.log('[' + stamp() + '] ❤️ 点赞风暴限速中（高峰期限流，平时秒放行）');
        }
        for (const ev of events.slice(0, allowed)) emit({ type: 'like', ...ev });
        if (delta > 0 && !events.length && !roster.size) console.log('[' + stamp() + '] ❤️ 点赞 +%d（观众名单还没就绪，先不打印）', delta);
      }
      lastLikes = s.likes;
    }
    const parsedNames = [];
    for (const line of diffNew(s.lines || [], seen)) {
      const ev = parseChatLine(line);
      if (!ev) continue;
      const key = normKey(ev.name);
      const avatar = avatars[ev.name] || (key && (normMap.get(key) || normAvatars[key])) || roster.get(ev.name) || '';
      if (!roster.has(ev.name)) likeState.used.clear();
      roster.set(ev.name, avatar);
      lastSeen.set(ev.name, Date.now());
      if (ev.kind !== 'comment') parsedNames.push(ev.name);
      if (ev.kind === 'comment') {
        // 评论立刻发出：补取资料卡要串行点击、每轮最长约 4 秒，扣在这里会让「评论 666」
        // 十几秒都不上屏。头像先用已知的，补取成功后由 avatar 事件回填给前端。
        emit({ type: 'comment', name: ev.name, text: ev.text, avatar: (avatars[ev.name] || (key && normMap.get(key)) || avatar) || '' });
        if (!avatars[ev.name] && !avatar) {
          hoverResolveAvatars([ev.name]).then(() => {
            if (room !== currentRoom) return;
            const resolved = avatars[ev.name] || (key && normMap.get(key)) || '';
            if (resolved) emit({ type: 'avatar', name: ev.name, avatar: resolved });
          }).catch(err => console.error('评论头像补取失败：', err.message));
        }
      }
      else if (ev.kind === 'gift' || ev.kind === 'follow') {
        const payload = ev.kind === 'gift'
          ? { type: 'gift', name: ev.name, gift: mapGift(ev.gift), raw: ev.gift, count: ev.count }
          : { type: 'follow', name: ev.name };
        // 礼物/关注原先用「此刻已知的头像」直接广播，新观众第一次送礼时往往还是空串，
        // 打印出来的就是合成头像。这里给它一个很短的补取窗口，至少不阻塞打印节奏。
        const dispatch = () => {
          if (room !== currentRoom) return;
          const resolved = avatars[ev.name] || (key && normMap.get(key)) || normAvatars[key] || avatar;
          emit({ ...payload, avatar: resolved || '' });
        };
        if (avatar) dispatch();
        else {
          let done = false;
          const once = () => { if (done) return; done = true; clearTimeout(timer); dispatch(); };
          const timer = setTimeout(once, 300);
          hoverResolveAvatars([ev.name]).then(once, once);
        }
      }
      else if (ev.kind === 'join' && Date.now() - lastWsJoinAt > 30000) emit({ type: 'join', name: ev.name, avatar });
    }
    if (parsedNames.length) {
      const need = [...new Set(parsedNames.filter(n => !roster.get(n)))];
      if (need.length) hoverResolveAvatars(need.slice(0, 2));
    }
    pollFollowers();
  }

  const timer = setInterval(async () => {
    if (ws.readyState !== 1) return;
    try {
      const r = await rpc('Runtime.evaluate', { expression: COLLECT, returnByValue: true });
      if (r && r.result && r.result.value) {
        const s = r.result.value;
        // Leave login / verification pages alone; only an explicit room switch navigates.
        if (s.href && !s.href.includes('live.douyin.com/' + currentRoom)) return;
        if (!chatSeen && (s.lines.length || s.likes != null)) {
          chatSeen = true;
          console.log('[' + stamp() + '] ✅ 已读到直播数据：弹幕 %d 条，点赞计数 %s', s.lines.length, s.likes);
        }
        handle(s);
      }
    } catch (e) { fail(e) }
  }, 300);

  const watch = setInterval(() => {
    const n = hub.clientCount();
    if (n !== clientCount) {
      if (n > clientCount) {
        hub.broadcast({ type: 'hello', room: currentRoom, people: [...roster.entries()].sort((a, b) => Number(!!b[1]) - Number(!!a[1])).slice(0, 8).map(([name, avatar]) => ({ name, avatar })) });
        console.log('[' + stamp() + '] 🖨 打印页面已连接（共 %d 个）', n);
      } else console.log('[' + stamp() + '] 打印页面断开（剩 %d 个）', n);
      clientCount = n;
    }
    if (hub.clientCount()) hub.broadcast({ type: 'ping', room: currentRoom, ts: Date.now(), people: [...roster.entries()].sort((a, b) => Number(!!b[1]) - Number(!!a[1])).slice(0, 8).map(([name, avatar]) => ({ name, avatar })), stats: { comment: total.comment, like: total.like, gift: total.gift, join: total.join, lastAgo: lastEventAt ? Date.now() - lastEventAt : null, roster: roster.size, viewers: Math.max(roster.size, liveViewerCount) } });
  }, 2000);
  watch.unref?.();

  // 空闲补取：即使没人发言，也定期给最近活跃、还没有头像的观众再点几次资料卡。
  const sweep = setInterval(() => {
    if (!cdpRef || !hub.clientCount()) return;
    const need = [...roster.keys()].filter(n => !avatars[n])
      .sort((a, b) => (lastSeen.get(b) || 0) - (lastSeen.get(a) || 0)).slice(0, 2);
    if (need.length) hoverResolveAvatars(need);
  }, 45000);
  sweep.unref?.();
}

async function main() {
  const argRoom = (process.argv[2] || '').replace(/\D/g, '');
  let fileRoom = '';
  try { fileRoom = ((fs.readFileSync(path.join(__dirname, '.bridge-room'), 'utf8').match(/(\d{5,25})/)) || [])[1] || '' } catch { }
  currentRoom = argRoom || fileRoom || currentRoom;
  if (!currentRoom) { console.error('请提供直播间号：node douyin-bridge.mjs 房间号（也可写入 .bridge-room 文件，或在打印程序里切换房间）'); process.exit(1); }
  const wsPort = Number(process.argv[3]) || 8765;
  hub = startWSServer(wsPort, {
    onStatus: p => console.log('[' + stamp() + '] ✅ 数据桥服务 ws://127.0.0.1:' + p + '（等待打印页面接入）'),
    onError: err => {
      console.error('[' + stamp() + '] ❌ 端口 ' + wsPort + ' 启动失败（' + err.code + '），可能有另一个数据桥在运行，本实例退出');
      process.exit(1);
    },
    onMessage: raw => {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type !== 'set-room') return;
      const id = String(m.room || '').match(/(\d{5,25})/);
      if (!id) return;
      const room = id[1];
      if (room === currentRoom) { hub.broadcast({ type: 'hello', room, people: [...roster.entries()].slice(0, 6).map(([name, avatar]) => ({ name, avatar })) }); return }
      currentRoom = room;
      try { fs.writeFileSync(path.join(__dirname, '.bridge-room'), room) } catch { }
      console.log('[' + stamp() + '] 📺 切换直播间 → ' + room);
      resetRoomState();
      hub.broadcast({ type: 'hello', room, people: [] });
      if (cdpRef) cdpRef.rpc('Page.navigate', { url: 'https://live.douyin.com/' + room }).catch(() => { });
    }
  });
  console.log('房间号 ' + currentRoom + '。正在弹出直播间窗口（可在里面登录抖音）；来源优先级：自建窗口(:9223) → BrowserOS(:9110) → 调试Chromium(:9222)');
  // 数据桥要长期驻留：连接失败只重试，不退出。不然窗口一刷新就会静默断流。
  for (;;) {
    try {
      await run(hub);
      break;
    } catch (e) {
      console.error('[' + stamp() + '] ❌ ' + e.message + '；8 秒后重试连接…');
      await sleep(8000);
    }
  }
  process.on('SIGINT', () => process.exit());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
