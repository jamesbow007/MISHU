/**
 * 纯 HTTP 扫码登录（备用分支，主线是复用日常 Chrome 的登录态）。
 *
 * 接口链路（已实测存在，未登录态即可调用）：
 *   ① POST /wapi/zppassport/captcha/randkey        body: pk=cpc_user_sign_up
 *      → zpData: { qrId, randKey, secretKey, shortRandKey }
 *   ② GET  /wapi/zppassport/qrcode/getMpCode?uuid=<shortRandKey>&width=200
 *      → zpData.mpCodeUrl（服务端直接给 PNG，不需要自己生成二维码）
 *   ③ GET  /wapi/zppassport/qrcode/scan?uuid=<qrId>   轮询扫码状态
 *   ④ GET  /wapi/zppassport/qrcode/dispatcher?qrId=&pk=&fp=   登录确认 → 服务端种会话 cookie
 *
 * 注：各步骤的 uuid 取值（qrId / shortRandKey）随前端版本变化，
 *     这里按候选顺序逐个尝试，取第一个返回有效结果的。
 */
import type { BossClient } from './client.js';

export const QR_PK = 'cpc_user_sign_up';

export interface QrLogin {
  qrId: string;
  shortRandKey: string;
  randKey: string;
  secretKey: string;
  mpCodeUrl: string;
  /** 二维码 PNG 二进制（已下载） */
  png?: Buffer;
}

export type QrState = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed';

/** 取页面上的 pk（登录页的 page_key_name） */
export async function fetchPk(): Promise<string> {
  try {
    const res = await fetch('https://www.zhipin.com/web/user/?ka=header-login', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0 Safari/537.36' },
    });
    const html = await res.text();
    const m = html.match(/id="page_key_name"\s+value="([^"]+)"/);
    return m?.[1] ?? QR_PK;
  } catch {
    return QR_PK;
  }
}

/** 第一步：申请二维码 */
export async function createQr(client: BossClient, pk = QR_PK): Promise<QrLogin> {
  const res: any = await client.request('/wapi/zppassport/captcha/randkey', {
    method: 'POST',
    body: `pk=${encodeURIComponent(pk)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const d = res?.zpData ?? {};
  const qr: QrLogin = {
    qrId: String(d.qrId ?? ''),
    shortRandKey: String(d.shortRandKey ?? d.randKey ?? ''),
    randKey: String(d.randKey ?? ''),
    secretKey: String(d.secretKey ?? ''),
    mpCodeUrl: '',
  };
  if (!qr.qrId && !qr.shortRandKey) throw new Error('randkey 未返回 qrId');

  // 第二步：拿二维码图片地址
  try {
    const img: any = await client.request('/wapi/zppassport/qrcode/getMpCode', {
      method: 'GET',
      query: { uuid: qr.shortRandKey || qr.qrId, width: 200 },
    });
    qr.mpCodeUrl = String(img?.zpData?.mpCodeUrl ?? '');
  } catch {
    /* 拿不到图片地址时仍可走 scan 轮询 */
  }

  // 下载二维码 PNG
  if (qr.mpCodeUrl) {
    try {
      const r = await fetch(qr.mpCodeUrl);
      if (r.ok) qr.png = Buffer.from(await r.arrayBuffer());
    } catch {
      /* ignore */
    }
  }

  return qr;
}

/** 第三步：轮询扫码状态 */
export async function pollScan(
  client: BossClient,
  qr: QrLogin,
): Promise<{ scanned: boolean; msg?: string }> {
  const uuids = [qr.qrId, qr.shortRandKey].filter(Boolean);
  for (const uuid of uuids) {
    try {
      const res: any = await client.request('/wapi/zppassport/qrcode/scan', {
        method: 'GET',
        query: { uuid },
        raw: true,
      });
      const parsed = typeof res === 'string' ? safeJson(res) : res;
      if (parsed && (parsed.scaned || parsed.scanned)) {
        return { scanned: true, msg: parsed.msg };
      }
      if (parsed?.msg && parsed.msg !== 'timeout') {
        return { scanned: false, msg: parsed.msg };
      }
    } catch {
      /* 换下一个 uuid 试 */
    }
  }
  return { scanned: false };
}

/** 第四步：登录确认 */
export async function confirmLogin(
  client: BossClient,
  qr: QrLogin,
  pk = QR_PK,
  fp = '',
): Promise<{ ok: boolean; code?: number; message?: string }> {
  const queries = [qr.qrId, qr.shortRandKey].filter(Boolean);
  for (const uuid of queries) {
    try {
      const res: any = await client.request('/wapi/zppassport/qrcode/dispatcher', {
        method: 'GET',
        query: { qrId: uuid, pk, fp },
        raw: true,
      });
      const parsed = typeof res === 'string' ? safeJson(res) : res;
      if (parsed && Number(parsed.code) === 0) {
        return { ok: true, code: 0, message: parsed.message ?? 'Success' };
      }
      if (parsed?.code !== undefined) {
        return { ok: false, code: Number(parsed.code), message: parsed.message };
      }
    } catch {
      /* 换下一个 uuid 试 */
    }
  }
  return { ok: false, message: 'dispatcher 未返回有效结果' };
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 完整扫码登录流程。
 * @param onQr 拿到二维码时回调（用于把图片交给用户）
 * @param onState 状态变化回调
 */
export async function loginByQr(
  client: BossClient,
  opts: {
    pk?: string;
    timeoutMs?: number;
    onQr?: (qr: QrLogin) => void;
    onState?: (s: QrState, detail?: string) => void;
  } = {},
): Promise<{ success: boolean; qr?: QrLogin; message?: string }> {
  const pk = opts.pk ?? (await fetchPk());
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;

  const qr = await createQr(client, pk);
  opts.onQr?.(qr);
  opts.onState?.('waiting');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const { scanned } = await pollScan(client, qr);
    if (!scanned) continue;

    opts.onState?.('scanned');
    const r = await confirmLogin(client, qr, pk);
    if (r.ok) {
      opts.onState?.('confirmed');
      return { success: true, qr };
    }
    opts.onState?.('failed', r.message);
    return { success: false, qr, message: r.message };
  }

  opts.onState?.('expired');
  return { success: false, qr, message: '扫码超时' };
}
