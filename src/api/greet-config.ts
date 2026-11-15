/**
 * 主动打招呼的配置。
 *
 * 存在 data/greet-config.json（data/ 在 .gitignore 里 —— 里面可能有 key，不进仓库）。
 * 没这个文件就用默认值。
 *
 * ⚠️ 这里的「间隔」是**礼貌节奏**，不是「等某个状态」：
 *    它决定「隔多久跟下一个 HR 打招呼」，跟网络快慢无关。
 *    真正决定「能不能发」的是状态（聊天面板开没开、按钮解没解禁）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './llm.js';
import type { LlmConfig } from './llm.js';

export const CONFIG_FILE = path.join(DATA_DIR, 'greet-config.json');

export interface GreetConfig {
  /** 搜索关键词（走搜索接口那条路） */
  query: string;
  /** 城市码列表 —— 每个城市各取一遍推荐 + 搜索 */
  cities: string[];
  /** 薪资下限（K）。0 = 不限 */
  salaryMinK: number;
  /** 学历白名单（空 = 不限） */
  degrees: string[];
  /** 经验白名单（空 = 不限），按 JD 里的「3-5年」这种原文匹配 */
  experiences: string[];
  /** 每个来源翻几页 */
  pages: number;
  /** 送去给模型判的岗位上限（先粗筛再取 JD，别把 450 个全拉一遍） */
  candidates: number;
  /** 一批问模型几个岗位 */
  batchSize: number;
  /** 每轮最多跟几个 HR 打招呼（0 = 不限） */
  perRound: number;
  /** 每轮最少间隔多久（秒）—— 常驻模式两轮之间的休息 */
  roundGapSec: number;
  /** 每天最多跟几个 HR 打招呼（0 = 不限） */
  dailyLimit: number;
  /** 两个招呼之间的间隔（秒），在 [min, max] 里随机 */
  intervalMinSec: number;
  intervalMaxSec: number;
  /** 已沟通过的岗位多久之内不再打招呼（天） */
  cooldownDays: number;
  /** 大模型配置（可被环境变量覆盖） */
  llm?: Partial<LlmConfig>;
}

export const DEFAULT_CONFIG: GreetConfig = {
  query: '大模型算法',
  cities: ['101010100', '101280600'], // 北京、深圳
  salaryMinK: 0,
  degrees: [],
  experiences: [],
  pages: 1,
  candidates: 40,
  batchSize: 4,
  perRound: 20,
  dailyLimit: 0,
  roundGapSec: 300,
  intervalMinSec: 120,
  intervalMaxSec: 300,
  cooldownDays: 30,
};

/** 读配置（文件里没写的项用默认值） */
export function loadGreetConfig(): GreetConfig {
  let file: any = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  } catch {
    file = {};
  }
  const cfg: GreetConfig = { ...DEFAULT_CONFIG, ...file };
  cfg.cities = Array.isArray(cfg.cities) && cfg.cities.length ? cfg.cities : DEFAULT_CONFIG.cities;
  cfg.llm = file.llm;
  return cfg;
}

/** 写配置（存盘用） */
export function saveGreetConfig(cfg: GreetConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
