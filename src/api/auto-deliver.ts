/**
 * 自动投递 —— 「新招呼」里带红点的会话，自动发一份附件简历。
 *
 * 为什么要有这个模块：
 *   「投递简历」在 BOSS 上**没有可用的 HTTP 接口**（onekeydeliver 对猎头岗位返回
 *   code=1，exchange/videoResume/accept 返回 code=1049），本质上就是发一条聊天消息
 *   （走 MQTT）。所以只能让浏览器自己点：
 *       点会话 → 点「发简历」→ 弹窗点「确定」
 *   而这三步必须共享同一个页面上下文，桥接任务又有 20 秒硬上限 ——
 *   所以整条链放在页面里一次跑完（见 extension/background.js 的 pageGreetingTask）。
 *
 * 这个模块是**纯逻辑**：不打印、不退出进程。所有中止都通过返回值表达，
 * 因为常驻进程里 process.exit 会把整个轮询循环干掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BossClient } from './client.js';
import { runPageFn } from './page-transport.js';
import {
  isResumeMessage,
  listMessages,
  listSessions,
  probeLogin,
  requireLogin,
  type ChatSession,
} from './messages.js';
import { sleep } from './util.js';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const STATE_FILE = path.join(DATA_DIR, 'auto-deliver-state.json');

/** 同名 HR 的去重窗口：同一个人 + 同一个职位，12 小时内不重复投 */
export const DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * 状态文件里记录保留多久。
 *
 * 跟去重窗口是两回事：去重只看 12 小时内（buildExclude / recentlyHandled 都按那个算），
 * 但「投过谁」的记录本身是要留给人看的 —— 所以留一个月，
 * 一个月之后清掉，文件才不会无限涨。
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------------- 本地状态 ---------------- */

export interface AutoRecord {
  name: string;
  job?: string;
  company?: string;
  at: number;
  status: string;
  reason?: string;
}

export interface AutoState {
  version: number;
  sent: Record<string, AutoRecord>;
  failed: Record<string, AutoRecord>;
  stats: { day: string; sentToday: number; rounds: number; lastRoundAt?: number };
}

function emptyState(): AutoState {
  const today = new Date().toISOString().slice(0, 10);
  return { version: 1, sent: {}, failed: {}, stats: { day: today, sentToday: 0, rounds: 0 } };
}

export function loadState(): AutoState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw) as AutoState;
    if (!s || typeof s !== 'object') return emptyState();
    s.sent ??= {};
    s.failed ??= {};
    s.stats ??= { day: new Date().toISOString().slice(0, 10), sentToday: 0, rounds: 0 };
    return s;
  } catch {
    return emptyState();
  }
}

export function saveState(state: AutoState): void {
  try {
    // 窗口外的记录留着也没用（排除名单只看窗口内）—— 顺手裁掉，文件才不会无限涨
    prune(state);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    // 状态写不进去不该让整个进程挂掉 —— 顶多下一轮会重复投递
    console.error('[auto-deliver] 状态文件写入失败：' + (e as Error).message);
  }
}

/** 裁掉保留期以外的记录（统计数字在 stats 里，不受影响） */
function prune(state: AutoState): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const bag of [state.sent, state.failed]) {
    for (const [k, rec] of Object.entries(bag)) {
      if (!rec || (rec.at ?? 0) < cutoff) delete bag[k];
    }
  }
}

/** 去重键：优先用 HTTP 侧的 friendId，退化成「姓名::职位」 */
export function stateKey(name: string, job?: string, friendId?: string): string {
  if (friendId) return `id:${friendId}`;
  return `n:${String(name || '').trim()}::${String(job || '').trim()}`;
}

/** 这个会话最近投过吗（防止红点没消掉时重复投） */
export function recentlyHandled(state: AutoState, key: string, name?: string): boolean {
  const rec = state.sent[key] ?? state.failed[key];
  if (rec && Date.now() - rec.at < DEDUP_WINDOW_MS) return true;
  if (!name) return false;
  // 兜底：老记录可能是「姓名::」这种没有 friendId 的键（页面侧读不到 id）。
  // 只有「同名只有一个、且那条记录没有公司名」时才敢认 ——
  // 同名多人的时候宁可不认，也不能把另一个人算成「已经投过」。
  const same = [...Object.values(state.sent), ...Object.values(state.failed)].filter(
    (r) => r?.name === name,
  );
  if (same.length !== 1) return false;
  const r = same[0]!;
  return !r.company && Date.now() - (r.at ?? 0) < DEDUP_WINDOW_MS;
}

/* ---------------- 页面侧动作 ---------------- */

export interface ExcludeEntry {
  name: string;
  /** 公司名 —— 用它区分同名 HR（行文本里就是「名字+公司+HR职位」） */
  company?: string;
}

export interface DeliverOutcome {
  /** 这一步是否走通了（sent = 简历已发起投递） */
  ok: boolean;
  /** 没有更多红点了 —— 整轮可以结束 */
  done?: boolean;
  /** 失败卡在哪一步：conv-mismatch / no-resume-btn / no-panel / no-sure-btn / … */
  step?: string;
  /** 目标 HR 的名字 */
  name?: string;
  /** 失败现场（会话头文本、弹窗文本…） */
  detail?: string;
  /** 打开的会话头部文本 */
  conv?: string;
  /** 红点上的未读条数 */
  badge?: number;
  /** 投完之后回读到的最近几条消息（排查用） */
  messages?: string[];
  /**
   * 结果不确定（任务超时，可能已经发出去了）。
   * 这种要用服务端确认来判定，不能当成失败重投。
   */
  uncertain?: boolean;
  /** 失败时的建议文案 */
  reason?: string;
}

const STEP_REASON: Record<string, string> = {
  'no-tab': '页面上找不到「新招呼」tab（BOSS 改版了？）',
  'list-not-ready': '会话列表还没渲染出来',
  'row-name-unknown': '这一行读不出 HR 名字，不敢认人',
  'row-missing': '会话行在点击前消失了',
  'conv-mismatch': '打开的会话和目标对不上（可能同名 HR），已停手',
  'no-resume-btn': '聊天工具栏里没有「发简历」按钮（对方可能不支持）',
  'no-panel': '没弹出简历确认框',
  'no-sure-btn': '弹窗里找不到「确定」按钮',
  'unknown-mode': '未知的页面任务模式',
};

/**
 * 每一步之后，Node 侧要等多久页面才渲染好（毫秒）。
 *
 * 只有「点了按钮、页面要重新渲染」的那几步才需要等；
 * 读一读的步骤（核对会话头、读弹窗）不用等。
 */
const STEP_WAIT = {
  'switch-tab': 1200,
  'open': 1600,
  'send-resume': 2000,
  'confirm': 2500,
} as const;

/** 调一次页面函数（url / 超时都用 runPageFn 的默认值，这里只给守恒进程专属的两项） */
async function call(mode: string, extra: Record<string, any> = {}): Promise<any> {
  return runPageFn('greeting', { mode, ...extra }, { pin: true, own: true });
}

/**
 * 切到「新招呼」tab，必要时等列表重载。
 *
 * 页面会报 alreadyOn（已经在「新招呼」上了）—— 切 tab 会触发列表重载，
 * 没切就等纯属白等。deliverNext 和 scanGreetings 都要走这一步，收在一处。
 */
async function switchAndSettle(): Promise<{ ok: boolean; sw: any }> {
  const sw = await call('switch-tab');
  if (!sw?.ok) return { ok: false, sw };
  if (!sw.alreadyOn) await sleep(STEP_WAIT['switch-tab']);
  return { ok: true, sw };
}

/**
 * 投掉**一个**带红点的新招呼。
 *
 * 分成好几步做，每步一次桥接任务：
 *   ① 切「新招呼」tab → ② 找到带红点的行并点开 → ③ 核对会话头
 *   → ④ 点「发简历」→ ⑤ 核对弹窗 → ⑥ 点「确定」→ ⑦ 回读消息
 *
 * 为什么不用「一次调用跑完整条链」：
 *   页面里只要有 await(sleep)，而守护进程用的是**后台标签页** ——
 *   Chrome 会限流甚至冻结后台页的定时器，定时器不触发就永远挂着，
 *   桥接任务必然 20 秒超时（实测踩过：简历发出去了，但任务超时，状态没记上）。
 *   把等待全挪到 Node 侧（Node 的定时器不会被限流），每步都很快。
 *
 * 认错人就在第③步停手，不会点「确定」。
 */
export async function deliverNext(opts: { exclude?: ExcludeEntry[]; pick?: string } = {}): Promise<DeliverOutcome> {
  const out: DeliverOutcome = { ok: false };

  /** 失败收口：六个失败分支原来各写一遍这三行 */
  const fail = (step: string, detail?: string): DeliverOutcome => {
    out.ok = false;
    out.step = step;
    out.reason = STEP_REASON[step] ?? step;
    if (detail !== undefined) out.detail = detail;
    return out;
  };

  // ① 切到「新招呼」tab（列表没渲染出来就重试）
  let opened: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await switchAndSettle();
      if (!r.ok) {
        return fail(r.sw?.step ?? 'no-tab');
      }
      opened = await call('open', { exclude: opts.exclude ?? [], pick: opts.pick });
      if (opened?.step !== 'list-not-ready') break;
    } catch (e) {
      out.step = 'timeout';
      out.reason = (e as Error).message;
      out.uncertain = true; // 可能已经发出去了，交给上层用服务端确认来判
      return out;
    }
  }

  if (opened?.done) {
    out.ok = true;
    out.done = true;
    out.step = 'done';
    out.detail = opened?.detail;
    return out;
  }
  if (!opened?.ok) {
    out.name = opened?.name;
    return fail(opened?.step ?? 'open-failed', opened?.detail);
  }
  out.name = opened.name;
  out.badge = opened.badge;
  await sleep(STEP_WAIT['open']);

  // ③ 核对会话头 —— 名字对不上就停手，不点「确定」
  const conv = await call('verify-conv');
  const convText = String(conv?.conv ?? '');
  if (!convText.includes(String(out.name))) {
    return fail('conv-mismatch', convText.slice(0, 160));
  }
  out.conv = convText.slice(0, 200);

  // ④ 点「发简历」
  const sr = await call('send-resume');
  if (!sr?.ok) {
    return fail(sr?.step ?? 'no-resume-btn');
  }
  await sleep(STEP_WAIT['send-resume']);

  // ⑤ 核对确认弹窗
  const cp = await call('check-panel');
  if (!cp?.hasPanel) {
    return fail('no-panel', String(cp?.panel ?? '').slice(0, 160));
  }

  // ⑥ 点「确定」—— 这一步才真的发起投递
  const cf = await call('confirm');
  if (!cf?.ok) {
    return fail(cf?.step ?? 'no-sure-btn');
  }
  await sleep(STEP_WAIT['confirm']);

  // ⑦ 回读消息 —— 服务端确认之外，页面这边也留一份现场（确认失败时有用）
  const rm = await call('read-messages');
  out.messages = rm?.messages ?? [];
  out.ok = true;
  out.step = 'sent';
  return out;
}

/**
 * 只扫描不动作：列出「新招呼」tab 里所有带红点的会话。
 *
 * 两个「等」：
 *   ① 等页面就绪 —— 消息页是 SPA，HTML 加载完不等于聊天界面有了。
 *      冷启动（守护进程刚开、标签页刚建）时能等好几秒。
 *      用「聊天界面在不在」判断，而不是「有没有会话行」——
 *      列表真的空了的时候不该一直等。
 *   ② 等红点推下来 —— 未读数是前端从 MQTT 收到后自己算的，
 *      列表先出来、红点后到。冷启动时多等一会儿复查一次。
 *
 * 等待全在 Node 侧（Node 的定时器不会被浏览器限流）。
 */
export async function scanGreetings(): Promise<{
  rowCount: number;
  badges: { idx: number; badge: number; name: string; lines: string[]; text: string }[];
}> {
  let last: any = null;
  /** 第一次成功切 tab 时页面是否已在「新招呼」上 —— false = 冷启动（页面是新开的） */
  let firstAlreadyOn: boolean | null = null;
  const deadline = Date.now() + 30_000;

  // ① 等页面就绪
  while (Date.now() < deadline) {
    try {
      const r = await switchAndSettle();
      if (r.ok) {
        if (firstAlreadyOn === null) firstAlreadyOn = !!r.sw.alreadyOn;
        last = await call('scan');
      }
      // 「聊天界面在不在」—— 不是「有没有会话行」。
      // 列表真的空了的时候不该一直等。
      if (last?.ready) break;
    } catch {
      /* ignore */
    }
    await sleep(1500);
  }

  // ② 冷启动时红点可能比列表晚到（列表先渲染、红点是 MQTT 后推的）—— 复查一次。
  //    只在冷启动做：常驻固定页上 MQTT 一直连着，列表和红点本来就是同步的，
  //    每个空闲轮都等 3 秒再扫一遍纯属白等（30 秒轮询下占空比翻了四倍）。
  if (firstAlreadyOn === false && (last?.rowCount ?? 0) > 0 && !(last?.badges ?? []).length) {
    await sleep(3000);
    try {
      const again = await call('scan');
      if (again) last = again;
    } catch {
      /* ignore */
    }
  }

  return {
    rowCount: last?.rowCount ?? 0,
    badges: last?.badges ?? [],
  };
}

/**
 * 这个会话在排除名单里吗？
 *
 * 页面侧有一份同样的判断（extension/background.js 的 isExcluded）——
 * 这份是 Node 侧的镜像，用来在**干跑预览**时算出「这一轮到底会投给谁」，
 * 两边必须一致，否则干跑名单和实际投递名单会对不上。
 */
export function isExcludedEntry(
  entry: { name?: string; text?: string },
  exclude: ExcludeEntry[],
): boolean {
  if (!entry?.name) return false;
  return exclude.some((ex) => {
    if (!ex || !ex.name || ex.name !== entry.name) return false;
    // 行文本里就是「名字+公司+HR职位」，公司名对不上就不是同一个人
    if (ex.company && entry.text && !entry.text.includes(ex.company)) return false;
    return true;
  });
}

/* ---------------- HTTP 侧确认 ---------------- */

/** 拉一遍会话列表（labelId=0 的列表项本来就带 name/jobName/friendId，不用补详情） */
export async function fetchSessions(client: BossClient): Promise<ChatSession[]> {
  return listSessions(client, { labelId: 0, enrich: 'none' });
}

/**
 * 服务端确认：这个会话里真的有「我发的简历」。
 *
 * 判据见 messages.ts 的 isResumeMessage（手动投递脚本和守护进程共用一份，
 * 两边的「算不算投出去了」必须一致）。
 * 同名 HR 会挨个查 —— 只要有一个命中就算数。
 */
export async function verifyDelivered(
  client: BossClient,
  name: string,
  sessions?: ChatSession[],
): Promise<boolean> {
  const list = sessions ?? (await listSessions(client, { labelId: 0, enrich: 'none' }));
  const cands = list.filter((s) => s.name === name);
  for (const s of cands) {
    try {
      const msgs = await listMessages(client, s, { limit: 10 });
      if (msgs.some(isResumeMessage)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * 用 HTTP 会话列表反查这个 HR 的 friendId / 职位。
 *
 * 为什么要反查：页面侧拿到的 uniqueId 依赖前端 store（读不到就是空），
 * 而 HTTP 的会话列表（labelId=0）带 jobName 和 friendId ——
 * 用「姓名 + 职位」匹配，能在同名 HR 里精确锁定对的那一个
 * （同一个账号里可能有好几个同名的 HR）。
 */
export function resolveSession(
  sessions: ChatSession[],
  name: string,
  conv?: string,
): { friendId?: string; job?: string; brandName?: string } | null {
  const cands = sessions.filter((s) => s.name === name);
  if (!cands.length) return null;
  if (cands.length === 1) {
    const s = cands[0];
    return { friendId: s.friendId, job: s.jobName, brandName: s.brandName };
  }
  // 同名：会话头里出现了哪个职位，就选那个
  const withJob = cands.filter((s) => s.jobName && conv && conv.includes(s.jobName));
  const pick = withJob[0] ?? cands[0];
  return { friendId: pick.friendId, job: pick.jobName, brandName: pick.brandName };
}

/** 探登录态（失败时抛带排查清单的错误） */
export async function ensureLogin(client: BossClient): Promise<{ uid?: number }> {
  const p = requireLogin(await probeLogin(client));
  return { uid: (p.user as any)?.userId };
}
