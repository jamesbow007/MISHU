/**
 * MCP 层端到端自测：用 MCP 客户端真实调用工具。
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/verify.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/index.ts')],
    // MCP SDK 默认会过滤环境变量，这里显式透传
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client({ name: 'verify', version: '1.0.0' });
  await client.connect(transport);
  console.log('✔ MCP 客户端已连接\n');

  // 1) 登录态
  console.log('══════ check_status ══════');
  const st: any = await client.callTool({ name: 'check_status', arguments: {} });
  console.log((st.content ?? []).map((c: any) => c.text).join('\n'));

  // 2) 会话列表
  console.log('\n══════ list_chats ══════');
  const chats: any = await client.callTool({ name: 'list_chats', arguments: { limit: 8 } });
  console.log((chats.content ?? []).map((c: any) => c.text).join('\n'));

  // 3) 取第一个会话的聊天记录
  let key: string | undefined;
  try {
    const parsed = JSON.parse((chats.content ?? []).map((c: any) => c.text).join('\n'));
    key = parsed?.会话?.[0]?.key;
  } catch {
    /* ignore */
  }

  if (key) {
    console.log(`\n══════ read_chat  (key=${key}) ══════`);
    const msgs: any = await client.callTool({ name: 'read_chat', arguments: { key, limit: 20 } });
    console.log((msgs.content ?? []).map((c: any) => c.text).join('\n'));
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
