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
import { runPageFnFull, reloadTab } from './page-transport.js';
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
  /** 失败卡在哪一步：conv-not-open / no-resume-btn / no-panel / no-sure-btn / … */
  step?: string;
  /** 目标 HR 的名字（会话头上读到的为准） */
  name?: string;
  /** 点开的那一行上写的名字（跟 name 对不上说明点歪了，仅作日志用，不拦） */
  clickedName?: string;
  /** 失败现场（会话头文本、弹窗文本…） */
  detail?: string;
  /** 简历确认弹窗的文本 */
  panel?: string;
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
  /**
   * **可能已经投出去了**（点了「发简历」但确认弹窗没出现）。
   *
   * BOSS 有两种投递形态：弹确认框让你点「确定」；或者**直接就发了**。
   * 后者没有弹窗可等 —— 只能靠服务端确认来判断到底成没成。
   */
  maybeSent?: boolean;
  /** 点了「发简历」的时刻（服务端确认的时间下界） */
  sentAt?: number;
  /** 失败时的建议文案 */
  reason?: string;
}

const STEP_REASON: Record<string, string> = {
  'no-tab': '页面上找不到「新招呼」tab（BOSS 改版了？）',
  'list-not-ready': '会话列表还没渲染出来',
  'list-empty': '会话列表是空的',
  'row-name-unknown': '这一行读不出 HR 名字，不敢认人',
  'row-missing': '会话行在点击前消失了',
  'conv-not-open': '点了会话但它没打开（页面可能还没准备好）',
  'no-resume-btn': '聊天工具栏里没有「发简历」按钮（对方可能不支持）',
  'not-seen': '点了「发简历」，但会话里一直没出现附件简历',
  'not-seen-after-confirm': '点了确定，但会话里一直没出现附件简历',
  'no-sure-btn': '弹窗里找不到「确定」按钮',
  'unknown-mode': '未知的页面任务模式',
};

/**
 * 轮询节奏与上限。
 *
 * ⚠️ **这里只有「多久算超时」，没有「要等多久」**。
 * 每一步等的是**状态**（会话打开了？弹窗出现了？列表切过去了？），
 * 不是猜一个时长 —— 网络慢的时候等待自动变长，快的时候自动变短。
 * 固定 sleep 在弱网下会把节奏全搞乱（实测 1600ms 硬等 → 会话没打开就被误判）。
 */
const POLL_MS = 350;
/** 各步的超时上限（只作兜底，正常情况下都由状态判定提前结束） */
const TIMEOUT_CONV_OPEN = 15_000;
const TIMEOUT_PANEL = 12_000;
const TIMEOUT_LIST = 20_000;

/**
 * 当前用的那个标签页（守护进程固定的那个）。
 *
 * 记它是为了「页面卡住了要重载」时知道重载谁 —— 页面里拿不到自己的 tabId，
 * 只能从扩展回传的结果里拿。
 */
let currentTabId: number | null = null;

/** 调一次页面函数（url / 超时都用 runPageFn 的默认值，这里只给守恒进程专属的两项） */
async function call(mode: string, extra: Record<string, any> = {}): Promise<any> {
  const r = await runPageFnFull('greeting', { mode, ...extra }, { pin: true, own: true });
  if (r.tabId) currentTabId = r.tabId;
  return r.data;
}

/**
 * 等「会话真的打开了」。
 *
 * 为什么不能死等一个固定时长：会话要拉消息历史，冷页面可能要好几秒
 * （实测 8 秒）。之前固定等 1600ms → 会话还没打开 → 被误判成「同名 HR 对不上」
 * → 招呼被白白跳过（一晚上 5 个招呼一个没投出去）。
 *
 * 也不拿名字跟点开的行比对 —— 红点只出现在一行上，点哪行就是哪个人，
 * 没有认错的余地；拿名字卡反而会误伤。
 */
async function waitConvOpen(): Promise<{ open: boolean; name: string; text: string }> {
  const deadline = Date.now() + TIMEOUT_CONV_OPEN;
  let last = { open: false, name: '', text: '' };
  for (;;) {
    try {
      const v = await call('verify-conv');
      last = { open: !!v?.open, name: String(v?.name ?? ''), text: String(v?.conv ?? '') };
      if (last.open) return last;
    } catch {
      /* 页面还没准备好 → 继续等 */
    }
    if (Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

/** 等弹窗关闭（点完「确定」之后弹窗会消失，说明这一步真的走了） */
async function waitPanelClosed(): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_PANEL;
  for (;;) {
    try {
      const p = await call('check-panel');
      if (p && p.hasPanel === false) return true;
    } catch {
      /* 继续等 */
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * 切到「新招呼」tab。
 *
 * **不在这儿等列表重载** —— 切完 tab 页面要去重新拉接口，耗时完全看网络，
 * 猜一个时长必然错位。改成由 `open` 模式报「还没切过去 / 列表还是空的」，
 * 这里轮询重试，等的是状态不是时间。
 */
async function switchAndSettle(): Promise<{ ok: boolean; sw: any }> {
  const sw = await call('switch-tab');
  if (!sw?.ok) return { ok: false, sw };
  return { ok: true, sw };
}

/**
 * 投掉**一个**带红点的新招呼。
 *
 * 分成好几步做，每步一次桥接任务：
 *   ① 切「新招呼」tab → ② 找到带红点的行并点开 → ③ 等会话真的打开
 *   → ④ 点「发简历」→ ⑤ 核对弹窗 → ⑥ 点「确定」→ ⑦ 回读消息
 *
 * 为什么不用「一次调用跑完整条链」：
 *   页面里只要有 await(sleep)，而守护进程用的是**后台标签页** ——
 *   Chrome 会限流甚至冻结后台页的定时器，定时器不触发就永远挂着，
 *   桥接任务必然 20 秒超时（实测踩过：简历发出去了，但任务超时，状态没记上）。
 *   把等待全挪到 Node 侧（Node 的定时器不会被限流），每步都很快。
 *
 * 第③步**不比对名字**：红点只出现在一行上，点哪行就是哪个人，
 * 没有认错的余地；拿名字卡反而会误伤（实测一晚上 5 个招呼一个没投出去）。
 * 只等「会话真的打开了」这个事实。
 */
export async function deliverNext(
  opts: {
    exclude?: ExcludeEntry[];
    pick?: string;
    /**
     * 服务端确认：这个 HR 的会话里到底有没有简历。
     *
     * 用来识别「点「发简历」但没有确认弹窗、直接就发了」那种形态 ——
     * 没有它就只能干等弹窗，最后把成功的投递误判成失败。
     *
     * sinceAt 是点了「发简历」的时刻 —— 只认那之后出现的简历消息。
     */
    verify?: (name: string, sinceAt: number) => Promise<boolean>;
  } = {},
): Promise<DeliverOutcome> {
  const out: DeliverOutcome = { ok: false };

  /** 失败收口：六个失败分支原来各写一遍这三行 */
  const fail = (step: string, detail?: string): DeliverOutcome => {
    out.ok = false;
    out.step = step;
    out.reason = STEP_REASON[step] ?? step;
    if (detail !== undefined) out.detail = detail;
    return out;
  };

  // ① 切到「新招呼」tab，找到带红点的行并点开
  //
  //    这里等的是**状态**不是时间：
  //      · not-on-tab → tab 还没切过去（页面在重新渲染）
  //      · list-empty → 列表还是空的（接口还没回来 / 重渲染中）
  //    两种都重试；重试到上限还是空 → 真的没红点了。
  //    （列表重渲染的那一瞬间正好是 0 行，这时候判「收工」会把后面
  //      还没投的人整个跳过 —— 实测一晚上 5 个招呼只试了 3 个。）
  let opened: any = null;
  let emptyTries = 0;
  const deadline = Date.now() + TIMEOUT_LIST;
  for (;;) {
    try {
      const r = await switchAndSettle();
      if (!r.ok) {
        // 页面还没渲染出 tab 栏 → 等一下再试（页面可能刚打开）
        if (r.sw?.step === 'no-tab') {
          await sleep(POLL_MS);
          continue;
        }
        return fail(r.sw?.step ?? 'no-tab');
      }
      opened = await call('open', { exclude: opts.exclude ?? [], pick: opts.pick });
      if (opened?.step === 'not-on-tab' || opened?.step === 'list-empty') {
        emptyTries++;
        if (emptyTries >= 3 && Date.now() >= deadline) {
          // 重试到上限还是空 → 真的没红点了
          out.ok = true;
          out.done = true;
          out.step = 'done';
          out.detail = '没有带红点的会话了';
          return out;
        }
        await sleep(POLL_MS);
        continue;
      }
      break;
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
  out.clickedName = opened.name;
  out.badge = opened.badge;

  // ③ 等会话真的打开（不靠名字比对 —— 红点只在一行上，点哪行就是哪个人）
  const conv = await waitConvOpen();
  if (!conv.open) {
    // 点了但没打开 —— 不重试这个（红点可能已经消了），交给上层跳到下一个
    out.name = conv.name || out.name;
    out.conv = conv.text.slice(0, 200);
    return fail('conv-not-open', conv.text.slice(0, 160));
  }
  out.conv = conv.text.slice(0, 200);
  // 会话头上的人名才是准的（列表行里的名字可能同名）
  if (conv.name) out.name = conv.name;

  // ④ 点「发简历」，然后等「投递真的发生了」
  //
  //    BOSS 有两种投递形态：
  //      A. 弹确认框 → 点「确定」才真的发
  //      B. **直接就发了**，没有弹窗（实测 2026-11-15 12:34 对「何女士（SHEIN）」）
  //
  //    两种形态的**共同结果**是：会话里出现「附件简历」消息。
  //    所以判据取这个**页面状态**，而不是「弹窗出来没有」——
  //    既不用猜弹窗，也不会把「弹窗没出现但投出去了」误判成失败。
  //
  //    ⚠️ 等待期间只做「读状态」和「点确定」，不按固定时长猜什么该发生。
  const sr = await call('send-resume');
  if (!sr?.ok) {
    return fail(sr?.step ?? 'no-resume-btn');
  }
  // 点了「发简历」的时刻 —— 服务端确认时用它当时间下界
  // （只认这之后出现的简历消息，免得 HR 自己发过附件简历被误判）
  out.sentAt = Date.now();

  const sendDeadline = Date.now() + TIMEOUT_PANEL;
  let confirmed = false;
  let delivered = false;
  let panelText = '';
  for (;;) {
    // ① 确认框出现了？→ 点「确定」（形态 A）
    if (!confirmed) {
      try {
        const p = await call('check-panel');
        if (p?.hasPanel) {
          panelText = String(p?.panel ?? '');
          const cf = await call('confirm');
          if (cf?.ok) {
            confirmed = true;
            out.panel = panelText.slice(0, 200);
          }
        }
      } catch {
        /* 页面没准备好 → 继续等 */
      }
    }

    // ② 会话里出现「附件简历」？→ 投递真的发生了（A/B 两种形态都适用）
    try {
      const d = await call('check-resume-sent');
      if (d?.delivered) {
        delivered = true;
        out.messages = d?.messages ?? [];
        break;
      }
    } catch {
      /* 页面没准备好 → 继续等 */
    }

    if (Date.now() >= sendDeadline) break;
    await sleep(POLL_MS);
  }

  if (delivered) {
    out.ok = true;
    out.step = 'sent';
    out.detail = confirmed ? '弹窗确认后投递成功' : '没有确认框，直接投递成功';
    return out;
  }

  // 到这一步页面上还没看到简历 —— 可能只是慢。
  // 交给上层用服务端确认兜底（那边会一直查到截止时刻，不是试几次就放弃）。
  out.maybeSent = true;
  return fail(confirmed ? 'not-seen-after-confirm' : 'not-seen', panelText.slice(0, 160));
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
  /** 页面是不是卡住了（列表请求压根没发出去）—— 守护进程据此重载页面 */
  stuck?: boolean;
}> {
  let last: any = null;
  /** 第一次成功切 tab 时页面是否已在「新招呼」上 —— false = 冷启动（页面是新开的） */
  let firstAlreadyOn: boolean | null = null;
  /** 这次切 tab 有没有真的点（点了 → 列表要去重新拉接口，要等它回来） */
  let needsRefresh: boolean | null = null;
  const deadline = Date.now() + 30_000;

  // ① 等页面就绪 + 列表真的到货
  while (Date.now() < deadline) {
    try {
      const r = await switchAndSettle();
      if (r.ok) {
        if (firstAlreadyOn === null) firstAlreadyOn = !!r.sw.alreadyOn;
        if (needsRefresh === null) needsRefresh = !r.sw.alreadyOn;
        last = await call('scan');
      }
      // 就绪 = 聊天界面挂上了 **且**（没切 tab，或切 tab 之后的列表接口已经回来）
      // 只看界面会漏：界面先挂上、列表后到（弱网时差好几秒）→ 误判成「没有新招呼」
      if (last?.ready && (!needsRefresh || last?.listFresh)) break;
    } catch {
      /* ignore */
    }
    await sleep(POLL_MS);
  }

  // ② **页面卡住了？** —— 「0 行」有两种完全不同的含义：
  //    a) 新招呼 tab 真的没有会话（正常）
  //    b) 页面压根没发出列表请求，卡在初始化之前（后台标签页被限流时会这样）
  //    判据是**有没有发过列表请求**（performance 里的 geekFilterByLabel），
  //    不是靠等多久来猜。b) 的表现是守护进程一直扫 0 行、静默停摆。
  const stuck = (last?.rowCount ?? 0) === 0 && last?.listRequested === false;
  if (stuck) {
    // 重载页面 → 初始化重跑一遍 → 再扫
    await reloadTab(currentTabId ?? 0).catch(() => {});
    await sleep(1500);
    try {
      last = await call('scan');
    } catch {
      /* ignore */
    }
  }

  // ③ 冷启动时红点可能比列表晚到（红点是 MQTT 后推的）——
  //    轮询到**真的出现红点**为止（不是「等 3 秒再看一眼」）。
  //    只在冷启动做：常驻固定页上 MQTT 一直连着，列表和红点本来就是同步的。
  if (firstAlreadyOn === false && (last?.rowCount ?? 0) > 0 && !(last?.badges ?? []).length) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      try {
        const again = await call('scan');
        if (again?.badges?.length) {
          last = again;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    rowCount: last?.rowCount ?? 0,
    badges: last?.badges ?? [],
    stuck,
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
 *
 * sinceAt：**只认这个时刻之后的消息**。
 *   没有它会误判 —— 有些 HR 自己会发附件简历，那也是「简历类消息」，
 *   但不是我们投的。加上时间下界，只认「我们点了发简历之后」出现的。
 */
export async function verifyDelivered(
  client: BossClient,
  name: string,
  sessions?: ChatSession[],
  sinceAt?: number,
): Promise<boolean> {
  const list = sessions ?? (await listSessions(client, { labelId: 0, enrich: 'none' }));
  const cands = list.filter((s) => s.name === name);
  for (const s of cands) {
    try {
      const msgs = await listMessages(client, s, { limit: 10 });
      const fresh = sinceAt
        ? msgs.filter((m) => (m.time ?? 0) >= sinceAt - 5000)
        : msgs;
      if (fresh.some(isResumeMessage)) return true;
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
