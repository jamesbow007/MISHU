/**
 * 让扩展自己重载 —— 改完 extension/background.js 后跑这个就行。
 *
 * 为什么需要它：
 *   Chrome 加载扩展时会把资源（background.js 等）**缓存住**，磁盘上改了不重载不生效；
 *   而重载的入口 chrome.runtime.reload() 只有扩展自己的代码能调用。
 *   于是每次改完扩展都得手动去 chrome://extensions/ 点「🔄 重新加载」。
 *
 * 怎么绕开这个死结：
 *   扩展启动时记下自己的启动时刻（SW_START）和正在跑的源码指纹（selfHash），
 *   并在 /diag 里报上来。本脚本把磁盘上 background.js 的**修改时间**和
 *   **内容哈希**发过去，扩展比一下：
 *     · 磁盘比我新（mtime > SW_START，或哈希不同）→ chrome.runtime.reload()
 *     · 一样 → 跑的就是磁盘上这份，不用重载
 *
 * ⚠️ 这个脚本**不修改任何文件** —— 磁盘上的 background.js 保持原样，
 *    git 里不会有任何多余改动。
 *
 * 用法：npm run ext:reload
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridge, bridgeStatus } from '../api/bridge.js';
import { sleep } from '../api/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BG = path.join(ROOT, 'extension', 'background.js');

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function main() {
  // 扩展的诊断信息刷屏 —— 关掉
  process.env.BOSS_ZHIPIN_QUIET_DIAG = '1';

  await bridge.start();

  // ① 等扩展连上（桥接刚起来时扩展要重连一次）
  let connected = false;
  for (let i = 0; i < 24; i++) {
    if ((await bridgeStatus())?.connected) {
      connected = true;
      break;
    }
    await sleep(500);
  }
  if (!connected) {
    console.error('❌ 扩展没连上本地桥接 —— 检查 chrome://extensions/ 里扩展是否被停用');
    process.exit(1);
  }

  // ② 触发一次 cookie 采集 —— 扩展借这个机会把 swStart / selfHash 报上来。
  //    必须显式派任务：远程模式下 requestCookies 可能直接返回宿主缓存，
  //    拿到的就是**旧**的诊断数据（swStart / selfHash 都是过期的）。
  try {
    await bridge.runTask({ kind: 'cookies' }, 8000);
  } catch {
    /* ignore */
  }
  await sleep(300);
  const st = await bridgeStatus();

  // ③ 磁盘上的代码 —— 只读，不改
  const stat = fs.statSync(BG);
  const diskHash = sha256(fs.readFileSync(BG, 'utf8'));
  console.log(`磁盘上的 background.js：${stat.size} 字节，修改于 ${new Date(stat.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`);
  console.log(`扩展当前：SW 启动于 ${st?.swStart ? new Date(st.swStart).toLocaleString('zh-CN', { hour12: false }) : '(未知)'}`);

  // ④ 派「自重载」任务。
  //    扩展要重载时会直接 chrome.runtime.reload()，**故意不回结果** ——
  //    所以这里只等 2.5 秒：回不来就是「正在重载」，等满 12 秒纯属白等。
  let triggered = false;
  try {
    const r = await bridge.runTask(
      { kind: 'self-reload', diskMtime: stat.mtimeMs, diskHash },
      2_500,
    );
    if (r?.ok && r?.data?.reloaded === false) {
      console.log('ℹ️  扩展跑的就已经是磁盘上的代码 —— 不用重载。');
      process.exit(0);
    }
    triggered = true;
  } catch {
    // 重载会让 SW 当场死掉，结果回不来 —— 那正是重载成功的信号
    triggered = true;
  }

  // ⑤ 等扩展重新连上，并确认它跑的是新代码
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s2 = await bridgeStatus();
    if (!s2?.connected) continue;
    const fresh = (s2.swStart ?? 0) > stat.mtimeMs || (s2.selfHash && s2.selfHash === diskHash);
    if (fresh) {
      console.log('✅ 扩展已重载，跑的是磁盘上的新代码。');
      process.exit(0);
    }
  }
  console.log(
    triggered
      ? '⚠️ 已发出重载指令，但没确认到新代码生效 —— 去 chrome://extensions/ 手动点一下「🔄 重新加载」。'
      : '⚠️ 没确认到扩展状态。',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
