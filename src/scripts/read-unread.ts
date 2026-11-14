/**
 * 读取未读消息。
 *
 * ⚠️ 未读数只存在于浏览器侧：
 *   服务端的会话详情接口里 unreadMsgCount 恒为 0（实测 269 个会话全是 0），
 *   而网页上「未读(N)」的 N 是真的 —— 前端从 MQTT 长连接收到未读后自己在内存里算的。
 *   所以未读必须从**页面**读（扩展的 DOM 探针），再用 HTTP 接口补齐聊天内容。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs src/scripts/read-unread.ts [每个会话显示几条]
 */
import { createBrowserClient } from '../api/browser-client.js';
import { CHAT_URL } from '../api/constants.js';
import { probeDom } from '../api/page-transport.js';
import { requireLogin, probeLogin, listSessions, listMessages, enrichSessions } from '../api/messages.js';

interface DomRow {
  unread: number;
  lines: string[];
}

/**
 * 把页面上显示的时间（「13:59」「昨天」「11月09日」）换算成时间戳，
 * 用来和会话列表的 updateTime 对齐。
 */
function domTimeToDate(txt?: string, base = new Date()): Date | null {
  if (!txt) return null;
  const hm = txt.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(base);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d;
  }
  const md = txt.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (md) {
    return new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2]), 0, 0, 0, 0);
  }
  if (txt.includes('昨天')) {
    const d = new Date(base);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return null;
}

async function main() {
  const perSession = Number(process.argv[2] ?? 6);

  const client = await createBrowserClient(15000).catch((e) => {
    console.error('❌ 拿不到登录 cookie：' + (e as Error).message);
    process.exit(1);
  });

  const login = requireLogin(await probeLogin(client));
  const myUid = Number((login.user as any)?.userId);
  console.log(`登录态: 已登录  ${login.user?.name ?? ''} (uid ${myUid})`);

  // 会话详情里的 relationType 就是左下角那几个分类（与前端的 labelId 一一对应）
  const RELATION: Record<number, string> = {
    1: '新招呼',
    2: '仅沟通',
    3: '有交换',
    4: '有面试',
    5: '不感兴趣',
  };

  // —— 第一步：从页面读真实未读 ——
  const dom = await probeDom(CHAT_URL, 'unread');
  const rows: DomRow[] = dom?.allRows ?? [];
  const unreadRows = rows.filter((r) => r.unread > 0);

  console.log(
    `页面未读 tab: ${JSON.stringify(dom?.unreadTabText ?? '')} → 总数 ${dom?.unreadTotal ?? '?'} | ` +
      `会话行 ${dom?.rowCount ?? rows.length} | 有未读的 ${unreadRows.length} 行`,
  );

  // 完整性校验：徽标条数应该等于 tab 上的总数。
  // 不等说明消息页停在别的标签（「新招呼」等），当前视图盖不全所有未读。
  const total = dom?.unreadTotal;
  if (typeof total === 'number' && unreadRows.length < total) {
    console.log(
      `⚠️ tab 上有 ${total} 条未读，但当前视图只找到 ${unreadRows.length} 条 —— ` +
        `消息页可能停在别的标签，请切到「全部」或「未读」再试`,
    );
  }

  // —— 第二步：HTTP 侧拿结构化会话，用来给 DOM 行补上 HR/公司/职位 ——
  // 只拉列表不补详情：列表项本身就带 name/brandName/jobName/jobCity，
  // 补全量详情要 2~6 批请求（慢十几秒），这里用「姓名 + 时间」先定位，
  // 再用**一次**请求只补命中的那几个（拿 relationType / lastMsg）。
  const sessions = await listSessions(client, { labelId: 0, enrich: 'none' });

  if (!unreadRows.length) {
    console.log('\n（当前没有未读消息）');
    return;
  }

  const matchRow = (row: DomRow) => {
    const [, timeTxt, who] = row.lines;
    return (
      sessions.find((s) => {
        if (!who?.startsWith(s.name)) return false;
        const t = domTimeToDate(timeTxt);
        if (!t) return true;
        return Math.abs((s.lastMessageAt ?? 0) - t.getTime()) < 10 * 60 * 1000;
      }) ?? sessions.find((s) => s.lastMessage === row.lines[row.lines.length - 1])
    );
  };

  // 先定位，再一次性补齐这几个会话的详情
  const prelim = unreadRows.map(matchRow);
  await enrichSessions(
    client,
    sessions,
    prelim.filter(Boolean).map((s) => String(s!.friendId)),
  );

  for (const [idx, row] of unreadRows.entries()) {
    // 行结构： [未读数, 时间, "名字公司职位", 最后一句, ...]
    const [, timeTxt, who, ...rest] = row.lines;
    const lastText = rest.join(' ').trim() || row.lines[row.lines.length - 1] || '';

    // 补完详情后再匹配一次：这时有 lastMessage，可以精确核对
    const hit = prelim[idx] && prelim[idx]!.lastMessage === lastText ? prelim[idx] : matchRow(row);

    const rel = hit ? Number((hit.raw as any)?.relationType) : undefined;
    const relTag = rel && RELATION[rel] ? `[${RELATION[rel]}]` : '';

    console.log('\n' + '═'.repeat(64));
    console.log(
      `未读 ${row.unread} 条 | ${timeTxt ?? ''} | ${hit ? `${hit.name} · ${hit.brandName} · ${hit.jobName ?? ''}` : who ?? '?'} ${relTag}`,
    );
    console.log(`  最后一句: ${lastText}`);
    if (hit) {
      console.log(`  friendId: ${hit.friendId} · encryptBossId: ${hit.encryptBossId ?? ''} · relationType: ${rel}`);
    }

    if (!hit) continue;

    const msgs = await listMessages(client, hit, { limit: 100 });
    const tail = msgs.slice(-perSession);
    console.log('─'.repeat(64));
    for (const m of tail) {
      const t = m.time
        ? new Date(m.time).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      const dir = m.from === 'me' ? '我' : m.from === 'peer' ? 'HR' : '系统';
      console.log(`  [${dir}] ${t}  ${m.text}`);
    }
  }
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
