/**
 * 岗位来源 —— 「主动投递」的弹药从这儿来。
 *
 * **只走职位页的「推荐」区**（用户 2026-11-15 定的）：
 *   /wapi/zpgeek/pc/recommend/expect/list.json  → 期望项（大模型算法 深圳/北京）
 *   /wapi/zpgeek/pc/recommend/job/list.json     → 该期望下的岗位（15 条/页）
 *
 * 为什么走接口而不是读 DOM —— 接口给的是**明文薪资**，
 * 页面上那个数字是自定义字体渲染的，DOM 里读出来是空的。
 *
 * JD 正文单独取：/wapi/zpgeek/job/detail.json?securityId=…&lid=…
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './llm.js';
import { pageApiJson } from './page-transport.js';

export const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs?ka=header-jobs';

/**
 * 「被风控了」—— list 类接口返回 code=37。
 *
 * 单独一个错误类型，是为了调用方能**跳过剩下的列表请求**：
 * 被挡了之后再打下一个，只会再被挡一次（每次还白等一个安静期）。
 */
export class RateLimitedError extends Error {
  constructor(url: string) {
    super('被风控了（code=37）：' + url);
    this.name = 'RateLimitedError';
  }
}

/** 列表接口被挡了就抛这个错（其它错误照常抛） */
function assertNotBlocked(json: any, url: string): void {
  if (Number(json?.code) === 37) throw new RateLimitedError(url);
}

/**
 * JD 缓存 —— 详情接口是最慢的一环（实测一条 1.4 秒，40 条要近一分钟）。
 *
 * 岗位列表每轮都会推同样的岗位出来，JD 却不会变 —— 缓存住，
 * 下一轮就不用重新拉一遍。
 */
const JD_CACHE_FILE = path.join(DATA_DIR, 'jd-cache.json');
const JD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface JdCacheEntry {
  at: number;
  jd: string;
  address: string;
  bossName: string;
  /** HR 的唯一 id（encryptBossId）—— 去重要按「人」而不是按「岗位」 */
  bossId: string;
  bossTitle: string;
  activeTime: string;
  company: string;
  scale: string;
  stage: string;
  industry: string;
}

function loadJdCache(): Record<string, JdCacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(JD_CACHE_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function saveJdCache(cache: Record<string, JdCacheEntry>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 顺手裁掉过期和太旧的，别让文件无限涨
    const cutoff = Date.now() - JD_CACHE_TTL_MS;
    for (const [k, v] of Object.entries(cache)) if ((v?.at ?? 0) < cutoff) delete cache[k];
    fs.writeFileSync(JD_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

const API = 'https://www.zhipin.com/wapi/zpgeek';

/** 常用城市码（BOSS 的 city 参数） */
export const CITY_CODES: Record<string, string> = {
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  南京: '101190100',
  武汉: '101200100',
  西安: '101110100',
  苏州: '101190400',
  天津: '101030100',
  重庆: '101040100',
  合肥: '101220100',
  长沙: '101250100',
  青岛: '101120200',
};

/** BOSS 的筛选码 */
export const FILTER_CODES = {
  /** 工作经验 */
  experience: {
    '经验不限': '101', '在校/应届': '102', '1年以内': '103', '1-3年': '104',
    '3-5年': '105', '5-10年': '106', '10年以上': '107',
  },
  /** 学历要求 */
  degree: {
    '学历不限': '201', '初中及以下': '202', '中专/中技': '203', '高中': '204',
    '大专': '205', '本科': '206', '硕士': '207', '博士': '208',
  },
  /** 薪资待遇 */
  salary: {
    '3K以下': '401', '3-5K': '402', '5-10K': '403', '10-15K': '404',
    '15-20K': '405', '20-30K': '406', '30-50K': '407', '50K以上': '408',
  },
};

/** 岗位（列表里的通用形态） */
export interface Job {
  /** encryptJobId —— 岗位唯一标识，也是点「立即沟通」时 ka 参数里的那段 */
  jobId: string;
  /** securityId —— 取 JD 正文要用 */
  securityId: string;
  /** lid —— 列表上下文 id，取 JD 正文时一起带上 */
  lid: string;
  name: string;
  /** 明文薪资，如 "30-60K·16薪" */
  salary: string;
  experience: string;
  degree: string;
  company: string;
  city: string;
  district: string;
  /** 公司规模 / 阶段 / 行业 */
  scale: string;
  stage: string;
  industry: string;
  /** HR */
  bossName: string;
  /** HR 的唯一 id（encryptBossId）—— 去重要按「人」而不是按「岗位」 */
  bossId: string;
  bossTitle: string;
  /** 技能标签 */
  tags: string[];
  /** 福利 */
  welfare: string[];
  /** 来自哪个期望（推荐区才有） */
  expectLabel?: string;
  source: 'recommend' | 'search';
}

/** BOSS 里的期望工作项 */
export interface ExpectItem {
  encryptId: string;
  positionName: string;
  locationName: string;
  location: string;
  salary: string;
  lowSalary: number;
  highSalary: number;
}

/** 岗位详情（JD 正文 + HR） */
export interface JobDetail {
  jd: string;
  address: string;
  bossName: string;
  /** HR 的唯一 id（encryptBossId）—— 去重要按「人」而不是按「岗位」 */
  bossId: string;
  bossTitle: string;
  activeTime: string;
  company: string;
  scale: string;
  stage: string;
  industry: string;
}

/** 列表接口的原始条目 → Job */
function toJob(raw: any, source: 'recommend' | 'search', expectLabel?: string): Job {
  return {
    jobId: String(raw?.encryptJobId ?? ''),
    securityId: String(raw?.securityId ?? ''),
    lid: String(raw?.lid ?? ''),
    name: String(raw?.jobName ?? ''),
    salary: String(raw?.salaryDesc ?? ''),
    experience: String(raw?.jobExperience ?? ''),
    degree: String(raw?.jobDegree ?? ''),
    company: String(raw?.brandName ?? ''),
    city: String(raw?.cityName ?? ''),
    district: [raw?.areaDistrict, raw?.businessDistrict].filter(Boolean).join('·'),
    scale: String(raw?.brandScaleName ?? ''),
    stage: String(raw?.brandStageName ?? ''),
    industry: String(raw?.brandIndustry ?? ''),
    bossName: String(raw?.bossName ?? ''),
    bossId: String(raw?.encryptBossId ?? ''),
    bossTitle: String(raw?.bossTitle ?? ''),
    tags: Array.isArray(raw?.jobLabels) ? raw.jobLabels.map((t: any) => String(t?.name ?? t)).filter(Boolean) : [],
    welfare: Array.isArray(raw?.welfareList) ? raw.welfareList.map((t: any) => String(t?.name ?? t)) : [],
    expectLabel,
    source,
  };
}

/** 读期望工作列表（大模型算法 深圳 / 北京 …） */
export async function listExpects(): Promise<ExpectItem[]> {
  const url = `${API}/pc/recommend/expect/list.json`;
  const json = await pageApiJson(url);
  assertNotBlocked(json, url);
  const list = json?.zpData?.expectList;
  if (!Array.isArray(list)) return [];
  return list.map((e: any) => ({
    encryptId: String(e?.encryptId ?? ''),
    positionName: String(e?.positionName ?? ''),
    locationName: String(e?.locationName ?? ''),
    location: String(e?.location ?? ''),
    salary: String(e?.salary ?? ''),
    lowSalary: Number(e?.lowSalary ?? 0),
    highSalary: Number(e?.highSalary ?? 0),
  }));
}

/**
 * 读某个期望下的推荐岗位。
 *
 * 页面自己用的是 pageSize=15，翻页靠 page 参数。
 */
export async function listRecommendJobs(
  expect: ExpectItem,
  page = 1,
  pageSize = 15,
): Promise<Job[]> {
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    city: expect.location,
    encryptExpectId: expect.encryptId,
    mixExpectType: '',
    expectInfo: '',
    jobType: '',
    salary: '',
    experience: '',
    degree: '',
    industry: '',
    scale: '',
  });
  const url = `${API}/pc/recommend/job/list.json?${qs}`;
  const json = await pageApiJson(url);
  assertNotBlocked(json, url);
  const list = json?.zpData?.jobList;
  if (!Array.isArray(list)) return [];
  const label = `${expect.positionName}（${expect.locationName}）`;
  return list.map((r: any) => toJob(r, 'recommend', label));
}

/**
 * 取岗位 JD 正文。
 *
 * 详情接口要 securityId + lid 两个参数 —— 少了会 code=37 或者 404。
 * 结果进缓存（JD 不会变，列表每轮却会重复推同样的岗位）。
 */
export async function fetchJobDetail(job: Job): Promise<JobDetail> {
  const cache = loadJdCache();
  const hit = cache[job.jobId];
  if (hit && Date.now() - (hit.at ?? 0) < JD_CACHE_TTL_MS) {
    return {
      jd: hit.jd,
      address: hit.address,
      bossName: hit.bossName,
      bossId: String(hit.bossId ?? job.bossId ?? ''),
      bossTitle: hit.bossTitle,
      activeTime: hit.activeTime,
      company: hit.company,
      scale: hit.scale,
      stage: hit.stage,
      industry: hit.industry,
    };
  }

  const qs = new URLSearchParams({ securityId: job.securityId, lid: job.lid });
  const url = `${API}/job/detail.json?${qs}`;
  const json = await pageApiJson(url);
  assertNotBlocked(json, url);
  const d = json?.zpData ?? {};
  const ji = d.jobInfo ?? {};
  const bi = d.bossInfo ?? {};
  const ci = d.brandComInfo ?? {};
  const detail: JobDetail = {
    jd: String(ji.postDescription ?? ''),
    address: String(ji.address ?? ji.locationName ?? ''),
    bossName: String(bi.name ?? job.bossName),
    bossId: String(bi.encryptFriendId ?? bi.bossId ?? job.bossId ?? ''),
    bossTitle: String(bi.title ?? job.bossTitle),
    activeTime: String(bi.activeTimeDesc ?? ''),
    company: String(ci.brandName ?? job.company),
    scale: String(ci.scaleName ?? job.scale),
    stage: String(ci.stageName ?? job.stage),
    industry: String(ci.industryName ?? job.industry),
  };

  cache[job.jobId] = { at: Date.now(), ...detail };
  saveJdCache(cache);
  return detail;
}

/** 薪资下限（K）—— 从 "30-60K·15薪" 里抠出 30 */
export function salaryLowK(job: Job): number {
  const m = job.salary.match(/(\d+)\s*-\s*(\d+)\s*K/i);
  if (m) return Number(m[1]);
  const one = job.salary.match(/(\d+)\s*K/i);
  return one ? Number(one[1]) : 0;
}
