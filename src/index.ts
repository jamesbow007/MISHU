import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridge } from './api/bridge.js';
import { BossClient, BossApiError, ERROR_CODES } from './api/client.js';
import { toSession } from './api/session-store.js';
import {
  probeLogin,
  refreshZpToken,
  listSessions,
  listMessages,
  getBossProfile,
} from './api/messages.js';
import { createQr, confirmLogin, fetchPk } from './api/login.js';
import { createPageTransport } from './api/page-transport.js';

const server = new McpServer({
  name: 'mishu',
  version: '0.2.0',
});

const json = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const QR_STATE_FILE = path.join(DATA_DIR, 'qr-session.json');

/** 复用的客户端（30 秒内不重建） */
let cachedClient: BossClient | null = null;
let cachedClientAt = 0;
let cachedSource = '';

/**
 * 拿到客户端。
 *
 * 必须走【页面代理】通道：请求在浏览器页面里发，浏览器自动携带完整登录 cookie。
 * 直连只能带 bst（扩展读不到 HttpOnly / 分区的 cookie），服务端会回 code=7。
 */
async function getClient(): Promise<{ client: BossClient; source: string }> {
  await bridge.start();

  // 复用 client：每次重建会丢 myUid 之外的连接状态，且白白多一次往返
  if (cachedClient && Date.now() - cachedClientAt < 30_000) {
    return { client: cachedClient, source: cachedSource };
  }

  let cookies: any[] = [];
  try {
    // 不强制刷新：扩展每 3 秒主动推一次，桥接有 30 秒新鲜度缓存
    cookies = await bridge.requestCookies(5000);
  } catch {
    /* 扩展没接上 */
  }

  const session = toSession(cookies);

  cachedClient = new BossClient(session, 'https://www.zhipin.com', createPageTransport(bridge));
  cachedClientAt = Date.now();
  cachedSource = cookies.length ? '页面代理（扩展）' : '页面代理（扩展未接上）';
  return { client: cachedClient, source: cachedSource };
}

/** 若有未完成的扫码会话，尝试确认登录 */
async function tryConfirmPendingLogin(client: BossClient): Promise<string | null> {
  if (!fs.existsSync(QR_STATE_FILE)) return null;
  try {
    const st = JSON.parse(fs.readFileSync(QR_STATE_FILE, 'utf8'));
    if (st?.confirmed) return null;
    const qr = st?.qr;
    if (!qr?.qrId && !qr?.shortRandKey) return null;

    const r = await confirmLogin(client, qr, st.pk ?? 'cpc_user_sign_up');
    if (r.ok) {
      st.confirmed = true;
      fs.writeFileSync(QR_STATE_FILE, JSON.stringify(st, null, 2));
      return '扫码登录已确认';
    }
    return null;
  } catch {
    return null;
  }
}

server.registerTool(
  'check_status',
  {
    title: '检查 BOSS直聘登录态',
    description:
      '通过纯 HTTP 接口检查当前登录态（不驱动浏览器）。若之前生成过二维码但还没确认，会顺带尝试确认登录。',
    inputSchema: {},
  },
  async () => {
    try {
      const { client, source } = await getClient();
      const confirmed = await tryConfirmPendingLogin(client);
      let p = await probeLogin(client);

      if (!p.loggedIn) {
        await refreshZpToken(client);
        p = await probeLogin(client);
      }

      return json({
        登录态: p.loggedIn ? '已登录' : '未登录',
        code: p.code,
        错误含义: p.code ? (ERROR_CODES[p.code] ?? '未知') : '',
        cookie来源: source,
        扫码确认: confirmed,
        用户信息: p.user ?? null,
        建议: p.loggedIn
          ? '可以调用 list_chats 读取会话列表'
          : '调用 ensure_login 生成二维码，用手机 BOSS直聘 扫码',
      });
    } catch (e) {
      return json({ 错误: (e as Error).message });
    }
  },
);

server.registerTool(
  'ensure_login',
  {
    title: '生成扫码登录二维码',
    description:
      '用纯 HTTP 申请一个登录二维码并返回图片。用手机 BOSS直聘 扫码后，调用 check_status 完成确认。',
    inputSchema: {},
  },
  async () => {
    try {
      const { client } = await getClient();
      const pk = await fetchPk();
      const qr = await createQr(client, pk);

      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        QR_STATE_FILE,
        JSON.stringify({ pk, qr, createdAt: Date.now(), confirmed: false }, null, 2),
      );

      if (qr.png) {
        const pngPath = path.join(DATA_DIR, 'qr.png');
        fs.writeFileSync(pngPath, qr.png);
        return {
          content: [
            {
              type: 'image' as const,
              data: qr.png.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text' as const,
              text: `请用手机 BOSS直聘 扫描二维码。扫码后调用 check_status 确认登录。\n（图片同时已保存到 ${pngPath}）`,
            },
          ],
        };
      }

      return json({
        错误: '未能取到二维码图片',
        qrId: qr.qrId,
        mpCodeUrl: qr.mpCodeUrl,
        提示: '可手动打开 mpCodeUrl 扫码',
      });
    } catch (e) {
      if (e instanceof BossApiError) {
        return json({ 错误: e.message, code: e.code, raw: e.raw });
      }
      return json({ 错误: (e as Error).message });
    }
  },
);

server.registerTool(
  'list_chats',
  {
    title: '读取 HR 会话列表',
    description:
      '读取你账号里与 HR 的会话列表：对方昵称、最后一条消息、未读标记与时间。',
    inputSchema: {
      labelId: z.number().int().default(0).describe('标签筛选，0 表示全部（实测 -1 会返回空数组）'),
      limit: z.number().int().min(1).max(200).default(50).describe('最多返回多少条'),
    },
  },
  async ({ labelId, limit }) => {
    try {
      const { client } = await getClient();
      const sessions = await listSessions(client, { labelId });
      const sliced = sessions.slice(0, limit);

      return json({
        会话数: sessions.length,
        未读数: sessions.filter((s) => s.unread).length,
        会话: sliced.map((s) => ({
          key: s.key,
          昵称: s.name,
          公司: s.brandName,
          职位: s.jobName,
          城市: s.jobCity,
          最后消息: s.lastMessage,
          未读: s.unread,
          未读数: s.unreadCount,
          时间: s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString('zh-CN') : undefined,
          encryptFriendId: s.encryptBossId,
        })),
      });
    } catch (e) {
      if (e instanceof BossApiError) {
        return json({ 错误: e.message, code: e.code, 错误含义: ERROR_CODES[e.code] ?? '' });
      }
      return json({ 错误: (e as Error).message });
    }
  },
);

server.registerTool(
  'read_chat',
  {
    title: '读取某个会话的聊天记录',
    description:
      '按会话 key 读取与该 HR 的完整聊天记录（时间、发送方、正文）。',
    inputSchema: {
      key: z.string().describe('会话 key，取自 list_chats 的输出'),
      limit: z.number().int().min(1).max(200).default(50).describe('最多返回多少条'),
    },
  },
  async ({ key, limit }) => {
    try {
      const { client } = await getClient();
      const sessions = await listSessions(client);
      const session = sessions.find((s) => s.key === key);
      if (!session) {
        return json({ 错误: `找不到 key=${key} 的会话`, 可用key: sessions.slice(0, 20).map((s) => s.key) });
      }

      const msgs = await listMessages(client, session, { limit });
      let profile: any = null;
      try {
        profile = await getBossProfile(client, session);
      } catch {
        /* 档案拿不到不影响聊天记录 */
      }

      return json({
        会话: { key: session.key, 昵称: session.name },
        HR档案: profile?.data ?? profile ?? null,
        消息数: msgs.length,
        消息: msgs.map((m) => ({
          mid: m.mid,
          发送方: m.from === 'me' ? '我' : m.from === 'peer' ? 'HR' : '系统',
          时间: m.time ? new Date(m.time).toLocaleString('zh-CN') : undefined,
          类型: m.type,
          内容: m.text,
        })),
      });
    } catch (e) {
      if (e instanceof BossApiError) {
        return json({ 错误: e.message, code: e.code, 错误含义: ERROR_CODES[e.code] ?? '' });
      }
      return json({ 错误: (e as Error).message });
    }
  },
);

server.registerTool(
  'api_probe',
  {
    title: '调试：直接调用任意 BOSS 接口',
    description: '裸调一个 /wapi 接口并返回原始 JSON，用于探测未知接口。',
    inputSchema: {
      path: z.string().describe('接口路径，如 /wapi/zpchat/session/check'),
      method: z.enum(['GET', 'POST']).default('GET'),
      query: z.record(z.string()).optional().describe('查询参数'),
    },
  },
  async ({ path: p, method, query }) => {
    try {
      const { client } = await getClient();
      const res = await client.request(p, { method, query });
      return json({ path: p, 返回: res });
    } catch (e) {
      if (e instanceof BossApiError) {
        return json({ path: p, 错误: e.message, code: e.code, raw: e.raw });
      }
      return json({ 错误: (e as Error).message });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mishu] MCP server 已启动 (stdio)');
