/**
 * 主动打招呼的本地状态 —— 记着「哪些已经打过招呼了」。
 *
 * 为什么必须有：岗位列表会反复推同样的岗位，不记的话同一个 HR 会收到
 * 一遍又一遍的招呼（BOSS 会把这种账号判成骚扰）。
 *
 * ⚠️ **要按「人」去重，不只是按「岗位」**：
 *   同一个 HR 常常同时挂好几个岗位（招聘者 / 猎头尤其常见）。
 *   只按 jobId 记的话，他招 3 个岗就会被你打扰 3 次。
 *   所以除了 jobId，还要记 **bossId（encryptBossId，HR 的唯一 id）**。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './llm.js';

export const STATE_FILE = path.join(DATA_DIR, 'greet-state.json');

export interface GreetRecord {
  jobId: string;
  /** HR 的唯一 id（没有就空） */
  bossId?: string;
  name: string;
  company: string;
  at: number;
  status: 'sent' | 'failed';
  score?: number;
  reason?: string;
}

export interface GreetState {
  version: number;
  /** jobId → 记录 */
  greeted: Record<string, GreetRecord>;
  /**
   * bossId → 最近一次联系（按「人」去重用）
   *
   * 存 {at, status} 而不是纯时间戳 —— **失败的不该锁 30 天**
   * （失败通常是一次性的：页面没加载好、按钮没找到）。
   */
  bosses: Record<string, { at: number; status: 'sent' | 'failed' } | number>;
  stats: { day: string; sentToday: number; rounds: number };
}

function emptyState(): GreetState {
  const today = new Date().toISOString().slice(0, 10);
  return { version: 1, greeted: {}, bosses: {}, stats: { day: today, sentToday: 0, rounds: 0 } };
}

export function loadGreetState(): GreetState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as GreetState;
    if (!s || typeof s !== 'object') return emptyState();
    s.greeted ??= {};
    s.bosses ??= {};
    s.stats ??= { day: new Date().toISOString().slice(0, 10), sentToday: 0, rounds: 0 };
    return s;
  } catch {
    return emptyState();
  }
}

export function saveGreetState(state: GreetState): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[greet] 状态文件写入失败：' + (e as Error).message);
  }
}

/**
 * 冷却期内的岗位不再打招呼。
 *
 * 「发成功过」按配置的冷却期算（默认 30 天）。
 * **「失败过」只挡一天** —— 失败通常是一次性的（页面没加载好、按钮没找到），
 * 拿它挡 30 天等于把这个岗位永远放弃了。
 */
export function greetedRecently(
  state: GreetState,
  jobId: string,
  cooldownDays: number,
  bossId?: string,
): boolean {
  // ① 按 HR 去重 —— 同一个 HR 挂了好几个岗位也不能打扰多次
  const b = bossId ? state.bosses?.[bossId] : undefined;
  if (b) {
    // 兼容老格式（纯时间戳 = 当成发成功过）
    const at = typeof b === 'number' ? b : b.at;
    const status = typeof b === 'number' ? 'sent' : b.status;
    const days = status === 'sent' ? (cooldownDays <= 0 ? 30 : cooldownDays) : 1;
    if (Date.now() - at < days * 24 * 60 * 60 * 1000) return true;
  }
  // ② 按岗位去重（老记录没有 bossId，只能靠这条兜底）
  const rec = state.greeted[jobId];
  if (!rec) return false;
  const days = rec.status === 'sent' ? cooldownDays : 1;
  if (days <= 0) return true;
  return Date.now() - (rec.at ?? 0) < days * 24 * 60 * 60 * 1000;
}

/**
 * 把老记录的 bossId 回填进 bosses 表（一次性状态迁移，幂等）。
 *
 * 背景：早期只按 jobId 记，同一个 HR 换个岗位还能被找到。
 * 现在跑一圈就能把他认出来 —— 以后他招什么都绕过去。
 * 「按人去重」的完整语义（含这个迁移）都收在本文件。
 */
export function backfillBosses(
  state: GreetState,
  jobs: Array<{ jobId: string; bossId?: string }>,
): void {
  for (const job of jobs) {
    const rec = state.greeted[job.jobId];
    if (rec && job.bossId && !state.bosses[job.bossId]) {
      state.bosses[job.bossId] = { at: rec.at ?? Date.now(), status: rec.status };
    }
  }
}

/** 今天已经打了几个招呼（跨天自动清零） */
export function sentToday(state: GreetState): number {
  const today = new Date().toISOString().slice(0, 10);
  if (state.stats.day !== today) return 0;
  return state.stats.sentToday ?? 0;
}

/** 记一次打招呼 */
export function recordGreeting(
  state: GreetState,
  rec: Omit<GreetRecord, 'at'> & { at?: number },
): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.stats.day !== today) {
    state.stats.day = today;
    state.stats.sentToday = 0;
  }
  state.greeted[rec.jobId] = { ...rec, at: rec.at ?? Date.now() };
  // 按「人」也记一笔 —— 免得他换个岗位又被打扰一次
  // （带上 status：失败的只挡一天，别把人锁死 30 天）
  if (rec.bossId) state.bosses[rec.bossId] = { at: rec.at ?? Date.now(), status: rec.status };
  if (rec.status === 'sent') state.stats.sentToday += 1;
}

/* ---------------- 判断结果缓存 ---------------- */

/**
 * 大模型判断结果的缓存。
 *
 * 为什么缓存：常驻模式下每轮都会把同一批岗位再判一遍 ——
 * 而「这个岗位值不值得投 + 开场白怎么写」一天之内不会变。
 * 不缓存的话，每轮都要为 40 个岗位重新付一次模型的钱。
 */
export const JUDGE_CACHE_FILE = path.join(DATA_DIR, 'greet-judgements.json');

export interface JudgementCacheEntry {
  at: number;
  jobName: string;
  company: string;
  worth: boolean;
  score: number;
  reason: string;
  greeting: string;
  /**
   * 判断时的**简历指纹**。
   *
   * 为什么必须记：判断结果依赖简历内容 —— 改了简历，匹配结论就该重算。
   * 只按 jobId 缓存的话，改完简历 24 小时内都还在用旧结论。
   */
  profileSig?: string;
  /**
   * 岗位元数据（securityId / lid / HR 名字…）。
   *
   * 为什么连它一起存：岗位列表每轮都在轮换 —— 上一轮排第一的岗位，
   * 这一轮可能就不在候选里了。想「补投某个具体岗位」时，光有判断结果
   * 没有 securityId/lid 是拼不出详情页地址的。
   */
  job?: Record<string, any>;
}

/** 缓存多久算新鲜（毫秒） */
export const JUDGE_TTL_MS = 24 * 60 * 60 * 1000;

export function loadJudgeCache(): Record<string, JudgementCacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(JUDGE_CACHE_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export function saveJudgeCache(cache: Record<string, JudgementCacheEntry>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const cutoff = Date.now() - JUDGE_TTL_MS;
    for (const [k, v] of Object.entries(cache)) if ((v?.at ?? 0) < cutoff) delete cache[k];
    fs.writeFileSync(JUDGE_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}
