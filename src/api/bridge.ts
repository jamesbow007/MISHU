/**
 * 本地桥接服务：接收 Chrome 扩展回传的 cookie 明文。
 *
 * Chrome 157 的 App-Bound Encryption 让外部无法解密 cookie，且默认目录又禁调试连接，
 * 所以改用扩展的 chrome.cookies API 取明文 —— 扩展是唯一不触发风控的取 cookie 途径。
 *
 * 协议：
 *   GET  /poll?wait=1   扩展长轮询取任务；本地服务有任务时立即返回，否则挂起至多 25s
 *   POST /cookies       扩展回传 cookie 明文
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { sleep } from './util.js';

export const BRIDGE_PORT = 39115;

/**
 * 桥接任务的硬上限（毫秒）。
 *
 * 扩展那边一次任务最多跑这么久，超时就回 504。
 * 所有调用方的 timeout 都必须从这一个常量派生 ——
 * 之前各处写 25s / 30s / 60s / 120s，全都大于 20s，
 * 于是「声明的超时」永远不生效，真正的上限只有这一个。
 */
export const BRIDGE_TASK_TIMEOUT_MS = 20_000;

/** 扩展回传的 cookie（只有 name/value/domain 三个字段被真正消费） */
export interface PlainCookie {
  name: string;
  value: string;
  domain: string;
}

interface Waiter {
  resolve: (taskId: string, task: any) => void;
  timer: NodeJS.Timeout;
}

export class CookieBridge {
  private server: http.Server | null = null;
  private waiters: Waiter[] = [];
  private pendingTasks: Array<{ taskId: string; task: any }> = [];
  /** 等待扩展回传结果的任务 → 挂起的 HTTP 响应 */
  private pendingResults = new Map<string, import('node:http').ServerResponse>();
  private latest: PlainCookie[] = [];
  private lastUpdate = 0;
  /** 扩展最近一次来长轮询的时间 —— 判断「扩展是否连着」要看它，不是看 cookie */
  private lastPoll = 0;
  /** 端口已被别的进程占用时，走远程模式向那个宿主取 cookie */
  private remote = false;
  /** 宿主注册的停机回调（watch 工作进程接 /shutdown 用） */
  private shutdownFn: (() => Promise<void>) | null = null;

  /** 注册停机回调：桥接只提供通道，退出策略归调用方 */
  registerShutdown(fn: () => Promise<void>): void {
    this.shutdownFn = fn;
  }

  /** 最近一次收到 cookie 的时间 */
  get lastUpdated(): number {
    return this.lastUpdate;
  }

  /**
   * 扩展当前的 service worker 启动时刻 + 它正在跑的源码指纹。
   * 扩展在 /diag 里报上来，本地脚本靠它判断「磁盘上的代码是不是更新的」。
   */
  private swStart = 0;
  private selfHash = '';

  get cached(): PlainCookie[] {
    return this.latest;
  }

  async start(port = BRIDGE_PORT): Promise<void> {
    if (this.server || this.remote) return;

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/poll') {
        this.handlePoll(res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/cookies') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const cookies: PlainCookie[] = Array.isArray(data.cookies) ? data.cookies : [];
            this.latest = cookies;
            this.lastUpdate = Date.now();

            // 如果这是一个任务的结果，写回等待中的调用方
            if (data.taskId) {
              const pending = this.pendingResults.get(data.taskId);
              if (pending) {
                this.pendingResults.delete(data.taskId);
                pending.writeHead(200, { 'Content-Type': 'application/json' });
                pending.end(JSON.stringify({ cookies }));
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch (e) {
            res.writeHead(400);
            res.end('{"ok":false}');
          }
        });
        return;
      }

      // 给其它进程（MCP server / 探测脚本）读取缓存的 cookie
      if (req.method === 'GET' && url.pathname === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookies: this.latest, lastUpdate: this.lastUpdate }));
        return;
      }

      // 扩展回传任务结果
      if (req.method === 'POST' && url.pathname.startsWith('/result')) {
        const taskId = url.pathname.slice('/result/'.length);
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const pending = this.pendingResults.get(taskId);
          if (pending) {
            this.pendingResults.delete(taskId);
            let payload: any;
            try {
              payload = JSON.parse(body || '{}');
            } catch {
              payload = { raw: body };
            }
            pending.writeHead(200, { 'Content-Type': 'application/json' });
            pending.end(JSON.stringify(payload));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }

      // 派发任务给扩展（任何进程都能用，本地与远程统一走这里）
      if (req.method === 'POST' && url.pathname === '/task') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let task: any = {};
          try {
            task = JSON.parse(body || '{}');
          } catch {
            /* ignore */
          }
          const taskId = randomUUID();

          // 【顺序很重要】必须先登记 pendingResults，再把任务推给扩展 ——
          // 否则扩展可能瞬间就把结果 POST 回来，而此时还没登记，结果就丢了。
          const timer = setTimeout(() => {
            this.pendingResults.delete(taskId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: '任务超时（扩展未响应）' }));
          }, BRIDGE_TASK_TIMEOUT_MS);
          // 客户端提前断开（超时/abort）时，除了清定时器，还要把挂起的响应从表里摘掉 ——
          // 只 clearTimeout 会让这条记录永远留在 Map 里，连同它持有的 socket。
          res.on('close', () => {
            clearTimeout(timer);
            this.pendingResults.delete(taskId);
          });
          this.pendingResults.set(taskId, res);

          this.pendingTasks.push({ taskId, task });

          const w = this.waiters.shift();
          if (w) {
            clearTimeout(w.timer);
            w.resolve(taskId, task);
          }
        });
        return;
      }

      // 扩展发来的诊断信息
      if (req.method === 'POST' && url.pathname === '/diag') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const diag = JSON.parse(body || '{}');
            if (diag.swStart) this.swStart = Number(diag.swStart);
            if (diag.selfHash) this.selfHash = String(diag.selfHash);
            // 守护进程模式下关掉：诊断信息会跟它自己的日志混在一起，刷屏。
            // （单独跑 npm run bridge 时默认是开着的，排查问题用得上。）
            const quiet = process.env.BOSS_ZHIPIN_QUIET_DIAG === '1';
            if (!quiet) {
              // 必须走 stderr：MCP server 的 stdout 是 JSON-RPC 协议通道，
              // 往 stdout 写任何非 JSON 文本都会让客户端解析失败。
              console.error('\n[扩展诊断]');
              console.error('  zhipin cookie:', diag.zhipinCount, '个 →', (diag.zhipinNames ?? []).join(', '));
              if (diag.errors?.length) console.error('  错误:', diag.errors.join(' | '));
              if (diag.tabCandidates) {
                console.error(
                  '  候选标签页: ' +
                    (diag.tabCandidates as any[])
                      .map((t: any) => `#${t.id}${t.incognito ? '(隐身)' : ''}${t.active ? '(活动)' : ''} ${String(t.url).slice(0, 50)}`)
                      .join('  ||  '),
                );
              }
            }
          } catch {
            /* ignore */
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            // 扩展空闲时不会回传 cookie，只是一直在长轮询 ——
            // 所以「连没连上」看它最近一次来没来 /poll，而不是看 cookie 时间戳。
            connected: Date.now() - this.lastPoll < 60_000,
            lastPoll: this.lastPoll,
            lastUpdate: this.lastUpdate,
            cookieCount: this.latest.length,
            names: this.latest.map((c) => c.name),
            // 扩展当前 SW 的启动时刻 / 源码指纹（判断磁盘代码是否更新）
            swStart: this.swStart,
            selfHash: this.selfHash,
          }),
        );
        return;
      }

      // 请求宿主进程优雅停机（watch:stop 用 —— 让工作进程自己跑退出钩子，
      // 而不是父进程在进程外替它释放资源）
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        const fn = this.shutdownFn;
        if (fn) setImmediate(() => fn().catch(() => {}));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    };

    // 先探一下端口上是不是已经有个活着的桥接 —— 有就直接走远程模式。
    // 不探的话，下面那个「等刚被 kill 的旧进程释放端口」的重试循环
    // 要白等 5 秒才降级；而守护进程在跑时（--stop / --tabs / ext:reload）
    // 端口持有者是**故意活着的**，5 秒全是白等。
    try {
      const alive = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(600),
      });
      if (alive.ok) {
        this.remote = true;
        return;
      }
    } catch {
      /* 没人监听 → 自己当宿主 */
    }

    // bind 失败时重试几次：端口常常是「刚被 kill 的旧进程」还占着，
    // 直接降级成远程模式会导致旧进程一死就没人监听端口，全链路卡死。
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const srv = http.createServer(handler); // 每次重试都要新的 server 对象
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(port, '127.0.0.1', () => resolve());
        });
        this.server = srv;
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        this.server = null;
        if (e?.code !== 'EADDRINUSE') throw e;
        await sleep(1000);
      }
    }

    if (lastErr) {
      // 确实有别的进程长期占着 → 降级为远程读取
      this.remote = true;
      console.error('[bridge] 端口已被其它进程占用，改为向现有桥接读取 cookie');
      return;
    }
  }

  /** 远程模式下向宿主取缓存 cookie */
  private async remoteSession(): Promise<{ cookies: PlainCookie[]; lastUpdate: number }> {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/session`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`桥接返回 HTTP ${res.status}`);
    return (await res.json()) as { cookies: PlainCookie[]; lastUpdate: number };
  }

  /** 长轮询：有任务立刻发，没有就挂起 */
  private handlePoll(res: http.ServerResponse): void {
    this.lastPoll = Date.now();
    const send = (taskId: string, task: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId, kind: task?.kind ?? 'cookies', task }));
    };

    const queued = this.pendingTasks.shift();
    if (queued) {
      send(queued.taskId, queued.task);
      return;
    }

    const timer = setTimeout(() => {
      this.waiters = this.waiters.filter((w) => w.timer !== timer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"idle":true}');
    }, 20_000);

    this.waiters.push({ resolve: send, timer });
  }

  /**
   * 派发一个任务给扩展并等待结果。
   * 任务类型：
   *   {kind:'cookies'}          → 扩展回传 cookie 明文
   *   {kind:'api', url, ...}    → 扩展转给页面里的 content script 去发请求
   */
  async runTask(task: any, timeoutMs = BRIDGE_TASK_TIMEOUT_MS + 5_000): Promise<any> {
    // 本地与远程统一走 HTTP /task，宿主负责派发给扩展并回传结果
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text.slice(0, 200) };
    }
  }

  /**
   * 向扩展索要 cookie。优先用缓存；缓存太旧则发起一次实时请求。
   */
  async requestCookies(timeoutMs = 8000, force = false): Promise<PlainCookie[]> {
    // 远程模式：向宿主进程要缓存
    if (this.remote) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const s = await this.remoteSession();
          // 缓存够新 → 直接用
          if (s.cookies.length && Date.now() - s.lastUpdate < 30_000) {
            this.latest = s.cookies;
            this.lastUpdate = s.lastUpdate;
            return s.cookies;
          }
          // 缓存太旧（扩展空闲时不回传 cookie，lastUpdate 会变旧）：
          // 走宿主派一次实时采集，否则会拿着过期 cookie 请求 → 被判「未登录」
          if (s.cookies.length) {
            const payload = await this.runTask({ kind: 'cookies' }, Math.max(2000, deadline - Date.now()));
            if (payload?.cookies?.length) {
              this.latest = payload.cookies;
              this.lastUpdate = Date.now();
              return payload.cookies as PlainCookie[];
            }
          }
        } catch {
          /* 宿主可能刚启动 */
        }
        await sleep(1000);
      }
      throw new Error('扩展未响应（远程桥接也没有拿到 cookie）');
    }

    if (!force && this.latest.length && Date.now() - this.lastUpdate < 30_000) {
      return this.latest;
    }

    const payload = await this.runTask({ kind: 'cookies' }, timeoutMs);
    if (!payload?.cookies) {
      throw new Error(
        payload?.error ||
          '扩展未响应。请确认：① 已加载 extension/ 目录的扩展；② 已登录 BOSS直聘；③ 本地服务已启动（端口 39115）',
      );
    }
    return payload.cookies as PlainCookie[];
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      // close() 只停收新连接，**不掐断已有的** ——
      // 扩展那边一直挂着长轮询连接（/poll?wait=1 挂 20 秒然后立刻重连），
      // 不主动掐断的话 close() 的回调永远不会触发，进程就卡在这里退不出去。
      srv.closeAllConnections?.();
    });
  }
}

export const bridge = new CookieBridge();

/**
 * 读一次桥接状态（扩展连着没、最近一次轮询什么时候）。
 *
 * 守护进程和扩展自重载脚本都要看这个 —— 之前两边各写了一份
 * 一模一样的 fetch，还把端口号 39115 又硬编码了一次。
 */
export async function bridgeStatus(): Promise<BridgeStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/status`, { cache: 'no-store' });
    return (await res.json()) as BridgeStatus;
  } catch {
    return null;
  }
}

/** 请求宿主桥接优雅停机（没有宿主时返回 false） */
export async function requestBridgeShutdown(timeoutMs = 4_000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface BridgeStatus {
  connected: boolean;
  lastPoll: number;
  lastUpdate: number;
  cookieCount: number;
  names: string[];
  /** 扩展 service worker 的启动时刻 —— 判断磁盘代码是不是更新的 */
  swStart?: number;
  /** 扩展正在跑的源码指纹 */
  selfHash?: string;
}
