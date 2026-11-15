/**
 * 主动打招呼 —— 给一个岗位的 HR 发一条定制开场白。
 *
 * 链路（每一步都是一次独立的桥接任务，页面侧只做同步的读/点）：
 *   ① 打开**岗位详情页** → 点「立即沟通」→ 弹出「打招呼」弹窗
 *   ② 等弹窗真的打开（判据：body 上有 dialog-open + 有「发送」按钮）
 *   ③ 把开场白写进 textarea.input-area → 等「发送」解禁 → 点发送
 *   ④ 验证：服务端会话里能看到这条消息（最可靠）
 *
 * ⚠️ **为什么走详情页而不是职位列表**：
 *   列表页 DOM 里只有推荐区那十几个卡片，搜索接口拿到的岗位不在那一页里
 *   （实测点「立即沟通」会报「列表里没有这个岗位」）。详情页对任何来源的岗位都能打开。
 *
 * ⚠️ **「打招呼」弹窗才是能写自定义文案的地方**：
 *   点「立即沟通」不会直接进聊天页，而是弹一个框：
 *     DIV.startchat-content > DIV.edit-area
 *         TEXTAREA.input-area   ← 自定义打招呼语
 *         DIV.send-message      ← 初始带 .disable，输入后才解禁
 *   在聊天页的输入框里写是没用的 —— 那个面板这时候根本没打开。
 *
 * ⚠️ **页面侧一律不等待** —— 跑在后台标签页里，
 *    Chrome 会限流甚至冻结后台页的定时器，await sleep() 会永远挂着，
 *    桥接任务必然 20 秒超时。所有等待都在 Node 侧。
 */
import { type Job } from './jobs.js';
import { listMessages, listSessions, type ChatSession } from './messages.js';
import type { BossClient } from './client.js';
import { closeTabs, runPageFn, runPageFnFull } from './page-transport.js';
import { sleep } from './util.js';

const POLL_MS = 400;
const TIMEOUT_DIALOG = 15_000;
const TIMEOUT_SEND = 12_000;
const TIMEOUT_CHAT = 25_000;

export interface GreetOutcome {
  ok: boolean;
  /** 卡在哪一步 */
  step?: string;
  detail?: string;
  /** 会话里对方/我方的名字 */
  convName?: string;
  /** 发出后回读到的消息 */
  messages?: string[];
}

const STEP_REASON: Record<string, string> = {
  'no-chat-btn': '岗位详情页上没有「立即沟通」按钮',
  'dialog-not-open': '点了「立即沟通」，但「打招呼」弹窗没打开',
  'no-input': '弹窗里没有自定义输入框',
  'still-disabled': '输入了内容，但「发送」按钮一直不解禁',
  'no-send': '弹窗里没有「发送」按钮',
  'not-sent': '点了发送，但服务端没查到这条消息',
};

/** 岗位详情页的地址 */
export function detailUrl(job: Job): string {
  const qs = new URLSearchParams({ securityId: job.securityId, lid: job.lid });
  return `https://www.zhipin.com/job_detail/${job.jobId}.html?${qs}`;
}

/**
 * 本进程开着的标签页（进程被强杀时用来收尾）。
 *
 * 为什么记着：打招呼流程用的是 keep=true 的标签页（要跨好几个任务用同一个），
 * 正常路径在 finally 里关掉了；**进程被 Ctrl+C / kill 时 finally 不会跑**，
 * 那些标签页就成了没人认领的孤儿 —— 攒多了又是标签页泄漏。
 */
const openTabs = new Set<number>();

/** 关掉本进程开着的所有标签页（退出时调） */
export async function cleanupGreetTabs(): Promise<number> {
  const ids = [...openTabs];
  openTabs.clear();
  if (!ids.length) return 0;
  return closeTabs(ids).catch(() => 0);
}

/** 等「打招呼」弹窗真的打开 */
async function waitDialog(tabId: number): Promise<{ ok: boolean; state?: any }> {
  const deadline = Date.now() + TIMEOUT_DIALOG;
  let last: any = null;
  for (;;) {
    try {
      const st = await runPageFn('greet', { mode: 'state' }, { tabId });
      last = st;
      if (st?.dialogOpen && st?.hasSend) return { ok: true, state: st };
    } catch {
      /* 页面还在跳转 → 继续等 */
    }
    if (Date.now() >= deadline) return { ok: false, state: last };
    await sleep(POLL_MS);
  }
}

/** 等聊天页的输入框**可见**（会话真的打开了） */
async function waitChatReady(tabId: number): Promise<{ ok: boolean; state?: any }> {
  const deadline = Date.now() + TIMEOUT_CHAT;
  let last: any = null;
  for (;;) {
    try {
      const st = await runPageFn('chat', { mode: 'state' }, { tabId });
      last = st;
      if (st?.boxVisible && st?.hasInput) return { ok: true, state: st };
    } catch {
      /* 可能正在跳转 → 继续等 */
    }
    if (Date.now() >= deadline) return { ok: false, state: last };
    await sleep(POLL_MS);
  }
}

/**
 * 给一个岗位的 HR 发一条消息。
 *
 * greeting 是大模型生成的开场白（已经截到 300 字符以内）。
 *
 * verify：发完之后怎么确认「真的发出去了」。
 *   服务端会话列表最可靠（页面 DOM 的消息列表选择器不可靠）；
 *   没有 verify 回调就只做页面侧的尽力确认。
 */
export async function greetOne(
  job: Job,
  greeting: string,
  verify?: (job: Job, greeting: string) => Promise<boolean>,
): Promise<GreetOutcome> {
  const out: GreetOutcome = { ok: false };
  let ownTabId: number | null = null;

  try {
    // ① 打开岗位详情页，点「立即沟通」（keep → 标签页留着，后面几步都用它）
    const clicked = await runPageFnFull(
      'detail',
      { mode: 'chat-click' },
      { own: true, url: detailUrl(job), keep: true, timeoutMs: 25_000 },
    );
    ownTabId = clicked.tabId;
    if (ownTabId) openTabs.add(ownTabId);
    if (!clicked.data?.ok) {
      out.step = clicked.data?.step ?? 'no-chat-btn';
      out.detail = clicked.data?.detail;
      return out;
    }

    // ② 分两条路：
    //    「继续沟通」= 已经聊过 → 点完直接进聊天页 → 在聊天输入框里发
    //    「立即沟通」= 第一次   → 点完弹「打招呼」弹窗 → 在弹窗里发
    const alreadyTalked = !!clicked.data?.alreadyTalked;

    if (alreadyTalked) {
      const ready = await waitChatReady(ownTabId!);
      if (!ready.ok) {
        out.step = 'chat-not-open';
        out.detail = '点了「继续沟通」，但聊天页的输入框没出现';
        return out;
      }
      out.convName = ready.state?.convName;

      const typed = await runPageFn('chat', { mode: 'type', text: greeting }, { tabId: ownTabId! });
      if (!typed?.ok) {
        out.step = typed?.step ?? 'no-input';
        out.detail = typed?.detail;
        return out;
      }
      if (!(await waitSubmitReady(ownTabId!))) {
        out.step = 'still-disabled';
        out.detail = '输入框里的内容没被页面认下（value 改了但 Vue 模型没更新）';
        return out;
      }
      const sent = await runPageFn('chat', { mode: 'submit' }, { tabId: ownTabId! });
      if (!sent?.ok) {
        out.step = sent?.step ?? 'no-submit';
        return out;
      }
    } else {
      const dlg = await waitDialog(ownTabId!);
      if (!dlg.ok) {
        out.step = 'dialog-not-open';
        out.detail = '点了「立即沟通」，弹窗没打开（页面可能还在跳转）';
        return out;
      }

      const typed = await runPageFn('greet', { mode: 'type', text: greeting }, { tabId: ownTabId! });
      if (!typed?.ok) {
        out.step = typed?.step ?? 'no-input';
        return out;
      }
      if (!(await waitSendReady(ownTabId!))) {
        out.step = 'still-disabled';
        out.detail = '输入框里的内容没被页面认下（value 改了但 Vue 模型没更新）';
        return out;
      }
      const sent = await runPageFn('greet', { mode: 'send' }, { tabId: ownTabId! });
      if (!sent?.ok) {
        out.step = sent?.step ?? 'no-send';
        return out;
      }
    }

    // ③ 验证
    if (verify) {
      const ok = await verify(job, greeting);
      if (!ok) {
        out.step = 'not-sent';
        out.detail = '服务端会话里没找到这条消息';
        return out;
      }
    }

    out.ok = true;
    out.step = 'sent';
    return out;
  } catch (e) {
    out.step = out.step ?? 'error';
    out.detail = (e as Error).message;
    return out;
  } finally {
    // 自己开的标签页用完要收掉（不然会攒出一堆页面）
    if (ownTabId) {
      openTabs.delete(ownTabId);
      await closeTabs([ownTabId]).catch(() => {});
    }
  }
}

/** 等「发送」解禁（有内容才解禁）—— 等状态，不等固定时长 */
async function waitSendReady(tabId: number): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_SEND;
  for (;;) {
    try {
      const st = await runPageFn('greet', { mode: 'state' }, { tabId });
      if (st?.sendReady) return true;
    } catch {
      /* ignore */
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** 等聊天页的「提交」解禁 */
async function waitSubmitReady(tabId: number): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_SEND;
  for (;;) {
    try {
      const st = await runPageFn('chat', { mode: 'state' }, { tabId });
      if (st?.submitReady) return true;
    } catch {
      /* ignore */
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

export { STEP_REASON };

/* ---------------- 服务端确认 ---------------- */

/**
 * 服务端确认：这个会话里真的有我刚发的那句话。
 *
 * 为什么用服务端而不是页面 DOM：
 *   页面上的消息列表选择器（.im-list .message-item）在不同版本的消息页里
 *   并不一致 —— 实测按它回读会得到「一条消息都没有」，而服务端明明有会话。
 *   服务端是唯一可靠的判据。
 *
 * 找会话：按「职位名 + HR 名字」匹配 —— 同一个账号里可能有多个同名 HR。
 */
export async function verifyGreeting(
  client: BossClient,
  job: Job,
  greeting: string,
  sessions?: ChatSession[],
): Promise<boolean> {
  let list: ChatSession[];
  try {
    list = sessions ?? (await listSessions(client, { labelId: 0, enrich: 'none' }));
  } catch {
    return false;
  }

  const cands = list.filter((s) => {
    const jobOk = !job.name || !s.jobName || s.jobName.includes(job.name) || job.name.includes(s.jobName);
    const nameOk = !job.bossName || !s.name || s.name === job.bossName;
    return jobOk && nameOk;
  });
  if (!cands.length) return false;

  const head = greeting.slice(0, 12);
  for (const s of cands) {
    try {
      const msgs = await listMessages(client, s, { limit: 10 });
      // ⚠️ **不能要求 from === 'me'**：服务端把「打招呼」这类消息记成对方发的
      //    （实测：发出去的招呼语在 historyMsg 里 from = peer）。
      //    所以只认「内容对得上」。
      if (msgs.some((m) => String(m.text ?? '').includes(head))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
