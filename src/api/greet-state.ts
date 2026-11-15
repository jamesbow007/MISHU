/**
 * 主动打招呼的本地状态 —— 记着「哪些岗位已经打过招呼了」。
 *
 * 为什么必须有：岗位列表会反复推同样的岗位，不记的话同一个 HR 会收到
 * 一遍又一遍的招呼（BOSS 会把这种账号判成骚扰）。
 *
 * 按 encryptJobId 记（岗位唯一）—— 不按公司名，因为同一家公司会招很多岗位。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './llm.js';

export const STATE_FILE = path.join(DATA_DIR, 'greet-state.json');

export interface GreetRecord {
  jobId: string;
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
  stats: { day: string; sentToday: number; rounds: number };
}

function emptyState(): GreetState {
  const today = new Date().toISOString().slice(0, 10);
  return { version: 1, greeted: {}, stats: { day: today, sentToday: 0, rounds: 0 } };
}

export function loadGreetState(): GreetState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as GreetState;
    if (!s || typeof s !== 'object') return emptyState();
    s.greeted ??= {};
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
export function greetedRecently(state: GreetState, jobId: string, cooldownDays: number): boolean {
  const rec = state.greeted[jobId];
  if (!rec) return false;
  const days = rec.status === 'sent' ? cooldownDays : 1;
  if (days <= 0) return true;
  return Date.now() - (rec.at ?? 0) < days * 24 * 60 * 60 * 1000;
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
