/**
 * MISHU —— 后台 service worker
 *
 * 职责：把浏览器里的 zhipin cookie 明文交给本地 MCP 服务。
 * 不做任何页面操作 —— 只读 cookie。
 *
 * 协议（与本地 MCP 服务）：
 *   GET  /poll?wait=1   长轮询。有任务立刻返回 {taskId, kind}，否则挂起至多 25s
 *   POST /cookies       扩展 → MCP 服务，回传 cookie 明文 {taskId?, cookies:[...]}
 */

const LOCAL = 'http://127.0.0.1:39115';

/**
 * 往本地桥接 POST 一个 JSON。
 *
 * 回传结果、报诊断、回传 cookie、派任务结果 —— 四处都是同一段 fetch，
 * 之前各抄一遍。
 */
async function postJson(path, body) {
  try {
    await fetch(`${LOCAL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return true;
  } catch (e) {
    return false;
  }
}

let booted = false;

/**
 * 这个 service worker 实例的启动时刻 + 它正在跑的源码指纹。
 *
 * 用途：让本地脚本能判断「磁盘上的 background.js 是不是比我新」——
 * 新的话扩展就自己 chrome.runtime.reload()（省得每次都让人去
 * chrome://extensions/ 手动点「重新加载」）。
 *
 * 两个信号互补：
 *   SW_START  —— 磁盘文件比这个时间新，说明我跑的是旧代码
 *   selfHash  —— 把自己正在跑的源码算个指纹，跟磁盘上的对比
 *                （service worker 空闲重启后**不会**重新读磁盘，
 *                 所以光看时间会漏判）
 */
const SW_START = Date.now();
let selfHash = '';

async function hashText(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (e) {
    return '';
  }
}

async function selfSourceHash() {
  try {
    const res = await fetch(chrome.runtime.getURL('background.js'), { cache: 'no-store' });
    return await hashText(await res.text());
  } catch (e) {
    return '';
  }
}

// 算一次就够 —— 源码在 SW 生命周期里不会变
selfSourceHash().then((h) => {
  selfHash = h;
});

/** 把任务结果回传给本地桥接 */
async function postResult(taskId, payload) {
  await postJson(`/result/${taskId}`, payload);
}

/**
 * 处理「自重载」任务：磁盘上的代码比我跑的旧 → 重载自己。
 *
 * 本地脚本（npm run ext:reload）把磁盘上 background.js 的修改时间和
 * 内容哈希发过来；两个信号任一表明「磁盘比我新」就重载。
 */
async function handleSelfReload(taskId, task) {
  const diskMtime = Number((task && task.diskMtime) || 0);
  const diskHash = String((task && task.diskHash) || '');

  const byTime = !!diskMtime && diskMtime > SW_START;
  const byHash = !!diskHash && !!selfHash && diskHash !== selfHash;

  if (!byTime && !byHash) {
    await postResult(taskId, {
      ok: true,
      data: { reloaded: false, swStart: SW_START, selfHash, reason: '跑的就是磁盘上这份代码' },
    });
    return;
  }
  // 磁盘上改过了 → 重载。SW 会死，所以不回报结果（调用方会超时，那是预期的）。
  chrome.runtime.reload();
}

/**
 * 常驻「自动投递」用的固定标签页。
 *
 * 为什么需要固定：
 *   - 每开一个新标签页都要等 SPA 渲染（实测 3~8 秒），而桥接任务有 20 秒硬上限；
 *   - 未读数靠 MQTT 推送，页面开着才有 —— 固定住一个标签页，MQTT 连接就一直活着。
 * 空闲太久（10 分钟）自动关掉，免得守护进程崩了之后留下一个永远开着的标签页。
 *
 * ⚠️ **固定页必须存在 SW 之外**：
 *   MV3 的 service worker 随时会被回收，模块里的变量一重置就忘了固定页是谁 ——
 *   下一轮就会另开一个，旧的那个再也关不掉（标签页会越攒越多）。
 *
 * ⚠️ **用 storage.local，不用 storage.session**：
 *   session 在扩展 reload / update 时会被**清空** —— 而我们自己的开发流程
 *   （npm run ext:reload）天天触发。账本一清零，旧固定页就成了没人认领的孤儿
 *   （泄漏 bug 换个马甲回来）。local 跨 reload 存活；
 *   浏览器重启后 tabId 全部失效也无妨 —— tabs.get 抛错就清空，
 *   sweepOrphans 对死 id 的 remove 会被 catch 掉，自愈。
 *
 * state = { tabId, at, opened: number[] }
 *   tabId —— 当前固定的那个标签页
 *   at    —— 最后一次使用它的时间（用来判断空闲）
 *   opened —— 本扩展开过的所有标签页，用来清理孤儿页
 */
const PIN_KEY = 'daemonTab';
const PIN_IDLE_MS = 10 * 60 * 1000;
/**
 * 页面加载最多等多久。
 *
 * 必须远小于桥接任务的 20 秒硬上限 —— 剩下的额度要留给
 * 渲染等待 + executeScript（扫一遍消息页实测 2.1 秒）。
 */
const PAGE_LOAD_BUDGET_MS = 10_000;

async function loadPin() {
  try {
    return (await chrome.storage.local.get(PIN_KEY))[PIN_KEY] ?? null;
  } catch (e) {
    return null;
  }
}

async function savePin(next) {
  try {
    if (next) await chrome.storage.local.set({ [PIN_KEY]: next });
    else await chrome.storage.local.remove(PIN_KEY);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 读-改-写收在一处 —— 「谁在什么时候改 pin」只看这一个函数。
 * 之前五处调用点各自 loadPin → 展开 → savePin，await 的间隙里交错写
 * 会用旧 opened[] 覆盖掉别人的变更（比如把刚移除的死 id 又写回去）。
 */
async function updatePin(fn) {
  const next = fn((await loadPin()) || { tabId: null, at: 0, opened: [] });
  await savePin(next);
  return next;
}

/** 关掉本扩展开过、但已经不是固定页的那些标签页（孤儿页） */
/** 关掉本扩展开过、但已经不是固定页的那些标签页（孤儿页） */
async function sweepOrphans(keepTabId) {
  await updatePin((pin) => {
    const orphans = (pin.opened ?? []).filter((id) => id !== keepTabId);
    if (orphans.length) chrome.tabs.remove(orphans).catch(() => {});
    return { ...pin, opened: (pin.opened ?? []).filter((id) => id === keepTabId) };
  });
}

/**
 * 关掉我们开过的所有标签页（固定页 + 孤儿），并清空账本。
 *
 * 「释放固定页」（守护进程退出）和「空闲清理」（10 分钟闹钟）都走这里 ——
 * 两处各自手写的话迟早漂移（之前就漂过：一边有 tabId 兜底一边没有）。
 */
async function closeAllOpenedTabs() {
  const pin = await loadPin();
  const ids = [...new Set([...(pin?.opened ?? []), ...(pin?.tabId ? [pin.tabId] : [])])];
  if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
  await savePin(null);
  return ids.length;
}

/**
 * tabs 域任务的统一信封 —— 加第三种 tabs 任务不用再抄一遍 try/postResult。
 */
async function tabsTask(taskId, compute) {
  try {
    await postResult(taskId, { ok: true, data: await compute() });
  } catch (e) {
    await postResult(taskId, { ok: false, error: String((e && e.message) || e) });
  }
}

/** 列出浏览器里所有的标签页 —— 排查「标签页是不是越攒越多」用 */
async function listTabsData() {
  const allTabs = await chrome.tabs.query({}); // 一次全量查询，客户端过滤，省一次 IPC
  const pin = await loadPin();
  return {
    totalTabs: allTabs.length,
    pinTabId: pin?.tabId ?? null,
    // 全部列出来（不只 BOSS 的）—— 万一泄漏的不是 BOSS 页面，也要看得见
    tabs: allTabs.slice(0, 200).map((t) => ({
      id: t.id,
      title: String(t.title || '').slice(0, 40),
      url: String(t.url || '').slice(0, 120),
      active: !!t.active,
      windowId: t.windowId,
      isZhipin: /^https:\/\/[^/]*zhipin\.com\//.test(String(t.url || '')),
    })),
  };
}

/**
 * 清理「泄漏」出来的标签页。
 *
 * 之前有个 bug 会让守护进程每轮漏几个标签页，几小时就能攒几百个。
 * 修好之后不会再漏，但已经漏掉的那些还在浏览器里 —— 这个任务负责收尾。
 *
 * 规则：关掉所有 BOSS直聘 聊天页标签页，但**保留每个窗口当前正在看的那一个**
 * （免得把用户正在读的消息页也关了）。dryRun=true 时只报告不关。
 */
async function closeLeakedTabsData(task) {
  const dryRun = !!(task && task.dryRun);
  const allTabs = await chrome.tabs.query({});
  const pin = await loadPin();
  const chat = allTabs.filter((t) =>
    /^https:\/\/[^/]*zhipin\.com\/web\/geek\/chat/.test(String(t.url || '')),
  );
  // 保留：每个窗口当前正在看的那一个 + 守护进程自己固定的那个
  // （注意是按「标签页」保留，不是按窗口 —— 一个窗口里可能攒了几十个）
  const keep = new Set([...allTabs.filter((t) => t.active).map((t) => t.id), ...(pin?.tabId ? [pin.tabId] : [])]);
  const targets = chat.filter((t) => !keep.has(t.id));
  // chrome.tabs.remove 接受 id 数组，一次调用关全部 ——
  // 这个命令的设计场景就是「攒了几百个」，逐个 await 会白白吃 20 秒预算
  if (!dryRun && targets.length) await chrome.tabs.remove(targets.map((t) => t.id)).catch(() => {});
  return { found: chat.length, closed: dryRun ? 0 : targets.length, kept: chat.length - targets.length };
}

/**
 * 释放固定标签页（守护进程退出时调用）。
 *
 * 单独做一个任务种类，而不是拿 `pin:false` 反义表示「释放」——
 * 一个布尔扛三种语义迟早会漏。
 */
async function releasePinnedTab(taskId) {
  const closed = await closeAllOpenedTabs();
  await postResult(taskId, { ok: true, data: { released: true, closed } });
}

async function collectCookies() {
  // 只查 zhipin 域。
  // 之前会枚举整个浏览器的 cookie 罐（getAll({})）只为打一行诊断日志 ——
  // 既浪费，又把无关站点的域名带出去了。
  try {
    const list = await chrome.cookies.getAll({ domain: 'zhipin.com' });
    const cookies = list.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    }));
    await reportDiag({
      zhipinCount: cookies.length,
      zhipinNames: cookies.map((c) => c.name),
      // 供本地脚本判断「磁盘上的代码是不是比我新」
      swStart: SW_START,
      selfHash,
    });
    return cookies;
  } catch (e) {
    console.warn('[mishu] 取 cookie 失败', e);
    return [];
  }
}

/** 把诊断信息发给本地服务 */
async function reportDiag(diag) {
  await postJson('/diag', diag);
}

async function postCookies(taskId, cookies) {
  // postJson 出错时返回 false —— 所以这里要自己判，
  // 不然本地服务没起来的时候徽章还会显示「已同步 N 个 cookie」。
  const ok = await postJson('/cookies', { taskId: taskId ?? null, cookies });
  if (!ok) {
    await setBadge('!', '#dc2626');
    console.warn('[mishu] 回传 cookie 失败（本地服务没起来？）');
    return false;
  }
  await setBadge(String(cookies.length), cookies.length ? '#16a34a' : '#dc2626');
  if (!cookies.length) {
    console.warn(
      '[mishu] 拿到 0 个 cookie —— 检查 manifest 的 host_permissions 是否包含 https://*.zhipin.com/*，' +
        '以及浏览器是否已登录 zhipin.com',
    );
  }
  return true;
}

/** 状态徽章：让用户一眼看出通没通 */
async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({
      title:
        text === '!'
          ? '本地服务未连接 —— 请先运行 npm run bridge 或 npm run watch'
          : `已同步 ${text} 个 cookie`,
    });
  } catch (e) {
    /* ignore */
  }
}

/**
 * 任务派发 —— pollOnce（定时）和 pollLoop（长轮询）共用一份。
 *
 * 以前两处各写一遍，加一种 kind（比如自重载）就得改两个地方，
 * 漏改一处会静默走 cookie 分支（任务没执行，也不报错）。
 */
async function dispatch(data) {
  if (!data || data.idle) return;
  if (data.kind === 'api') return runApiTask(data.taskId, data.task);
  if (data.kind === 'page') return runPageTask(data.taskId, data.task);
  if (data.kind === 'self-reload') return handleSelfReload(data.taskId, data.task);
  if (data.kind === 'tab-release') return releasePinnedTab(data.taskId);
  if (data.kind === 'tabs') return tabsTask(data.taskId, listTabsData);
  if (data.kind === 'tabs-close') return tabsTask(data.taskId, () => closeLeakedTabsData(data.task));
  if (data.kind === 'cookies') {
    const cookies = await collectCookies();
    return postCookies(data.taskId, cookies);
  }
  // 兜底必须报错，不能静默走 cookie —— 上次泄漏事故的根因之一就是
  // 某个新任务种类被旧的派发链漏掉后，静默变成了「采集 cookie 还返回成功」。
  await postResult(data.taskId, { ok: false, error: '未知任务类型：' + String(data.kind) });
}

async function pollOnce() {
  try {
    const res = await fetch(`${LOCAL}/poll?wait=1`, { cache: 'no-store' });
    await dispatch(await res.json());
  } catch (e) {
    await setBadge('!', '#dc2626');
  }
}

/**
 * 长轮询循环：**处理完立刻进入下一轮**。
 *
 * 原来用 setInterval(3000) 节流，结果每个任务之间要等最多 3 秒 ——
 * 一条命令要发 6~10 个请求，光排队就得 20 秒（实测 read-unread 21 秒）。
 * 改成循环后：任务一派发就被挂起的 poll 立刻接走，单次请求回到 ~200ms。
 */
async function pollLoop() {
  for (;;) {
    try {
      const res = await fetch(`${LOCAL}/poll?wait=1`, { cache: 'no-store' });
      await dispatch(await res.json());
    } catch (e) {
      await setBadge('!', '#dc2626');
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 不等 tick，直接下一轮
  }
}

/**
 * 打开一个页面（真实加载），提取其中的内容后关掉。
 *
 * 为什么不用 fetch 直接拉：岗位详情页受网关签名保护（__zp_stoken__），
 * 裸 fetch 会拿到 code=37。真实浏览器加载时，页面自己会跑安全 JS 刷新 token，
 * 我们只在渲染完成后把 DOM 读出来。
 */
async function runPageTask(taskId, task) {
  const send = (payload) => {
    postJson(`/result/${taskId}`, payload);
  };

  let tab = null;
  let reused = false; // 复用用户已有的标签页时不能关掉它
  let fromUser = false; // 复用「用户自己正在看的」标签页 —— 绝对不能被关掉
  let createdWindowId = null; // 自己建的窗口 → 收尾时连窗口一起关
  try {
    // ① 固定标签页优先：省掉页面加载时间，也让 MQTT 连接常驻
    if (task.type === 'dom') {
      const pin = await loadPin();
      if (pin?.tabId) {
        try {
          const t = await chrome.tabs.get(pin.tabId);
          if (t && !t.incognito) {
            tab = t;
            reused = true;
            await updatePin((p) => ({ ...p, at: Date.now() }));
          } else {
            await savePin(null); // 标签页没了
          }
        } catch (e) {
          await savePin(null); // 标签页被用户关了
        }
      }
    }

    // ② DOM 探针优先复用「已经打开的」消息页 —— 不新开标签页、不打断用户
    //    task.own = true 时跳过：守护进程要自己的标签页，不动用户正在看的页面
    if (!tab && task.type === 'dom' && !task.own) {
      try {
        const open = await chrome.tabs.query({ url: ['https://*.zhipin.com/web/geek/chat*'] });
        const hit = open.find((t) => !t.incognito);
        if (hit) {
          tab = hit;
          reused = true;
          fromUser = true;
        }
      } catch (e) {
        /* ignore */
      }
    }

    if (!tab) {
      // 后台打开，不打断用户当前标签页
      const opened = await openTabFor(task.url);
      tab = opened.tab;
      // 窗口是我们自己建的 → 收尾时连窗口一起关，别留空窗口壳
      if (opened.createdWindow) {
        createdWindowId = opened.windowId;
      }
      // ⚠️ **先固定，再等加载**。
      //   顺序反了会漏标签页：页面加载慢 → 这一次的任务撞上桥接的 20 秒上限超时 →
      //   固定页没设上（finally 里 task.pin 为真时又不关它）→
      //   下一轮又以为没有固定页，再开一个 → 每轮漏好几个，标签页越攒越多。
      //   只固定「我们自己开的」—— 用户正在看的页面绝不能被当成固定页。
      if (task.pin && tab && tab.id && !fromUser) {
        await updatePin((p) => ({
          tabId: tab.id,
          at: Date.now(),
          opened: [...new Set([...(p.opened ?? []), tab.id])],
        }));
      }
      await waitForTabLoad(tab.id, PAGE_LOAD_BUDGET_MS);
      // 上一轮留下的孤儿页（固定页换过、SW 重启过）顺手清掉
      if (task.pin) await sweepOrphans(tab.id);
    }

    // 给页面一点渲染时间；复用已有标签页时页面早加载好了，不用等
    await new Promise((r) => setTimeout(r, reused ? 300 : task.waitMs ?? 1200));

    // 「DOM 探针」任务：在页面上下文里跑一段固定脚本，把页面状态读回来。
    // 用 executeScript(func) 而不是 content script —— func 会被序列化注入，
    // 能直接拿到 DOM / computed style，不受扩展 CSP 的 eval 限制。
    // （固定页的写入在上面「新开标签页」分支里已经做过了 —— 这里不再写）
    if (task.type === 'dom') {
      try {
        const fn = task.fn ? getPageFn(task.fn) : task.actions ? domActions : domProbe;
        if (!fn) {
          send({ ok: false, error: '未知页面函数：' + task.fn });
          return;
        }
        const arg = task.fn ? task.arg ?? {} : task.actions ? task.actions : task.probe || 'unread';
        const out = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: fn,
          args: [arg],
        });
        send({ ok: true, data: out?.[0]?.result ?? null });
      } catch (e) {
        send({ ok: false, error: 'DOM 操作失败：' + String((e && e.message) || e) });
      }
      return;
    }

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'extract' });
    } catch (e) {
      // content script 没注入 → 注入后重试
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        await new Promise((r) => setTimeout(r, 400));
        res = await chrome.tabs.sendMessage(tab.id, { type: 'extract' });
      } catch (e2) {
        send({ ok: false, error: '提取失败：' + String((e2 && e2.message) || e2) });
        return;
      }
    }

    send(res && res.ok ? res : { ok: false, error: '页面没有返回内容' });
  } catch (e) {
    send({ ok: false, error: String((e && e.message) || e) });
  } finally {
    // 固定标签页不能关（守护进程还要用）
    const closedTab = tab && tab.id && !reused && !task.pin;
    if (closedTab) chrome.tabs.remove(tab.id).catch(() => {});
    // 自己建的窗口，标签页关掉后窗口也关掉（别留空窗口壳）。
    // 标签页被固定住时不能关窗口 —— 关窗口等于把固定页一起关掉。
    if (createdWindowId && closedTab) chrome.windows.remove(createdWindowId).catch(() => {});
  }
}

/**
 * 通用 DOM 操作器：在页面上下文里按脚本执行一串动作。
 *
 * 为什么需要它：BOSS 的「投递简历 / 发附件简历」本质是**发一条聊天消息**（走 MQTT），
 * 没有可用的 HTTP 接口（onekeydeliver 对猎头岗位返回 code=1，
 * exchange/videoResume/accept 返回 code=1049）。
 * 所以只能模拟用户操作：点开会话 → 点「简历/附件」→ 选简历 → 发送。
 *
 * 动作用 args 传入（可序列化），func 本身自包含 —— 扩展 CSP 禁止 eval。
 */
async function domActions(actions) {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const a of actions || []) {
    try {
      if (a.type === 'wait') {
        await sleep(a.ms || 500);
        out.push({ ok: true, type: 'wait' });
        continue;
      }

      if (a.type === 'click') {
        const el = document.querySelector(a.selector);
        if (!el) {
          out.push({ ok: false, type: 'click', error: '没找到 ' + a.selector });
          continue;
        }
        el.click();
        await sleep(a.after ?? 600);
        out.push({ ok: true, type: 'click', text: (el.innerText || '').slice(0, 80) });
        continue;
      }

      if (a.type === 'clickText') {
        const scope = a.scope ? document.querySelector(a.scope) : document;
        const root = scope || document;
        const els = Array.from(root.querySelectorAll(a.tag || 'a,button,div,span,li,em,i,p'));
        const hits = els.filter((e) => {
          const t = (e.innerText || e.textContent || '').trim();
          if (!t) return false;
          return a.exact ? t === a.text : t.includes(a.text);
        });
        // 取文本最贴近的那个（外层容器文本更长，排在前面）
        const el = hits.sort((x, y) => {
          const lx = (x.innerText || '').trim().length;
          const ly = (y.innerText || '').trim().length;
          return lx - ly;
        })[0];
        if (!el) {
          out.push({ ok: false, type: 'clickText', error: '没找到文字「' + a.text + '」' });
          continue;
        }
        el.click();
        await sleep(a.after ?? 800);
        out.push({
          ok: true,
          type: 'clickText',
          clicked: (el.innerText || '').trim().slice(0, 80),
          cls: String(el.className || '').slice(0, 140),
        });
        continue;
      }

      if (a.type === 'dump') {
        const els = Array.from(document.querySelectorAll(a.selector || '*')).slice(0, a.limit || 40);
        out.push({
          ok: true,
          type: 'dump',
          items: els.map((e) => ({
            tag: e.tagName,
            cls: String(e.className || '').slice(0, 160),
            text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, a.textLimit ?? 120),
            visible: !!(e.offsetParent || e.getClientRects().length),
            html: a.html ? e.outerHTML.slice(0, a.html) : undefined,
          })),
        });
        continue;
      }

      if (a.type === 'text') {
        out.push({
          ok: true,
          type: 'text',
          text: (document.body.innerText || '').slice(0, a.limit || 4000),
        });
        continue;
      }

      out.push({ ok: false, type: a.type, error: '未知动作' });
    } catch (e) {
      out.push({ ok: false, type: a.type, error: String((e && e.message) || e) });
    }
  }
  return out;
}

/**
 * DOM 探针：在页面上下文里读取「未读」相关的页面状态。
 *
 * 用 executeScript({func}) 而不是 content script：
 *   - func 会被序列化后注入页面，能直接访问 DOM 与 computed style
 *   - 不受扩展 CSP 的 eval 限制（不能传字符串脚本）
 *   - 自包含：不能引用外部变量
 */
async function domProbe(probe) {
  const out = { url: location.href, title: document.title, probe };

  // 等会话列表渲染出来。
  // 消息页是 SPA：HTML 加载完 ≠ 列表有了（要等接口回来 + Vue 渲染）。
  // 之前固定等 1.2~1.5 秒就开读，常常读到一个空页面，
  // 误报成「没有未读消息」—— 而其实页面上一片红点。
  for (let i = 0; i < 24; i++) {
    if (document.querySelectorAll('.friend-content').length > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // 1) 找到「未读」这个 tab
  const leafs = Array.from(document.querySelectorAll('*')).filter(
    (e) => e.children.length === 0 && (e.textContent || '').trim() === '未读',
  );
  out.unreadMatches = leafs.length;
  if (leafs.length) {
    const el = leafs[0];
    const ancestors = [];
    let p = el;
    for (let i = 0; i < 5 && p && p !== document.body; i++) {
      ancestors.push({
        tag: p.tagName,
        cls: String(p.className || '').slice(0, 140),
        text: (p.innerText || '').replace(/\s+/g, ' ').slice(0, 140),
      });
      p = p.parentElement;
    }
    out.unread = {
      outer: el.outerHTML.slice(0, 800),
      parentOuter: (el.parentElement ? el.parentElement.outerHTML : '').slice(0, 1500),
      before: getComputedStyle(el, '::before').content,
      after: getComputedStyle(el, '::after').content,
      ancestors,
    };
  }

  // 2) 会话列表项的 class —— 未读通常有专门的 class / 红点
  const items = Array.from(
    document.querySelectorAll(
      '[class*="friend"], [class*="chat-item"], [class*="user-item"], [class*="card"], li',
    ),
  );
  out.itemClasses = items.slice(0, 60).map((e) => ({
    cls: String(e.className || '').slice(0, 140),
    text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
  }));

  // 3) 页面文本
  out.bodyText = (document.body.innerText || '').slice(0, 4000);

  // 4) 前端自己的 store —— 未读数是前端本地算出来的，
  //    直接读它的 state 比猜接口可靠得多。
  out.store = null;
  try {
    const els = document.querySelectorAll('body *');
    for (let i = 0; i < els.length && i < 3000; i++) {
      const vm = els[i].__vue__;
      if (!vm) continue;
      const store = vm.$store || (vm.$children && vm.$children[0] && vm.$children[0].$store);
      const state = store && store.state;
      if (!state) continue;

      // 找到装着会话数组的那个 state 节点
      let friends = null;
      let where = '';
      const candidates = [
        ['friends', state.friends],
        ['localFriends', state.localFriends],
        ['chat.friends', state.chat && state.chat.friends],
        ['chatStore.friends', state.chatStore && state.chatStore.friends],
      ];
      for (const [label, arr] of candidates) {
        if (Array.isArray(arr) && arr.length) {
          friends = arr;
          where = label;
          break;
        }
      }

      out.store = {
        stateKeys: Object.keys(state).slice(0, 40),
        where,
        friendsCount: friends ? friends.length : 0,
        sampleKeys: friends && friends[0] ? Object.keys(friends[0]).slice(0, 40) : [],
        unread: friends
          ? friends
              .filter((f) => Number(f && f.unreadCount) > 0)
              .slice(0, 20)
              .map((f) => ({
                name: f.name,
                unreadCount: f.unreadCount,
                lastText: f.lastText,
                relationType: f.relationType,
                uniqueId: f.uniqueId,
                lastTS: f.lastTS,
                lastMsgId: f.lastMsgId,
              }))
          : [],
        totalUnread: friends
          ? friends.reduce((a, f) => a + (Number(f && f.unreadCount) || 0), 0)
          : 0,
      };
      break;
    }
  } catch (e) {
    out.storeError = String((e && e.message) || e);
  }

  // 5) 精确定位未读徽标：
  //    列表行首的小圆点里是未读条数（纯数字文本），所属会话由最近的
  //    .friend-content 祖先决定；tab 上的总数在「未读(N)」文本里。
  out.unreadTotal = null;
  out.unreadTabText = '';
  const tabCandidates = Array.from(document.querySelectorAll('*')).filter((e) =>
    /^\s*未读\s*(\(\d+\))?\s*$/.test(e.textContent || ''),
  );
  // 取最深的那一个（文档顺序里靠后的通常是内层元素）
  const tabEl = tabCandidates.length ? tabCandidates[tabCandidates.length - 1] : null;
  if (tabEl) {
    out.unreadTabText = (tabEl.textContent || '').trim();
    const m = (tabEl.textContent || '').match(/\((\d+)\)/);
    out.unreadTotal = m ? Number(m[1]) : null;
  }

  // 未读徽标：文本是纯数字、且是个很小的方块（圆点）
  const badges = Array.from(document.querySelectorAll('*')).filter((e) => {
    if (e.children.length) return false;
    const t = (e.textContent || '').trim();
    if (!/^\d{1,3}$/.test(t)) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.width <= 26 && r.height > 0 && r.height <= 26;
  });

  out.unreadBadges = badges.map((b) => {
    const row = b.closest('.friend-content') || b.closest('[class*="friend"]');
    const text = row ? (row.innerText || '').replace(/\s+/g, ' ').trim() : '';
    // 从行文本里剥掉开头的未读数字，剩下的就是 时间 + 名字 + 公司 + 职位 + 最后一句
    const clean = text.replace(/^\d{1,3}\s*/, '');
    const lines = (row ? row.innerText || '' : '').split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      count: Number((b.textContent || '').trim()),
      cls: String(b.className || '').slice(0, 120),
      rowText: text.slice(0, 200),
      clean: clean.slice(0, 200),
      lines: lines.slice(0, 8),
    };
  });

  // 5b) 完整映射：每一行会话 + 它自己的未读数
  //     （HTTP 接口给的 unreadMsgCount 恒为 0，这里给出网页的真实值，用来对账）
  const isBadge = (e) => {
    if (e.children.length) return false;
    const t = (e.textContent || '').trim();
    if (!/^\d{1,3}$/.test(t)) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.width <= 26 && r.height > 0 && r.height <= 26;
  };
  const rowEls = Array.from(document.querySelectorAll('.friend-content'));
  out.allRows = rowEls.slice(0, 400).map((row) => {
    const badge = Array.from(row.querySelectorAll('*')).find(isBadge);
    const lines = (row.innerText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      unread: badge ? Number((badge.textContent || '').trim()) : 0,
      lines: lines.slice(0, 8),
    };
  });
  out.rowCount = rowEls.length;

  // 6) 点开「未读」tab，把里面的列表读出来。
  //    点 tab 不会标记已读 —— 前端只在点开【某个会话】时才发 MQTT read 消息。
  if (probe === 'unread-list' && tabEl) {
    const before = (document.body.innerText || '').slice(0, 400);
    tabEl.click();
    await new Promise((r) => setTimeout(r, 1800));
    out.beforeClick = before;
    out.afterClick = (document.body.innerText || '').slice(0, 3000);
    // 未读 tab 里每一条会话的 DOM（class 常带未读标记）
    const rows = Array.from(document.querySelectorAll('[class*="friend"], [class*="item"], li'))
      .map((e) => ({
        cls: String(e.className || '').slice(0, 140),
        text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
      }))
      .filter((r) => r.text && r.text.length > 2);
    out.rows = rows.slice(0, 40);
  }

  return out;
}

/**
 * 页面函数派发。
 *
 * executeScript({func}) 传的是**函数本身**，不是字符串（扩展 CSP 禁止 eval）。
 * 所以要用哪个页面函数，得在扩展侧先映射好。
 */
function getPageFn(name) {
  if (name === 'greeting') return pageGreetingTask;
  return null;
}

/**
 * 「新招呼」任务 —— 在页面上下文里执行。
 *
 * ⚠️ **页面侧不许等待**：所有 sleep 都放到 Node 侧。
 *   守护进程用的是**后台标签页**，Chrome 会限流、甚至冻结后台页的定时器 ——
 *   定时器不触发，await 就永远挂着，桥接任务必然 20 秒超时（实测踩过）。
 *   所以这里每一步只做**同步**的读/点；等页面渲染由 Node 侧用 setTimeout 控制。
 *
 * 模式（arg.mode）：
 *   inspect       探测：把 tab / store / 会话行结构原样吐出来
 *   scan          列出「新招呼」tab 里所有带红点的会话
 *   switch-tab    点一下「新招呼」tab
 *   open          找一个带红点的会话并点开它（返回名字）
 *   verify-conv   读会话头部（用来核对有没有点错人）
 *   send-resume   点「发简历」
 *   check-panel   读简历确认弹窗
 *   confirm       点弹窗里的「确定」（这一步才真的发起投递）
 *   read-messages 回读最近的消息
 *
 * 关键事实：
 *   - 未读红点**只存在于浏览器**（服务端 unreadMsgCount 恒为 0），靠 MQTT 推给前端
 *   - 红点徽标没有专属 class，只能靠几何特征认：叶子节点 + 纯数字 + 盒子 ≤26px
 *   - 点开会话会发 MQTT read 消息 → 红点消失（所以红点天然就是「已处理」标记）
 */
function pageGreetingTask(arg) {
  const A = arg || {};
  const mode = A.mode || 'scan';
  const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\s+/g, ' ').trim();
  const out = { mode, ok: false, step: mode, at: Date.now() };

  /** 未读徽标：叶子节点 + 纯数字文本 + 渲染盒子 ≤26px */
  const isBadge = (e) => {
    if (!e || e.children.length) return false;
    const t = (e.textContent || '').trim();
    if (!/^\d{1,3}$/.test(t)) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.width <= 26 && r.height > 0 && r.height <= 26;
  };

  /** Vue 响应式对象可能带循环引用，序列化要兜住 */
  const safe = (o) => {
    try {
      return JSON.parse(JSON.stringify(o));
    } catch (e) {
      return { __unserializable: true };
    }
  };

  /**
   * 一次遍历找出所有 tab 元素（全部 / 未读 / 新招呼 / …）。
   *
   * 为什么不用 querySelectorAll('*') + textContent：
   *   那样会对页面上**每一个**元素读 textContent，而 textContent 要走整棵子树 ——
   *   消息页上万个元素，7 个 tab 就是 7 遍全页遍历，实测单次 scan 要 19 秒，
   *   直接撞上桥接任务 20 秒的上限。走 TreeWalker 只看文本节点，毫秒级。
   */
  const TAB_LABELS = ['全部', '未读', '新招呼', '仅沟通', '有交换', '有面试', '不感兴趣'];
  const findTabs = () => {
    const cands = {};
    let node;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (!t || t.length > 12) continue;
      const el = node.parentElement;
      if (!el || el === document.body) continue;
      for (const lb of TAB_LABELS) {
        if (t !== lb && !(t.startsWith(lb) && t.length <= lb.length + 8)) continue;
        (cands[lb] = cands[lb] || []).push(el);
        break;
      }
    }
    // 优先挑「tab 列表」里的那个（UL.label-list / UL.more-label）
    const pick = (arr) => {
      if (!arr || !arr.length) return null;
      for (const el of arr) {
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          if (p.tagName === 'UL' && /label/i.test(String(p.className || ''))) return el;
          p = p.parentElement;
        }
      }
      return arr[0];
    };
    const out2 = {};
    for (const lb of TAB_LABELS) out2[lb] = pick(cands[lb]);
    return out2;
  };

  /**
   * 读会话列表的每一行。
   *
   * debug=false（生产路径 scan/open）时跳过只给排查用的字段：
   *   - badgeCls / nameCls / attrs：只有 inspect 会读
   *   - html：outerHTML 序列化不便宜（整棵子树），每行都算就是纯浪费
   * 之前每投一个人都要重新扫一遍全部行，等于白算几百次。
   */
  const collectRows = (debug) => {
    const els = Array.from(document.querySelectorAll('.friend-content'));
    return els.map((row, idx) => {
      const badge = Array.from(row.querySelectorAll('*')).find(isBadge);
      const nameEl = row.querySelector('.name-text') || row.querySelector('[class*="name"]');
      // innerText 只读一次 —— 读两遍会把整棵子树的文本各遍历一次
      const inner = row.innerText || '';
      const lines = inner
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const base = {
        idx,
        badge: badge ? Number((badge.textContent || '').trim()) : 0,
        name: txt(nameEl),
        dc: row.getAttribute('d-c') || '',
        lines: lines.slice(0, 6),
        // 单行版文本 —— 从上面那份 innerText 折出来，不再读一遍（读 innerText 要走整棵子树）
        text: inner.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
      if (!debug) return base;
      // 行上可能带稳定的 id（d-c / data-*），有的话就能精确锁定某个会话
      const attrs = {};
      for (const a of Array.from(row.attributes)) {
        if (a.name.startsWith('data-') || a.name === 'd-c') attrs[a.name] = a.value;
      }
      return {
        ...base,
        badgeCls: badge ? String(badge.className || '') : '',
        nameCls: nameEl ? String(nameEl.className || '') : '',
        attrs,
        // outerHTML 序列化不便宜，只给前几行要（排查用）
        html: idx < 6 ? row.outerHTML.slice(0, 700) : '',
      };
    });
  };

  /**
   * 找前端的状态容器。
   *
   * Vue 2：元素上有 __vue__，vm.$store.state
   * Vue 3：根元素上有 __vue_app__，store 挂在 app.config.globalProperties.$store
   *         或 app._context.provides 里（Vuex 的 key 是 Symbol）
   */
  const findStore = () => {
    const roots = Array.from(document.querySelectorAll('body > div, body > div > div, #app'));
    for (const el of roots) {
      const app = el.__vue_app__;
      if (!app) continue;
      const gp = app.config && app.config.globalProperties;
      if (gp && gp.$store && gp.$store.state) return gp.$store;
      const provides = app._context && app._context.provides;
      if (provides) {
        for (const k of Reflect.ownKeys(provides)) {
          const v = provides[k];
          if (v && typeof v === 'object' && v.state && typeof v.state === 'object') return v;
        }
      }
    }
    const els = document.querySelectorAll('body *');
    for (let i = 0; i < els.length && i < 4000; i++) {
      const vm = els[i].__vue__;
      if (!vm) continue;
      const store = vm.$store || (vm.$children && vm.$children[0] && vm.$children[0].$store);
      if (store && store.state) return store;
    }
    return null;
  };

  /** 读前端自己的 store —— 未读数是它从 MQTT 收到后自己算的 */
  const readStore = () => {
    try {
      const store = findStore();
      const state = store && store.state;
      if (!state) return { ok: false, error: '页面里没找到 store（Vue2 __vue__ / Vue3 __vue_app__ 都没命中）' };

      const cands = [
        ['friends', state.friends],
        ['localFriends', state.localFriends],
        ['chat.friends', state.chat && state.chat.friends],
        ['chatStore.friends', state.chatStore && state.chatStore.friends],
      ];
      let friends = null;
      let where = '';
      for (const [label, arr] of cands) {
        if (Array.isArray(arr) && arr.length) {
          friends = arr;
          where = label;
          break;
        }
      }
      if (!friends) {
        return {
          ok: true,
          where: '(没找到 friends 数组)',
          stateKeys: Object.keys(state).slice(0, 60),
          allKeys: Object.keys(state).slice(0, 80).map((k) => {
            const v = state[k];
            return `${k}:${Array.isArray(v) ? 'array(' + v.length + ')' : typeof v}`;
          }),
        };
      }

      const relCount = {};
      let unread = 0;
      for (const f of friends) {
        const r = Number(f && f.relationType);
        relCount[String(r)] = (relCount[String(r)] || 0) + 1;
        if (Number(f && f.unreadCount) > 0) unread++;
      }
      const unreadOnes = friends.filter((f) => Number(f && f.unreadCount) > 0);
      return {
        ok: true,
        where,
        count: friends.length,
        unreadCount: unread,
        relCount,
        stateKeys: Object.keys(state).slice(0, 60),
        friendKeys: friends[0] ? Object.keys(friends[0]) : [],
        sample: friends[0] ? safe(friends[0]) : null,
        sampleUnread: unreadOnes.slice(0, 6).map(safe),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  /** 列出所有 tab 的结构 */
  const listTabs = () => {
    const map = findTabs();
    return TAB_LABELS.map((lb) => {
      const el = map[lb];
      const ancestors = [];
      let p = el;
      for (let i = 0; i < 4 && p && p !== document.body; i++) {
        ancestors.push({
          tag: p.tagName,
          cls: String(p.className || '').slice(0, 140),
          text: txt(p).slice(0, 100),
        });
        p = p.parentElement;
      }
      return {
        label: lb,
        found: !!el,
        cls: el ? String(el.className || '') : '',
        outer: el ? el.outerHTML.slice(0, 400) : '',
        parentOuter: el && el.parentElement ? el.parentElement.outerHTML.slice(0, 1000) : '',
        ancestors,
      };
    });
  };

  /**
   * 本轮已试过的会话（同名 HR 靠公司名区分）。
   *
   * ⚠️ 这里**不是**「投过的人的名单」—— 那个由红点天然承担了。
   * 这份只是防止一轮里反复挑中同一个「点了没打开」的会话。
   */
  const isExcluded = (r) => {
    const exclude = Array.isArray(A.exclude) ? A.exclude : [];
    return exclude.some((ex) => {
      if (!ex || !ex.name || ex.name !== r.name) return false;
      // 行文本里就是「名字+公司+HR职位」，公司名对不上就不是同一个人
      const ec = ex.company || '';
      if (ec && r.text && !r.text.includes(ec)) return false;
      return true;
    });
  };

  /** 「新招呼」是不是当前选中的 tab（切 tab 后列表要重新拉，这中间读到的是旧列表） */
  const isOnNewTab = () => {
    const tab = findTabs()['新招呼'];
    if (!tab) return false;
    const li = tab.closest ? tab.closest('li') : null;
    return !!(li && /selected|active/i.test(String(li.className || '')));
  };

  /**
   * 切到「新招呼」之后，列表接口回来了没有？
   *
   * 列表内容是异步拉的：切 tab → 页面发请求 → 回来才渲染。
   * 界面挂上了不代表列表到货 —— 这中间差着一次网络往返，弱网时能差好几秒。
   *
   * 判据用「切 tab 之后有没有发出过列表请求」（performance 的 resource 记录），
   * 而不是「等 N 毫秒」。
   */
  const listFetchedAfterSwitch = () => {
    const switchedAt = Number((window && window.__mishuSwitchedAt) || 0);
    if (!switchedAt) return true; // 没切过 tab → 列表本来就是加载好的
    try {
      return performance.getEntriesByType('resource').some((e) => {
        if (!e.name.includes('geekFilterByLabel')) return false;
        const at = performance.timeOrigin + e.startTime;
        return at >= switchedAt - 500;
      });
    } catch (e) {
      return true; // 读不到就当它好了，别卡死
    }
  };

  /* ================= 分派 ================= */

  if (mode === 'inspect') {
    out.ok = true;
    out.step = 'inspect';
    out.url = location.href;
    out.title = document.title;
    out.tabs = listTabs();
    out.store = readStore();
    const allRows = collectRows(true);
    out.rows = allRows.slice(0, 8);
    out.allRows = allRows.map((r) => ({
      idx: r.idx,
      badge: r.badge,
      badgeCls: r.badgeCls,
      name: r.name,
      nameCls: r.nameCls,
      dc: r.dc,
      attrs: r.attrs,
      lines: r.lines,
    }));
    // 页面上所有「像徽标」的 class（找红点的真实 class 用）
    out.badgeLike = Array.from(
      document.querySelectorAll('[class*="badge"],[class*="notice"],[class*="red"],[class*="dot"],[class*="unread"]'),
    )
      .slice(0, 30)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          cls: String(e.className || '').slice(0, 140),
          text: txt(e).slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    out.bodyHead = (document.body.innerText || '').slice(0, 1200);
    return out;
  }

  if (mode === 'scan') {
    const rows = collectRows(false);
    out.rowCount = rows.length;
    // 当前选中的是不是「新招呼」—— 切 tab 后列表要重新拉，
    // 这中间读到的可能是上一个 tab 的旧列表。Node 侧靠这个判断该不该等。
    out.onNewTab = isOnNewTab();
    // 切 tab 之后列表是**重新拉接口**才有的。
    //   界面挂上了 ≠ 列表到货 —— 冷启动时这两件事差着一次网络往返。
    //   用「切 tab 之后有没有发出过列表请求」这个事实来判断，别猜时间。
    out.listFresh = listFetchedAfterSwitch();
    // 页面是否就绪 —— 用来区分「列表是空的」和「列表还没渲染出来」。
    // 聊天页一加载完就有 tab 栏和会话面板，哪怕一条会话都没有。
    out.ready = !!(
      document.querySelector('.label-list') ||
      document.querySelector('.chat-conversation') ||
      document.querySelector('.friend-content')
    );
    out.badges = rows
      .filter((r) => r.badge > 0)
      .map((r) => ({ idx: r.idx, badge: r.badge, name: r.name, lines: r.lines, text: r.text }));
    out.ok = true;
    out.step = 'scan';
    return out;
  }

  if (mode === 'switch-tab') {
    const tab = findTabs()['新招呼'];
    if (!tab) {
      out.step = 'no-tab';
      out.detail = '页面上找不到「新招呼」这个 tab';
      return out;
    }
    out.tabCls = String(tab.className || '');
    // 已经在「新招呼」上了就**别再点** ——
    //   ① 点了会触发列表重载，白等 1.2 秒；
    //   ② 更要命的是重载那一瞬间列表是 0 行，会被误判成「列表空了」。
    const li = tab.closest ? tab.closest('li') : null;
    out.alreadyOn = !!(li && /selected|active/i.test(String(li.className || '')));
    if (!out.alreadyOn) {
      tab.click();
      // 记下切的时间 —— 后面 scan 用它判断「列表接口回来了没有」
      try { window.__mishuSwitchedAt = Date.now(); } catch (e) { /* ignore */ }
    }
    out.ok = true;
    out.step = 'switched';
    return out;
  }

  if (mode === 'open') {
    // 还没切到「新招呼」→ 读到的可能是上一个 tab 的旧列表，不能拿它选人
    if (!isOnNewTab()) {
      out.ok = false;
      out.step = 'not-on-tab';
      return out;
    }
    const rows = collectRows(false);
    out.rowCount = rows.length;
    if (!rows.length) {
      // 列表 0 行 —— **不要**在这里判「没红点了」。
      //   切 tab / 点开会话之后列表会重渲染（要重新拉接口），那一瞬间正好是 0 行；
      //   这时候判「收工」会把后面还没投的人整个跳过。
      // 交给 Node 侧重试（重试完还是空，才算真的收工）。
      out.ok = false;
      out.step = 'list-empty';
      return out;
    }
    // 投递判据 = **红点**。
    //   红点 = 没人打开过这个会话；投递必然要打开会话 → 投过的人红点必然消失
    //   → 红点自己就是「还没投过」的标记，不需要另设排除名单。
    // A.exclude 只用来挡「本轮已经试过、但没打开成功」的会话（防止一轮里反复挑中它）。
    const target = A.pick
      ? rows.find((r) => r.name === String(A.pick))
      : rows.find((r) => r.badge > 0 && !isExcluded(r));
    if (!target) {
      out.ok = true;
      out.step = 'done';
      out.done = true;
      out.detail = A.pick
        ? `列表里没有叫「${A.pick}」的人`
        : rows.filter((r) => r.badge > 0).length
          ? '剩下的红点都在跳过名单里'
          : '没有带红点的会话了';
      return out;
    }
    if (!target.name) {
      out.ok = false;
      out.step = 'row-name-unknown';
      out.detail = target.text.slice(0, 120);
      return out;
    }
    // 点**行内**的名字，不能全文档按名字找
    // （同一个账号里可能有好几个同名 HR，全文档找会点错人）
    const rowEls = document.querySelectorAll('.friend-content');
    const rowEl = rowEls[target.idx];
    const nameEl = rowEl ? rowEl.querySelector('.name-text') || rowEl.querySelector('[class*="name"]') : null;
    const clickEl = nameEl || rowEl;
    if (!clickEl) {
      out.ok = false;
      out.step = 'row-missing';
      return out;
    }
    clickEl.click();
    out.ok = true;
    out.step = 'opened';
    out.name = target.name;
    out.badge = target.badge;
    out.dc = target.dc || '';
    out.lines = target.lines;
    return out;
  }

  if (mode === 'verify-conv') {
    // 「会话有没有真的打开」—— 判据是**会话头的 .name-text 在不在**。
    // 没打开时这个面板显示的是空状态文案（「与您进行过沟通的 Boss 都会在左侧列表中显示」），
    // 靠判空/判文案都不可靠，靠结构最稳。
    //
    // ⚠️ 这里**不**拿名字跟点开的那个行比对：
    //   红点本来就只出现在一行上，点哪行就是哪个人，没有认错的余地。
    //   之前拿名字比对反而误伤了 —— 会话加载慢一点就判成「同名 HR 对不上」，
    //   活生生的招呼就这么被跳过。
    const panel = document.querySelector('.chat-conversation');
    const head = panel ? panel.querySelector('.name-text') : null;
    out.ok = true;
    out.step = 'conv';
    out.open = !!head;
    out.name = head ? txt(head) : '';
    out.conv = txt(panel).slice(0, 200);
    return out;
  }

  if (mode === 'send-resume') {
    // 已经有弹窗开着（上一轮残留）就直接用，别再点一次把弹窗关掉
    if (document.querySelector('.panel-resume')) {
      out.ok = true;
      out.step = 'resume-panel-already-open';
      return out;
    }
    const btn = document.querySelector('.toolbar-btn:not([class*="btn-"])');
    if (!btn) {
      out.ok = false;
      out.step = 'no-resume-btn';
      return out;
    }
    btn.click();
    out.ok = true;
    out.step = 'resume-clicked';
    return out;
  }

  if (mode === 'check-panel') {
    const el = document.querySelector('.panel-resume');
    const panel = txt(el);
    out.ok = true;
    out.step = 'panel';
    out.panel = panel.slice(0, 200);
    // hasPanel = 弹窗出现了；ready = 弹窗内容是「发送简历」（可以点确定了）
    out.hasPanel = !!el;
    out.ready = !!el && panel.includes('发送简历');
    return out;
  }

  if (mode === 'confirm') {
    const sure = document.querySelector('.panel-resume .btn-sure-v2');
    if (!sure) {
      out.ok = false;
      out.step = 'no-sure-btn';
      return out;
    }
    sure.click();
    out.ok = true;
    out.step = 'confirmed';
    return out;
  }

  if (mode === 'read-messages') {
    const items = document.querySelectorAll('.im-list .message-item');
    const n = items.length;
    out.messages = [];
    for (let i = Math.max(0, n - 6); i < n; i++) out.messages.push(txt(items[i]).slice(0, 100));
    out.ok = true;
    out.step = 'messages';
    return out;
  }

  out.ok = false;
  out.step = 'unknown-mode';
  return out;
}

/**
 * 把接口请求转给 zhipin 页面里的 content script 执行。
 * 页面上下文的 fetch 会自动带上完整登录 cookie —— 这是扩展读不到 cookie 时的兜底通道。
 */
async function runApiTask(taskId, task) {
  const send = (payload) => {
    postJson(`/result/${taskId}`, payload);
  };

  // 临时开的标签页，用完要关掉
  let tempTabId = null;
  // 如果这个窗口也是我们自己建的，标签页关掉后连窗口一起关（别留空窗口壳）
  let tempWindowId = null;

  try {
    const allTabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });
    // 隐身窗口有独立的 cookie jar（未登录），必须排除
    const normalTabs = allTabs.filter((t) => !t.incognito);
    const tabs = normalTabs.length ? normalTabs : allTabs;

    await reportDiag({
      tabCandidates: allTabs.map((t) => ({
        id: t.id,
        url: t.url,
        incognito: !!t.incognito,
        active: !!t.active,
      })),
    });

    if (!tabs.length) {
      // 一个 zhipin 页面都没有 —— 自己临时开一个（后台标签页，用完关掉）。
      // 否则「用户一个页面都没开」这种最常见的状态就直接报错了。
      const tmp = await openTempTab();
      if (!tmp) {
        send({
          ok: false,
          error:
            '打不开 BOSS直聘 页面 —— Chrome 是不是没开、或者扩展被停用了？（临时标签页创建失败）',
        });
        return;
      }
      tabs.push(tmp.tab);
      tempTabId = tmp.tab.id;
      // 窗口是我们自己建的 → 用完连窗口一起关，否则会留下一个空窗口壳
      tempWindowId = tmp.createdWindow ? tmp.windowId : null;
    }

    const payload = {
      type: 'api',
      url: task.url,
      method: task.method,
      headers: task.headers,
      body: task.body,
    };

    // 逐个尝试：固定页 → active → 其它；content script 没注入就自动注入后重试
    //
    // 为什么要限量：标签页一多（曾经因为泄漏攒到几百个），每个都试一遍
    // 就会超过桥接任务 20 秒的上限 —— 请求直接超时。
    // content script 是按 manifest 注入的，任意一个 zhipin 页面都有，
    // 前几个都失败的话基本就是「页面还没加载好」，试再多也没用。
    const pin = await loadPin();
    const ordered = [...tabs].sort((a, b) => {
      if (a.id === pin?.tabId) return -1;
      if (b.id === pin?.tabId) return 1;
      return (b.active ? 1 : 0) - (a.active ? 1 : 0);
    });
    const MAX_TRY_TABS = 5;
    const errors = [];

    for (const tab of ordered.slice(0, MAX_TRY_TABS)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await chrome.tabs.sendMessage(tab.id, payload);
          if (res && res.ok) {
            send(res);
            return;
          }
          if (res) {
            errors.push(`tab${tab.id}: ${res.error || '返回为空'}`);
            break; // 有响应但失败，换下一个 tab
          }
        } catch (e) {
          errors.push(`tab${tab.id}: ${String((e && e.message) || e).slice(0, 60)}`);
          if (attempt === 0) {
            // 第一次失败 → 尝试注入 content script 再来一次
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js'],
              });
              await new Promise((r) => setTimeout(r, 400));
              continue;
            } catch {
              /* ignore */
            }
          }
          break;
        }
      }
    }

    send({
      ok: false,
      error:
        '所有 BOSS直聘 标签页都不可用：' +
        errors.slice(0, 3).join(' | ') +
        (ordered.length > MAX_TRY_TABS ? `（共 ${ordered.length} 个标签页，只试了前 ${MAX_TRY_TABS} 个）` : ''),
    });
  } catch (e) {
    send({ ok: false, error: String((e && e.message) || e) });
  } finally {
    // 临时开的标签页用完就关；窗口是自己建的话连窗口一起关
    if (tempTabId) chrome.tabs.remove(tempTabId).catch(() => {});
    if (tempWindowId) chrome.windows.remove(tempWindowId).catch(() => {});
  }
}

/**
 * 开一个后台标签页。
 *
 * Chrome 一个窗口都没有的时候（用户把窗口全关了、只留后台进程），
 * chrome.tabs.create 会直接报 "No current window" —— 因为它默认把标签页
 * 放进「当前窗口」。这时**直接建窗口、标签页就是目标页面**，
 * 不要多开一个空白页（用户会看到凭空冒出来的空白窗口）。
 *
 * 有窗口时就挂在已有窗口里，不抢焦点。
 */
async function openTabFor(url) {
  const wins = await chrome.windows.getAll({});
  if (wins.length) {
    const tab = await chrome.tabs.create({ url, active: false, windowId: wins[0].id });
    return { tab, windowId: wins[0].id, createdWindow: false };
  }
  // 没有窗口 → 建一个，标签页直接是目标页面
  const w = await chrome.windows.create({ url, focused: false });
  let tab = w.tabs && w.tabs[0] ? w.tabs[0] : null;
  if (!tab) {
    const tabs = await chrome.tabs.query({ windowId: w.id });
    tab = tabs[0];
  }
  // createdWindow=true → 用完要把整个窗口关掉，
  // 否则关掉最后一个标签页会留下一个空窗口壳。
  return { tab, windowId: w.id, createdWindow: true };
}

/** 等标签页加载完（已经加载完就直接返回，不用干等） */
async function waitForTabLoad(tabId, timeoutMs) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t || t.status === 'complete') return;
  } catch (e) {
    return;
  }
  await new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(resolve, timeoutMs); // 超时兜底
  });
}

/**
 * 临时开一个 zhipin 页面（后台标签页），等它加载完。
 *
 * 为什么需要：接口请求必须在**页面上下文**里发（浏览器才会带齐全部登录 cookie），
 * 所以至少要有一个 zhipin 页面开着。用户一个页面都没开的时候，就自己开一个临时的。
 */
async function openTempTab(url = 'https://www.zhipin.com/web/geek/chat') {
  try {
    const opened = await openTabFor(url);
    await waitForTabLoad(opened.tab.id, PAGE_LOAD_BUDGET_MS);
    return opened;
  } catch (e) {
    return null;
  }
}

/**
 * 启动引导。
 * MV3 的 service worker 安装后不会自己启动，必须靠事件唤醒 ——
 * 这里用四种触发源保证一定能起来：安装/更新、浏览器启动、用户点图标、页面 content script。
 */
async function boot() {
  if (booted) {
    await syncNow();
    return;
  }
  booted = true;

  try {
    chrome.alarms.create('boss-poll', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(async () => {
      pollOnce();
      // 固定标签页空闲太久就关掉（守护进程崩了也不留尾巴）
      const pin = await loadPin();
      if (pin?.tabId && Date.now() - (pin.at ?? 0) > PIN_IDLE_MS) {
        await closeAllOpenedTabs();
      }
    });
  } catch (e) {
    console.warn('[mishu] alarms 不可用', e);
  }

  // 立即同步一次
  await syncNow();

  // 保持长轮询（处理完立刻再 poll，任务之间不排队）
  if (!loopStarted) {
    loopStarted = true;
    pollLoop();
  }
}

let loopStarted = false;

async function syncNow() {
  const cookies = await collectCookies();
  await postCookies(null, cookies);
}

// —— 触发源 1/2：安装/更新、浏览器启动 ——
chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());

// —— 触发源 3：用户点工具栏图标 ——
chrome.action.onClicked.addListener(() => boot());

// —— 用户把我们开的标签页关了：从账本里划掉，别再去用死掉的 tabId ——
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void updatePin((pin) =>
      pin.tabId === tabId || (pin.opened ?? []).includes(tabId)
        ? {
            ...pin,
            tabId: pin.tabId === tabId ? null : pin.tabId,
            opened: (pin.opened ?? []).filter((id) => id !== tabId),
          }
        : pin,
    );
  });
} catch (e) {
  /* ignore */
}

// —— 触发源 4：页面里的 content script 发消息 ——
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ping') {
    // 只唤醒 service worker，不在这里采集 cookie ——
    // 每个 zhipin 页面加载都会 ping 一次，采集要等到真有任务时再做。
    boot().then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
  return false;
});

// 脚本被直接加载时（SW 首次启动）也走一遍引导
boot();
