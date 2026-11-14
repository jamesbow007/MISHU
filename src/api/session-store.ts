/**
 * 会话构造工具。
 *
 * 这里【不】持久化 cookie：登录凭据由浏览器持有，Node 侧存一份只会产生
 * 「三份 cookie 互相覆盖」的假象 —— 扩展推来的只有 bst 一条，直连又必然
 * 被服务端拒（code=7），所以这份「兜底」兜不住任何东西。
 * 需要重新登录时，在浏览器里扫码即可，扩展会自动用上新 cookie。
 */
import type { BossSession } from './client.js';
import { DEFAULT_UA } from './client.js';

/** 把 Chrome 的 cookie 列表转成会话 */
export function toSession(
  cookies: Array<{ name: string; value: string; domain: string }>,
  userAgent = DEFAULT_UA,
): BossSession {
  const map: Record<string, string> = {};
  for (const c of cookies) {
    if (!c.domain.includes('zhipin.com')) continue;
    map[c.name] = c.value;
  }
  return { cookies: map, updatedAt: Date.now(), userAgent };
}
