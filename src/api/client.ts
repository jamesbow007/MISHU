/**
 * BOSS直聘 接口客户端（纯 HTTP）。
 *
 * 认证机制（逆向自官方 chat bundle 的 withHeaders）：
 *   - Cookie：全部 zhipin cookie
 *   - zp_token 请求头 = cookie `bst` 的明文值
 *   - X-Requested-With: XMLHttpRequest
 *   - traceid：随机串
 *   - withCredentials = true
 */

export interface BossSession {
  /** cookie 名 → 值 */
  cookies: Record<string, string>;
  /** 更新时间戳 */
  updatedAt: number;
  /** 使用的 User-Agent */
  userAgent: string;
}

/** 错误码语义（逆向自 bundle 的 resCodeMap / i18n 文案） */
export const ERROR_CODES: Record<number, string> = {
  7: '登录已失效（logout）',
  31: '网关校验失败（webGate）',
  32: '网关校验失败（webGate）',
  35: '网关校验失败（webGate）',
  36: '网关校验失败（webGate）',
  1011: '登录已失效（logout）',
  120: 'CSRF 校验失败',
  121: 'CSRF 校验失败',
  122: 'CSRF 校验失败',
  5002: '网关校验失败（webGate）',
  5003: '网关校验失败（webGate）',
  5004: '网关校验失败（webGate）',
  5011: '网关校验失败（webGate）',
  5013: '网关校验失败（webGate）',
  10000: '获取 zp_token 失败',
  10002: '重试次数已达上限',
  10004: '当前网络环境已可用',
  10005: '当前登录状态已失效',
  10006: 'JS 检测到 zpToken 失效',
  10007: '读取 zp_token 失败',
  10008: '写入 geek_zp_token 失败',
  10009: '服务端检测到 zpToken 已失效',
  20000: '网关 seed/name/ts 存在空值',
  20001: '读取网关关键信息存在空值',
  20003: '网关 ABC 不存在或不是 1 个函数',
  20004: '生成 __zp_stoken__ 值失败',
};

export class BossApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public path: string,
    public raw?: any,
  ) {
    super(`${ERROR_CODES[code] ?? message ?? '未知错误'} (code=${code}) [${path}]`);
    this.name = 'BossApiError';
  }
}

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

/** 一次请求的描述（交给 transport 执行） */
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  text: string;
  headers?: Record<string, string | undefined>;
}

/**
 * 请求通道。
 * 默认直连（fetch）；也可以换成「页面代理」——让扩展把请求丢到浏览器页面里发，
 * 由浏览器自动携带完整登录 cookie（扩展读不到的那些 HttpOnly/分区 cookie 也就无所谓了）。
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export class BossClient {
  constructor(
    private session: BossSession,
    private base = 'https://www.zhipin.com',
    private transport?: Transport,
  ) {}

  get cookies(): Record<string, string> {
    return this.session.cookies;
  }

  setCookie(name: string, value: string): void {
    this.session.cookies[name] = value;
    this.session.updatedAt = Date.now();
  }

  /** 把 cookie 拼成 Cookie 请求头 */
  private cookieHeader(): string {
    return Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** 随机 traceid */
  private traceid(): string {
    return (
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /**
   * 发起一次接口请求。
   * @param path 以 / 开头，如 /wapi/zpchat/session/check
   */
  async request<T = any>(
    path: string,
    opts: {
      method?: 'GET' | 'POST';
      query?: Record<string, string | number | undefined>;
      body?: any;
      headers?: Record<string, string>;
      raw?: boolean;
    } = {},
  ): Promise<T> {
    const { method = 'GET', query, body, headers = {}, raw = false } = opts;

    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const h: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      traceid: this.traceid(),
      ...headers,
    };

    // User-Agent / Accept-Language / Referer / Origin 都是 fetch 的 forbidden header，
    // 页面代理模式下由浏览器自己填。**不要手动设 UA** ——
    // BOSS 会用 cookie 里的设备指纹（__a）校验 UA，硬编码的版本号与真实 UA 不符会被拒。
    if (!this.transport) {
      h['User-Agent'] = this.session.userAgent || DEFAULT_UA;
      h['Accept-Language'] = 'zh-CN,zh;q=0.9';
      h['Referer'] = `${this.base}/`;
      h['Origin'] = this.base;
    }

    // zp_token = cookie `bst` 的明文值
    const bst = this.session.cookies['bst'];
    if (bst) h['zp_token'] = bst;

    const cookieStr = this.cookieHeader();
    // 页面代理模式下不能手动设 Cookie 头 —— fetch 规范禁止，
    // 而且浏览器会自动带上【完整】的登录 cookie（HttpOnly 也照带），
    // 手动设置反而会覆盖掉。
    if (cookieStr && !this.transport) h['Cookie'] = cookieStr;

    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        payload = body;
        h['Content-Type'] ??= 'application/x-www-form-urlencoded';
      } else {
        payload = JSON.stringify(body);
        h['Content-Type'] ??= 'application/json';
      }
    }

    const res = this.transport
      ? await this.transport({ url: url.toString(), method, headers: h, body: payload })
      : await fetch(url.toString(), {
          method,
          headers: h,
          body: payload,
          redirect: 'manual',
        }).then(async (r) => ({
          status: r.status,
          text: await r.text(),
          headers: Object.fromEntries((r.headers as any).entries()),
          setCookieList: r.headers.getSetCookie?.() ?? [],
        }));

    // 把响应里的 Set-Cookie 收回会话（token 刷新靠这个）
    // 注意：空值也是有效语义 —— 服务端用 `bst=; Expires=<过去>` 表示删除该 cookie
    const setCookies = (res as any).setCookieList ?? [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        this.setCookie(name, value);
      }
    }

    const text = res.text;
    if (raw) return text as any;

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON：多半是 HTML（风控页 / 登录页）
      throw new BossApiError(
        -1,
        `响应不是 JSON（HTTP ${res.status}）—— 可能是风控页或被重定向到登录页：${text.slice(0, 120)}`,
        path,
        text.slice(0, 500),
      );
    }

    // BOSS 的业务码在 code 字段；0 / 1 视为成功
    const code = Number(data?.code);
    if (Number.isFinite(code) && code !== 0 && code !== 1) {
      throw new BossApiError(code, data?.message ?? '', path, data);
    }
    return data as T;
  }
}
