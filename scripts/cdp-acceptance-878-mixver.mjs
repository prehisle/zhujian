// 手机端「混版提醒」验收(878,发版全案格 2 的手机那半;安卓 / 鸿蒙共用 android/src/)。
//
// 判两件事:
//   A. 本机第一次往**已配同步的空间**发 doc_at(展开成长文 / 新建长文 / 收回随记 / 长文移到别的空间 —— 移动判**目标**)之前,
//      底部确认条问「其他设备都升级了吗?…」〔仍然使用〕/〔先不用〕(android/src/skewask.ts):
//        ① 配了同步的空间第一次展开 → 弹;〔先不用〕→ 没发 set_doc、条目仍是随记、本机账上没记这一本;
//        ② 再展开 → 再弹;〔仍然使用〕→ 发了 set_doc、成了长文、账上记了这一本;
//        ③ 之后同一本里收回随记 → 不弹、照发 set_doc;从「记一笔」新建长文 → 不弹、编辑器直接开;
//        ④ 另一本配了同步、没看过提醒的(丙)从「记一笔」新建长文 → 弹;〔先不用〕→ 编辑器没开、框里的字还在;
//        ⑤ 没配同步的空间(乙)展开 → 不弹、照发、账上不记;
//        ⑥ 乙里的长文移到丙(配了、没看过)→ 先两拍「移到…?」,再弹混版提醒;〔先不用〕→ 没发 move_item_to_space;
//           再来一遍〔仍然使用〕→ 移过去了、账上记了丙。
//   B. 同步面渲染 `skew`:截下 `sync_status` 的回包把 skew 置 true(页内假造 —— core 那半另有人在接,这里只证前端那一行)
//      → 同步面出「对端版本较新:请升级朱简后继续同步。」、顶栏圆点不再是实心「已连接」;撤掉假造 → 那一行没了。
//
// 「已配同步」是**真的**:跑之前起本机 syncd,本资产在两个测试空间上真建账户(`sync_create_account`)。
//   起法:`server/target/release/zhujian-syncd.exe --listen 127.0.0.1:18901 --data-dir <临时目录>`(目录里放一份空的 banlist.txt);
//   真机上再 `adb -s <序列号> reverse tcp:18901 tcp:18901`(手机连的是它自己的 127.0.0.1)。
// IPC 观测:安卓包 `window.ipc`(postMessage 转发壳),桌面构型 / 鸿蒙包全局 fetch(822「IPC 观测的两条路」);
//   ⭐ 先自证拦截真生效(⑤ 那一发 set_doc 必须被记到 —— 正面对照),再拿「没记到」当结论。
//
// ⛔ **会建三个空间、建两个本机测试账户**:只动自己建的(名字以「混版验收」开头);开跑前已有同名空间就拒跑;
//    收尾 reset_space 三个都删(非 main 的 reset = 删库文件)、本机「看过提醒」那一账还回开跑前的原值。
//    服务器上那两个测试账户留在你自己起的 syncd 临时目录里,删目录即清。⛔ 别指向官方服务器。
//
// 跑法:
//   ① 桌面构型的隔离实例(不占手机,878 用的就是它):`node scripts/ui-shots-wide.mjs <目录> --only phone-360x800-ideas --keep`
//      → `CDP_PORT=9245 node scripts/cdp-acceptance-878-mixver.mjs --server ws://127.0.0.1:18901 --emulate 360x800 [--shots <目录>]`
//   ② 真机 devtools 包:`node scripts/android-cdp.mjs forward` → `CDP_PORT=9222 node scripts/cdp-acceptance-878-mixver.mjs --server ws://127.0.0.1:18901`
// 退出码 0 = 全过。
// @cdp-run driver
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9222);
const SHOTS = arg("--shots");
const SERVER = arg("--server");
if (!SERVER || !/^wss?:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) {
  console.error("要 --server ws://127.0.0.1:<端口>(本机 syncd;⛔ 别指向官方服务器)");
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PREFIX = "混版验收";
const ACK_KEY = "zhujian.skew-ask-ack";
const TITLE = "其他设备都升级了吗?";
const J = JSON.stringify;

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const ev = (js) => s.evaluate(js);
// 桌面构型的隔离实例窗口是 1440×960(平板排法)⇒ 带 `--emulate 360x800` 压成手机竖放;真机不用给
const EMU = arg("--emulate");
if (EMU) {
  const [w, h] = EMU.split("x").map(Number);
  await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
}
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + J(extra) : ""}`);
};
async function waitFor(expr, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return true;
    } catch {
      /* 重画 / 重载途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`, expr);
      return false;
    }
    await sleep(150);
  }
}
const inv = async (cmd, args = {}) => {
  const r = await ev(`window.__TAURI__.core.invoke(${J(cmd)}, ${J(args)}).then((v) => ({ v }), (e) => ({ e: String(e) }))`);
  if ("e" in r) throw new Error(`${cmd}: ${r.e}`);
  return r.v;
};
const shot = async (name) => {
  if (!SHOTS) return;
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
};
const ack = async () => J(await ev(`localStorage.getItem(${J(ACK_KEY)})`));
const acked = async (id) => ev(`(JSON.parse(localStorage.getItem(${J(ACK_KEY)}) ?? "[]")).includes(${J(id)})`);

// ---- IPC 记录器(文档一开头就装:Page.addScriptToEvaluateOnNewDocument,重载后自己在)--------------------
// 记每一发命令名。假造 skew(sessionStorage `zj878.fakeSkew` = "1",跨重载)时改两条来路 —— 同步面的状态只有这两条进来:
//   · `sync_status` 的回包(启动 / 换空间 / 动作之后那一读)→ skew = true;
//   · `sync-status` 事件(后台状态推送):在 `plugin:event|listen` 登记那一刻把 handler 换成转发壳,推过来的状态 skew = true。
//   ⛔ 只改回包那一条不够:连上之后后台一推,那一行就被真状态冲掉(878 第一版实撞)。
const INSTALL = `(() => {
  // 可重入:文档开头那一趟在安卓上包不上 window.ipc(那一刻桥还没就位),重载后 install() 再跑一趟要能补上
  // —— ⛔ 别再用「装过了就整段跳过」(878 真机第一趟栽在这:记录器在、却一发安卓 IPC 都没记到)。
  const o = window.__zj878 || { calls: [] };
  window.__zj878 = o;
  const fake = () => sessionStorage.getItem("zj878.fakeSkew") === "1";
  const I = () => window.__TAURI_INTERNALS__;
  const skewEv = (e) => (fake() && e && e.payload && e.payload.payload ? { ...e, payload: { ...e.payload, payload: { ...e.payload.payload, skew: true } } } : e);
  /** listen 登记的参数:event === "sync-status" 就把 handler 换成转发壳。 */
  const wrapListen = (args) => {
    if (!args || args.event !== "sync-status" || typeof args.handler !== "number") return false;
    const back = args.handler;
    args.handler = I().transformCallback((e) => I().runCallback(back, skewEv(e)), false);
    return true;
  };
  const orig = window.fetch.bind(window);
  if (!window.fetch.__zj878) window.fetch = Object.assign(async function (u, init) {
    const m = /^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/(.*)$/.exec(String(u));
    if (!m) return orig(u, init);
    const cmd = decodeURIComponent(m[1]);
    o.calls.push(cmd);
    if (cmd === "plugin:event|listen" && typeof init?.body === "string") {
      try {
        const a = JSON.parse(init.body);
        if (wrapListen(a)) init = { ...init, body: JSON.stringify(a) };
      } catch {}
    }
    const res = await orig(u, init);
    if (cmd !== "sync_status" || !fake() || !res.ok) return res;
    const v = await res.clone().json();
    return new Response(JSON.stringify({ ...v, skew: true }), { status: res.status, headers: res.headers });
  }, { __zj878: true });
  // 安卓上 Tauri 从不走 fetch(WebView 读不到 POST 体),一律 window.ipc.postMessage;桌面构型 / 鸿蒙走 fetch(822)
  if (/Android/.test(navigator.userAgent)) {
    /** 把 Tauri 的安卓 IPC 桥包成转发壳(记命令 / 换 sync-status 监听 / 改 sync_status 回包)。 */
    const mk = (real) => {
      const origPm = real.postMessage.bind(real);
      return {
        __zj878: true,
        postMessage(data) {
          let msg = null;
          try { msg = JSON.parse(data); } catch {}
          if (!msg) return origPm(data);
          o.calls.push(msg.cmd);
          if (msg.cmd === "plugin:event|listen" && wrapListen(msg.payload)) return origPm(JSON.stringify(msg));
          if (msg.cmd === "sync_status" && fake()) {
            const back = msg.callback;
            msg.callback = I().transformCallback((v) => I().runCallback(back, { ...v, skew: true }), true);
            return origPm(JSON.stringify(msg));
          }
          return origPm(data);
        },
      };
    };
    // 文档开头那一趟:桥还没装(Tauri 稍后用 JS 赋值 window.ipc,878 真机实测两次 set)⇒ 挂访问器,
    // 赋值那一刻就包上 —— 这样 app 启动时登记的 sync-status 监听也走转发壳(只在重载后补包就晚了,监听早登记完)。
    const cur = window.ipc;
    if (cur === undefined) {
      let shell;
      Object.defineProperty(window, "ipc", { configurable: true, get() { return shell; }, set(v) { shell = v && !v.__zj878 ? mk(v) : v; } });
      return "trapped";
    }
    if (cur.__zj878) return "installed";
    const shell = mk(cur);
    try { window.ipc = shell; } catch {}
    if (window.ipc !== shell) return "android-ipc-not-wrappable";
  }
  return "installed";
})()`;
let earlyId = null;
async function install() {
  const r = await ev(INSTALL);
  if (r === "android-ipc-not-wrappable" || r === "android-ipc-missing") throw new Error(`window.ipc 包不上(${r})—— 看不见 IPC,判据作废`);
}
const mark = () => ev(`window.__zj878.calls.length`);
const callsSince = (m) => ev(`window.__zj878.calls.slice(${m})`);

async function reloadInto(spaceId) {
  await ev(`(localStorage.setItem("zhujian.last-space", ${J(spaceId)}), localStorage.setItem("zhujian.lang", "zh"), setTimeout(() => location.reload(), 0), true)`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar") && !!window.__TAURI__ && document.getElementById("gate")?.hidden === true`, "页面就绪", 30000);
  await waitFor(`document.body.dataset.view === "ideas"`, "随记面", 15000);
  await install();
  await ev(`(document.getElementById("error").hidden = true, true)`);
}

// ---- 确认条 ---------------------------------------------------------------------------------
const barState = () =>
  ev(`(() => { const b = document.getElementById("confirmbar"); return b.hidden ? null : { q: document.getElementById("confirmbar-q").textContent, yes: document.getElementById("confirmbar-yes").textContent, no: document.getElementById("confirmbar-no").textContent }; })()`);
const isSkewBar = (b) => b !== null && b.q.startsWith(TITLE) && b.yes === "仍然使用" && b.no === "先不用";
/** 等一会儿,确认条**一直没起**(给异步那一跳留足时间:skewAsk 先读一次空间列表)。 */
async function noBarFor(ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await barState()) !== null) return false;
    await sleep(100);
  }
  return true;
}
const clickBar = (which) => ev(`(document.getElementById("confirmbar-${which}").click(), true)`);

// ---- 随记卡片 / 长文面 ------------------------------------------------------------------------
/** 点开那张卡的操作面 → 「更多…」→ 点 `act`。 */
async function cardAct(id, act) {
  await waitFor(`!!document.querySelector('#timeline .card[data-id="${id}"]')`, "卡在时间轴上");
  await ev(`(() => { const c = document.querySelector('#timeline .card[data-id="${id}"]'); if (!c.querySelector(".panel")) c.querySelector(".body").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
  await waitFor(`!!document.querySelector('#timeline .card[data-id="${id}"] .panel [data-pact="more"]') || !!document.querySelector('#timeline .card[data-id="${id}"] .panel [data-pact="${act}"]')`, "操作面");
  await ev(`(() => { const p = document.querySelector('#timeline .card[data-id="${id}"] .panel'); const m = p.querySelector('[data-pact="more"]'); if (m && !p.querySelector('[data-pact="${act}"]')) m.click(); return true; })()`);
  // 906:「更多…」是屏底菜单层 ⇒ 第一层没有的那一枚到层里找(#more-list [data-more-act])
  const SEL = `(document.querySelector('#timeline .card[data-id="${id}"] .panel [data-pact="${act}"]') ?? document.querySelector('#more-list [data-more-act="${act}"]'))`;
  await waitFor(`!!${SEL}`, `「${act}」钮`);
  await ev(`(${SEL}.click(), true)`);
}
const clickDocsText = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll("#docs-body button")].find((x) => x.textContent.trim() === ${J(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function openReaderMore(id) {
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!!document.querySelector('#docs-body [data-doc="${id}"]')`, "长文列表里有那篇");
  await ev(`document.querySelector('#docs-body [data-doc="${id}"]').click()`);
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页");
  await clickDocsText("更多…");
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-acts button")].some((b) => b.textContent.trim() === "收回随记")`, "「更多…」那排");
}
const isDoc = async (spaceId, id) => (await inv("list_docs", { spaceId })).some((d) => d.id === id);
/** 「记一笔」层:开层、写字、点「长文」。 */
async function composeDoc(text) {
  await ev(`document.getElementById("capture-fab").click()`);
  await waitFor(`document.getElementById("compose-card").classList.contains("open")`, "记一笔层");
  await ev(`(() => { const ta = document.getElementById("text"); ta.value = ${J(text)}; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await ev(`(document.getElementById("compose-doc").click(), true)`);
}

// ---- 跑 ------------------------------------------------------------------------------------
const made = [];
let ackBefore = null;
let home = null;
try {
  home = await ev(`localStorage.getItem("zhujian.last-space")`);
  ackBefore = await ev(`localStorage.getItem(${J(ACK_KEY)})`);
  const spaces0 = await inv("list_spaces");
  if (spaces0.some((x) => (x.name ?? "").startsWith(PREFIX))) throw new Error(`已有「${PREFIX}…」空间(上一趟没收尾?)—— 先手工 reset_space`);
  await ev(`(localStorage.removeItem(${J(ACK_KEY)}), sessionStorage.removeItem("zj878.fakeSkew"), true)`);
  await s.send("Page.enable", {}); // ⚠ 不先 enable,WebView2 上新文档脚本静默不跑(878 实测)
  earlyId = (await s.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL })).identifier;

  // 三个测试空间:甲 / 丙 真建账户(配了同步),乙不配
  const A = await inv("create_space", { name: `${PREFIX}甲` });
  made.push(A);
  const B = await inv("create_space", { name: `${PREFIX}乙` });
  made.push(B);
  const C = await inv("create_space", { name: `${PREFIX}丙` });
  made.push(C);
  for (const sp of [A, C]) {
    await inv("activate_space", { spaceId: sp });
    await reloadInto(sp);
    await inv("sync_create_account", { spaceId: sp, serverUrl: SERVER });
  }
  const conf = Object.fromEntries((await inv("list_spaces")).map((x) => [x.id, x.configured]));
  ok(conf[A] === true && conf[C] === true && conf[B] === false, "前置:甲 / 丙 配了同步、乙没配(list_spaces.configured)", { A: conf[A], B: conf[B], C: conf[C] });

  // ① ② ③ 甲(配了同步)
  await inv("activate_space", { spaceId: A });
  const a1 = await inv("capture_idea", { spaceId: A, content: "混版验收 甲一" });
  await reloadInto(A);
  let m = await mark();
  await cardAct(a1, "expand");
  await waitFor(`!document.getElementById("confirmbar").hidden`, "混版提醒弹出");
  const b1 = await barState();
  ok(isSkewBar(b1), "① 甲第一次展开 → 弹混版提醒(标题 + 正文 +〔仍然使用〕/〔先不用〕)", b1);
  ok(b1 !== null && b1.q.includes("电脑 0.2.50 / 安卓 0.3.46 / 鸿蒙 0.3.39"), "① 正文带三端版本线");
  await shot("01-expand-ask");
  const form = await ev(`(() => { const q = document.getElementById("confirmbar-q"); const b = q.querySelector("b"); return { title: b?.textContent ?? null, br: !!q.querySelector("br"), column: getComputedStyle(document.getElementById("confirmbar")).flexDirection }; })()`);
  ok(form.title === TITLE && form.br && form.column === "column", "① 标题加粗独占一行、正文另起一行、条是上下排(问句整宽)", form);
  // sticky(878 主控拍):这段话 6 秒读不完 ⇒ 不许自动作罢。CONFIRM_REVERT_MS = 6 s,等 7 s 还在、钮还点得动、没进余温态
  await sleep(7000);
  const after7 = await ev(`(() => { const b = document.getElementById("confirmbar"); return { shown: !b.hidden, retiring: b.classList.contains("retiring"), q: document.getElementById("confirmbar-q").textContent.slice(0, 10), yes: document.getElementById("confirmbar-yes").disabled, no: document.getElementById("confirmbar-no").disabled }; })()`);
  ok(after7.shown && !after7.retiring && !after7.yes && !after7.no && after7.q.startsWith(TITLE.slice(0, 5)), "① 等 7 秒条仍在、钮仍可点(不自动作罢)", after7);
  await clickBar("no");
  await sleep(1200);
  ok(!(await callsSince(m)).includes("set_doc"), "① 〔先不用〕→ 没发 set_doc", await callsSince(m));
  ok(!(await isDoc(A, a1)), "① 〔先不用〕→ 条目仍是随记");
  ok(!(await acked(A)), "① 〔先不用〕→ 账上没记甲", await ack());

  m = await mark();
  await cardAct(a1, "expand");
  await waitFor(`!document.getElementById("confirmbar").hidden`, "混版提醒再弹");
  ok(isSkewBar(await barState()), "② 再展开 → 再弹");
  await clickBar("yes");
  await waitFor(`(window.__zj878.calls.slice(${m})).includes("set_doc")`, "set_doc 发出");
  await sleep(600);
  ok(await isDoc(A, a1), "② 〔仍然使用〕→ 成了长文");
  ok(await acked(A), "② 〔仍然使用〕→ 账上记了甲", await ack());
  await shot("02-expanded");

  m = await mark();
  await openReaderMore(a1);
  await clickDocsText("收回随记");
  ok(await noBarFor(), "③ 甲里收回随记 → 不再弹");
  await waitFor(`(window.__zj878.calls.slice(${m})).includes("set_doc")`, "收回那一发 set_doc");
  await sleep(600);
  ok(!(await isDoc(A, a1)), "③ 收回成随记");

  await reloadInto(A);
  await composeDoc("");
  ok(await noBarFor(), "③ 甲里从「记一笔」新建长文 → 不弹");
  await waitFor(`document.body.classList.contains("doc-editing")`, "长文编辑器开了");
  await ev(`window.__zhujianHandleBack(), true`); // 空篇离开 = 不建

  // ④ 丙(配了、没看过):新建长文 → 弹;〔先不用〕→ 编辑器没开、字还在
  await inv("activate_space", { spaceId: C });
  await reloadInto(C);
  await composeDoc("混版验收 丙的草稿");
  await waitFor(`!document.getElementById("confirmbar").hidden`, "丙新建长文弹混版提醒");
  ok(isSkewBar(await barState()), "④ 丙(配了、没看过)从「记一笔」新建长文 → 弹");
  await shot("03-compose-ask");
  await clickBar("no");
  await sleep(800);
  ok(!(await ev(`document.body.classList.contains("doc-editing")`)), "④ 〔先不用〕→ 编辑器没开");
  ok((await ev(`document.getElementById("text").value`)) === "混版验收 丙的草稿", "④ 〔先不用〕→ 框里的字还在");
  ok(!(await acked(C)), "④ 账上没记丙");
  // 返回键 = 先不用:条收、不记、记一笔层原地不动
  await ev(`(document.getElementById("compose-doc").click(), true)`);
  await waitFor(`!document.getElementById("confirmbar").hidden`, "丙再点「长文」再弹");
  const backed = await ev(`window.__zhujianHandleBack()`);
  await sleep(500);
  const afterBack = await ev(`({ bar: !document.getElementById("confirmbar").hidden, compose: document.getElementById("compose-card").classList.contains("open"), editing: document.body.classList.contains("doc-editing") })`);
  ok(backed === true && !afterBack.bar && afterBack.compose && !afterBack.editing, "④ 返回键 → 条收了、记一笔层还在、编辑器没开", { backed, ...afterBack });
  ok(!(await acked(C)), "④ 返回键也不记");
  await ev(`(() => { const ta = document.getElementById("text"); ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // ⑤ 乙(没配):展开 → 不弹、照发(正面对照:记录器真记得到 set_doc)
  await inv("activate_space", { spaceId: B });
  const b1id = await inv("capture_idea", { spaceId: B, content: "混版验收 乙一" });
  await reloadInto(B);
  m = await mark();
  await cardAct(b1id, "expand");
  ok(await noBarFor(), "⑤ 乙(没配同步)展开 → 不弹");
  await waitFor(`(window.__zj878.calls.slice(${m})).includes("set_doc")`, "乙那一发 set_doc(正面对照:记录器记得到)");
  await sleep(600);
  ok(await isDoc(B, b1id), "⑤ 乙里成了长文");
  ok(!(await acked(B)), "⑤ 没配同步的空间不记账");

  // ⑥ 乙的长文移到丙(目标配了、没看过)
  await reloadInto(B);
  await openReaderMore(b1id);
  await clickDocsText("移动");
  await waitFor(`[...document.querySelectorAll("#docs-body button")].some((b) => b.textContent.trim() === "${PREFIX}丙")`, "目标空间那一枚");
  m = await mark();
  await clickDocsText(`${PREFIX}丙`);
  await waitFor(`!document.getElementById("confirmbar").hidden`, "移动两拍");
  ok(!isSkewBar(await barState()), "⑥ 先是「移到…?」两拍", await barState());
  await clickBar("yes");
  await waitFor(`(() => { const b = document.getElementById("confirmbar"); return !b.hidden && document.getElementById("confirmbar-q").textContent.startsWith(${J(TITLE)}); })()`, "按目标空间弹混版提醒");
  ok(isSkewBar(await barState()), "⑥ 移到丙(配了同步)→ 按目标空间弹");
  await shot("04-move-ask");
  await clickBar("no");
  await sleep(1000);
  ok(!(await callsSince(m)).includes("move_item_to_space"), "⑥ 〔先不用〕→ 没发 move_item_to_space", await callsSince(m));
  ok(await isDoc(B, b1id), "⑥ 〔先不用〕→ 长文还在乙");
  await clickDocsText(`${PREFIX}丙`);
  await waitFor(`!document.getElementById("confirmbar").hidden`, "移动两拍(第二趟)");
  await clickBar("yes");
  await waitFor(`(() => { const b = document.getElementById("confirmbar"); return !b.hidden && document.getElementById("confirmbar-q").textContent.startsWith(${J(TITLE)}); })()`, "混版提醒(第二趟)");
  await clickBar("yes");
  await waitFor(`(window.__zj878.calls.slice(${m})).includes("move_item_to_space")`, "move_item_to_space 发出");
  await sleep(1200);
  ok(!(await isDoc(B, b1id)), "⑥ 〔仍然使用〕→ 移走了(乙里没了)");
  await inv("activate_space", { spaceId: C }); // 读命令只认前台空间
  ok((await inv("list_docs", { spaceId: C })).some((d) => d.content === "混版验收 乙一"), "⑥ 丙里是长文");
  ok(await acked(C), "⑥ 账上记了丙(目标)", await ack());

  // B. skew:回甲(配了、连着本机 syncd),假造 sync_status.skew = true
  await inv("activate_space", { spaceId: A });
  await reloadInto(A);
  await waitFor(`document.getElementById("sync-dot").className.includes("online")`, "甲连上本机 syncd", 20000);
  await ev(`(sessionStorage.setItem("zj878.fakeSkew", "1"), true)`);
  await reloadInto(A);
  await ev(`document.getElementById("sync-toggle").click()`);
  await waitFor(`document.getElementById("sync-state").textContent.includes("对端版本较新")`, "同步面出 skew 那一行", 20000);
  await sleep(4000); // 连上之后的后台推送也得过一遍(那条来路同样被假造),行不该被冲掉
  const st = await ev(`({ text: document.getElementById("sync-state").textContent, dot: document.getElementById("sync-dot").className })`);
  ok(st.text.includes("对端版本较新:请升级朱简后继续同步。"), "B 同步面出「对端版本较新:请升级朱简后继续同步。」", st.text);
  ok(!st.dot.includes("online"), "B skew 时顶栏圆点不是实心「已连接」", st.dot);
  await shot("05-sync-skew");
  await ev(`(sessionStorage.removeItem("zj878.fakeSkew"), true)`);
  await reloadInto(A);
  await ev(`document.getElementById("sync-toggle").click()`);
  await waitFor(`document.getElementById("sync-dot").className.includes("online")`, "撤掉假造后回到实心「已连接」", 20000);
  await waitFor(`!document.getElementById("sync-state").textContent.includes("对端版本较新") && document.getElementById("sync-state").textContent.length > 0`, "撤掉假造后那一行没了");
  ok(await ev(`!document.getElementById("sync-state").textContent.includes("对端版本较新")`), "B 撤掉假造 → 那一行没了");
} catch (e) {
  ok(false, `跑崩:${e.message}`);
} finally {
  // 收尾:回开跑前那一本、删三个测试空间、还原账
  try {
    await ev(`(sessionStorage.removeItem("zj878.fakeSkew"), true)`);
    if (earlyId !== null) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: earlyId });
    const live = await inv("list_spaces");
    const back = live.find((x) => x.id === home && !made.includes(x.id)) ?? live.find((x) => x.id === "main");
    await inv("activate_space", { spaceId: back.id });
    for (const id of made) await inv("reset_space", { spaceId: id }).catch((e) => ok(false, `删测试空间 ${id}`, String(e)));
    await ev(`(${ackBefore === null ? `localStorage.removeItem(${J(ACK_KEY)})` : `localStorage.setItem(${J(ACK_KEY)}, ${J(ackBefore)})`}, true)`);
    await reloadInto(back.id);
    const left = (await inv("list_spaces")).filter((x) => (x.name ?? "").startsWith(PREFIX));
    ok(left.length === 0, "收尾:测试空间清干净", left.map((x) => x.name));
  } catch (e) {
    ok(false, `收尾失败:${e.message}(手工 reset_space「${PREFIX}…」那几本)`);
  }
  s.close?.();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 格没过`);
process.exit(fails === 0 ? 0 : 1);
