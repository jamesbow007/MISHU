/**
 * 造一个「连着浏览器」的客户端。
 *
 * 为什么必须走页面代理：扩展读不全 zhipin 的 cookie（会话 cookie 常是
 * HttpOnly / 分区的），直连 HTTP 只能带上 bst → 服务端返回 code=7。
 * 页面上下文里发 fetch 时浏览器会带齐全部登录 cookie。
 *
 * 这段「起桥接 → 取 cookie → 组装客户端」在 5 个脚本里各抄了一份，
 * 漏掉 createPageTransport 就会静默降级成直连（表现为「登录已失效」）。
 *
 * 例外：probe-messages.ts 保留了自己的写法 —— 它要等扩展接入、
 * 打印 cookie 明细，是诊断脚本，形状不一样。
 */
import { bridge } from './bridge.js';
import { BossClient } from './client.js';
import { createPageTransport } from './page-transport.js';
import { toSession } from './session-store.js';

export async function createBrowserClient(timeoutMs = 15_000): Promise<BossClient> {
  await bridge.start();
  const cookies = await bridge.requestCookies(timeoutMs);
  return new BossClient(toSession(cookies), 'https://www.zhipin.com', createPageTransport(bridge));
}
