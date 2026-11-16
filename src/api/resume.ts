/**
 * 我的在线简历 —— 「根据我的信息」的那一半。
 *
 * 来源：/web/geek/resume（BOSS 里维护的在线简历）
 * 通过扩展的 resume 页面函数分块读回来（见 extension/background.js 的 pageResumeTask）。
 *
 * 为什么不读附件简历（PDF）：那个要下载 + 解析，在线简历本身就是结构化文本，
 * 而且 HR 看到的也是这份 —— 拿它做匹配才对得上。
 */
import { createHash } from 'node:crypto';

import { closeTabsOpenedSince, runPageFnFull, tabIdsSnapshot } from './page-transport.js';
import { sleep } from './util.js';

export const RESUME_URL = 'https://www.zhipin.com/web/geek/resume';

export interface ResumeBlock {
  title: string;
  text: string;
}

/**
 * 简历指纹 —— 判断结果缓存的钥匙。
 *
 * 改了简历（加项目、改优势），匹配结论就该重算；
 * 用「摘要的哈希」当指纹，缓存一比对就知道该不该作废。
 */
export function profileSignature(summary: string): string {
  return createHash('sha1').update(summary).digest('hex').slice(0, 12);
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

/**
 * 摘要里保留哪几块。
 *
 * 用户定的（2026-11-15，最后一版）：
 *   - **只留个人优势**，全不截断 —— 技术栈自述，判断匹不匹配和写开场白都用它
 *   - 项目经历也拿掉：写给 HR 的招呼语里罗列项目太刻意，而且 HR 看不懂那些细节
 *   - 其余（期望职位 / 工作经历 / 专业技能 / 教育经历 / 资格证书 / 其它）全不要
 */
const SUMMARY_BLOCKS = ['个人优势'];

/**
 * 读我的在线简历。
 *
 * ⚠️ **等状态，不等时长**：简历页是 SPA，页面加载完 ≠ 内容渲染好了。
 * 之前固定等 1.5 秒就读，实测读到过**空页面**（拿到的 blocks 是空的，
 * 后面模型就拿着空简历去判断）。现在一直读到真的有内容为止。
 *
 * 复用同一个标签页重试（不每读一次就开一个新页）。
 */
export async function readMyProfile(): Promise<MyProfile> {
  const deadline = Date.now() + 15_000;
  let tabId: number | null = null;
  let r: any = null;

  // 开页面前拍个快照 —— 读完把「这次新出现的标签页」全关掉
  // （实测一次调用会多开一个同样地址的页面，只关自己那个就会漏）
  const tabsBefore = await tabIdsSnapshot();

  for (;;) {
    const res: any = await runPageFnFull(
      'resume',
      { mode: 'read' },
      { url: RESUME_URL, own: true, keep: true, tabId: tabId ?? undefined },
    ).catch((e: any) => {
      // 失败时也要记住 tabId —— 否则这个标签页永远关不掉（泄漏）。
      // 扩展的错误信封里现在会带 tabId。
      if (e?.tabId) tabId = e.tabId;
      return null;
    });
    tabId = res?.tabId ?? tabId;
    r = res?.data ?? null;
    if (r?.ok && (r.blocks?.length ?? 0) > 0) break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  // 关掉这次新出现的所有标签页（我们自己开的 + 多出来那个）
  await closeTabsOpenedSince(tabsBefore).catch(() => {});
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

  // 摘要 = 只留个人优势，**一段不截**。
  //
  // ⚠️ 个人优势读不到时**宁可报错**，也不退回用全部块 ——
  //    全部块里含工作经历和项目经历，而用户明确要求这两块不进当前工作流
  //    （工作经历他之后要重新包装）。宁停一轮，也不要偷偷换个输入源。
  const picked = blocks.filter((b) => SUMMARY_BLOCKS.includes(b.title));
  if (!picked.length) {
    throw new Error(
      `简历里没读到「${SUMMARY_BLOCKS.join('/')}」这一块（页面可能改版了）—— ` +
      `读到的块有：${blocks.map((b) => b.title).join('、') || '(空)'}`,
    );
  }
  const summary = picked.map((b) => `【${b.title}】${b.text}`).join('\n');

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
