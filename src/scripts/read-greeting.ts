/**
 * 读取「新招呼」tab 里的会话与对话。
 *
 * label 定义来自官方 bundle：
 *   0 全部 / -2 未读 / 1 新招呼 / 2 仅沟通 / 3 有交换 / 4 有面试 / 5 不感兴趣
 *   （relationType 分布与之对应：1=93 2=46 3=118 5=12）
 *
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/read-greeting.ts [会话数] [每会话消息数]
 */
import { createBrowserClient } from '../api/browser-client.js';
import { requireLogin, probeLogin, listSessions, listMessages } from '../api/messages.js';

const LABEL_NEW_GREETING = 1;

async function main() {
  const sessionCount = Number(process.argv[2] ?? 5);
  const msgCount = Number(process.argv[3] ?? 6);

  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  const p = requireLogin(await probeLogin(client));
  console.log(`登录态: 已登录  ${p.user?.name ?? ''}\n`);

  // 只补前 N 个会话的详情（补全 93 个要多花好几秒，而只需要前几个）
  const sessions = await listSessions(client, {
    labelId: LABEL_NEW_GREETING,
    enrich: 'limit',
    limit: sessionCount,
  });
  console.log(`「新招呼」会话共 ${sessions.length} 个，以下展示前 ${sessionCount} 个\n`);

  for (const [i, s] of sessions.slice(0, sessionCount).entries()) {
    const when = s.lastMessageAt
      ? new Date(s.lastMessageAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '';

    console.log('═'.repeat(66));
    console.log(
      `${i + 1}. ${s.name} · ${s.brandName ?? ''} · ${s.jobName ?? ''} · ${s.jobCity ?? ''} · ${when}`,
    );
    if (s.bossTitle) console.log(`   HR 职位: ${s.bossTitle}`);

    const msgs = await listMessages(client, s, { limit: 100 });

    // 列表接口在非「全部」label 下不返回职位名/城市，但消息里的职位卡片有
    const jd = msgs.find((m) => m.raw?.body?.jobDesc)?.raw?.body?.jobDesc;
    if (jd) {
      console.log(
        `   岗位: ${jd.title} · ${jd.salary} · ${jd.city} · ${jd.experience} · ${jd.education}` +
          (jd.company ? ` · ${jd.company}` : ''),
      );
    }

    console.log('─'.repeat(66));
    for (const m of msgs.slice(0, msgCount)) {
      const t = m.time
        ? new Date(m.time).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '?';
      const dir = m.from === 'me' ? '我  ' : m.from === 'peer' ? 'HR  ' : '系统';
      console.log(`   [${dir}] ${t}  ${String(m.text).replace(/\n/g, ' ⏎ ')}`);
    }
    if (msgs.length > msgCount) console.log(`   …（该会话共 ${msgs.length} 条消息）`);
    console.log();
  }
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
