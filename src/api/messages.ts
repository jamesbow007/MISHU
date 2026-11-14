/**
 * HR 消息读取（纯 HTTP）。
 *
 * 接口路径来自官方 bundle 的静态分析 + 未登录态实测（未登录时返回 code=7
 * 而非 404，说明路径确实存在）：
 *   ✅ 已实测：/wapi/zprelation/friend/geekFilterByLabel、getGeekFriendList.json、
 *              /wapi/zpchat/session/check、/wapi/zpchat/geek/historyMsg、
 *              /wapi/zpchat/message/batchGet、/wapi/zpchat/geek/getBossData
 *   🔶 静态分析（参数待实测）：其余
 */
import type { BossClient } from './client.js';

export interface ChatSession {
  /** 会话唯一标识（friendId / encryptBossId / uniqueId 之一，取第一个有值的） */
  key: string;
  name: string;
  avatar?: string;
  lastMessage: string;
  lastMessageAt?: number;
  unread: boolean;
  unreadCount?: number;
  /** 打开会话详情需要的 securityId */
  securityId?: string;
  encryptBossId?: string;
  friendId?: string;
  /** 实测附带字段 */
  brandName?: string;
  jobName?: string;
  jobCity?: string;
  bossTitle?: string;
  /** 原始数据，站点改版后便于重新解析 */
  raw: any;
}

export interface ChatMessage {
  mid: string;
  from: 'me' | 'peer' | 'system';
  /** 对端昵称（HR 名） */
  fromName?: string;
  text: string;
  time?: number;
  type?: string;
  raw: any;
}

/** 会话列表 */
export const LIST_SESSION_PATH = '/wapi/zprelation/friend/geekFilterByLabel';
/** 批量拉会话详情（含最后一条消息） */
export const BATCH_FRIEND_PATH = '/wapi/zprelation/friend/getGeekFriendList.json';
/** 聊天记录 */
export const HISTORY_PATH = '/wapi/zpchat/geek/historyMsg';
/** 批量取消息 */
export const BATCH_MSG_PATH = '/wapi/zpchat/message/batchGet';
/** HR 档案 */
export const BOSS_DATA_PATH = '/wapi/zpchat/geek/getBossData';
/** 登录态探针 */
export const USER_INFO_PATH = '/wapi/zpuser/wap/getUserInfo.json';

/* ---------- 宽松字段解析 ---------- */

function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function pickStr(obj: any, keys: string[]): string | undefined {
  const v = pick(obj, keys);
  return v === undefined ? undefined : String(v);
}

function pickNum(obj: any, keys: string[]): number | undefined {
  const v = pick(obj, keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 当前登录用户的 uid —— 模块级持有。
 * 之前存在 BossClient 实例上，而每次工具调用都会新建 client，
 * 导致 read_chat 拿不到 uid，「我发的」消息被显示成「HR 发的」。
 */
let myUid: number | undefined;

/**
 * 我自己的附件简历 id 集合。
 *
 * 用途：附件简历消息（body.type=12）服务端把 from 记成了**对方**
 * （实测投递后 from.uid = HR 的 uid，但页面把它渲染成系统消息「附件简历请求已发送」）。
 * 判断归属只能看这份附件是不是我的 —— 用 resumeId 比对最准。
 */
let myResumeIds: Set<string> | null = null;

async function ensureMyResumes(client: BossClient): Promise<Set<string>> {
  if (myResumeIds) return myResumeIds;
  const set = new Set<string>();
  try {
    const r: any = await client.request('/wapi/zpgeek/resume/attachment/checkbox.json', { method: 'GET' });
    for (const item of r?.zpData?.resumeList ?? []) {
      const id = item?.resumeId ?? item?.encryptId;
      if (id) set.add(String(id));
    }
  } catch {
    /* 拿不到就退回按方向判断 */
  }
  myResumeIds = set;
  return set;
}

/* ---------- 登录态 ---------- */

export async function probeLogin(client: BossClient): Promise<{ loggedIn: boolean; code: number; message: string; user?: any }> {
  try {
    const res: any = await client.request(USER_INFO_PATH, { method: 'GET' });
    // 记下「我是谁」，后面判断消息归属就不用每次传参
    const uid = Number((res?.zpData as any)?.userId);
    if (Number.isFinite(uid)) myUid = uid;

    return {
      loggedIn: true,
      code: Number(res?.code ?? 0),
      message: res?.message ?? 'ok',
      user: res?.zpData,
    };
  } catch (e: any) {
    return {
      loggedIn: false,
      code: Number(e?.code ?? -1),
      message: e?.message ?? String(e),
    };
  }
}

/**
 * 必须登录才能继续，否则抛出一条**能照着做**的错误。
 *
 * 之前脚本里的写法是 `probeLogin` 返回 loggedIn=false 就打印「未登录」——
 * 但拿不到 cookie 和真的掉登录是两回事，误导性很强。
 */
export function requireLogin(result: {
  loggedIn: boolean;
  code: number;
  message: string;
  user?: any;
}): { loggedIn: true; code: number; message: string; user?: any } {
  if (!result.loggedIn) {
    throw new Error(
      `拿不到登录态（code=${result.code} ${result.message}）。请依次检查：` +
        `① Chrome 浏览器开着吗 ② chrome://extensions/ 里扩展加载并启用了吗（被停用时点一下 🔄）` +
        `③ Chrome 里登录 BOSS直聘了吗 ④ 本地桥接在跑吗（npm run bridge 或 npm run watch）`,
    );
  }
  return result as { loggedIn: true; code: number; message: string; user?: any };
}

/**
 * 刷新 zp_token（bst）。
 * 服务端会根据会话状态下发新的 bst；无会话时会下发 `bst=; Expires=过去`（删除语义）。
 */
export async function refreshZpToken(client: BossClient): Promise<boolean> {
  try {
    await client.request('/wapi/zppassport/set/zpToken', { method: 'POST', body: '' });
    return true;
  } catch {
    return false;
  }
}

/* ---------- 会话列表 ---------- */

/** 宽松解析一条会话（字段名以实测为准：name/brandName/jobName/updateTime/encryptFriendId） */
function parseSession(raw: any): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null;

  const friendId = pickStr(raw, ['friendId', 'encryptFriendId', 'id']);
  const name =
    pickStr(raw, ['name', 'nickName', 'nickname', 'bossName', 'geekName', 'friendName', 'title']) ?? '';

  // 实测：列表接口在不同 label 下返回的字段不一样 ——
  //   labelId=0（全部）  → 带 name / brandName / jobName / jobCity …
  //   其它 label（1/2/3/5）→ 只有 friendId / encryptFriendId / updateTime 等 6 个字段
  // 所以没名字时先留着（靠 friendId 关联详情接口补齐），补完再解析。
  if (!name && !friendId) return null;

  const encryptFriendId = pickStr(raw, ['encryptFriendId', 'encryptBossId', 'bossId', 'encryptGeekId']);
  const uniqueId = pickStr(raw, ['uniqueId', 'securityId', 'chatId', 'geekId']);

  // 实测：lastMsg 是文本，lastMessageInfo.showText 也是；lastMessageInfo.msgTime 是时间
  const lastMsgRaw = pick(raw, ['lastMessageInfo', 'lastMsg', 'lastMessage', 'message']) ?? raw;
  const lastMessage =
    pickStr(raw, ['lastMsg']) ??
    pickStr(lastMsgRaw, ['showText', 'text', 'content', 'msg']) ??
    '';

  const unreadCount = pickNum(raw, ['unreadMsgCount', 'unreadCount', 'unreadNum', 'newMsgCount']);
  const unreadRaw = pick(raw, ['unread', 'redDot', 'hasNewMessage', 'hasUnread', 'showRedDot']);

  const unread =
    unreadCount !== undefined ? unreadCount > 0 : unreadRaw !== undefined ? Boolean(unreadRaw) : false;

  return {
    key: friendId ?? encryptFriendId ?? uniqueId ?? '',
    name,
    avatar: pickStr(raw, ['avatar', 'avatarUrl', 'photo', 'headImg', 'tinyAvatar']),
    lastMessage,
    lastMessageAt:
      pickNum(raw, ['lastTS', 'updateTime', 'lastMessageTime', 'lastUpdateTime', 'time']) ??
      pickNum(pick(raw, ['lastMessageInfo']) ?? {}, ['msgTime']),
    unread,
    unreadCount,
    securityId: pickStr(raw, ['securityId']),
    encryptBossId: encryptFriendId,
    friendId,
    // 实测附带字段
    brandName: pickStr(raw, ['brandName', 'companyName']),
    jobName: pickStr(raw, ['jobName', 'positionTitle']),
    jobCity: pickStr(raw, ['jobCity', 'city']),
    bossTitle: pickStr(raw, ['bossTitle', 'title']),
    raw,
  };
}

/**
 * 拉会话列表。
 * 先用 geekFilterByLabel（labelId=0 表示全部），再用 getGeekFriendList.json 补齐最后一条消息。
 *
 * `enrich` 控制补详情的范围 —— 这直接决定快慢：
 *   'all'（默认）补全部会话的详情
 *   'none'  只拉列表，不补详情（快，但拿不到 lastMsg / securityId）
 *   'limit' 只补前 `limit` 个会话的详情
 * 实测：批量上限是 200 个 friendId（传 271 个服务端返回 code=1092）。
 */
export async function listSessions(
  client: BossClient,
  opt: { labelId?: number; enrich?: 'all' | 'none' | 'limit'; limit?: number } = {},
): Promise<ChatSession[]> {
  // 实测：labelId=-1 返回空数组，labelId=0 才有会话
  const labelId = opt.labelId ?? 0;
  const enrich = opt.enrich ?? 'all';

  const res: any = await client.request(LIST_SESSION_PATH, {
    method: 'GET',
    query: { labelId },
  });

  const data = res?.zpData ?? res;
  const friendList: any[] =
    data?.friendList ?? data?.list ?? data?.result ?? (Array.isArray(data) ? data : []);

  let sessions = friendList.map(parseSession).filter((s): s is ChatSession => !!s);
  if (enrich === 'none') return sessions;

  // 用 friendId 批量补齐详情（securityId / lastMsg / unreadMsgCount / 头像）
  // 实测参数：POST form，friendIds=逗号分隔的 friendId；单批上限 200
  const BATCH = 200;
  const needIds =
    enrich === 'limit'
      ? (sessions.slice(0, opt.limit ?? sessions.length).map((s) => s.friendId).filter(Boolean) as string[])
      : (sessions.map((s) => s.friendId).filter(Boolean) as string[]);
  const ids = needIds;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const batch: any = await client.request(BATCH_FRIEND_PATH, {
        method: 'POST',
        body: `friendIds=${encodeURIComponent(chunk.join(','))}&dzFriendIds=`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const list: any[] = batch?.zpData?.result ?? [];
      if (!Array.isArray(list) || !list.length) continue;

      // 详情里没有 friendId，用 securityId / uid 之类的键去关联
      const byKey = new Map<string, any>();
      for (const item of list) {
        for (const k of ['encryptFriendId', 'encryptBossId', 'uid', 'encryptUid', 'friendId']) {
          const v = pickStr(item, [k]);
          if (v) byKey.set(v, item);
        }
      }

      sessions = sessions.map((s) => {
        const extra =
          (s.encryptBossId ? byKey.get(s.encryptBossId) : undefined) ??
          (s.friendId ? byKey.get(s.friendId) : undefined);
        if (!extra) return s;
        // 详情里的字段覆盖列表里的（详情更全）。
        // 注意顺序：extra 必须放在最后，否则会被 s.raw 覆盖回去，合并等于没做。
        const merged = parseSession({ ...s.raw, ...extra });
        return merged ?? s;
      });
    } catch {
      /* 补齐失败不影响主列表 */
    }
  }

  // 补完详情还是没名字的（既没有 name 也拉不到详情）才丢掉。
  // ⚠️ 只有全量补齐时才能这么过滤：非 0 的 label 下，列表项本来就没 name
  //（名字在详情里），只补了前几个的话会把没补到的全误杀。
  if (enrich === 'all') return sessions.filter((s) => !!s.name);
  return sessions;
}

/**
 * 只给指定的几个会话补详情（**1 次请求**），就地更新传入的会话对象。
 *
 * 用途：先拉列表（不补详情）定位到目标会话，再用一次请求补上
 * relationType / lastMsg 等只有详情里才有的字段 —— 比补全量快一个数量级。
 */
export async function enrichSessions(
  client: BossClient,
  sessions: ChatSession[],
  ids: string[],
): Promise<number> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return 0;

  const batch: any = await client.request(BATCH_FRIEND_PATH, {
    method: 'POST',
    body: `friendIds=${encodeURIComponent(want.join(','))}&dzFriendIds=`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const list: any[] = batch?.zpData?.result ?? [];
  if (!Array.isArray(list) || !list.length) return 0;

  const byKey = new Map<string, any>();
  for (const item of list) {
    for (const k of ['encryptFriendId', 'encryptBossId', 'uid', 'encryptUid', 'friendId']) {
      const v = pickStr(item, [k]);
      if (v) byKey.set(v, item);
    }
  }

  let n = 0;
  for (const s of sessions) {
    const extra =
      (s.encryptBossId ? byKey.get(s.encryptBossId) : undefined) ??
      (s.friendId ? byKey.get(s.friendId) : undefined);
    if (!extra) continue;
    const merged = parseSession({ ...s.raw, ...extra });
    if (merged) {
      Object.assign(s, merged);
      n++;
    }
  }
  return n;
}

/* ---------- 岗位详情（JD） ---------- */

export interface JobDetailQuery {
  /** 岗位 id（消息里 jobDesc.jobId） */
  jobId?: string | number;
  /** 岗位安全 id（消息里 jobDesc.url 里的 securityId） */
  securityId?: string;
  /** 岗位加密 id（会话详情的 encryptJobId），用于降级时打开详情页 */
  encryptJobId?: string;
}

/**
 * 拉取岗位的完整信息（JD 正文、要求、地址、HR 档案、公司信息）。
 *
 * 岗位详情接口受网关签名保护（__zp_stoken__），token 失效时返回 code=37。
 * 这里做成自愈：先用 JSON 接口拿；被拒就让真实浏览器加载一次岗位页
 * （页面自己会跑安全 JS 刷新 token），然后再试 JSON。
 */
export async function getJobDetail(
  client: BossClient,
  q: JobDetailQuery,
): Promise<any> {
  const query = { jid: q.jobId, securityId: q.securityId, encryptJobId: q.encryptJobId };

  const tryJson = async (): Promise<any> => {
    const res: any = await client.request('/wapi/zpgeek/job/detail.json', {
      method: 'GET',
      query,
    });
    return res?.zpData;
  };

  try {
    const d = await tryJson();
    if (d?.jobInfo?.postDescription) return d;
    return d; // 拿到了但没 JD 正文，也算有效响应
  } catch (e) {
    const code = (e as any)?.code;
    if (code !== 37 && code !== 10009) throw e; // 其它错误直接抛
  }

  // code=37 → 网关 token 失效：让真实浏览器加载一次页面（它会刷新 token）
  if (q.encryptJobId) {
    const { fetchPage } = await import('./page-transport.js');
    await fetchPage(`https://www.zhipin.com/job_detail/${q.encryptJobId}.html`);
    const d = await tryJson();
    if (d) return d;
  }

  throw new Error('岗位详情获取失败：网关签名无法刷新（可稍后重试）');
}

/* ---------- 聊天记录 ---------- */

/**
 * 解析一条消息（字段以实测为准）。
 *
 * 实测结构：
 *   { mid, type:3, time, from:{uid,name,avatar}, to:{uid,name}, body:{type,text,...} }
 *   body.type: 1=文本  8=职位卡片(body.jobDesc)  12=附件/超链接(body.hyperLink)
 */
function parseMessage(raw: any, index: number, myUid?: number): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  const mid = pickStr(raw, ['mid', 'msgId', 'messageId', 'id']) ?? String(index);
  const time = pickNum(raw, ['time', 'createTime', 'sendTime', 'timestamp', 'msgTime']);

  const from = raw.from;
  const fromUid = typeof from === 'object' ? from?.uid : from;
  const fromName = typeof from === 'object' ? from?.name : undefined;

  let fromKind: ChatMessage['from'] = 'peer';
  if (myUid !== undefined && fromUid !== undefined) {
    fromKind = String(fromUid) === String(myUid) ? 'me' : 'peer';
  } else if (typeof from === 'string') {
    if (from === 'me') fromKind = 'me';
    else if (/system|notice/i.test(from)) fromKind = 'system';
  }

  // 正文：body 是对象，按 body.type 分类取（类型集合实测：1/4/7/8/12/16）
  const body = raw.body && typeof raw.body === 'object' ? raw.body : {};
  const bodyType = Number(body.type ?? 0);
  let text = '';
  let kind = 'text';

  switch (bodyType) {
    case 1: {
      text = pickStr(body, ['text', 'extend']) ?? '';
      kind = 'text';
      break;
    }
    case 4: {
      // 动作卡片：我投递简历 / 交换简历等
      const aid = body.action?.aid;
      const labels: Record<string, string> = {
        '38': '我投递了简历',
        '39': '请求交换简历',
      };
      text = labels[String(aid)] ?? `动作卡片(aid=${aid ?? '?'})`;
      kind = 'action';
      break;
    }
    case 7: {
      // 交互弹窗：同意 / 拒绝
      const btns = Array.isArray(body.dialog?.buttons)
        ? body.dialog.buttons.map((b: any) => b?.text).filter(Boolean).join(' / ')
        : '';
      text = btns ? `交互请求（${btns}）` : '交互请求';
      kind = 'dialog';
      break;
    }
    case 8: {
      // 职位卡片
      const jd = body.jobDesc ?? {};
      text = `[职位] ${jd.title ?? ''}${jd.company ? ' @ ' + jd.company : ''}` +
        `${jd.salary ? ' · ' + jd.salary : ''}${jd.city ? ' · ' + jd.city : ''}` +
        `${jd.experience ? ' · ' + jd.experience : ''}${jd.education ? ' · ' + jd.education : ''}`;
      kind = 'job';
      break;
    }
    case 12: {
      // 附件（简历 PDF 等）
      let name = '';
      let ej: any = {};
      try {
        ej = JSON.parse(body.hyperLink?.extraJson ?? '{}');
        name = ej.resumeName || ej.fileName || ej.name || '';
        if (!name && typeof ej.resumePreviewH5Url === 'string') {
          const m = ej.resumePreviewH5Url.match(/resumeName=([^&]+)/);
          if (m) name = decodeURIComponent(m[1]);
        }
      } catch {
        /* ignore */
      }
      // 这份附件是我的简历 → 是我发起的投递/交换请求（服务端却把 from 记成对方）
      // 注意 resumeId 不在 extraJson 顶层，藏在 resumeNewUrl / resumePreviewH5Url 里，
      // 而且整个 url 是 URL 编码的（resumeId%3D...），得先解码再匹配
      const pickResumeId = (u: any): string | undefined => {
        if (typeof u !== 'string') return undefined;
        const dec = (() => {
          try {
            return decodeURIComponent(u);
          } catch {
            return u;
          }
        })();
        return dec.match(/resumeId=([^&?]+)/)?.[1];
      };
      const rid =
        ej.resumeId ??
        pickResumeId(ej.resumeNewUrl) ??
        pickResumeId(ej.resumePreviewH5Url) ??
        pickResumeId(ej.resumeUrl);
      if (rid && myResumeIds && myResumeIds.has(String(rid))) {
        fromKind = 'me';
      }
      text = name ? `[附件] ${name}` : '[附件]';
      kind = 'attachment';
      break;
    }
    case 16: {
      // 打招呼文章
      const a = Array.isArray(body.articles) ? body.articles[0] : null;
      text = a ? `[文章] ${a.title ?? ''}${a.description ? ' — ' + a.description : ''}` : '[文章]';
      kind = 'article';
      break;
    }
    default: {
      text = pickStr(body, ['text', 'extend', 'content']) ?? JSON.stringify(body).slice(0, 120);
      kind = bodyType ? `type${bodyType}` : 'text';
    }
  }

  return {
    mid,
    from: fromKind,
    text,
    time,
    type: kind,
    fromName: fromName ?? undefined,
    raw,
  };
}

/**
 * 这条消息算不算「我投出去的简历」？
 *
 * 判据（实测过）：
 *   - 附件消息（body.type = 12）
 *   - 正文里出现「简历」
 *   - 投递动作卡（aid 38 = 我投递了简历，40 = 附件简历）
 *
 * 手动投递脚本（deliver-chat.ts）和常驻守护进程（auto-deliver.ts）都用这一份 ——
 * 两边的「算不算投出去了」要是各写各的，守护进程就会对同一个 HR 重复投递。
 */
export function isResumeMessage(m: ChatMessage): boolean {
  const aid = Number((m.raw as any)?.body?.action?.aid);
  return m.type === 'attachment' || String(m.text).includes('简历') || aid === 38 || aid === 40;
}

/**
 * 拉某个会话的聊天记录。
 * 参数名尚未实测，依次尝试几种常见组合，取第一个成功的。
 */
export async function listMessages(
  client: BossClient,
  session: ChatSession,
  opt: { limit?: number } = {},
): Promise<ChatMessage[]> {
  const limit = opt.limit ?? 50;

  // 先拿到「我的简历 id 集合」，用于判断附件简历消息是谁发的
  await ensureMyResumes(client);

  // 实测有效形态：bossId = 会话列表里的 encryptFriendId
  const query = session.encryptBossId ? { bossId: session.encryptBossId } : {};

  try {
    const res: any = await client.request(HISTORY_PATH, { method: 'GET', query });
    const data = res?.zpData ?? res;
    const list: any[] =
      data?.messages ?? data?.result ?? data?.list ?? (Array.isArray(data) ? data : []);
    return list
      .map((m, i) => parseMessage(m, i, myUid))
      .filter((m): m is ChatMessage => !!m)
      .slice(-limit);
  } catch (e) {
    const code = (e as any)?.code;
    throw new Error(
      `拉取聊天记录失败（code=${code ?? '?'}）：${(e as Error).message}`,
    );
  }
}

/** HR 档案 */
export async function getBossProfile(client: BossClient, session: ChatSession): Promise<any> {
  const res: any = await client.request(BOSS_DATA_PATH, {
    method: 'GET',
    query: {
      bossId: session.encryptBossId,
      securityId: session.securityId,
    },
  });
  return res?.zpData ?? res;
}
