/**
 * 探测「新招呼」的页面结构。
 *
 * 目的：把消息页的真实 DOM / store 结构打印出来，用来确定：
 *   - 「新招呼」tab 的精确元素与激活态 class
 *   - 会话行里有没有可用的 id（决定能不能按 id 定位，避开同名 HR）
 *   - 行内名字元素的真实选择器
 *   - 未读徽标的真实 class
 *
 * 这是「自动投递」的前置步骤 —— 没探测清楚就写投递逻辑，等于闭着眼睛点。
 * 探测结果要跟网页上看到的红点**逐条对质**，对不上就别往下走。
 *
 * 用法：npm run probe:greeting
 */
import { bridge } from '../api/bridge.js';
import { CHAT_URL } from '../api/constants.js';
import { runPageFn } from '../api/page-transport.js';

const CHAT = CHAT_URL;

function hr(title: string) {
  console.log('\n' + '═'.repeat(60));
  console.log('  ' + title);
  console.log('═'.repeat(60));
}

async function main() {
  await bridge.start();

  console.log('正在打开消息页并采集结构…（首次可能要等页面渲染几秒）');
  const out = await runPageFn('greeting', { mode: 'inspect' }, { url: CHAT, own: true });

  hr('页面');
  console.log('  URL   :', out?.url);
  console.log('  标题  :', out?.title);
  console.log('  渲染出的会话行数:', (out?.allRows ?? []).length);

  hr('Tab 结构（全部 / 未读 / 新招呼 / …）');
  for (const t of out?.tabs ?? []) {
    console.log(`\n  【${t.label}】${t.found ? '找到了' : '❌ 没找到'}`);
    if (!t.found) continue;
    console.log('    class :', t.cls);
    console.log('    outer :', t.outer.slice(0, 220));
    for (const a of t.ancestors ?? []) {
      console.log(`      ↑ ${a.tag}.${a.cls}  「${a.text}」`);
    }
  }

  hr('前端 store（未读数的真正来源 —— MQTT 推给它，它自己算）');
  const st = out?.store;
  if (!st?.ok) {
    console.log('  ❌ 没读到 store：', st?.error);
  } else {
    console.log('  路径      :', st.where);
    console.log('  会话总数  :', st.count);
    console.log('  未读会话数:', st.unreadCount);
    console.log('  relationType 分布:', JSON.stringify(st.relCount));
    console.log('  会话对象字段:', (st.friendKeys ?? []).join(', '));
    console.log('\n  ── 一个会话对象的完整内容 ──');
    console.log(JSON.stringify(st.sample, null, 2).slice(0, 1600));
    if ((st.sampleUnread ?? []).length) {
      console.log('\n  ── 未读会话长这样 ──');
      console.log(JSON.stringify(st.sampleUnread[0], null, 2).slice(0, 1200));
    }
  }

  hr('会话行（.friend-content）');
  console.log('  行数:', (out?.allRows ?? []).length);
  for (const r of (out?.allRows ?? []).slice(0, 12)) {
    console.log(
      `   #${String(r.idx).padStart(2)}  未读=${r.badge}  名字=${JSON.stringify(r.name)}  ` +
        `名字class=${r.nameCls || '(无)'}  徽标class=${r.badgeCls || '(无)'}`,
    );
    console.log('       行文本:', JSON.stringify((r.lines ?? []).join(' | ')));
  }
  if ((out?.rows ?? []).length) {
    console.log('\n  ── 第一行的 HTML ──');
    console.log(out.rows[0].html);
  }

  hr('页面上所有「像徽标」的 class（找红点的真实 class）');
  for (const b of out?.badgeLike ?? []) {
    console.log(`   ${String(b.w).padStart(3)}×${String(b.h).padEnd(3)} ${b.cls}  「${b.text}」`);
  }

  hr('页面正文开头');
  console.log(out?.bodyHead ?? '(空)');

  console.log('\n探测完成。把上面的「带未读的行」和网页上看到的红点对一下。\n');

  // 桥接是个 HTTP server，不关的话这个进程永远退不出来、还占着端口
  await bridge.stop();
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  console.error(
    '排查：① npm run bridge 在跑吗 ② chrome://extensions/ 里扩展已启用并点过「重新加载」了吗 ' +
      '③ Chrome 里已登录 BOSS直聘吗',
  );
  process.exit(1);
});
