/**
 * 通过扩展桥接取 cookie → 打 BOSS 接口 → 读 HR 消息。
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/probe-messages.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridge } from '../api/bridge.js';
import { createPageTransport } from '../api/page-transport.js';
import { BossClient, BossApiError, ERROR_CODES } from '../api/client.js';
import { toSession } from '../api/session-store.js';
import { probeLogin, refreshZpToken, listSessions, listMessages } from '../api/messages.js';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

async function main() {
  await bridge.start();
  console.log('① 本地桥接已启动: http://127.0.0.1:39115');
  console.log(`   请确认扩展已加载（${EXTENSION_DIR}）并在浏览器中已登录 BOSS直聘\n`);

  // 等扩展连上（最多 10 分钟，用户可以慢慢装扩展 + 登录）
  const deadline = Date.now() + 10 * 60 * 1000;
  let cookies: Awaited<ReturnType<typeof bridge.requestCookies>> | undefined;
  let waited = false;
  while (Date.now() < deadline) {
    try {
      cookies = await bridge.requestCookies(3000, true);
      if (cookies.length) break;
    } catch {
      if (!waited) {
        waited = true;
        console.log('   等待扩展接入…（最多 10 分钟）');
        console.log(`   若一直无响应：检查 chrome://extensions/ 是否已加载 ${EXTENSION_DIR}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!cookies?.length) {
    console.log('\n❌ 等待超时，没有拿到 cookie。检查：');
    console.log(`   1) chrome://extensions/ 是否已加载 ${EXTENSION_DIR}`);
    console.log('   2) 扩展图标是否已启用');
    console.log('   3) 浏览器里是否已登录 BOSS直聘');
    process.exit(1);
  }

  const session = toSession(cookies);
  console.log(`② 拿到 ${Object.keys(session.cookies).length} 个 zhipin cookie:`);
  for (const [k, v] of Object.entries(session.cookies)) {
    console.log(`   ${k.padEnd(18)} ${String(v.length).padStart(4)}B`);
  }

  // 走页面代理：请求在浏览器页面里发，浏览器自动带完整登录 cookie
  const client = new BossClient(session, 'https://www.zhipin.com', createPageTransport(bridge));

  console.log('\n③ 探测登录态 (/wapi/zpuser/wap/getUserInfo.json)…');
  let p = await probeLogin(client);
  console.log(`   ${p.loggedIn ? '✅ 已登录' : '❌ 未登录'} code=${p.code} ${p.message}`);

  if (!p.loggedIn) {
    console.log('   → 尝试刷新 zp_token (POST /wapi/zppassport/set/zpToken)…');
    await refreshZpToken(client);
    p = await probeLogin(client);
    console.log(`   ${p.loggedIn ? '✅ 已登录' : '❌ 仍未登录'} code=${p.code} ${p.message}`);
  }

  if (!p.loggedIn) {
    console.log('\n   错误码含义:', ERROR_CODES[p.code] ?? '未知');
    process.exit(2);
  }

  console.log('\n④ 拉会话列表 (/wapi/zprelation/friend/geekFilterByLabel?labelId=-1)…');
  let sessions = [];
  try {
    sessions = await listSessions(client);
  } catch (e) {
    if (e instanceof BossApiError) {
      console.log(`   ❌ code=${e.code} ${ERROR_CODES[e.code] ?? ''}`);
      console.log(`      raw: ${JSON.stringify(e.raw).slice(0, 400)}`);
    } else {
      console.log('   ❌', (e as Error).message);
    }
    process.exit(3);
  }

  console.log(`   ✅ ${sessions.length} 条会话\n`);
  for (const s of sessions.slice(0, 10)) {
    console.log(
      `   ${s.unread ? '🔴' : '  '} ${s.name.padEnd(14).slice(0, 14)} | ${String(s.lastMessage).slice(0, 40).padEnd(40)} | key=${s.key.slice(0, 20)}`,
    );
  }

  if (sessions.length) {
    console.log('\n⑤ 拉第一个会话的聊天记录…');
    try {
      const msgs = await listMessages(client, sessions[0], { limit: 20 });
      console.log(`   ✅ ${msgs.length} 条消息`);
      for (const m of msgs.slice(-10)) {
        console.log(
          `   ${m.from === 'me' ? '我' : m.from === 'peer' ? 'HR' : '系统'} | ${m.time ? new Date(m.time).toLocaleString('zh-CN') : '?'} | ${String(m.text).slice(0, 50)}`,
        );
      }
    } catch (e) {
      console.log('   ❌', (e as Error).message.slice(0, 200));
    }
  }

  await bridge.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
