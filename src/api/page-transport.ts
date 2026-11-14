/**
 * 「页面代理」通道：让扩展把请求丢到浏览器页面里发。
 *
 * 为什么需要它：
 *   扩展读不全 zhipin 的 cookie（会话 cookie 常是 HttpOnly / 分区的，
 *   chrome.cookies 读不到），所以直连 HTTP 只能带上 bst → 服务端返回 code=7。
 *   但浏览器在【页面上下文】里发 fetch 时，会自动带上完整登录 cookie
 *   （HttpOnly 也照带）—— 所以把请求交给页面发，登录态就齐了。
 *
 * 前提：浏览器里有一个打开着的 zhipin.com 标签页（content script 在那里面）。
 */
import { bridge, BRIDGE_TASK_TIMEOUT_MS } from './bridge.js';
import type { CookieBridge } from './bridge.js';
import type { Transport, TransportResponse } from './client.js';
import { CHAT_URL } from './constants.js';
import { sleep } from './util.js';

export function createPageTransport(
  bridge: CookieBridge,
  // 比桥接的硬上限略长 —— 这样超时是桥接先回 504（错误信息更清楚），
  // 而不是客户端先 abort 抛一句没头没脑的 "This operation was aborted"
  timeoutMs = BRIDGE_TASK_TIMEOUT_MS + 2_000,
): Transport {
  return async ({ url, method, headers, body }): Promise<TransportResponse> => {
    const payload = await bridge.runTask({ kind: 'api', url, method, headers, body }, timeoutMs);

    if (!payload) throw new Error('扩展没有返回结果');
    if (payload.ok === false) {
      throw new Error(payload.error || '页面代理请求失败');
    }

    return {
      status: payload.status ?? 200,
      text: payload.text ?? '',
      headers: payload.headers ?? {},
    };
  };
}

/**
 * 派任务 + 解包：扩展没回 / ok:false 统一抛错，返回 data。
 *
 * 之前每个包装各自手写这三行，还漂移出过两种行为
 * （一种对「没返回」静默成功、一种抛错）。
 */
async function runTaskChecked(task: unknown, timeoutMs: number, what: string): Promise<any> {
  const payload = await bridge.runTask(task, timeoutMs);
  if (!payload) throw new Error('扩展没有返回结果');
  if (payload.ok === false) throw new Error(payload.error || what + '失败');
  return payload.data;
}

/**
 * 让真实浏览器打开一个页面并把渲染后的内容读回来。
 *
 * 用于受网关签名保护的页面（如岗位详情页）：裸 fetch 会拿到 code=37，
 * 而真实加载时页面自己会跑安全 JS 刷新 __zp_stoken__。
 */
export async function fetchPage(url: string): Promise<any> {
  return runTaskChecked({ kind: 'page', url }, BRIDGE_TASK_TIMEOUT_MS + 5_000, '页面加载');
}

/**
 * 在真实页面里跑一段固定的探针脚本，把页面状态读回来。
 *
 * 为什么需要它：**未读数只存在于浏览器侧**。
 * 服务端的会话详情接口里 unreadMsgCount 恒为 0，而网页上的「未读(N)」是真的 ——
 * 前端那个 N 是 MQTT 长连接推下来、由它自己在内存里算的。
 * 所以要读真实未读，只能去读页面。
 *
 * 扩展侧优先复用用户已经打开的消息页，不会新开标签页。
 *
 * ⚠️ **要重试**：页面刚打开时，前端还没收到 MQTT 推送，
 * 「未读」tab 上没有数字、行里也没有 notice-badge 徽标 —— 那不是「没有未读」，
 * 是「还没算出来」。所以读到这种状态要等一下再读。
 */
export async function probeDom(url: string, probe = 'unread', retries = 3): Promise<any> {
  let last: any = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    last = await runTaskChecked(
      { kind: 'page', url, type: 'dom', probe, waitMs: 800 },
      BRIDGE_TASK_TIMEOUT_MS + 2_000,
      'DOM 探针',
    );
    if (!last) continue;

    // 页面还没渲染出「未读」tab → 继续等
    const tabText = String(last.unreadTabText ?? '');
    if (!tabText.includes('未读')) continue;
    // tab 上有数字、或列表里已经有徽标 → 说明前端算完了
    if (/\(\d+\)/.test(tabText)) return last;
    if ((last.allRows ?? []).some((r: any) => r.unread > 0)) return last;

    // 「未读」在但没有数字、也没有徽标 —— 可能是真的 0，也可能还没推完，再等一轮
    if (attempt < retries - 1) {
      await sleep(1500);
    }
  }
  return last;
}

/**
 * 在真实页面里执行一串 DOM 动作（点会话、点按钮、读元素…）。
 *
 * 用于 BOSS 上那些**没有 HTTP 接口**的操作：
 * 「投递简历 / 发附件简历」本质是发一条聊天消息（走 MQTT），
 * onekeydeliver 对猎头岗位返回 code=1、exchange/videoResume/accept 返回 code=1049，
 * 所以只能模拟用户点击。
 *
 * 动作类型：wait / click / clickText / dump / text
 */
export async function runActions(url: string, actions: any[]): Promise<any[]> {
  const data = await runTaskChecked(
    { kind: 'page', url, type: 'dom', actions, waitMs: 2500 },
    BRIDGE_TASK_TIMEOUT_MS + 5_000,
    'DOM 操作',
  );
  return (data ?? []) as any[];
}

/**
 * 调用扩展里注册的页面函数（目前只有 'greeting'）。
 *
 * 与 runActions 的区别：**一整条动作链在一次 executeScript 里跑完**，
 * 全程共享同一个页面上下文。
 *
 * 为什么必须这样：桥接任务有 20 秒硬上限（bridge.ts 里的 504 超时），
 * 而「点会话 → 点发简历 → 点确定」三步依赖同一个页面状态 ——
 * 拆成三次调用，中间一旦标签页被回收，第②步就会跑在空页面上找不到按钮。
 *
 * opts.pin：把这个标签页固定住，后续任务复用（省掉每次 3~8 秒的页面加载，
 *            也让 MQTT 长连接一直活着）
 * opts.own：开自己的标签页，不复用用户正在看的消息页（不动用户界面）
 */
export async function runPageFn(
  fnName: string,
  arg: any,
  opts: { url?: string; timeoutMs?: number; pin?: boolean; own?: boolean } = {},
): Promise<any> {
  return runTaskChecked(
    {
      kind: 'page',
      url: opts.url ?? CHAT_URL,
      type: 'dom',
      fn: fnName,
      arg,
      pin: opts.pin,
      own: opts.own,
      waitMs: 1500,
    },
    opts.timeoutMs ?? BRIDGE_TASK_TIMEOUT_MS + 5_000,
    '页面函数执行',
  );
}

/**
 * 释放守护进程固定的那个标签页（退出时调用）。
 *
 * 单独一个任务种类 —— 之前是拿 `pin:false` 反义表示「释放」，
 * 一个布尔扛三种语义。
 */
export async function releasePinnedTab(): Promise<void> {
  await runTaskChecked({ kind: 'tab-release' }, BRIDGE_TASK_TIMEOUT_MS + 2_000, '释放固定标签页');
}

/** 浏览器标签页清单（--tabs 排查用） */
export interface ChatTabsInfo {
  tabs: {
    id: number;
    title: string;
    url: string;
    active: boolean;
    windowId: number;
    isZhipin: boolean;
  }[];
  totalTabs: number;
  /** 守护进程固定页的 tabId（没固定就是 null） */
  pinTabId: number | null;
}

/**
 * 列出浏览器里所有 BOSS直聘 标签页 —— 排查「是不是在攒标签页」。
 */
export async function listChatTabs(): Promise<ChatTabsInfo> {
  return runTaskChecked({ kind: 'tabs' }, BRIDGE_TASK_TIMEOUT_MS + 2_000, '拿标签页列表');
}

/**
 * 清理泄漏出来的聊天页标签页（保留每个窗口当前正在看的那一个 + 固定页）。
 * dryRun=true 时只报告不关。
 */
export async function closeLeakedChatTabs(dryRun = true): Promise<{
  found: number;
  closed: number;
  kept: number;
}> {
  return runTaskChecked(
    { kind: 'tabs-close', dryRun },
    BRIDGE_TASK_TIMEOUT_MS + 2_000,
    '清理标签页',
  );
}
