/**
 * 常驻自动投递进程。
 *
 * 启动后一直挂着，每 5 分钟查一次「新招呼」tab 里带红点（= 前端 MQTT 推来的真实未读
 * = 你肯定没点开过这个会话）的会话，自动给这些 HR 各发一份附件简历。
 *
 * 用法：
 *   npm run watch                    前台常驻，每 5 分钟一轮
 *   npm run watch -- --once          只跑一轮就退出
 *   npm run watch -- --once --dry-run 只扫不投（先看看会投给谁）
 *   npm run watch -- --interval 120  改轮询间隔（秒）
 *   npm run watch -- --no-verify     不做服务端二次确认（快一点）
 *   npm run watch:bg                 后台脱离终端启动
 *   npm run watch:stop               停掉后台进程
 *   npm run watch:status             看状态
 *
 * 前提：
 *   - Chrome 开着、已登录 BOSS直聘、扩展已加载
 *   - `npm run bridge` 在跑 —— 或者让本进程自己当宿主（端口空着时会自动接管）
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEDUP_WINDOW_MS,
  DATA_DIR,
  STATE_FILE,
  deliverNext,
  ensureLogin,
  fetchSessions,
  isExcludedEntry,
  loadState,
  recentlyHandled,
  resolveSession,
  saveState,
  scanGreetings,
  stateKey,
  verifyDelivered,
  type AutoRecord,
  type AutoState,
  type ExcludeEntry,
} from '../api/auto-deliver.js';
import { createBrowserClient } from '../api/browser-client.js';
import type { ChatSession } from '../api/messages.js';
import { bridge, bridgeStatus, requestBridgeShutdown } from '../api/bridge.js';
import { closeLeakedChatTabs, listChatTabs, releasePinnedTab } from '../api/page-transport.js';
import { sleep } from '../api/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PID_FILE = path.join(DATA_DIR, 'watch.pid');
const LOG_FILE = path.join(DATA_DIR, 'watch.log');

const DEFAULT_INTERVAL = 300; // 秒 = 5 分钟
/** 单轮最多投多少个 —— 防「红点一直消不掉」把进程跑飞，不是业务上限 */
const ROUND_GUARD = 100;
/**
 * 服务端确认的预算（毫秒）。
 *
 * 这是**兜底上限**，不是「等多久就会好」——
 * 真正的判据是「服务端回没回我这条简历」，查到了就立刻停。
 */
const VERIFY_BUDGET_MS = 15_000;

/* ---------------- 小工具 ---------------- */

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (f: string, d: number): number => {
  const n = Number(val(f));
  return Number.isFinite(n) && n > 0 ? n : d;
};

function log(msg: string) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

function readPid(): number | null {
  try {
    const p = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
function writePid(pid: number) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}
function clearPid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 等扩展连上。
 *
 * 不用桥接的 `connected`（那是 60 秒窗口）—— Chrome 刚被关掉时它会「假连接」，
 * 判据换成看扩展最近一次轮询的新鲜度：扩展的长轮询最长挂 20 秒，
 * 所以超过 30 秒没来轮询，就说明它不在了（Chrome 关了 / 扩展被停用）。
 *
 * 桥接刚起来的时候，扩展那边的长轮询会失败一次，要等它重连（实测 1~2 秒），
 * 不等的话第一轮会误判成「扩展没连上」直接跳过。
 */
async function waitForExtension(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await bridgeStatus();
    if (st && typeof st.lastPoll === 'number' && Date.now() - st.lastPoll < 30_000) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

/* ---------------- 后台启动 / 停止 / 状态 ---------------- */

async function startBackground() {
  const existing = readPid();
  if (existing && alive(existing)) {
    console.log(`已经在后台跑了（PID ${existing}）。`);
    console.log('要停掉先跑：npm run watch:stop');
    return;
  }
  clearPid();

  // 必须直接 spawn node + tsx，不能套 npm run ——
  // 杀 npm 包装进程时 tsx 子进程会残留占着端口（这个坑踩过）。
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(ROOT, 'src', 'scripts', 'watch.ts');
  const child = spawn(process.execPath, [tsxCli, script, '--worker'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
  });
  child.unref();

  // PID 由**工作进程自己**写（tsx 会再套一层进程，父进程拿到的 pid 不是真正干活的）。
  // 这里等它把 pid 写出来。
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const pid = readPid();
    if (pid && alive(pid)) {
      console.log('已在后台启动。');
      console.log(`  PID   : ${pid}`);
      console.log(`  日志  : ${LOG_FILE}`);
      console.log('  停止  : npm run watch:stop');
      console.log('  状态  : npm run watch:status');
      return;
    }
  }
  console.log('已尝试后台启动，但没拿到工作进程的 PID —— 看 ' + LOG_FILE);
}

async function stopBackground() {
  const pid = readPid();
  if (!pid) {
    console.log('没有在后台跑（没有 pid 文件）。');
    return;
  }
  if (!alive(pid)) {
    console.log(`进程 ${pid} 已经不在了，清掉 pid 文件。`);
    clearPid();
    return;
  }

  // ① 让工作进程**自己**优雅退出（它有自己的退出钩子：释放固定页 + 清 pid）。
  //    父进程不替它释放资源 —— 那是资源所有者的职责；而且「先释放后硬杀」
  //    会跟正在跑的轮次打架（轮中间 pin 没了，下一个任务立刻重开新页）。
  try {
    await bridge.start(); // 守护进程宿主着桥接 → 探活后直接远程模式
  } catch {
    /* 桥接起不来也没关系，走硬杀兜底 */
  }
  const graceful = await requestBridgeShutdown();
  if (graceful) {
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  }

  // ② 还活着 → 硬杀兜底（顺带收掉它固定的标签页）
  if (!alive(pid)) {
    console.log(`已停止（PID ${pid}，优雅退出）。`);
    clearPid();
    await bridge.stop().catch(() => {});
    return;
  }
  try {
    await releasePinnedTab();
  } catch {
    /* 扩展会空闲 10 分钟后自己关 */
  }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
    if (err) {
      console.error('停止失败：' + err.message);
      return;
    }
    // taskkill 的输出是控制台编码（GBK），直接打印会乱码 —— 只报自己的话
    console.log(`已停止（PID ${pid}，硬杀）。`);
    clearPid();
  });
  await bridge.stop().catch(() => {});
}

function showStatus() {
  const pid = readPid();
  const running = pid ? alive(pid) : false;
  const state = loadState();
  console.log('── 自动投递守护进程 ──');
  console.log(`  状态      : ${running ? `运行中（PID ${pid}）` : '没在跑'}`);
  console.log(`  日志      : ${LOG_FILE}`);
  console.log(`  状态文件  : ${STATE_FILE}`);
  console.log(`  今日投递  : ${state.stats?.sentToday ?? 0} 个`);
  console.log(`  累计轮次  : ${state.stats?.rounds ?? 0}`);
  if (state.stats?.lastRoundAt) {
    console.log(`  上轮结束  : ${new Date(state.stats.lastRoundAt).toLocaleString('zh-CN', { hour12: false })}`);
  }
  const sent = Object.keys(state.sent ?? {}).length;
  const failed = Object.keys(state.failed ?? {}).length;
  console.log(`  已投/失败  : ${sent} / ${failed}`);
}

/* ---------------- 标签页排查 ---------------- */

/** 列出浏览器里所有 BOSS直聘 标签页（桥接生命周期由 main 的分发处管） */
async function showTabs() {
  const info = await listChatTabs();
  const zhipin = info.tabs.filter((t) => t.isZhipin).length;
  console.log('── 浏览器标签页 ──');
  console.log(`  全部标签页   : ${info.totalTabs}`);
  console.log(`  BOSS 页面    : ${zhipin}`);
  console.log(`  守护进程固定页: ${info.pinTabId ?? '(没有)'}`);
  for (const t of info.tabs.slice(0, 30)) {
    console.log(
      `   #${String(t.id).padStart(5)} ${t.id === info.pinTabId ? '★固定' : '     '} ${t.active ? '当前' : '    '} ` +
        `${t.isZhipin ? 'BOSS' : '    '} ${t.title}`,
    );
  }
  if (info.tabs.length > 30) console.log(`   …… 还有 ${info.tabs.length - 30} 个`);
}

/** 清理泄漏出来的聊天页标签页（保留每个窗口当前正在看的那一个） */
async function cleanupTabs() {
  const dry = !has('--yes');
  const info = await closeLeakedChatTabs(dry);
  if (dry) {
    console.log(`发现 ${info.found} 个 BOSS 聊天页标签页。`);
    console.log(`将要关闭 ${info.found - info.kept} 个，保留 ${info.kept} 个（每个窗口当前正在看的那个 + 守护进程固定的那个）。`);
    console.log('确认无误就加 --yes 真正执行：npm run watch -- --cleanup-tabs --yes');
  } else {
    console.log(`已关闭 ${info.closed} 个多余的聊天页标签页（保留了 ${info.kept} 个）。`);
  }
}

/* ---------------- 一轮投递 ---------------- */
interface RoundOpts {
  dryRun: boolean;
  verify: boolean;
  /** 本轮最多投几个（0 = 不限，但受 ROUND_GUARD 保护） */
  limit: number;
  /** 只投指定名字的人（补投用），不投就留空 */
  only?: string;
}

/**
 * 最近投过（或者失败过）的会话 —— **只用来报警，不用来拦投递**。
 *
 * 投递判据是**红点**：红点 = 没人打开过这个会话，而投递必然要打开会话，
 * 所以投过的人红点必然消失 → 红点自己就是「还没投过」的标记。
 *
 * 这份名单唯一的用途：万一红点在投递后没及时消失（BOSS 的已读是异步推的），
 * 我们能看出「这个人 12 小时内投过，怎么还有红点」并提示，而不是闷头投第二遍。
 */
function recentlyHandledNames(state: AutoState): ExcludeEntry[] {
  const out: ExcludeEntry[] = [];
  const seen = new Set<string>();
  const collect = (recs: Record<string, any>) => {
    for (const rec of Object.values(recs ?? {})) {
      if (!rec?.name) continue;
      if (Date.now() - (rec.at ?? 0) >= DEDUP_WINDOW_MS) continue;
      const k = `${rec.name}::${rec.company ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name: rec.name, company: rec.company });
    }
  };
  collect(state.sent);
  collect(state.failed);
  return out;
}

/** 记一笔账（成功 / 失败 / 超时后确认成功，三处共用；bag 区分进哪张表） */
function record(state: AutoState, bag: 'sent' | 'failed', key: string, rec: Omit<AutoRecord, 'at'>) {
  state[bag][key] = { ...rec, at: Date.now() };
  saveState(state);
}

async function runRound(opts: RoundOpts) {
  const state = loadState();

  // ① 起桥接 —— 端口空着就自己当宿主，被占了就复用已有的那个。
  //    所以**不用**另外开 npm run bridge。
  await bridge.start();

  // ② 等扩展连上（桥接刚起来时扩展要重连一次）
  if (!(await waitForExtension(15_000))) {
    log('❌ 没等到 Chrome 扩展 —— 本地桥接在跑，但没有扩展来连它');
    log('   请确认：① Chrome 浏览器开着 ② chrome://extensions/ 里扩展已加载并启用（被停用时点一下 🔄）');
    return;
  }

  // ③ 扫描 —— 放在登录态探测**前面**。
  //    因为扫描是页面任务，它会把守护进程自己的标签页开出来；
  //    而登录态探测走的是接口请求，必须在页面上下文里发 ——
  //    用户一个 zhipin 页面都没开的时候，顺序反了就会报「没有打开的标签页」。
  const scan = await scanGreetings();
  log(
    `扫描：会话 ${scan.rowCount} 行，其中带红点 ${scan.badges.length} 个` +
      (scan.stuck ? '（页面卡住过 → 已重载恢复）' : ''),
  );

  // ④ 登录态
  const client = await createBrowserClient();
  await ensureLogin(client);

  // ⑤ 本轮要投的人 = **带红点的会话**。
  //    红点 = 没人打开过 = 还没投过（投递必然要打开会话，红点会随之消失）。
  //    所以判据只有红点，不再有「12 小时内投过就别投」那种名单 ——
  //    那种名单会误伤（一次偶发失败就把人挡 12 小时，同名同公司还会漏人）。
  const targets = scan.badges.filter((b) => !opts.only || b.name === opts.only);
  for (const b of targets) {
    log(`  · ${b.name || '(读不出名字)'} [红点 ${b.badge}] ${(b.lines ?? []).join(' | ')}`);
  }

  // 12 小时内投过的人如果还有红点 → BOSS 的已读是异步推的，红点没及时消失。
  // 提示一下，免得闷头投第二遍。
  const handled = recentlyHandledNames(state);
  for (const b of targets) {
    if (isExcludedEntry(b, handled)) {
      log(`  ⚠️ ${b.name} 12 小时内投过，却还有红点（已读推送可能滞后）—— 仍按红点投`);
    }
  }

  if (opts.dryRun) {
    log(
      `<dry-run> 本轮会投给 ${targets.length} 个人：${
        targets.map((b) => b.name || '?').join('、') || '（无）'
      }`,
    );
    log('<dry-run> 不投递。去掉 --dry-run 就会真的发简历。');
    return;
  }

  // 没有红点就没事可做（但 --only 指定了人时照投）
  if (!targets.length && !opts.only) {
    log('没有新招呼带红点，本轮无事可做');
    return;
  }

  // ⑥ 逐个投递
  let sessions: ChatSession[] = [];
  try {
    sessions = await fetchSessions(client);
  } catch (e) {
    log('⚠️ 拿会话列表失败，去重键会退化成「姓名」：' + (e as Error).message);
  }
  const sentList: { name: string; key: string }[] = [];
  let count = 0;

  // 本轮已经试过、但没打开成功的会话 ——
  //   只在本轮内生效：防止一轮里反复挑中同一个「点了没打开」的行。
  //   不跨轮（跨轮就该再试一次，一次偶发失败不该把人挡到下一轮）。
  const triedThisRound = new Set<string>();

  for (;;) {
    const res = await deliverNext({
      exclude: [...triedThisRound].map((name) => ({ name })),
      pick: opts.only,
      // 服务端确认：用来识别「点「发简历」但没有确认弹窗、直接就发了」那种形态。
      // 没有它就只能等弹窗，等到没弹窗就判失败 —— 明明投出去了却记成失败。
      verify: async (name: string, sinceAt: number) => {
        if (!client) return false;
        try {
          return await verifyDelivered(client, name, sessions, sinceAt);
        } catch {
          return false;
        }
      },
    });
    if (res.done) {
      log('没有更多红点了');
      break;
    }
    if (res.name) triedThisRound.add(res.name);

    // 去重键统一在这里算 —— 成功、失败、超时三条路径用同一个键，
    // 不然同一个人会在状态文件里落成两个键（`id:friendId` 和 `n:姓名::`）。
    const hit = res.name ? resolveSession(sessions, res.name, res.conv) : null;
    const key = res.name ? stateKey(res.name, hit?.job, hit?.friendId) : '';
    const company = hit?.brandName;

    if (!res.ok) {
      const who = res.name || '(不知是谁)';
      log(`❌ ${who} 投递失败：${res.reason ?? res.step}  ${res.detail ?? ''}`.trimEnd());

      // **可能其实投出去了** —— 有两种情况：
      //   ① uncertain：任务超时了，不知道点没点上
      //   ② maybeSent：点了「发简历」但确认弹窗没出现（BOSS 有直接发的形态，
      //      实测 2026-11-15 12:34 对「何女士」就是这样：简历 1 秒内就到了服务端，
      //      而弹窗从头到尾没出现）
      // 这两种都必须**用服务端确认**来判定，不能凭页面上没看到弹窗就判失败。
      if ((res.uncertain || res.maybeSent) && res.name) {
        try {
          // 一直查到截止时刻为止 —— **不是试几次就放弃**。
          // 慢网下消息可能好几秒才落库，试三次就判失败是错的
          // （跟当初 1600ms 硬等一个毛病：拿固定次数去猜状态什么时候到）。
          // 两次查询之间等「上一次查询自己花了多久」—— 网络慢就自然等得久。
          const until = Date.now() + VERIFY_BUDGET_MS;
          let ok = false;
          for (;;) {
            const t0 = Date.now();
            ok = await verifyDelivered(client, res.name, sessions, res.sentAt);
            if (ok) break;
            if (Date.now() >= until) break;
            await sleep(Math.max(200, Date.now() - t0));
          }
          if (ok) {
            record(state, 'sent', key, {
              name: res.name,
              job: hit?.job,
              company,
              status: 'verified',
            });
            sentList.push({ name: res.name, key });
            log('  ↳ 服务端确实收到了简历 —— 按已投递记账（页面没弹窗，但发出去了）');
            continue;
          }
          log('  ↳ 服务端也没查到简历，按失败记账');
        } catch (e) {
          log(`  ↳ 服务端确认也失败了：${(e as Error).message}`);
        }
      }

      if (res.name) {
        record(state, 'failed', key, {
          name: res.name,
          job: hit?.job,
          company,
          status: 'failed',
          reason: res.reason ?? res.step,
        });
      }
      // 连目标都没找到 → 再转下去也是白转，本轮到此为止
      if (!res.name) break;
      continue;
    }

    count++;
    const name = res.name!;
    // 简历**已经发出去了**（上一步点了「确定」）—— 照实记账。
    // 判据是红点，不是「记录里有没有」；这里只是把这次投递记进历史。
    const hadRecord = recentlyHandled(state, key, name);
    record(state, 'sent', key, {
      name,
      job: hit?.job,
      company,
      status: 'sent',
    });
    sentList.push({ name, key });
    if (hadRecord) {
      log(`  ⚠️ ${name} 的记录里已经有（12 小时内投过）—— 这次又投了一遍，红点没及时消`);
    }
    const mismatch = res.clickedName && res.clickedName !== name ? `（点的是 ${res.clickedName}）` : '';
    log(
      `✅ 已投给 ${name}${hit?.job ? ' · ' + hit.job : ''}${company ? ' · ' + company : ''}` +
        `${mismatch}  [会话头: ${res.conv ?? '-'}]`,
    );

    if (count >= ROUND_GUARD) {
      log(`⚠️ 达到单轮保护上限 ${ROUND_GUARD} 个，本轮收工`);
      break;
    }
    if (opts.limit > 0 && count >= opts.limit) {
      log(`达到本轮指定上限 ${opts.limit} 个，本轮收工`);
      break;
    }
    // --only 指定了人：只投这一个（否则会对着同一个人反复投）
    if (opts.only) break;
  }

  // ⑦ 服务端二次确认（超时那批在 ⑥ 里已确认过，看 status 就知道）
  if (opts.verify && sentList.length) {
    log(`正在服务端确认 ${sentList.length} 条投递…`);
    for (const s of sentList) {
      if (state.sent[s.key]?.status === 'verified') continue;
      try {
        const ok = await verifyDelivered(client, s.name, sessions);
        if (ok) {
          state.sent[s.key].status = 'verified';
          log(`  ✓ ${s.name} 服务端已看到简历消息`);
        } else {
          state.sent[s.key].status = 'unverified';
          log(`  ⚠️ ${s.name} 服务端没查到简历消息，请人工看一眼网页`);
        }
      } catch (e) {
        log(`  ⚠️ ${s.name} 确认失败：${(e as Error).message}`);
      }
    }
    saveState(state);
  }

  // ⑧ 收尾统计
  const today = new Date().toISOString().slice(0, 10);
  if (state.stats.day !== today) {
    state.stats.day = today;
    state.stats.sentToday = 0;
  }
  state.stats.sentToday += sentList.length;
  state.stats.rounds = (state.stats.rounds ?? 0) + 1;
  state.stats.lastRoundAt = Date.now();
  saveState(state);
  log(
    `本轮结束：投了 ${sentList.length} 个` +
      (sentList.length ? '（' + sentList.map((s) => s.name).join('、') + '）' : '') +
      `，今日累计 ${state.stats.sentToday} 个`,
  );
}

/* ---------------- 主流程 ---------------- */

async function main() {
  // 扩展的诊断信息会跟自己的日志混在一起刷屏 —— 守护进程模式下关掉
  process.env.BOSS_ZHIPIN_QUIET_DIAG = '1';

  // —— 子命令 ——
  if (has('--bg')) return await startBackground();
  if (has('--stop')) return stopBackground();
  if (has('--status')) return showStatus();
  // --tabs / --cleanup-tabs 自己不当宿主也行，桥接生命周期统一在这里管：
  // 出错也得 bridge.stop()，否则 HTTP server 会让进程挂住退不出去
  if (has('--tabs') || has('--cleanup-tabs')) {
    await bridge.start();
    try {
      return await (has('--tabs') ? showTabs() : cleanupTabs());
    } finally {
      await bridge.stop();
    }
  }

  // 工作进程自己登记 PID（父进程拿到的 pid 是 tsx 包装进程，不是真正干活的）
  if (has('--worker')) writePid(process.pid);

  const dryRun = has('--dry-run');
  const verify = !has('--no-verify');
  const once = has('--once');
  const interval = num('--interval', DEFAULT_INTERVAL);
  const limit = num('--limit', 0);
  const only = val('--only');

  log('════ 自动投递守护进程启动 ════');
  log(`  轮询间隔 : ${interval} 秒`);
  log(`  干跑模式 : ${dryRun ? '是（不投递）' : '否（会真的发简历）'}`);
  if (limit > 0) log(`  本轮上限 : ${limit} 个`);
  if (only) log(`  只投给  : ${only}`);
  log(`  服务端确认: ${verify ? '开' : '关'}`);
  log('  停止    : Ctrl+C');

  const shutdown = async (sig: string) => {
    log(`收到 ${sig}，正在退出…`);
    await releasePinnedTab().catch(() => {});
    clearPid();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // watch:stop 的优雅退出通道：父进程 POST /shutdown → 桥接调这里 → 走上面的 shutdown
  bridge.registerShutdown(() => shutdown('shutdown'));
  process.on('uncaughtException', (e) => log('❌ 未捕获异常（继续跑）：' + (e as Error).message));
  process.on('unhandledRejection', (e: any) => log('❌ 未处理的 Promise 拒绝（继续跑）：' + String(e)));

  /** 收尾：释放固定页 + 收掉桥接（HTTP server 不关进程就退不出去） */
  const teardown = async () => {
    await releasePinnedTab().catch(() => {});
    await bridge.stop().catch(() => {});
  };

  if (once) {
    try {
      await runRound({ dryRun, verify, limit, only });
    } catch (e) {
      log('❌ 本轮出错：' + (e as Error).message);
    }
    await teardown();
    return;
  }

  // 定时用 setTimeout 链：一轮没跑完就不会叠下一轮
  for (;;) {
    try {
      await runRound({ dryRun, verify, limit, only });
    } catch (e) {
      log('❌ 本轮出错：' + (e as Error).message);
    }
    // 干跑只跑一轮
    if (dryRun) {
      await teardown();
      return;
    }
    await sleep(interval * 1000);
  }
}

main().catch((e) => {
  console.error('❌', (e as Error).message);
  process.exit(1);
});
