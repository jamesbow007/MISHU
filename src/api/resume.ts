/**
 * 我的在线简历 —— 「根据我的信息」的那一半。
 *
 * 来源：/web/geek/resume（BOSS 里维护的在线简历）
 * 通过扩展的 resume 页面函数分块读回来（见 extension/background.js 的 pageResumeTask）。
 *
 * 为什么不读附件简历（PDF）：那个要下载 + 解析，在线简历本身就是结构化文本，
 * 而且 HR 看到的也是这份 —— 拿它做匹配才对得上。
 */
import { runPageFn } from './page-transport.js';

export const RESUME_URL = 'https://www.zhipin.com/web/geek/resume';

export interface ResumeBlock {
  title: string;
  text: string;
}

export interface MyProfile {
  name: string;
  degree: string;
  experience: string;
  status: string;
  phone: string;
  email: string;
  /** 期望职位原文，如 "大模型算法25-35K深圳" */
  expects: string[];
  blocks: ResumeBlock[];
  /** 完整文本（所有块拼起来） */
  full: string;
  /** 给大模型用的精简摘要 */
  summary: string;
}

/** 各块在摘要里最多留多少字 —— 项目经历最长，不截的话一个岗位的 JD 都不够地方放了 */
const SUMMARY_LIMIT: Record<string, number> = {
  个人优势: 800,
  期望职位: 200,
  工作经历: 900,
  项目经历: 2200,
  专业技能: 600,
  教育经历: 300,
};

/** 读我的在线简历 */
export async function readMyProfile(): Promise<MyProfile> {
  const r = await runPageFn('resume', { mode: 'read' }, { url: RESUME_URL, own: true });
  if (!r?.ok) throw new Error('读简历失败：' + (r?.error ?? '未知原因'));

  const info = r.info ?? {};
  const blocks: ResumeBlock[] = (r.blocks ?? []).map((b: any) => ({
    // 用 || 而不是 ??：个人信息那块没有标题（页面里它没有 h3），
    // title 是空串而不是 null —— ?? 不会兜住空串，id 就丢了
    title: String(b?.title || b?.id || ''),
    text: String(b?.text ?? ''),
  }));

  // 姓名：userinfo 那一块的第一段（页面侧取不到，兜在这里取）
  let name = String(info?.name ?? '');
  if (!name) {
    const base = blocks.find((b) => b.title === '个人信息' || b.title === 'userinfo');
    const m = base?.text.match(/^([一-龥]{2,4})\s/);
    if (m) name = m[1]!;
  }

  // 期望职位：从「期望职位」块里拆出来
  const expects: string[] = [];
  const expBlock = blocks.find((b) => b.title === '期望职位');
  if (expBlock) {
    const m = expBlock.text.match(/全职职位(.*)$/);
    const body = m ? m[1]! : expBlock.text;
    // 每一项之间是**空格**（城市列表内部是逗号，不含空格）——
    // 按空格切就行。之前用「中文+数字」前瞻切，会把「大模型算法」切成
    // 大 / 模 / 型 / 算法…（前瞻在词中间也能匹配上）。
    for (const part of body.split(/\s+/)) {
      const t = part.trim();
      if (t) expects.push(t);
    }
  }

  const full = blocks.map((b) => `【${b.title}】${b.text}`).join('\n');

  const summary = blocks
    .map((b) => {
      const limit = SUMMARY_LIMIT[b.title] ?? 300;
      const text = b.text.length > limit ? b.text.slice(0, limit) + '…' : b.text;
      return `【${b.title}】${text}`;
    })
    .join('\n');

  return {
    name,
    degree: String(info?.degree ?? ''),
    experience: String(info?.experience ?? ''),
    status: String(info?.status ?? ''),
    phone: String(info?.phone ?? ''),
    email: String(info?.email ?? ''),
    expects,
    blocks,
    full,
    summary,
  };
}
