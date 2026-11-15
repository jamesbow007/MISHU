/**
 * 主动打招呼 —— 根据我的简历和岗位 JD，主动联系 HR。
 *
 * 用法：
 *   npm run greet -- --dry-run        只算不打（看名单、看文案，不发任何消息）
 *   npm run greet -- --once            实发一轮
 *   npm run greet                      常驻，一轮一轮来
 *   npm run greet -- --limit 5         一轮最多联系 5 个
 *   npm run greet -- --city 101010100  只看某个城市（城市码）
 *   npm run greet -- --query 大模型算法 换搜索关键词
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
  cleanupGreetTabs,
  greetOne,
  verifyGreeting,
} from '../api/greet.js';
import { listSessions } from '../api/messages.js';
import {
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
  CITY_CODES,
  fetchJobDetail,
  listExpects,
  listRecommendJobs,
  listSearchJobs,
  salaryLowK,
  type Job,
} from '../api/jobs.js';
import { loadLlmConfig, llmMissingHint, type LlmConfig } from '../api/llm.js';
import { judgeJobs, type Judgement } from '../api/match.js';
import { readMyProfile } from '../api/resume.js';
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
 * 收集候选岗位：推荐区 + 搜索接口，按 jobId 去重。
 *
 * 两条路都会给 15~30 条/页，翻几页由配置里的 pages 决定。
 */
async function collectJobs(cfg: GreetConfig, cities: string[]): Promise<Job[]> {
  const out = new Map<string, Job>();

  // ① 推荐区（BOSS 里设的期望工作）
  try {
    const expects = await listExpects();
    log(`期望工作 ${expects.length} 项：${expects.map((e) => `${e.positionName}（${e.locationName}）`).join('、') || '（没设）'}`);
    for (const e of expects) {
      for (let p = 1; p <= cfg.pages; p++) {
        const jobs = await listRecommendJobs(e, p);
        log(`  推荐 ${e.positionName}（${e.locationName}）第 ${p} 页：${jobs.length} 条`);
        for (const j of jobs) if (j.jobId && !out.has(j.jobId)) out.set(j.jobId, j);
      }
    }
  } catch (e) {
    log('⚠️ 读推荐区失败：' + (e as Error).message);
  }

  // ② 搜索接口
  for (const city of cities) {
    for (let p = 1; p <= cfg.pages; p++) {
      try {
        const jobs = await listSearchJobs({ query: cfg.query, city, page: p, pageSize: 30 });
        log(`  搜索「${cfg.query}」${cityName(city)} 第 ${p} 页：${jobs.length} 条`);
        for (const j of jobs) if (j.jobId && !out.has(j.jobId)) out.set(j.jobId, j);
      } catch (e) {
        log(`⚠️ 搜索 ${cityName(city)} 第 ${p} 页失败：` + (e as Error).message);
      }
    }
  }

  return [...out.values()];
}

function cityName(code: string): string {
  for (const [n, c] of Object.entries(CITY_CODES)) if (c === code) return n;
  return code;
}

/** 粗筛：薪资 / 学历 / 经验 / 冷却期 */
function filterJobs(jobs: Job[], cfg: GreetConfig): { kept: Job[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = { 薪资: 0, 学历: 0, 经验: 0, 已联系过: 0 };
  const state = loadGreetState();
  const kept: Job[] = [];

  for (const j of jobs) {
    if (cfg.salaryMinK > 0 && salaryLowK(j) > 0 && salaryLowK(j) < cfg.salaryMinK) {
      dropped['薪资']!++;
      continue;
    }
    if (cfg.degrees.length && j.degree && !cfg.degrees.includes(j.degree)) {
      dropped['学历']!++;
      continue;
    }
    if (cfg.experiences.length && j.experience && !cfg.experiences.includes(j.experience)) {
      dropped['经验']!++;
      continue;
    }
    if (greetedRecently(state, j.jobId, cfg.cooldownDays)) {
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
  cities: string[];
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
  const all = await collectJobs(cfg, opts.cities);
  log(`  合计 ${all.length} 条（去重后）`);

  // ③ 粗筛
  const { kept, dropped } = filterJobs(all, cfg);
  const dropTxt = Object.entries(dropped).filter(([, n]) => n > 0).map(([k, n]) => `${k}${n}`).join(' ');
  log(`  粗筛后 ${kept.length} 条${dropTxt ? `（去掉：${dropTxt}）` : ''}`);

  // ④ 取 JD
  const candidates = kept.slice(0, cfg.candidates);
  if (kept.length > candidates.length) {
    log(`  只取前 ${candidates.length} 条取 JD（配置 candidates）`);
  }
  const withJd: (Job & { jd: string })[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const j = candidates[i]!;
    try {
      const d = await fetchJobDetail(j);
      withJd.push({ ...j, jd: d.jd });
    } catch (e) {
      log(`  ⚠️ ${j.name} 的 JD 取不到：${(e as Error).message}`);
    }
    if ((i + 1) % 10 === 0) log(`  JD 已取 ${i + 1}/${candidates.length}`);
  }
  log(`  拿到 JD ${withJd.length} 条`);

  // ⑤ 大模型判断 + 生成文案
  //    缓存命中就不用再问模型 —— 常驻模式下每轮都会遇到同一批岗位
  const cache = loadJudgeCache();
  const fresh = withJd.filter(
    (w) =>
      cache[w.jobId] &&
      Date.now() - (cache[w.jobId]!.at ?? 0) < JUDGE_TTL_MS &&
      cache[w.jobId]!.jobName === w.name,
  );
  const needAsk = withJd.filter((w) => !fresh.includes(w));

  const judgements: Judgement[] = [];
  if (fresh.length) {
    log(`判断结果缓存命中 ${fresh.length} 条（24 小时内算新鲜）`);
    for (const w of fresh) {
      const c = cache[w.jobId]!;
      // 老缓存里没存岗位元数据 → 顺手补上（下次 --pick 就能用）
      if (!c.job) c.job = { ...w };
      judgements.push({
        jobId: w.jobId, worth: c.worth, score: c.score, reason: c.reason, greeting: c.greeting,
      });
    }
    saveJudgeCache(cache);
  }
  if (needAsk.length) {
    log(`让大模型判断剩下 ${needAsk.length} 条…`);
    const asked = await judgeJobs(llm, profile.summary, needAsk, {
      batchSize: cfg.batchSize,
      onBatch: (done, total) => log(`  已判断 ${done}/${total}`),
    });
    judgements.push(...asked);
    for (const j of asked) {
      const w = needAsk.find((x) => x.jobId === j.jobId);
      cache[j.jobId] = {
        at: Date.now(), jobName: w?.name ?? '', company: w?.company ?? '',
        worth: j.worth, score: j.score, reason: j.reason, greeting: j.greeting,
        job: w ? { ...w } : undefined,
      };
    }
    saveJudgeCache(cache);
  }

  // ⑥ 汇总（值得投 **且** 有开场白的才进名单 —— 没文案可发等于没投）
  const worth = judgements
    .filter((j) => j.worth && j.greeting)
    .sort((a, b) => b.score - a.score)
    .map((j) => ({ j, job: withJd.find((w) => w.jobId === j.jobId) as unknown as Job }));

  log(`\n════ 大模型判断结果：${worth.length}/${judgements.length} 个值得投 ════`);
  for (const { j, job } of worth) {
    log(`\n【${job.name}】${job.salary} · ${job.company} · ${job.city}${job.district ? '·' + job.district : ''}`);
    log(`  HR ${job.bossName || '?'} · ${job.bossTitle || ''} · ${job.experience} · ${job.degree} · ${job.jobId}`);
    log(`  匹配 ${j.score} 分 —— ${j.reason}`);
    log(`  开场白：${j.greeting}`);
  }
  if (!worth.length) log('\n（没有值得投的）');

  // 不值得投的，简要列一下，方便调配置
  const notWorth = judgements.filter((j) => !j.worth);
  if (notWorth.length) {
    log(`\n──── 不投的 ${notWorth.length} 个 ────`);
    for (const j of notWorth.slice(0, 20)) {
      const job = withJd.find((w) => w.jobId === j.jobId);
      log(`  ✗ ${job?.name ?? j.jobId} · ${job?.company ?? ''} —— ${j.reason || j.error || ''}`);
    }
    if (notWorth.length > 20) log(`  …… 还有 ${notWorth.length - 20} 个`);
  }

  if (opts.dryRun) {
    log('\n<dry-run> 一个字都没发。去掉 --dry-run 就会真的打招呼。');
    return;
  }

  // ⑦ 实发
  const limit = opts.limit > 0 ? opts.limit : cfg.perRound;
  const todayCount = sentToday(state);
  if (cfg.dailyLimit > 0 && todayCount >= cfg.dailyLimit) {
    log(`\n今天已经打了 ${todayCount} 个招呼（上限 ${cfg.dailyLimit}），本轮不做任何事。`);
    return;
  }

  let targets = opts.pick
    ? worth.filter((w) => w.job.jobId === opts.pick)
    : worth.slice(0, limit > 0 ? limit : worth.length);

  // 指定的岗位这一轮不在候选里（岗位列表会轮换）→ 从缓存里捞
  if (opts.pick && !targets.length) {
    const cached = cache[opts.pick];
    if (cached?.job?.jobId) {
      log(`\n（指定的岗位这一轮不在列表里，用缓存里的岗位信息）`);
      targets.push({
        j: {
          jobId: cached.job.jobId, worth: cached.worth, score: cached.score,
          reason: cached.reason, greeting: cached.greeting,
        },
        job: cached.job as unknown as Job,
      });
    }
  }
  if (opts.pick && !targets.length) {
    log(`\n指定的岗位 ${opts.pick} 不在「值得投」的名单里 —— 换个人吧`);
    return;
  }
  log(`\n════ 开始打招呼（${targets.length} 个）════`);

  // 服务端确认用的登录态 + 会话列表（发完一条就查一次）
  const client = await createBrowserClient().catch((e) => {
    log('⚠️ 拿不到登录态，服务端确认用不了：' + (e as Error).message);
    return null;
  });
  let sessions = client ? await listSessions(client, { labelId: 0, enrich: 'none' }).catch(() => []) : [];

  for (let i = 0; i < targets.length; i++) {
    const { j, job } = targets[i]!;
    if (cfg.dailyLimit > 0 && sentToday(state) >= cfg.dailyLimit) {
      log(`  达到今日上限 ${cfg.dailyLimit}，收工`);
      break;
    }
    log(`\n→ ${job.name} · ${job.company} · ${job.bossName || '?'}`);
    log(`  jobId: ${job.jobId}`);
    log(`  ${j.greeting}`);
    const r = await greetOne(job, j.greeting, async (jb, g) => {
      if (!client) return true; // 没有服务端确认能力就只信页面
      // 一直查到截止时刻为止 —— 不写死试几次、也不写死间隔。
      // 消息是异步落库的，慢网下好几秒才到；两次查询之间等「上一次查询
      // 自己花了多久」，网络慢就自然等得久。
      const until = Date.now() + 15_000;
      for (;;) {
        const t0 = Date.now();
        if (await verifyGreeting(client, jb, g, sessions)) return true;
        if (Date.now() >= until) break;
        await sleep(Math.max(200, Date.now() - t0));
      }
      // 会话列表可能还没刷新（新建的会话），重取一次再查
      sessions = await listSessions(client, { labelId: 0, enrich: 'none' }).catch(() => sessions);
      return verifyGreeting(client, jb, g, sessions);
    });
    if (r.ok) {
      recordGreeting(state, {
        jobId: job.jobId, name: job.bossName, company: job.company,
        status: 'sent', score: j.score, reason: j.reason,
      });
      saveGreetState(state);
      log(`  ✅ 已发出${r.convName ? '（' + r.convName + '）' : ''}`);
    } else {
      recordGreeting(state, {
        jobId: job.jobId, name: job.bossName, company: job.company,
        status: 'failed', score: j.score, reason: r.step,
      });
      saveGreetState(state);
      log(`  ❌ 失败：${r.step} ${r.detail ?? ''}`);
    }

    // 下一个之前歇一会儿（礼貌节奏，区间内随机）—— 最后一个不用等
    const isLast = i === targets.length - 1;
    if (!isLast && cfg.intervalMaxSec > 0) {
      const wait = Math.floor(cfg.intervalMinSec + Math.random() * Math.max(0, cfg.intervalMaxSec - cfg.intervalMinSec));
      log(`  …等 ${wait} 秒再下一个`);
      await sleep(wait * 1000);
    }
  }

  log(`\n本轮结束：今天累计打了 ${sentToday(state)} 个招呼`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  process.env.BOSS_ZHIPIN_QUIET_DIAG = '1';

  const dryRun = has('--dry-run');
  const once = has('--once');
  const limit = num('--limit', 0);
  const query = val('--query');
  const cityArg = val('--city');
  const pick = val('--pick');

  const cfg = loadGreetConfig();
  if (query) cfg.query = query;
  const cities = cityArg ? [cityArg] : cfg.cities;

  const llm = loadLlmConfig();
  if (!llm) {
    console.error('❌ 没配大模型。\n' + llmMissingHint());
    process.exit(1);
  }

  log('════ 主动打招呼 ════');
  log(`  关键词 : ${cfg.query}`);
  log(`  城市   : ${cities.map(cityName).join('、')}`);
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

  const opts: RoundOpts = { dryRun, limit, cities, pick };

  if (once || dryRun) {
    try {
      await runRound(cfg, llm, opts);
    } catch (e) {
      log('❌ 本轮出错：' + (e as Error).message);
    }
    await bridge.stop().catch(() => {});
    return;
  }

  // 常驻：一轮接一轮
  const shutdown = async () => {
    log('收到退出信号，正在退出…');
    // 收掉本进程开着的标签页（否则会攒成标签页泄漏）
    const closed = await cleanupGreetTabs().catch(() => 0);
    if (closed) log(`  已关闭 ${closed} 个标签页`);
    await bridge.stop().catch(() => {});
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
