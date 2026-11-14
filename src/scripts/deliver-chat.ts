/**
 * 在聊天窗口里给对方发附件简历（BOSS 网页端点「发简历」按钮的那条路）。
 *
 * 为什么不用 HTTP 接口：
 *   - POST /wapi/zpgeek/resume/onekeydeliver.json  → 猎头岗位返回 code=1「不支持一键投递」
 *   - POST /wapi/zpchat/exchange/videoResume/accept → code=1049「交换视频简历失败」
 *   - 岗位页上猎头岗位根本没有投递按钮（只有「感兴趣」「立即沟通」）
 * 「发简历」本质是发一条聊天消息（走 MQTT），所以只能让浏览器自己点。
 *
 * 页面流程（实测）：
 *   ① 点会话列表里的 HR  →  ② 点工具栏「发简历」(.toolbar-btn:not([class*="btn-"]))
 *   →  ③ 弹窗「确定向 Boss 发送简历吗？」(.panel-resume)  →  ④ 点「确定」
 * 每一步都先校验再继续，认错人就不会发出去。
 *
 * 用法：
 *   node ... src/scripts/deliver-chat.ts <姓名> [公司关键词]            只看目标，不动作
 *   node ... src/scripts/deliver-chat.ts <姓名> [公司关键词] --confirm  真的发
 */
import { createBrowserClient } from '../api/browser-client.js';
import { CHAT_URL } from '../api/constants.js';
import { runActions } from '../api/page-transport.js';
import {
  requireLogin,
  probeLogin,
  listSessions,
  listMessages,
  isResumeMessage,
} from '../api/messages.js';

const CHAT = CHAT_URL;
const SEND_RESUME_BTN = '.toolbar-btn:not([class*="btn-"])';
const CONFIRM_BTN = '.panel-resume .btn-sure-v2';

async function main() {
  const who = process.argv[2] ?? '';
  const brand = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  const doConfirm = process.argv.includes('--confirm');
  if (!who) {
    console.error('用法：deliver-chat.ts <HR姓名> [公司关键词] [--confirm]');
    process.exit(1);
  }

  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  const p = requireLogin(await probeLogin(client));

  // —— 定位会话 ——
  const sessions = await listSessions(client, { labelId: 0 });
  const hits = sessions.filter((s) => {
    const nameHit = s.name?.includes(who) || who.includes(s.name ?? '');
    const brandHit = !brand || s.brandName?.includes(brand);
    return nameHit && brandHit;
  });
  if (hits.length !== 1) {
    console.log(hits.length ? `有 ${hits.length} 个匹配，请补公司关键词：` : `没找到「${who}」`);
    for (const s of hits) console.log(`  ${s.name} · ${s.brandName} · ${s.jobName ?? ''} · friendId ${s.friendId}`);
    process.exit(1);
  }
  const target = hits[0];
  const raw = target.raw as any;

  // —— 我的附件简历 ——
  const res: any = await client.request('/wapi/zpgeek/resume/attachment/checkbox.json', { method: 'GET' });
  const resumes = res?.zpData?.resumeList ?? [];

  // —— 投递记录查重 ——
  const del: any = await client.request('/wapi/zprelation/resume/geekDeliverList', { method: 'GET' });
  const cards = del?.zpData?.cardList ?? [];
  const delivered = cards.some((c: any) => String(c.bossId) === String(target.friendId));

  console.log('════ 投递目标 ════');
  console.log(`  HR       : ${target.name} · ${target.brandName ?? ''}（${target.bossTitle ?? ''}）`);
  console.log(`  职位     : ${raw?.jobName ?? '(无)'} · ${target.jobCity ?? ''} · jobId ${raw?.jobId ?? '?'}`);
  console.log(`  friendId : ${target.friendId} · relationType ${raw?.relationType}`);
  console.log(`  附件简历 : ${resumes.map((r: any) => r.showName ?? r.resumeId).join(', ') || '(无)'}`);
  console.log(`  投递记录 : ${cards.length} 条${delivered ? '  ⚠️ 里面已有同名 HR，投递前请确认' : '，没有他 → 未重复投递'}`);

  if (!doConfirm) {
    // 顺带把当前聊天记录打出来，投递前先看聊到哪了
    const msgs = await listMessages(client, target, { limit: 8 });
    console.log('\n──── 最近的聊天记录 ────');
    for (const m of msgs.slice(-6)) {
      const t = m.time
        ? new Date(m.time).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '';
      const dir = m.from === 'me' ? '我' : m.from === 'peer' ? 'HR' : '系统';
      console.log(`  [${dir}] ${t}  ${String(m.text).replace(/\n/g, ' ⏎ ').slice(0, 70)}`);
    }
    console.log('\n⟨dry-run⟩ 将在聊天窗口点「发简历」→「确定」。加 --confirm 执行。');
    return;
  }

  // —— ① 打开会话并核对 ——
  console.log('\n① 打开会话…');
  const r1 = await runActions(CHAT, [
    { type: 'clickText', text: target.name ?? '', exact: true, after: 1600 },
    { type: 'wait', ms: 1200 },
    { type: 'dump', selector: '.chat-conversation', limit: 2, textLimit: 200 },
  ]);
  const conv = r1.find((r) => r.type === 'dump')?.items?.[0]?.text ?? '';
  // ⚠️ 同名 HR 可能不止一个（同一个账号里见过 5 个同名的）。
  // 会话标题里没有公司名，但有职位名 —— 所以用「姓名 + 职位」双重校验。
  const nameOk = conv.includes(target.name ?? '');
  const jobOk = !target.raw?.jobName || conv.includes(String(target.raw.jobName));
  if (!nameOk || !jobOk) {
    console.error(
      `❌ 打开的会话与目标不符，已中止（姓名${nameOk ? '✓' : '✗'} 职位${jobOk ? '✓' : '✗'}）：` +
        `${conv.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
    process.exit(1);
  }
  console.log(`   当前会话: ${conv.replace(/\s+/g, ' ').slice(0, 90)}`);

  // —— ② 点「发简历」并核对弹窗 ——
  console.log('\n② 点「发简历」…');
  const r2 = await runActions(CHAT, [
    { type: 'click', selector: SEND_RESUME_BTN, after: 2500 },
    { type: 'wait', ms: 1200 },
    { type: 'dump', selector: '.panel-resume', limit: 2, textLimit: 200 },
  ]);
  const panel = r2.find((r) => r.type === 'dump')?.items?.[0]?.text ?? '';
  if (!panel.includes('发送简历')) {
    console.error(`❌ 没有出现确认弹窗，已中止：${panel.slice(0, 120)}`);
    process.exit(1);
  }
  console.log(`   弹窗: ${panel.replace(/\s+/g, ' ').slice(0, 90)}`);

  // —— ③ 点「确定」 ——
  console.log('\n③ 点「确定」（这一步会真的发起投递）…');
  const r3 = await runActions(CHAT, [
    { type: 'click', selector: CONFIRM_BTN, after: 3000 },
    { type: 'wait', ms: 2000 },
    { type: 'dump', selector: '.im-list .message-item', limit: 8, textLimit: 120 },
  ]);
  for (const it of r3.find((r) => r.type === 'dump')?.items ?? []) {
    console.log(`   · ${(it.text || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  }

  // —— ④ 验证 ——
  console.log('\n④ 服务端验证…');
  const fresh = await listSessions(client, { labelId: 0 });
  const s2 = fresh.find((x) => String(x.friendId) === String(target.friendId)) ?? target;
  const msgs = await listMessages(client, s2, { limit: 10 });
  const hasResume = msgs.some(isResumeMessage);
  for (const m of msgs.slice(-4)) {
    console.log(
      `   [${m.from === 'me' ? '我' : m.from === 'peer' ? 'HR' : '系统'}] ` +
        `${m.time ? new Date(m.time).toLocaleString('zh-CN', { hour12: false }) : ''} ${String(m.text).slice(0, 60)}`,
    );
  }
  console.log(
    hasResume
      ? '\n✅ 简历已发起投递（等待 Boss 确认后送达）'
      : '\n⚠️ 会话里没看到简历消息，请人工确认',
  );
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
