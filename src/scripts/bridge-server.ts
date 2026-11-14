/**
 * 常驻桥接进程：监听 127.0.0.1:39115，接收 Chrome 扩展回传的 cookie。
 *
 * 单独跑一个常驻进程的好处：
 *   - 扩展的连接不会因为某个脚本退出而断
 *   - MCP server / 探测脚本都通过 HTTP 问它要 cookie（远程模式），不会抢端口
 *
 * 用法：npm run bridge
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridge } from '../api/bridge.js';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

async function main() {
  await bridge.start();
  console.log('════════════════════════════════════════════════════');
  console.log('  MISHU 桥接已启动');
  console.log('  地址: http://127.0.0.1:39115');
  console.log(`  扩展加载目录: ${EXTENSION_DIR}`);
  console.log('  （在 chrome://extensions/ 开启开发者模式 → 加载已解压的扩展程序）');
  console.log('════════════════════════════════════════════════════\n');

  setInterval(() => {
    const s = bridge.cached;
    const age = bridge.lastUpdated ? Math.round((Date.now() - bridge.lastUpdated) / 1000) : null;
    console.log(
      `[bridge] cookie ${s.length} 个${s.length ? ' (' + s.map((c) => c.name).join(',') + ')' : ''}` +
        `${age !== null ? ` | 最近更新 ${age}s 前` : ' | 尚未收到扩展数据'}`,
    );
  }, 15_000);

  // 常驻
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
