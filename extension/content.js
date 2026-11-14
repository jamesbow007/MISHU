/**
 * content script —— 在【页面上下文】里发请求。
 *
 * 为什么需要它：扩展读不全所有 cookie（会话 cookie 可能是 HttpOnly/分区的，
 * 读不到），但浏览器自己在页面里发 fetch 时会自动携带【完整】的登录 cookie，
 * HttpOnly 也照带。这样就完全绕开了"读 cookie 明文"这一步。
 *
 * 同时它也是唤醒 background service worker 的触发源。
 */

// —— 唤醒 SW ——
// 间隔别太长：MV3 的 service worker 空闲约 30 秒就会被 Chrome 终止，
// 而没有 ping 的话，任务要一直等到浏览器下次自然唤醒它（实测能等十几秒）。
// 这里每 10 秒 ping 一次：既保活 SW，也让终止后的恢复更快。
function ping() {
  try {
    chrome.runtime.sendMessage({ type: 'ping' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* ignore */
  }
}
ping();
setInterval(ping, 10000);

// —— 提取页面里的岗位详情（JD）——
// 岗位详情页由真实浏览器加载：页面自己会跑安全 JS 刷新 __zp_stoken__，
// 我们只负责把渲染好的内容读出来。
function extractJob() {
  const t = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || '').trim() : undefined;
  };
  const all = (sel) => [
    ...new Set(
      Array.from(document.querySelectorAll(sel))
        .map((e) => (e.innerText || '').trim())
        .filter(Boolean),
    ),
  ];

  // JD 正文：只取 .job-sec-text 这类正文容器，
  // 否则会把侧边栏（技能标签、举报按钮等）也混进来。
  const sections = Array.from(
    document.querySelectorAll('.job-sec-text, .job-detail-text, .job-detail-desc'),
  )
    .map((el) => {
      const holder = el.closest('.job-sec, .job-detail-section') || el.parentElement;
      return {
        title: (holder?.querySelector('h3, h4, .job-sec-title, .job-detail-title')?.innerText || '').trim(),
        text: (el.innerText || '').trim(),
      };
    })
    .filter((s) => s.text.length > 4);

  // 岗位名与薪资在 .job-banner 里是相邻的两个元素，分开取
  const banner = document.querySelector('.job-banner');
  const nameEl = banner?.querySelector('.name, h1, .job-name');
  const salaryEl = banner?.querySelector('.salary, .job-limit .salary');

  return {
    url: location.href,
    title: (nameEl?.textContent || '').trim() || undefined,
    salary: (salaryEl?.textContent || '').trim() || undefined,
    address: t('.job-banner .text-city, .job-address, .location, .job-location, .job-banner .area'),
    company: t('.company-info a, .sider-company .name, .company-name, .company-text'),
    tags: all('.job-banner .tag-list li, .job-tags span, .job-limit .tag-list li, .company-tag span'),
    sections,
    bodyText: (document.body.innerText || '').slice(0, 30000),
  };
}

// —— 执行 SW 派来的接口请求 ——
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // 提取岗位详情（由 SW 在真实加载完岗位页后派发）
  if (msg.type === 'extract') {
    try {
      sendResponse({ ok: true, data: extractJob() });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }

  if (msg.type !== 'api') return false;

  const opts = {
    method: msg.method || 'GET',
    credentials: 'include', // 关键：带完整登录 cookie
    headers: msg.headers || {},
  };
  if (msg.body !== undefined && msg.body !== null && msg.method !== 'GET') {
    opts.body = msg.body;
  }

  fetch(msg.url, opts)
    .then((r) =>
      r.text().then((text) =>
        sendResponse({
          ok: true,
          status: r.status,
          text,
          headers: {
            'set-cookie': r.headers.get('set-cookie') || undefined,
            'content-type': r.headers.get('content-type') || undefined,
          },
        }),
      ),
    )
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

  return true; // 异步响应
});
