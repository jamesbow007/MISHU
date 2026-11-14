/**
 * 读取某个会话里那个职位链接对应的完整 JD。
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/read-job.ts [会话key]
 */
import { createBrowserClient } from '../api/browser-client.js';
import { requireLogin, probeLogin, listSessions, listMessages, getJobDetail } from '../api/messages.js';

async function main() {
  const wantKey = process.argv[2];

  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  requireLogin(await probeLogin(client));
  const sessions = await listSessions(client);
  const session = wantKey ? sessions.find((s) => s.key === wantKey) : sessions[0];
  if (!session) {
    console.log('找不到会话', wantKey);
    return;
  }
  console.log(`会话: ${session.name}（${session.brandName} / ${session.jobName}）`);

  // 会话详情里带 encryptJobId
  const encryptJobId = String((session.raw as any)?.encryptJobId ?? '');
  console.log(`encryptJobId: ${encryptJobId || '(无)'}`);

  // 消息里的职位卡片也带 jobId
  const msgs = await listMessages(client, session, { limit: 50 });
  const jobCard = msgs.find((m) => m.raw?.body?.jobDesc);
  const jd = jobCard?.raw?.body?.jobDesc;
  console.log(`\n消息里的职位卡片: ${jd ? `${jd.title} · ${jd.salary} · ${jd.city} · ${jd.company}` : '(无)'}`);
  if (jd) {
    console.log('  卡片字段:', Object.keys(jd).join(', '));
  }

  if (!encryptJobId) {
    console.log('\n没有 encryptJobId，无法取详情页');
    return;
  }

  console.log('\n正在获取岗位详情…');
  const t0 = Date.now();
  const detail = await getJobDetail(client, {
    jobId: jd?.jobId,
    securityId: String(jd?.url?.match(/securityId=([^&]+)/)?.[1] ?? ''),
    encryptJobId,
  });
  console.log(`耗时 ${Date.now() - t0}ms\n`);

  const ji = detail?.jobInfo ?? {};
  const bi = detail?.bossInfo ?? {};
  const ci = detail?.brandComInfo ?? {};

  console.log('════ 岗位详情 ════');
  console.log('职位     :', ji.jobName);
  console.log('薪资     :', ji.salaryDesc);
  console.log('地点     :', ji.locationName, '·', ji.address);
  console.log('经验/学历 :', [ji.experienceName, ji.degreeName].filter(Boolean).join(' · '));
  console.log('方向     :', ji.positionName);
  console.log('公司     :', ci.brandName, `(${ci.scaleName} / ${ci.industryName} / ${ci.stageName})`);
  console.log('HR       :', bi.name, '·', bi.title, `· ${bi.activeTimeDesc ?? ''}`);
  console.log('福利     :', (ci.labels ?? []).join(' / '));
  console.log(
    '投递状态 : alreadyApply=' + detail?.atsOnlineApplyInfo?.alreadyApply +
      ' canSendResume=' + detail?.oneKeyResumeInfo?.canSendResume,
  );
  console.log('\n──── JD 正文 ────');
  console.log(ji.postDescription ?? '(无)');
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
