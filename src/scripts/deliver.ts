/**
 * 投递简历（默认 dry-run，加 --confirm 才真的投）。
 *
 * 接口链路（逆向官方 job bundle `zhipin-geek-seo/v5487/web/geek/js/main.js`）：
 *   1) GET  /wapi/zpgeek/resume/attachment/checkbox.json      → 可选的附件简历列表
 *   2) POST /wapi/zpgeek/resume/onekeydeliver/precheck.json   → {jobId, securityId} 是否已投递
 *   3) GET  /wapi/zpgeek/hkapplyjob/prechat/dialog/query.json → 猎头场景的前置提示弹窗
 *      POST /wapi/zpgeek/hkapplyjob/prechat/dialog/confirm.json → {securityId, optType, source:1}
 *   4) POST /wapi/zpgeek/resume/onekeydeliver.json             → {securityId, resumeId, jobId}
 *
 * 用法：
 *   node ... src/scripts/deliver.ts <姓名>            只预检（dry-run）
 *   node ... src/scripts/deliver.ts <姓名> --confirm   真投递
 */
import { createBrowserClient } from '../api/browser-client.js';
import { requireLogin, probeLogin, listSessions } from '../api/messages.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function main() {
  const who = process.argv[2] ?? '';
  const brand = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  const doConfirm = process.argv.includes('--confirm');
  if (!who) {
    console.error('用法：deliver.ts <HR姓名> [公司关键词] [--confirm]');
    process.exit(1);
  }

  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  const p = requireLogin(await probeLogin(client));
  console.log(`登录态: 已登录  ${p.user?.name}\n`);

  // —— 定位会话（姓名 + 公司关键词）——
  const sessions = await listSessions(client, { labelId: 0 });
  const hits = sessions.filter((s) => {
    const nameHit = s.name?.includes(who) || who.includes(s.name ?? '');
    const brandHit = !brand || s.brandName?.includes(brand);
    return nameHit && brandHit;
  });
  if (!hits.length) {
    console.log(`没找到姓名/公司含「${who}」的会话`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.log(`有 ${hits.length} 个匹配，请更具体：`);
    for (const s of hits) console.log(`  ${s.name} · ${s.brandName} · ${s.jobName ?? ''} · ${s.friendId}`);
    process.exit(1);
  }
  const s = hits[0];
  const raw = s.raw as any;

  console.log('════ 投递目标 ════');
  console.log(`  HR      : ${s.name} · ${s.brandName ?? ''}（${s.bossTitle ?? ''}）`);
  console.log(`  职位    : ${s.jobName ?? '(无)'} ${s.jobCity ?? ''}`);
  console.log(`  会话key : ${s.key} / friendId ${s.friendId}`);
  console.log(`  securityId  : ${s.securityId ?? '(无)'}`);
  console.log(`  jobId       : ${raw?.jobId ?? '(无)'}`);
  console.log(`  encryptJobId: ${raw?.encryptJobId ?? '(无)'}`);

  // —— 1) 附件简历列表 ——
  const resumes: any = await client.request('/wapi/zpgeek/resume/attachment/checkbox.json', {
    method: 'GET',
  });
  const list = resumes?.zpData?.resumeList ?? [];
  console.log('\n════ 可选附件简历 ════');
  if (!list.length) {
    console.log('  ⚠️ 没有附件简历！投递需要 resumeId');
  }
  for (const [i, r] of list.entries()) {
    console.log(
      `  ${i + 1}. resumeId=${r.resumeId ?? r.encryptId}  encryptId=${r.encryptId ?? ''}  ` +
        `文件=${r.fileName ?? r.name ?? '(未知)'}  更新=${r.updateTime ? new Date(r.updateTime).toLocaleDateString('zh-CN') : '?'}`,
    );
  }

  const securityId = String(s.securityId ?? '');
  const jobId = String(raw?.jobId ?? '');
  const resumeId = String(list[0]?.resumeId ?? list[0]?.encryptId ?? '');

  // —— 2) 是否已投递 ——
  let precheck: any = null;
  try {
    precheck = await client.request('/wapi/zpgeek/resume/onekeydeliver/precheck.json', {
      method: 'POST',
      body: `jobId=${encodeURIComponent(jobId)}&securityId=${encodeURIComponent(securityId)}`,
      headers: FORM,
    });
    console.log(
      `\n════ 预检 ════\n  code=${precheck?.code} message=${precheck?.message ?? ''} 已投递=${precheck?.zpData?.result ? '是' : '否'}`,
    );
  } catch (e) {
    console.log(`\n  预检失败：${(e as Error).message}`);
  }

  // —— 3) 猎头场景前置弹窗 ——
  let dialog: any = null;
  try {
    const q: any = await client.request('/wapi/zpgeek/hkapplyjob/prechat/dialog/query.json', {
      method: 'GET',
      query: { securityId },
    });
    dialog = q?.zpData?.dialog ?? null;
    console.log('\n════ 猎头前置提示 ════');
    if (dialog) {
      console.log(`  标题: ${dialog.title ?? ''}`);
      console.log(`  内容: ${String(dialog.content ?? '').replace(/<[^>]+>/g, '').slice(0, 300)}`);
      console.log(`  按钮: ${(dialog.buttonList ?? []).map((b: any) => `${b.text}(optType=${b.optType ?? b.value ?? '?'})`).join(' / ')}`);
    } else {
      console.log('  无（直接投递）');
    }
  } catch (e) {
    console.log(`\n  猎头弹窗查询失败：${(e as Error).message}`);
  }

  // —— 汇总 ——
  console.log('\n════ 将要执行的请求 ════');
  console.log(`  POST /wapi/zpgeek/resume/onekeydeliver.json`);
  console.log(`       securityId=${securityId}`);
  console.log(`       resumeId=${resumeId}`);
  console.log(`       jobId=${jobId}`);
  if (dialog) {
    console.log(`  POST /wapi/zpgeek/hkapplyjob/prechat/dialog/confirm.json  (先过前置弹窗)`);
  }

  if (!doConfirm) {
    console.log('\n⟨dry-run⟩ 未执行。确认无误后加 --confirm 才会真的投递。');
    return;
  }

  if (!resumeId) {
    console.error('\n❌ 没有 resumeId，无法投递');
    process.exit(1);
  }

  // —— 4) 猎头弹窗确认（如有）——
  if (dialog) {
    const btns = dialog.buttonList ?? [];
    const confirmBtn = btns[btns.length - 1];
    const optType = confirmBtn?.optType ?? confirmBtn?.value ?? 1;
    console.log(`\n→ 确认前置弹窗（optType=${optType}）`);
    const c: any = await client.request('/wapi/zpgeek/hkapplyjob/prechat/dialog/confirm.json', {
      method: 'POST',
      body: `securityId=${encodeURIComponent(securityId)}&optType=${encodeURIComponent(String(optType))}&source=1`,
      headers: FORM,
    });
    console.log(`  code=${c?.code} ${c?.message ?? ''}`);
    if (c?.code !== 0) {
      console.error('❌ 前置弹窗确认失败，停止投递');
      process.exit(1);
    }
  }

  // —— 5) 投递 ——
  // 一键投递（普通岗位）；猎头岗位服务端会返回 code=1「该职位不支持一键投递简历」
  console.log('\n→ 正在投递（一键投递）…');
  const res: any = await client.request('/wapi/zpgeek/resume/onekeydeliver.json', {
    method: 'POST',
    body:
      `securityId=${encodeURIComponent(securityId)}` +
      `&resumeId=${encodeURIComponent(resumeId)}` +
      `&jobId=${encodeURIComponent(jobId)}`,
    headers: FORM,
  });
  console.log(`  code=${res?.code} message=${res?.message ?? ''}`);

  if (res?.code === 0) {
    console.log('\n✅ 投递成功 —— 附件简历已发送给该 HR');
    return;
  }

  // —— 5b) 回退：聊天里发送附件简历（猎头岗位走这条）——
  // 接口来自 chat bundle 的 choose-resume 组件：
  //   普通附件简历 → POST /wapi/zpchat/exchange/videoResume/accept
  //   {securityId, encryptResumeId, mid}
  if (res?.code === 1 && !process.argv.includes('--onekey-only')) {
    console.log('\n→ 该职位不支持一键投递（猎头岗位），改用「聊天中发送附件简历」…');
    const chatRes: any = await client.request('/wapi/zpchat/exchange/videoResume/accept', {
      method: 'POST',
      body:
        `securityId=${encodeURIComponent(securityId)}` +
        `&encryptResumeId=${encodeURIComponent(resumeId)}`,
      headers: FORM,
    });
    console.log(`  code=${chatRes?.code} message=${chatRes?.message ?? ''}`);
    console.log(`  zpData=${JSON.stringify(chatRes?.zpData ?? {}).slice(0, 400)}`);
    if (chatRes?.code === 0) {
      console.log('\n✅ 投递成功 —— 附件简历已在聊天中发送给该 HR');
      return;
    }
    console.log('\n❌ 聊天投递也未成功');
    process.exit(1);
  }

  console.log('\n❌ 投递未成功');
  process.exit(1);
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
