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
  /**
   * 每个来源翻几页。
   *
   * ⚠️ **这里不提供「薪资下限 / 学历 / 年限」这类筛选** —— 用户 2026-11-15 明确判断过：
   *    列表接口白送的这些字段**不一定是真的门槛**（很多岗位照模板写的），
   *    真匹不匹配要看 JD 内容，那是模型的活。
   *    所以配置里就不放这些开关，免得看着能调其实没接线。
   */
  pages: number;
  /**
   * 一轮里最多**处理**几个岗位（开详情页 + 问模型）。
   *
   * 为什么要有这个上限：处理一个岗位 = 一次详情页加载（3~8 秒）+ 一次模型调用。
   * 没有上限的话，一轮可能把推荐区几十个岗位全跑一遍（又慢又烧钱），
   * 而且「本轮上限」只数**发成功**的 —— 一路失败的话根本停不下来。
   */
  candidates: number;
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
  pages: 1,
  candidates: 30,
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
  cfg.llm = file.llm;
  return cfg;
}

/** 写配置（存盘用） */
export function saveGreetConfig(cfg: GreetConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
