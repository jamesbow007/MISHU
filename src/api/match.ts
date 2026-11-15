/**
 * 大模型匹配 + 文案生成 —— 「根据我的信息和工作JD」的那一步。
 *
 * 一条岗位问一次模型：值不值得投（worth/score/reason），
 * 值得投的话顺带把打招呼的第一句话写出来（greeting）。
 *
 * 为什么批量：模型调用是这里最慢的一环（秒级），
 * 一条一条问 30 个岗位要一分多钟；一批 4 条问 8 次，几十秒就完。
 *
 * 为什么让模型判而不写死关键词：他投的是「大模型算法」，
 * 但有的岗位写 RAG 其实只做数据标注、有的写 Agent 其实只调 API ——
 * 关键词命中不等于值得投，模型读 JD 能看出这个差别。
 */
import { chat, extractJson, type LlmConfig } from './llm.js';
import type { Job } from './jobs.js';

export interface Judgement {
  jobId: string;
  /** 值不值得投 */
  worth: boolean;
  /** 匹配分 0~100 */
  score: number;
  /** 一句话理由（给用户看，也给日志看） */
  reason: string;
  /** 打招呼的第一句话（不值得投就是空串） */
  greeting: string;
  /** 模型没给出 / 出错时的备注 */
  error?: string;
}

/** BOSS 聊天框的硬上限 */
export const GREETING_MAX = 300;

const SYSTEM_PROMPT = `你是一位资深求职顾问。你的任务有两件：
1) 判断岗位是否值得我投；
2) 对值得投的岗位，写一句发给 HR 的打招呼第一句话。

判断规则：
- 只根据「我的简历」和「岗位JD」的实质匹配度判断，不要看大厂光环、不要看岗位名好不好听。
- worth=true 的条件：JD 里的核心技术栈，职责或要求，和我简历中内容有**实质交集**（不是只沾边）。
- score 是 0~100 的匹配分，worth=true 的岗位给 60~100，false 的给 0~59。

写 greeting 的规则（非常重要）：
- 长度：不超过 120 个汉字。BOSS 聊天框上限 300 字符，宁短勿长。
- 语气：像一个真人在打招呼，口语、干脆。
- 内容：只从「个人优势」里挑和这个 JD 对得上的说 —— 技术栈、做过哪类事、经验年限；不要吹嘘简历里没有的东西。
- 不要罗列项目经历、项目名、具体指标（62%→93% 这种）—— 给 HR 的招呼语里写这些太刻意，而且他们也看不懂。
- 不值得投的岗位，greeting 写空字符串。

只输出 JSON，不要任何解释文字。格式：
{"results":[{"jobId":"...","worth":true,"score":85,"reason":"一句话理由","greeting":"打招呼的话"}]}`;

/** 一条岗位给模型看的内容 */
function jobPayload(job: Job, jd: string) {
  return {
    jobId: job.jobId,
    岗位: job.name,
    公司: job.company,
    城市: job.city + (job.district ? '·' + job.district : ''),
    薪资: job.salary,
    要求经验: job.experience,
    要求学历: job.degree,
    公司规模: job.scale,
    公司阶段: job.stage,
    行业: job.industry,
    技能标签: job.tags,
    福利: job.welfare.slice(0, 6),
    JD: jd.slice(0, 2200),
  };
}

/**
 * 批量判断 + 生成文案。
 *
 * jobs 里每条都要带 JD（`jd` 字段）—— 没 JD 判断不了。
 * 某一批挂了就整批标成 error，不影响其它批。
 */
export async function judgeJobs(
  cfg: LlmConfig,
  profileSummary: string,
  jobs: (Job & { jd: string })[],
  opts: { batchSize?: number; onBatch?: (done: number, total: number) => void } = {},
): Promise<Judgement[]> {
  const batchSize = Math.max(1, opts.batchSize ?? 4);
  const results: Judgement[] = [];
  /** 模型少返回的条目 —— 收尾时单独补问一次 */
  const missing: (Job & { jd: string })[] = [];

  const ask = async (batch: (Job & { jd: string })[]) => {
    const user =
      `【我的简历】\n${profileSummary}\n\n` +
      `【待判断的岗位】\n${JSON.stringify(batch.map((j) => jobPayload(j, j.jd)), null, 1)}\n\n` +
      `按上面说的 JSON 格式返回 ${batch.length} 条结果，jobId 必须原样带上。`;

    const raw = await chat(cfg, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ]);
    const parsed = extractJson<{ results?: any[] }>(raw);
    const arr = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : [];

    const got: Judgement[] = [];
    for (const job of batch) {
      const r = arr.find((x: any) => String(x?.jobId ?? '') === job.jobId);
      if (!r) {
        missing.push(job);
        got.push({
          jobId: job.jobId, worth: false, score: 0,
          reason: '模型没返回这一条', greeting: '', error: 'missing',
        });
        continue;
      }
      const greeting = String(r?.greeting ?? '').trim();
      got.push({
        jobId: job.jobId,
        worth: !!r?.worth,
        score: Math.max(0, Math.min(100, Number(r?.score ?? 0))),
        reason: String(r?.reason ?? '').trim(),
        greeting: greeting ? greeting.slice(0, GREETING_MAX) : '',
      });
    }
    return got;
  };

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    try {
      results.push(...(await ask(batch)));
    } catch (e) {
      const msg = (e as Error).message;
      for (const job of batch) {
        results.push({
          jobId: job.jobId, worth: false, score: 0,
          reason: '模型调用失败：' + msg, greeting: '', error: msg.slice(0, 120),
        });
      }
    }
    opts.onBatch?.(Math.min(i + batchSize, jobs.length), jobs.length);
  }

  // 补问：模型偶尔会漏掉几条 —— 单独用小批量再问一遍
  if (missing.length) {
    try {
      const retried = await ask(missing);
      // 补问成功的，用补问的结果替换掉原来那条「没返回」
      for (const r of retried) {
        const idx = results.findIndex((x) => x.jobId === r.jobId);
        if (idx >= 0 && results[idx]?.error === 'missing' && !r.error) results[idx] = r;
      }
    } catch {
      /* 补问也失败就留着原样 */
    }
  }

  return results;
}
