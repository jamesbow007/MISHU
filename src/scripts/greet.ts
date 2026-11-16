/**
 * 主动打招呼 —— 根据我的简历和岗位 JD，主动联系 HR。
 *
 * 用法：
 *   npm run greet -- --dry-run        只算不打（看名单、看文案，不发任何消息）
 *   npm run greet -- --once            实发一轮
 *   npm run greet                      常驻，一轮一轮来
 *   npm run greet -- --limit 5         一轮最多联系 5 个
 *
 * 前提：
 *   - Chrome 开着、已登录 BOSS直聘、扩展已加载
 *   - 配好了大模型（MISHU_LLM_API_KEY / MISHU_LLM_BASE_URL / MISHU_LLM_MODEL）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridge, bridgeStatus } from '../api/bridge.js';
import { createBrowserClient } from '../api/browser-client.js';
import { loadGreetConfig, type GreetConfig } from '../api/greet-config.js';
import {
  greetInPage,
  openJobPage,
  verifyGreeting,
  type JobPage,
} from '../api/greet.js';
import { closeTabs, closeTabsOpenedSince, tabIdsSnapshot } from '../api/page-transport.js';
import { listSessions } from '../api/messages.js';
import {
  backfillBosses,
  greetedRecently,
  JUDGE_TTL_MS,
  loadGreetState,
  loadJudgeCache,
  recordGreeting,
  saveGreetState,
  saveJudgeCache,
  sentToday,
} from '../api/greet-state.js';
import {
  fetchJobDetail,
  listExpects,
  listRecommendJobs,
  RateLimitedError,

  type Job,
} from '../api/jobs.js';
import { loadLlmConfig, llmMissingHint, type LlmConfig } from '../api/llm.js';
import { judgeJobs, type Judgement } from '../api/match.js';
import { profileSignature, readMyProfile } from '../api/resume.js';
import { sleep } from '../api/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'greet.log');

/* ---------------- 小工具 ---------------- */

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => {
  const n = Number(val(f));
  return Number.isFinite(n) && n >= 0 ? n : d;
};

function log(msg: string) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

/** 等扩展连上（看它最近一次轮询的新鲜度，别看 60 秒窗口的 connected） */
async function waitForExtension(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await bridgeStatus();
    if (st && typeof st.lastPoll === 'number' && Date.now() - st.lastPoll < 30_000) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

/* ---------------- 收集岗位 ---------------- */

/**
 * 收集候选岗位：**只走职位页的「推荐」区**，按 jobId 去重。
 *
 * ⚠️ **列表请求是稀缺资源** —— 实测连打 4~5 个就撞风控（code=37），
 *    被挡之后要等好几分钟才恢复。所以：
 *      ① 期望项缓存起来（很少变），每轮省一次请求
 *      ② 一旦被挡，**立刻停掉剩下的列表请求**（再打也只是再被挡一次，
 *         每次还白等一个 90 秒安静期）
 *
 * 每个期望（大模型算法 深圳 / 北京）一页 15 条 —— 页面自己就是这么取的
 * （pageSize 传 30/50/100 也只给 15）。
 */
async function collectJobs(cfg: GreetConfig): Promise<Job[]> {
  const out = new Map<string, Job>();
  let blocked = false;

  try {
    const expects = await loadExpects();
    log(`期望工作 ${expects.length} 项：${expects.map((e) => `${e.positionName}（${e.locationName}）`).join('、') || '（没设）'}`);
    for (const e of expects) {
      if (blocked) break;
      for (let p = 1; p <= cfg.pages; p++) {
        if (blocked) break;
        try {
          const jobs = await listRecommendJobs(e, p);
          log(`  推荐 ${e.positionName}（${e.locationName}）第 ${p} 页：${jobs.length} 条`);
          for (const j of jobs) if (j.jobId && !out.has(j.jobId)) out.set(j.jobId, j);
        } catch (err) {
          if (err instanceof RateLimitedError) {
            blocked = true;
            log('  ⚠️ 被风控了 —— 停止本轮剩下的列表请求（已拿到的照常用）');
            break;
          }
          log('  ⚠️ 推荐页失败：' + (err as Error).message);
        }
      }
    }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      blocked = true;
      log('  ⚠️ 期望项被风控挡了 —— 停止本轮剩下的列表请求');
    } else {
      log('⚠️ 读推荐区失败：' + (e as Error).message);
    }
  }

  return [...out.values()];
}

/**
 * 期望项缓存 6 小时。
 *
 * 期望很少改，但它是一次**列表请求** —— 风控额度紧张，能省一次是一次。
 */
const EXPECT_CACHE_FILE = path.join(DATA_DIR, 'greet-expects.json');
const EXPECT_TTL_MS = 6 * 60 * 60 * 1000;

async function loadExpects(): Promise<Awaited<ReturnType<typeof listExpects>>> {
  try {
    const c = JSON.parse(fs.readFileSync(EXPECT_CACHE_FILE, 'utf8'));
    if (c?.at && Date.now() - c.at < EXPECT_TTL_MS && Array.isArray(c.list) && c.list.length) {
      log(`  期望项用缓存（${c.list.length} 项，${Math.round((Date.now() - c.at) / 60000)} 分钟前取的）`);
      return c.list;
    }
  } catch {
    /* 没有缓存 */
  }
  const list = await listExpects();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EXPECT_CACHE_FILE, JSON.stringify({ at: Date.now(), list }), 'utf8');
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
  return list;
}

/**
 * 粗筛 —— **只挡「已经联系过的」**。
 *
 * 为什么不做别的筛选（用户 2026-11-15 的判断）：
 *   列表接口白送的「要求年限 / 要求学历 / 工作城市」**不一定是真的门槛**，
 *   很多岗位只是照着模板写上去的。真匹不匹配要看简历和 JD 的内容 ——
 *   那是大模型的活，不是几个字段能判的。
 *   所以这里只保留去重（别再打扰同一个 HR），其余全交给模型。
 */
function filterJobs(
  jobs: Job[],
  cfg: GreetConfig,
  state: ReturnType<typeof loadGreetState>,
): { kept: Job[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = { 已联系过: 0 };
  const kept: Job[] = [];

  for (const j of jobs) {
    if (greetedRecently(state, j.jobId, cfg.cooldownDays, j.bossId)) {
      dropped['已联系过']!++;
      continue;
    }
    kept.push(j);
  }
  return { kept, dropped };
}

/* ---------------- 一轮 ---------------- */

interface RoundOpts {
  dryRun: boolean;
  limit: number;
  /** 只跟这一个岗位打招呼（补投用），不填就按分数从高到低 */
  pick?: string;
}

async function runRound(cfg: GreetConfig, llm: LlmConfig, opts: RoundOpts) {
  const state = loadGreetState();

  // ① 我的简历
  log('读我的在线简历…');
  const profile = await readMyProfile();
  log(`  ${profile.name || '(没读到名字)'} · ${profile.experience || ''} · ${profile.degree || ''} · ${profile.status || ''}`);
  log(`  期望：${profile.expects.join('、') || '（没读到）'}`);

  // ② 收集岗位
  log('收集岗位…');
  const all = await collectJobs(cfg);
  log(`  合计 ${all.length} 条（去重后）`);

  // ③ 粗筛（只挡已经联系过的；其余交给大模型按简历和 JD 判）
  //    判断和记账用同一份 state，别加载两份
  const { kept, dropped } = filterJobs(all, cfg, state);

  // 老记录的 bossId 回填（幂等迁移）—— 逻辑收在 greet-state.ts
  backfillBosses(state, all);
  saveGreetState(state);
  const dropTxt = Object.entries(dropped).filter(([, n]) => n > 0).map(([k, n]) => `${k}${n}`).join(' ');
  log(`  粗筛后 ${kept.length} 条${dropTxt ? `（去掉：${dropTxt}）` : ''}`);

  // ④⑤⑥ 逐个来：一个岗位一个岗位地处理
  //
  //   取这个岗位的 JD → 让模型判值不值得投 → 值得就马上打招呼 → 不值得就下一个
  //
  // 为什么不是「先把 30 个 JD 都取了、再批量判、最后统一发」：
  //   - **省请求**：判断缓存命中就直接跳过，连 JD 都不用取
  //   - **出结果快**：第一个招呼在第一次模型调用之后就能发出去，
  //     而不是等 10 批模型全跑完
  //   - **撞风控时不白干**：已经打过招呼的那几个不会因为后面被挡而丢掉
  //
  //   缓存的钥匙 = 岗位 id + 简历指纹：岗位没变、简历没变 → 直接用旧结论；
  //   简历改了 → 指纹对不上 → 重新判断。
  const cache = loadJudgeCache();
  const sig = profileSignature(profile.summary);
  const limit = opts.limit > 0 ? opts.limit : cfg.perRound;

  if (cfg.dailyLimit > 0 && sentToday(state) >= cfg.dailyLimit) {
    log(`
今天已经打了 ${sentToday(state)} 个招呼（上限 ${cfg.dailyLimit}），本轮不做任何事。`);
    return;
  }

  // 服务端确认用的登录态 + 会话列表（发完一条就查一次）
  const client = opts.dryRun ? null : await createBrowserClient().catch((e) => {
    log('⚠️ 拿不到登录态，服务端确认用不了：' + (e as Error).message);
    return null;
  });
  let sessions = client ? await listSessions(client, { labelId: 0, enrich: 'none' }).catch(() => []) : [];

  let judged = 0;
  let worthCount = 0;
  let sentCount = 0;
  let skipped = 0;
  /**
   * 这一轮用的标签页（**整轮只开一个**，每个岗位导航过去用）。
   *
   * 之前每个岗位都新开一个详情页再关掉 → 用户看到一堆页面闪来闪去。
   * 现在：开一次，之后每个岗位把**它导航**到新地址。
   */
  let roundTabId: number | null = null;
  /** 轮次开始前的标签页快照（收尾时把「这轮新开的」全关掉） */
  const tabsBeforeRound = await tabIdsSnapshot();
  // 给退出钩子用的：中途被杀也能把这轮开的页收掉
  roundTabsBefore = tabsBeforeRound;

  /** 开（或导航到）这个岗位的详情页 —— 整轮只开一个标签页 */
  const openFor = async (job: Job): Promise<JobPage | null> => {
    try {
      const p = await openJobPage(job, roundTabId);
      roundTabId = p.tabId;
      return p;
    } catch (e) {
      log(`  ⚠️ ${job.name} 的详情页打不开：${(e as Error).message}`);
      return null;
    }
  };
  /** 上一次**打招呼**的时刻 —— 用来算两次招呼之间隔多久 */
  let lastGreetAt = 0;
  /** 当前这个岗位已经打开的详情页（值得投就在它上面打招呼） */
  let currentPage: JobPage | null = null;

  // --pick 指定的岗位，这一轮可能不在推荐列表里（列表会轮换）
  // → 从判断缓存里把它捞出来（结论和文案都在那儿，岗位元数据也在）
  let todo: Job[] = kept;
  if (opts.pick) {
    const inList = kept.find((j) => j.jobId === opts.pick);
    const cachedJob = cache[opts.pick]?.job as Job | undefined;
    if (!inList && cachedJob?.jobId) {
      log(`（指定的岗位这一轮不在推荐列表里 —— 用判断缓存里的岗位信息补投）`);
      todo = [cachedJob];
    } else if (inList) {
      todo = [inList];
    }
  }

  for (const job of todo) {
    if (sentCount >= limit && limit > 0) {
      log(`
达到本轮上限 ${limit} 个，收工。`);
      break;
    }

    // ── 判断：先看缓存，没有再问模型 ──
    let j: Judgement | null = null;
    const cached = cache[job.jobId];
    const cacheOk =
      cached &&
      Date.now() - (cached.at ?? 0) < JUDGE_TTL_MS &&
      cached.jobName === job.name &&
      cached.profileSig === sig;
    if (cacheOk) {
      j = {
        jobId: job.jobId, worth: cached!.worth, score: cached!.score,
        reason: cached!.reason, greeting: cached!.greeting,
      };
      skipped++;
    } else {
      // ── 打开岗位详情页，JD 从**页面里**读（0 次接口请求）──
      currentPage = await openFor(job);
      if (!currentPage) continue;
      let jd = currentPage.jd;
      if (!jd) {
        // 页面没渲染出 JD → 退回走接口取一次
        log(`  ⚠️ ${job.name} 页面里没读到 JD，退回接口取`);
        try {
          jd = (await fetchJobDetail(job)).jd;
        } catch (e) {
          await closeTabs([currentPage.tabId]).catch(() => {});
          currentPage = null;
          if (e instanceof RateLimitedError) {
            log('  ⚠️ 取 JD 时被风控 —— 这一轮到此为止（已打的招呼已经发出去了）');
            break;
          }
          log(`  ⚠️ ${job.name} 的 JD 取不到：${(e as Error).message}`);
          continue;
        }
      }

      // 问模型（一次一个）
      const [r] = await judgeJobs(llm, profile.summary, [{ ...job, jd }], { batchSize: 1 });
      if (!r) {
        currentPage = null; // 页面留着给下一个岗位用
        continue;
      }
      j = r;
      judged++;
      // 记判断结果（含岗位元数据 → 以后 --pick 能补投）
      cache[job.jobId] = {
        at: Date.now(), jobName: job.name, company: job.company,
        worth: r.worth, score: r.score, reason: r.reason, greeting: r.greeting,
        profileSig: sig,
        job: { ...job },
      };
      saveJudgeCache(cache);
      // 页面先留着 —— 值得投的话直接在这个页面上打招呼
    }

    log(`
${job.name} · ${job.company} · ${job.bossName || '?'} · ${job.salary}`);
    log(`  ${j!.score} 分 —— ${j!.reason}`);
    if (!j!.worth || !j!.greeting) {
      log('  ✗ 不值得投，下一个');
      currentPage = null; // 页面留着给下一个岗位用（整轮只开一个）
      continue;
    }
    worthCount++;
    log(`  开场白：${j!.greeting}`);

    // ── 打招呼 ──
    // 两次**招呼**之间隔 4~7 分钟（随机）。
    // 注意是按「距上次招呼」补足，不是「每处理完一个岗位就等一次」——
    // 中间夹着不值得投的岗位时，那些等待本来就已经把间隔拉长了，
    // 再等一次就变成两倍。
    if (lastGreetAt && cfg.intervalMaxSec > 0) {
      const target = Math.floor(
        cfg.intervalMinSec + Math.random() * Math.max(0, cfg.intervalMaxSec - cfg.intervalMinSec),
      );
      const elapsed = Math.round((Date.now() - lastGreetAt) / 1000);
      if (elapsed < target) {
        const wait = target - elapsed;
        if (opts.dryRun) {
          // 干跑不真等，但把节奏打印出来（能看出间隔对不对）
          log(`  [干跑] 距上次招呼 ${elapsed} 秒，真实发送时会再等 ${wait} 秒`);
        } else {
          log(`  …距上次招呼 ${elapsed} 秒，再等 ${wait} 秒`);
          await sleep(wait * 1000);
        }
      }
    }

    if (opts.dryRun) {
      sentCount++;
      currentPage = null; // 页面留着给下一个岗位用
      lastGreetAt = Date.now(); // 干跑也推进时间，模拟连续打招呼
      continue;
    }

    // 判断结果命中缓存的岗位：刚才没开页面（不需要读 JD）→ 现在才开
    if (!currentPage) {
      currentPage = await openFor(job);
      if (!currentPage) continue;
    }
    const pageForGreeting = currentPage;
    const r = await greetInPage(pageForGreeting, j!.greeting, async (jb, g) => {
      if (!client) return true;
      // 一直查到截止时刻为止 —— 不写死试几次、也不写死间隔
      const until = Date.now() + 15_000;
      for (;;) {
        const t0 = Date.now();
        if (await verifyGreeting(client, jb, g, sessions)) return true;
        if (Date.now() >= until) break;
        await sleep(Math.max(200, Date.now() - t0));
      }
      sessions = await listSessions(client, { labelId: 0, enrich: 'none' }).catch(() => sessions);
      return verifyGreeting(client, jb, g, sessions);
    });

    if (r.ok) {
      recordGreeting(state, {
        jobId: job.jobId, bossId: job.bossId, name: job.bossName, company: job.company,
        status: 'sent', score: j!.score, reason: j!.reason,
      });
      saveGreetState(state);
      sentCount++;
      log(`  ✅ 已发出${r.convName ? '（' + r.convName + '）' : ''}`);
    } else {
      recordGreeting(state, {
        jobId: job.jobId, bossId: job.bossId, name: job.bossName, company: job.company,
        status: 'failed', score: j!.score, reason: r.step,
      });
      saveGreetState(state);
      log(`  ❌ 失败：${r.step} ${r.detail ?? ''}`);
    }

    currentPage = null; // 页面留着给下一个岗位用（整轮只开一个）
    lastGreetAt = Date.now();
  }

  // 轮次收尾：把这轮新开的标签页全关掉（整轮只开一个，但页面自己可能多开）
  await closeTabsOpenedSince(tabsBeforeRound).catch(() => {});

  log(
    `
本轮结束：候选 ${kept.length} 个，实际处理 ${judged + skipped} 个` +
    `（问模型 ${judged}、命中缓存 ${skipped}），值得投 ${worthCount} 个，` +
    (opts.dryRun ? `打招呼 ${sentCount} 个（干跑，没发）` : `打招呼 ${sentCount} 个`),
  );
  if (opts.dryRun) {
    log('<dry-run> 一个字都没发。去掉 --dry-run 就会真的打招呼。');
  }
  return;
}

/* ---------------- 主流程 ---------------- */

/** 当前这轮开页前的标签页快照 —— 退出钩子用它收掉中途开的页（runRound 里赋值） */
let roundTabsBefore: number[] | null = null;

/** 单实例锁 —— 两个 greet 并发跑会用各自的旧内存状态互相覆盖记录（实测踩过） */
const LOCK_FILE = path.join(DATA_DIR, 'greet.lock');

function acquireLock(): boolean {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; } catch { /* 持有者已死 → 接管 */ }
    }
  } catch { /* 没有锁文件 */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

async function main() {
  process.env.BOSS_ZHIPIN_QUIET_DIAG = '1';

  if (!acquireLock()) {
    console.error('❌ 已经有一个 greet 在跑（data/greet.lock）—— 同跑两个会用旧状态互相覆盖记录。');
    process.exit(1);
  }

  const dryRun = has('--dry-run');
  const once = has('--once');
  const limit = num('--limit', 0);
  const pick = val('--pick');

  const cfg = loadGreetConfig();

  const llm = loadLlmConfig();
  if (!llm) {
    console.error('❌ 没配大模型。\n' + llmMissingHint());
    process.exit(1);
  }

  log('════ 主动打招呼 ════');
  log(`  模型   : ${llm.model} @ ${llm.baseUrl}`);
  log(`  干跑   : ${dryRun ? '是（一个字都不发）' : '否（会真的打招呼）'}`);
  if (limit > 0) log(`  本轮上限: ${limit} 个`);
  log(`  打招呼间隔: ${cfg.intervalMinSec}~${cfg.intervalMaxSec} 秒`);
  log(`  今日上限 : ${cfg.dailyLimit || '不限'}`);

  await bridge.start();
  if (!(await waitForExtension(15_000))) {
    log('❌ 没等到 Chrome 扩展 —— 请确认 Chrome 开着、扩展已加载并启用');
    await bridge.stop();
    return;
  }

  const opts: RoundOpts = { dryRun, limit, pick };

  if (once || dryRun) {
    try {
      await runRound(cfg, llm, opts);
    } catch (e) {
      log('❌ 本轮出错：' + (e as Error).message);
    }
    await bridge.stop().catch(() => {});
    releaseLock();
    return;
  }

  // 常驻：一轮接一轮
  const shutdown = async () => {
    log('收到退出信号，正在退出…');
    // 收掉这一轮开的标签页（中途被杀也不留孤儿页）
    if (roundTabsBefore) {
      const closed = await closeTabsOpenedSince(roundTabsBefore).catch(() => 0);
      if (closed) log(`  已关闭 ${closed} 个标签页`);
    }
    await bridge.stop().catch(() => {});
    releaseLock(); // 必须在 exit 之前 —— exit 之后的代码不会执行
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', (e) => log('❌ 未捕获异常（继续跑）：' + (e as Error).message));

  for (;;) {
    try {
      await runRound(cfg, llm, opts);
    } catch (e) {
      log('❌ 本轮出错：' + (e as Error).message);
    }
    const wait = Math.max(60, cfg.roundGapSec || cfg.intervalMaxSec);
    log(`\n（${wait} 秒后开始下一轮）`);
    await sleep(wait * 1000);
  }
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
