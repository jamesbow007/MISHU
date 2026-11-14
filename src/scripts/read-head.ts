/**
 * 读取：会话列表前 N 条 + 第一个会话的前 N 条消息。
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/read-head.ts [N]
 */
import { createBrowserClient } from '../api/browser-client.js';
import { requireLogin, probeLogin, listSessions, listMessages } from '../api/messages.js';

const N = Number(process.argv[2] ?? 5);

async function main() {
  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  const p = requireLogin(await probeLogin(client));
  console.log(`登录态: ✅ 已登录 (code=${p.code})`);

  // 只补前 N 个会话的详情（全量补齐要多花好几秒）
  const sessions = await listSessions(client, { enrich: 'limit', limit: N });
  console.log(`会话总数: ${sessions.length}\n`);

  console.log(`──── 会话列表前 ${N} 条 ────`);
  for (const [i, s] of sessions.slice(0, N).entries()) {
    console.log(
      `${String(i + 1).padStart(2)}. ${s.unread ? '🔴' : '  '} ${s.name.padEnd(8).slice(0, 8)} | ` +
        `${(s.brandName ?? '').padEnd(12).slice(0, 12)} | ${(s.jobName ?? '').padEnd(22).slice(0, 22)} | ` +
        `${String(s.lastMessage).slice(0, 34)}`,
    );
  }

  const first = sessions[0];
  if (!first) return;

  console.log(`\n──── 「${first.name}」的聊天记录（前 ${N} 条）────`);
  const msgs = await listMessages(client, first, { limit: 100 });
  for (const [i, m] of msgs.slice(0, N).entries()) {
    const t = m.time ? new Date(m.time).toLocaleString('zh-CN') : '?';
    console.log(`${String(i + 1).padStart(2)}. ${m.from === 'me' ? '我  ' : 'HR  '} ${t} | ${String(m.text).slice(0, 60)}`);
  }
  console.log(`\n（该会话共 ${msgs.length} 条消息）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
