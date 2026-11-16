/** 主动打招呼 —— 在已打开的岗位详情页里给 HR 发一条开场白（流程见 typeAndSend）。 */
import { type Job } from './jobs.js';
import { listMessages, listSessions, type ChatSession } from './messages.js';
import type { BossClient } from './client.js';
import { runPageFn, runPageFnFull } from './page-transport.js';
import { sleep } from './util.js';

const POLL_MS = 400;

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

/** 岗位详情页的地址 */
export function detailUrl(job: Job): string {
  const qs = new URLSearchParams({ securityId: job.securityId, lid: job.lid });
  return `https://www.zhipin.com/job_detail/${job.jobId}.html?${qs}`;
}

/**
 * 一个岗位的详情页 —— 已经打开、JD 已经在页面里读好了。
 */
export interface JobPage {
  tabId: number;
  /** JD 正文（从页面读的，不走接口） */
  jd: string;
  /** 页面上读到的岗位名（verify 时以它为准） */
  name: string;
  /** 原始岗位 —— 服务端确认要 bossName 等完整身份，别用 `{name} as Job` 伪造 */
  job: Job;
}

/**
 * 打开岗位详情页，把 JD 从**页面里**读出来。
 *
 * 为什么不用 job/detail.json 接口：
 *   详情页本身就渲染了 JD（服务端直出），所以读页面 = 0 次接口请求。
 *   而接口请求是**最容易被风控卡住的**稀缺资源（实测热了以后 3 分钟才放行 1 个）。
 *   代价是慢一点（页面加载 3~8 秒 vs 接口 1.4 秒）。
 *
 * ⚠️ 页面上的文字和接口返回的一样带「kanzhun」反爬替换（BOSS 故意把词换成这个），
 *    两边质量一样，所以读页面不吃亏。
 */
export async function openJobPage(job: Job, reuseTabId?: number | null): Promise<JobPage> {
  const read = (opts: Record<string, unknown>) =>
    runPageFnFull('detail', { mode: 'read' }, { keep: true, timeoutMs: 30_000, ...opts });

  let r: { data: any; tabId: number | null };
  if (reuseTabId) {
    // 复用上一个岗位的标签页 → **整轮只开一个页面**，用户看不到一堆页面闪
    try {
      r = await read({ tabId: reuseTabId, goto: detailUrl(job) });
    } catch (e) {
      // 复用的 tab 可能已死（用户关掉/浏览器回收）—— 不降级的话这个僵尸 id
      // 会废掉本轮剩下所有岗位（实测过的静默报废链）。降级成新开一个。
      if (!/标签页不在了/.test((e as Error).message)) throw e;
      r = await read({ own: true, url: detailUrl(job) });
    }
  } else {
    r = await read({ own: true, url: detailUrl(job) });
  }
  const d = r.data ?? {};
  return {
    tabId: r.tabId!,
    jd: String(d.jd ?? ''),
    name: String(d.name ?? job.name),
    job,
  };
}

/**
 * 把开场白写进去并点发送 —— **不预设走弹窗还是聊天页**。
 *
 * 为什么不能在检测到「表面」时就锁死走哪条路（2026-11-15 实测）：
 *   点完「立即沟通」，弹「打招呼」弹窗和**直接跳聊天页**都可能发生、还可能先后发生 ——
 *   弹窗刚被检测到、页面就跳走了，对着已不存在的弹窗写 8 秒全失败（no-input）。
 *   所以：
 *     ① 先等「能发消息的地方」出现（弹窗 **或** 聊天页，哪个都行）
 *     ② 写入两边都试 —— 哪边写进用哪边
 *     ③ 等按钮解禁再点；写着写着页面换了输入框 → 换边重写
 */
async function typeAndSend(
  tabId: number,
  greeting: string,
  reClick: () => Promise<void>,
): Promise<{ ok: boolean; step?: string; detail?: string; convName?: string }> {
  // ⚠️ 三步**各给各的预算**，不共用一个 deadline。
  //    之前的教训：弹窗出现得慢（点了 20 多秒才渲染好），
  //    共用预算时「等表面」把额度吃光，「写入」只剩几秒 ——
  //    正好在输入框渲染出来之前放弃了（no-input 的真凶）。
  const surfaceDeadline = Date.now() + 30_000;
  const TYPE_BUDGET = 15_000;
  const SEND_BUDGET = 15_000;
  const startAt = Date.now();
  let reClicked = false;
  let mode: 'greet' | 'chat' | null = null;
  let convName = '';

  // ① 等「能发消息的地方」出现（弹窗 或 聊天页）。
  //    6 秒没动静 = 点击大概率没生效（页面 JS 未就绪，点击处理器还没挂上）→ 再点一次。
  //    判据是「两个表面都没出现」这个事实，不是猜时间。
  //    两个状态查询并发发（各是一次桥接往返，串行白等）。
  let firstSeen: 'greet' | 'chat' | null = null;
  for (;;) {
    const [g, c] = await Promise.all([
      runPageFn('greet', { mode: 'state' }, { tabId }).catch(() => null),
      runPageFn('chat', { mode: 'state' }, { tabId }).catch(() => null),
    ]);
    if (g?.dialogOpen && g?.hasSend) { firstSeen = 'greet'; break; }
    if (c?.convName) convName = c.convName;
    if (c?.boxVisible && c?.hasInput) { firstSeen = 'chat'; break; }
    if (!reClicked && Date.now() - startAt > 6_000) {
      await reClick();
      reClicked = true;
    }
    if (Date.now() >= surfaceDeadline) {
      return { ok: false, step: 'greet-surface-not-ready', detail: '点了按钮，但弹窗和聊天页都没出现', convName };
    }
    await sleep(POLL_MS);
  }

  // ② 写入 —— 两边都试，哪边写进用哪边（预算从现在起算，不受上一步影响）。
  //    先试 ① 刚确认的那个表面，别对着不存在的一边白写一发。
  // 每个表面只写自己的输入框，并回报 surface —— 写进哪个表面，
  // 就必须用**那个表面**的发送按钮（2026-11-15 的 still-disabled 就是这错配）。
  const tryType = async (fn: 'greet' | 'chat') => {
    const r = await runPageFn(fn, { mode: 'type', text: greeting }, { tabId }).catch(() => null);
    if (!r?.ok) return null;
    if (r.surface && r.surface !== fn) return null; // 写错地方了 → 不认
    return r;
  };
  const order: Array<'greet' | 'chat'> =
    firstSeen === 'chat' ? ['chat', 'greet'] : ['greet', 'chat'];
  const typeDeadline = Date.now() + TYPE_BUDGET;
  for (;;) {
    const a = await tryType(order[0]!);
    if (a) { mode = order[0]!; if (a.convName) convName = a.convName; break; }
    const b = await tryType(order[1]!);
    if (b) { mode = order[1]!; if (b.convName) convName = b.convName; break; }
    if (Date.now() >= typeDeadline) {
      // 取证：把失败瞬间的两个状态带回来 —— 不带证据的 no-input 没法修（这次的教训）
      const [g2, c2] = await Promise.all([
        runPageFn('greet', { mode: 'state' }, { tabId }).catch(() => null),
        runPageFn('chat', { mode: 'state' }, { tabId }).catch(() => null),
      ]);
      return {
        ok: false,
        step: 'no-input',
        detail:
          `弹窗和聊天页的输入框都写不进 | ` +
          `greet{dialog=${g2?.dialogOpen} send=${g2?.hasSend} inputs=${JSON.stringify(g2?.inputs ?? [])} templates=${(g2?.templates ?? []).length}} ` +
          `chat{input=${c2?.hasInput} 可见=${c2?.boxVisible} url=${String(c2?.url ?? '').slice(-45)}}`,
        convName,
      };
    }
    await sleep(POLL_MS);
  }

  // ③ 等按钮解禁 → 点发送。等的过程中表面可能被页面换掉 → 换边并重写。
  const sendDeadline = Date.now() + SEND_BUDGET;
  for (;;) {
    const st = await runPageFn(mode, { mode: 'state' }, { tabId }).catch(() => null);
    // 表面被换掉了（弹窗没了 / 跳走了）→ 状态里没有它 → 换边重写
    const stillThere =
      mode === 'greet' ? !!st?.dialogOpen : !!st?.boxVisible;
    const ready = mode === 'greet' ? st?.sendReady : st?.submitReady;
    if (ready) {
      const sent = await runPageFn(mode, { mode: mode === 'greet' ? 'send' : 'submit' }, { tabId }).catch(() => null);
      if (sent?.ok) return { ok: true, convName };
      return { ok: false, step: sent?.step ?? 'send-failed', convName };
    }
    if (!stillThere) {
      // 我们那个表面没了（弹窗关了 / 跳到聊天页了）→ 字得在新的表面上重写
      const other: 'greet' | 'chat' = mode === 'greet' ? 'chat' : 'greet';
      const os = await runPageFn(other, { mode: 'state' }, { tabId }).catch(() => null);
      const there = other === 'greet' ? os?.dialogOpen && os?.hasSend : os?.boxVisible && os?.hasInput;
      if (there) {
        const t: any = await runPageFn(other, { mode: 'type', text: greeting }, { tabId }).catch(() => null);
        if (t?.ok && (!t.surface || t.surface === other)) {
          mode = other;
          if (t.convName) convName = t.convName;
        }
      }
    }
    if (Date.now() >= sendDeadline) {
      return { ok: false, step: 'still-disabled', detail: '输入了内容，但发送按钮一直不解禁', convName };
    }
    await sleep(POLL_MS);
  }
}

/**
 * 在**已经打开的**详情页里，给这个 HR 发一条消息。
 *
 * 只做两件事：点按钮（「立即沟通」/「继续沟通」是同一个按钮，文案不同），
 * 然后把剩下的交给 typeAndSend（它自己判断弹窗还是聊天页，两边都试）。
 */
export async function greetInPage(
  page: JobPage,
  greeting: string,
  verify?: (job: Job, greeting: string) => Promise<boolean>,
): Promise<GreetOutcome> {
  const out: GreetOutcome = { ok: false };
  // 以页面读到的岗位名为准，但保留 bossName 等完整身份 —— verify 靠它按人匹配
  const job: Job = { ...page.job, name: page.name };

  try {
    // 点「立即沟通 / 继续沟通」。
    // ⚠️ 点击可能没生效（页面 JS 未就绪）—— typeAndSend 里靠「表面没出现」再点一次
    const clicked = await runPageFn('detail', { mode: 'chat-click' }, { tabId: page.tabId });
    if (!clicked?.ok) {
      out.step = clicked?.step ?? 'no-chat-btn';
      return out;
    }

    const r = await typeAndSend(page.tabId, greeting, async () => {
      await runPageFn('detail', { mode: 'chat-click' }, { tabId: page.tabId }).catch(() => null);
    });
    if (!r.ok) {
      out.step = r.step;
      out.detail = r.detail;
      out.convName = r.convName;
      return out;
    }
    out.convName = r.convName;

    // 服务端确认
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
  }
}

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
