// 长文第 4b 格(真机 / 端到端验收,longform-plan §7)三端共用的驱动形资产:桌面隔离实例、安卓真机、鸿蒙
// (真机或 DevEco 模拟器)跑同一份判据,只在「怎么走到阅读页 / 历史页」那几步按端分叉。
//
// 分组(`--only a,b`,缺省全跑;draft 两步要在中间杀进程,单独点名):
//   sec    渲染与安全:同一份「合法语法 + 恶意文本」长文,在阅读页 / 预览 / 历史比对三处画;观测 DOM、网络、导航、
//          非预期 IPC 四样。⭐ 观测装置先过阴性对照(故意塞一个会发请求的 img、故意调一次 opener、故意导航一个
//          iframe),四样都真响了才判正文那趟的「零」有意义 —— ⛔ 不拿「没弹窗」当证据。
//   links  链接平台行为:点每一个 `.md-link`,opener 收到的恰是规范化的 http/https 地址、一次点一发;
//          鸿蒙(`HAS_BROWSER=false`)应一个 `.md-link` 都没有、点 `.md-link-off` 一发 opener 都不调。
//          opener 那一发在页内被截下(不真开浏览器);真开一次浏览器是手工那格,不在本资产里。
//   hist   历史接口:N 版 × 近 200 KiB(`--versions`,缺省 200)打开目录不传正文(量 IPC 回包字节)、默认比对只取
//          两份、翻页期间新增历史不重不漏、版本身份精确(别条的版本 / 已彻底删除 ⇒ 报错,不换版)。
//   edge   原文精确还原:CRLF / LF、末尾换行、重复行、删加等长与不等长、生僻字 / emoji / 组合音标 / ZWJ / 旗帜
//          在真调用链上选两版比对,从差异 DOM 拼回两侧,逐码元等于写进去的原文;差异里不渲染 Markdown、HTML 字样是字。
//   budget 三种降级在真调用链上:十万空行夹两处改动**不降级**(合块、pre-wrap、能滚到底、选中复制保留换行);
//          全异长文 ⇒ 「没算出逐行差异」+ 两份原文;贵配对 ⇒ 「细化受限」且之前那对已细化;许多小改动段 ⇒ 节点预算降级。
//   stale  过期回包:比对请求在页内被拖慢,其间①换一对版本 ②当前正文被改 ③条目被彻底删除 ④离开历史页 ——
//          屏上只许出现「最后一次选择」对应的、来自同一次读取的两份原文,或明确的错误;旧回包不覆盖新状态。
//   res    资源上界(墙钟,判据见各行):200 KiB 合法高密度 Markdown 阅读页首画 / 预览,两份 200 KiB 最贵比对族。
//   draftA 草稿与保存的前半:编辑器里敲字、停笔落本机草稿 —— 跑完由人(或调用方)**真杀进程**再起;
//          ⚠ 安卓上跑完先等 ≥ 2 s 再杀:WebView 的 localStorage 批量落盘,紧跟着杀会丢那一代草稿(4b 实测,读数在 progress-log);
//   draftB 后半:重开后阅读页明说「有一份没保存的草稿」,点「接着改」恢复原字、保存落一版、草稿键清掉。
//
// ⛔ **会写库**。只动自己种的条目(题目带「4b验收」),每组收尾 archive + purge;`draftA` 留一条给 `draftB`。
//    跑在会同步的空间里,种的条目与墓碑会同步出去 ⇒ 真机上先确认当前空间是测试空间(`--allow-synced` 才放行)。
//
// 跑法:
//   node scripts/cdp-acceptance-docs-4b.mjs --target desktop --port 9233 [--only sec,links]
//   node scripts/cdp-acceptance-docs-4b.mjs --target android --port 9222 --allow-synced …
//   node scripts/cdp-acceptance-docs-4b.mjs --target ohos    --port 9230 …
// 退出码 0 = 全过。读数(字节、毫秒)原样打印,进 progress-log。

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const TARGET = arg("--target");
if (!["desktop", "android", "ohos"].includes(TARGET)) throw new Error("--target desktop|android|ohos");
const PHONE = TARGET !== "desktop";
const PORT = Number(arg("--port", PHONE ? 9222 : 9233));
const ONLY = (arg("--only") ?? "sec,links,hist,edge,budget,stale,res").split(",");
const VERSIONS = Number(arg("--versions", 200));
const R = PHONE ? "#docs-body" : ".v-docs";
const LOADING = "读取中…";
const BACK = PHONE ? "← 正文" : "← 回到正文";
const TAG = "4b验收";

// ---- CDP(带事件分发;scripts/lib/cdp.mjs 那份只有一问一答)----------------------------------
async function pickPage() {
  const ts = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page");
  const t = ts.find((x) => /notebook\.html/.test(x.url)) ?? ts.find((x) => /localhost\/?$/.test(x.url)) ?? ts[0];
  if (!t) throw new Error(`:${PORT} 上没有页面`);
  return t;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await pickPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("连不上 " + page.webSocketDebuggerUrl));
});
let seq = 0;
const pending = new Map();
const handlers = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else for (const h of handlers) h(m.method, m.params);
};
const send = (method, params = {}, ms = 120000) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error("CDP 超时 " + method))), ms);
  });
async function ev(expr, ms = 120000) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.exceptionDetails) throw new Error("页内抛错:" + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}
const J = JSON.stringify;

let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} [${TARGET}] ${what}${extra !== undefined ? "  " + J(extra) : ""}`);
  return cond;
};
const note = (what, extra) => console.log(`· [${TARGET}] ${what}${extra !== undefined ? "  " + J(extra) : ""}`);
async function waitFor(expr, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return true;
    } catch {
      /* 重画 / 重载途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) return ok(false, `等「${what}」超过 ${ms}ms`);
    await sleep(100);
  }
}

// ---- 协议层观测(与页内观测互相独立)------------------------------------------------------
// 网络:IPC 走 `http://ipc.localhost/<cmd>`(桌面 / 安卓)或 `ipc://localhost/<cmd>`(鸿蒙),资源走 tauri 自己的源;
// 其余任何一发都是外泄。导航:主框架或任何子框架的导航 / 文档内导航 / 开新窗。
const wire = { net: [], nav: [], open: [] };
handlers.push((m, p) => {
  if (m === "Network.requestWillBeSent") wire.net.push(p.request.url);
  else if (m === "Page.frameNavigated") wire.nav.push(["frame", p.frame.parentId ? "child" : "main", p.frame.url]);
  else if (m === "Page.navigatedWithinDocument") wire.nav.push(["within", p.url]);
  else if (m === "Page.frameRequestedNavigation") wire.nav.push(["requested", p.url]);
  else if (m === "Page.windowOpen") wire.open.push(p.url);
});
await send("Network.enable");
await send("Page.enable");
const isOwn = (u) => /^(https?:\/\/(ipc|tauri|asset)\.localhost|ipc:\/\/localhost|tauri:\/\/localhost|asset:\/\/localhost|data:|blob:)/.test(u);
const wireMark = () => ({ net: wire.net.length, nav: wire.nav.length, open: wire.open.length });
const wireSince = (m) => ({
  foreign: wire.net.slice(m.net).filter((u) => !isOwn(u)),
  ipc: wire.net.slice(m.net).filter((u) => /ipc/.test(u)).map((u) => decodeURIComponent(u.replace(/^.*localhost\//, ""))),
  nav: wire.nav.slice(m.nav),
  open: wire.open.slice(m.open),
});

// ---- 页内观测:桌面与鸿蒙包 `window.fetch`(IPC 在调用那一刻取全局 fetch —— 4b 实测;`__TAURI_INTERNALS__.invoke`
// 本身不可写,505),安卓换掉 `window.ipc`(见下)。记下每条命令、回包字节;可按命令拖慢(请求前 / 回包后)或截下 opener。
// ⛔ 包装层自己绝不抛:Tauri 在 fetch 失败时会退到 postMessage,那条路就看不见了。
const INSTALL = `(() => {
  if (window.__zj4b) return "already";
  const o = { gen: Math.random(), calls: [], opener: [], rules: {}, dom: [] };
  window.__zj4b = o;
  const orig = window.fetch.bind(window);
  window.fetch = async function (u, init) {
    const url = String(u);
    const m = /^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/(.*)$/.exec(url);
    if (!m) return orig(u, init);
    const cmd = decodeURIComponent(m[1]);
    const rec = { cmd, t0: performance.now(), reqBytes: typeof init?.body === "string" ? init.body.length : (init?.body?.byteLength ?? 0), resBytes: null, ms: null };
    o.calls.push(rec);
    if (cmd === "plugin:opener|open_url") {
      let a = null;
      try { a = JSON.parse(init.body); } catch {}
      o.opener.push(a && (a.url ?? a.path ?? a));
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } });
    }
    const rule = o.rules[cmd];
    if (rule && rule.stage === "req" && rule.n > 0) { rule.n--; await new Promise((r) => setTimeout(r, rule.ms)); }
    const res = await orig(u, init);
    try {
      const buf = await res.clone().arrayBuffer();
      rec.resBytes = buf.byteLength;
    } catch {}
    if (rule && rule.stage === "res" && rule.n > 0) { rule.n--; await new Promise((r) => setTimeout(r, rule.ms)); }
    rec.ms = performance.now() - rec.t0;
    return res;
  };
  // 安卓那条:Tauri 在安卓上**从不走 fetch**(WebView 读不到 POST 体,ipc-protocol.js 的 canUseCustomProtocol),
  // 一律 「window.ipc.postMessage(JSON 串)」(4b 实测:只包 fetch 时 opener 那一发漏过去、真开了 Chrome)。
  // 包它:记命令、截下 opener(直接回调成功)、请求前拖慢。回包不经这里 ⇒ 安卓上「回包后拖慢」退化成请求前,
  // 回包字节由调用方拿同参数再取一次量。
  if (${TARGET === "android"}) {
    const ipc = window.ipc;
    const origPm = ipc.postMessage.bind(ipc);
    // ⚠ 那个 Java 桥对象吞掉对 postMessage 的赋值(4b 实测),但 window.ipc 本身可换 ⇒ 换成转发壳
    const shell = {};
    const wrapped = function (data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch {}
      if (!msg) return origPm(data);
      const rec = { cmd: msg.cmd, t0: performance.now(), reqBytes: data.length, resBytes: null, ms: null, payload: msg.payload };
      o.calls.push(rec);
      if (msg.cmd === "plugin:opener|open_url") {
        o.opener.push(msg.payload && (msg.payload.url ?? msg.payload.path ?? msg.payload));
        setTimeout(() => window.__TAURI_INTERNALS__.runCallback(msg.callback, null), 0);
        return;
      }
      const rule = o.rules[msg.cmd];
      if (rule && rule.n > 0) { rule.n--; setTimeout(() => origPm(data), rule.ms); return; }
      return origPm(data);
    };
    shell.postMessage = wrapped;
    try { window.ipc = shell; } catch {}
    o.androidWrapped = window.ipc === shell;
  }
  // DOM:整页上任何新加进来的危险元素 / 事件属性 / 可导航属性,都记下(含随即被删的)
  const BAD = /^(IMG|SCRIPT|IFRAME|OBJECT|EMBED|SVG|MATH|STYLE|LINK|META|BASE|FORM|VIDEO|AUDIO|SOURCE|FRAME|FRAMESET|PORTAL)$/;
  const check = (el) => {
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toUpperCase();
    if (BAD.test(tag)) o.dom.push("tag:" + tag);
    for (const at of el.attributes ?? []) {
      const n = at.name.toLowerCase();
      if (n.startsWith("on") || n === "href" || n === "src" || n === "srcset" || n === "srcdoc" || n === "action" || n === "formaction" || n === "xlink:href" || n === "style" && /url\\(|expression/i.test(at.value)) o.dom.push("attr:" + tag + "." + n);
    }
  };
  new MutationObserver((ms) => {
    for (const mu of ms) {
      if (mu.type === "attributes") check(mu.target);
      for (const n of mu.addedNodes) {
        check(n);
        if (n.querySelectorAll) for (const k of n.querySelectorAll("*")) check(k);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  if (o.androidWrapped === false) return "android-ipc-not-wrappable";
  return "installed";
})()`;
// 重载会换一只新的记录器(gen 变)⇒ 记号属于旧那只时从头算
const obs = () => ev(`(() => { const o = window.__zj4b; return { gen: o.gen, calls: o.calls.length, opener: o.opener.length, dom: o.dom.length }; })()`);
const obsSince = (m) =>
  ev(`(() => { const o = window.__zj4b; const z = o.gen === ${m.gen}; return { calls: o.calls.slice(z ? ${m.calls} : 0).map((c) => ({ cmd: c.cmd, resBytes: c.resBytes, reqBytes: c.reqBytes, ms: c.ms && Math.round(c.ms), payload: /revision/.test(c.cmd) ? c.payload : undefined })), opener: o.opener.slice(z ? ${m.opener} : 0), dom: o.dom.slice(z ? ${m.dom} : 0) }; })()`);
const rule = (cmd, stage, ms, n = 1) => ev(`(window.__zj4b.rules[${J(cmd)}] = { stage: ${J(stage)}, ms: ${ms}, n: ${n} }, true)`);
async function install() {
  const r = await ev(INSTALL);
  if (r === "android-ipc-not-wrappable") throw new Error("window.ipc.postMessage 包不上 —— 安卓上看不见 IPC,判据作废");
}
/** 安卓的回包不经包装层:拿同参数再取一次量字节(读命令,确定性)。 */
async function fillBytes(calls) {
  for (const c of calls) if (c.resBytes === null && c.payload) c.resBytes = await ev(`window.__TAURI__.core.invoke(${J(c.cmd)}, ${J(c.payload)}).then((v) => new TextEncoder().encode(JSON.stringify(v)).length)`);
  return calls;
}
const clearRules = () => ev(`(window.__zj4b.rules = {}, true)`);

// ---- 端适配:走到列表 / 阅读页 / 编辑器 / 历史页 -------------------------------------------
let SP = null;
const inv = async (cmd, args = {}) => {
  const r = await ev(`window.__TAURI__.core.invoke(${J(cmd)}, ${J({ spaceId: SP, ...args })}).then((v) => ({ v }), (e) => ({ e: String(e) }))`);
  if ("e" in r) throw new Error(`${cmd}: ${r.e}`);
  return r.v;
};
const created = new Set();
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(1500);
  await waitFor(`document.readyState === "complete" && !!window.__TAURI__`, "重载完成", 30000);
  await sleep(PHONE ? 1200 : 800);
  await install();
}
async function openList() {
  if (PHONE) {
    await reload();
    await waitFor(`!document.querySelector('#bottombar [data-pane="docs"]').hidden`, "底栏「长文」钮显形");
    await ev(`document.querySelector('#bottombar [data-pane="docs"]').click(), true`);
    await waitFor(`!document.getElementById("docs-pane").hidden && !!document.querySelector("#docs-body .doc-card")`, "长文面列表");
  } else {
    await ev(`localStorage.setItem("zhujian.last-view", "docs"), true`);
    await reload();
    await waitFor(`!!document.querySelector(".v-docs .doc-card")`, "长文视图列表");
  }
}
async function openDoc(id, title) {
  await openList();
  const clicked = PHONE
    ? await ev(`(() => { const c = document.querySelector('#docs-body .doc-card[data-doc="${id}"]'); if (!c) return false; c.click(); return true; })()`)
    : await ev(`(() => { const c = [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent === ${J(title)}); if (!c) return false; c.click(); return true; })()`);
  if (!ok(clicked, `列表里找得到「${title}」`)) return false;
  return waitFor(`!!document.querySelector("${R} .doc-page")`, "阅读页");
}
/** 点页头条里文字恰为 `text` 的钮(桌面的钮里还有键帽,取 `.lbl`)。 */
const barBtn = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll("${R} .doc-bar button")].find((x) => (x.querySelector(".lbl")?.textContent ?? x.textContent).trim() === ${J(text)}); if (!b) return false; b.click(); return true; })()`);
const anyBtn = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll("${R} button")].find((x) => x.textContent.trim() === ${J(text)} && !x.hidden); if (!b) return false; b.click(); return true; })()`);
async function openHistory(id, title) {
  if (!(await openDoc(id, title))) return false;
  ok(await barBtn("历史"), "点「历史」");
  await waitFor(`!!document.querySelector("${R} .hv-row")`, "历史目录");
  return waitCompare();
}
const waitCompare = () =>
  waitFor(`(() => { const o = document.querySelector("${R} .hv-out"); return !!o && o.textContent !== "" && o.textContent !== ${J(LOADING)}; })()`, "比对结果", 30000);
/** 选 old = 第 i 行、new = 第 j 行(第 0 行 = 当前,往下越来越旧)。 */
async function pick(i, j) {
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[${j}].querySelectorAll(".hv-pick")[1].click(); rows[${i}].querySelectorAll(".hv-pick")[0].click(); return true; })()`);
  return waitCompare();
}
/** 从差异 DOM 拼回两侧(相等块属两边;删 / 增行各属一边;降级时直接是两份原文)。 */
const readDiff = () =>
  ev(`(() => {
    const out = document.querySelector("${R} .hv-out");
    const d = out.querySelector(".diff");
    const noteEl = document.querySelector("${R} .hv-diff .doc-note:not([hidden]), ${R} > .doc-note:not([hidden])");
    const r = { text: out.textContent, cls: d ? d.className : null, note: noteEl && !noteEl.hidden ? noteEl.textContent : null, hl: out.querySelectorAll(".diff-hl").length, md: out.querySelectorAll("h1,h2,h3,strong,em,a,pre,blockquote,img").length, old: null, neu: null, ws: null, head: document.querySelector("${R} .hv-head")?.textContent ?? null };
    if (!d) return r;
    if (d.classList.contains("diff-raw")) {
      r.old = d.querySelector(".diff-raw-old").textContent;
      r.neu = d.querySelector(".diff-raw-new").textContent;
      r.ws = getComputedStyle(d.querySelector(".diff-raw-old")).whiteSpace;
    } else {
      let a = "", b = "";
      for (const k of d.children) {
        if (k.classList.contains("diff-eq")) { a += k.textContent; b += k.textContent; }
        else if (k.classList.contains("diff-del")) a += k.textContent;
        else if (k.classList.contains("diff-ins")) b += k.textContent;
        else return { ...r, bad: k.className };
      }
      r.old = a; r.neu = b;
      const eq = d.querySelector(".diff-eq") ?? d.firstElementChild;
      r.ws = eq ? getComputedStyle(eq).whiteSpace : null;
    }
    return r;
  })()`);

async function seedDoc(content) {
  const id = await inv("capture_doc", { content });
  created.add(id);
  return id;
}
async function cleanup() {
  const bad = [];
  for (const id of created) {
    try {
      await inv("archive_note", { id });
    } catch {
      /* 已在回收站 / 已删 */
    }
    try {
      await inv("purge_note", { id });
    } catch (e) {
      if (!/不存在|not found/i.test(String(e))) bad.push(id + ":" + e);
    }
  }
  created.clear();
  await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k); return true; })()`);
  return bad;
}
const title = (s) => `# ${TAG}·${s}`;

// ---- 开场 ------------------------------------------------------------------------------
await install();
SP = await ev(`localStorage.getItem("zhujian.last-space") ?? "main"`);
const spaces = await ev(`window.__TAURI__.core.invoke("list_spaces").catch(() => null)`);
const cur = Array.isArray(spaces) ? spaces.find((s) => s.id === SP) : null;
note("空间", { SP, name: cur?.name ?? null, configured: cur?.configured ?? null, ua: await ev("navigator.userAgent") });
if (cur?.configured && !argv.includes("--allow-synced")) throw new Error(`空间 ${SP} 在同步(configured),种的条目会同步出去 —— 换测试空间或带 --allow-synced`);
const leftovers = (await inv("list_docs")).filter((d) => d.content.includes(TAG) && d.id !== arg("--draft-id"));
if (leftovers.length) {
  note("上一趟残留,先清", leftovers.length);
  for (const d of leftovers) created.add(d.id);
  await cleanup();
}

// ======================================================================================
// sec + links
// ======================================================================================
const EVIL = [
  title("渲染与安全"),
  "## 二级标题",
  "### 三级标题",
  "",
  "段落里 **粗体**、*斜体*、`行内码`,链接 [官网](https://zhujian.app) 与裸地址 https://example.com/a?b=1&c=2 ,还有 [中文域名](https://例子.测试/路径)。",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "- [ ] 待办甲",
  "- [x] 待办乙",
  "",
  "> 引用一句",
  "",
  "---",
  "",
  "```html",
  '<script>window.__pwned = "fence"</script>',
  "```",
  "",
  '<img src="http://127.0.0.1:9/evil-img.png" onerror="window.__pwned=\'img\'">',
  '<script>window.__pwned = "script"</script>',
  '<iframe src="http://127.0.0.1:9/evil-frame"></iframe>',
  '<svg onload="window.__pwned=\'svg\'"><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<a href="http://127.0.0.1:9/evil-a">原始 a 标签</a> <style>body{display:none}</style> <base href="http://127.0.0.1:9/"> <meta http-equiv="refresh" content="0;url=http://127.0.0.1:9/">',
  '<form action="http://127.0.0.1:9/f"><button formaction="http://127.0.0.1:9/g">表单</button></form>',
  "![嵌图语法](http://127.0.0.1:9/evil-md-img.png)",
  "[脚本链接](javascript:window.__pwned='js') [大小写](JaVaScRiPt:alert(1)) [数据](data:text/html,<script>alert(1)</script>) [文件](file:///C:/Windows/win.ini)",
  "[邮件里嵌 https](mailto:a@x?body=https://evil.example/x) [电话](tel:10086) [带空格](https://ok.example/a b)",
  "[控制字符](https://ok\u0001.example/) [链接文字里有 <b>HTML</b>](https://zhujian.app/t) &lt;实体&gt; &#60;img&#62;",
  "图1 图999999999999 [图2](https://zhujian.app/i)",
  "```",
  "未闭合的围栏 <img src=x onerror=alert(1)>",
].join("\n");
const EVIL2 = EVIL.replace("引用一句", "引用两句 <b>加粗?</b>");

if (ONLY.includes("sec") || ONLY.includes("links")) {
  console.log(`\n=== sec / links ===`);
  const id = await seedDoc(EVIL);
  await inv("edit_note", { id, content: EVIL2 });
  // 阴性对照:四样观测各故意触发一次,必须都响
  await openList();
  {
    const w0 = wireMark();
    const o0 = await obs();
    await ev(`(() => { const d = document.createElement("div"); d.id = "zj4b-nc"; d.innerHTML = '<img src="http://127.0.0.1:9/zj4b-nc.png" onerror="window.__zj4bNC = 1">'; document.body.append(d); return true; })()`);
    await ev(`window.__TAURI__.core.invoke("plugin:opener|open_url", { url: "https://zj4b.invalid/nc" }).then(() => true, (e) => String(e))`);
    // CDP 那一路:opener 被页内截下、到不了网络层 ⇒ 拿一发无害的读命令证这一路看得见 IPC
    await ev(`window.__TAURI__.core.invoke("list_docs", { spaceId: ${J(SP)} }).then(() => true)`);
    await ev(`(() => { const f = document.createElement("iframe"); f.id = "zj4b-ncf"; f.style.display = "none"; f.srcdoc = "<p>x</p>"; document.body.append(f); return true; })()`);
    await sleep(1500);
    const nc = { ...(await obsSince(o0)), ...wireSince(w0), ran: await ev(`window.__zj4bNC === 1`) };
    await ev(`(() => { document.getElementById("zj4b-nc")?.remove(); document.getElementById("zj4b-ncf")?.remove(); delete window.__zj4bNC; return true; })()`);
    ok(nc.dom.some((x) => x === "tag:IMG") && nc.dom.some((x) => x === "attr:IMG.onerror"), "阴性对照·DOM 观测:故意塞的 img + onerror 被记下", nc.dom);
    ok(nc.foreign.some((u) => u.includes("zj4b-nc.png")), "阴性对照·网络观测(CDP):那张 img 的外发请求被看见", nc.foreign);
    ok(nc.ran === true, "阴性对照·那段 onerror 真执行了(证明正文那趟若不执行不是因为环境不跑脚本)");
    ok(nc.opener.includes("https://zj4b.invalid/nc"), "阴性对照·IPC 观测:故意调的 opener 被页内截下", nc.opener);
    if (TARGET === "android") note("安卓的 IPC 不走网络层(postMessage),CDP 那一路看不见 IPC —— 只剩页内那一路", nc.ipc);
    else ok(nc.ipc.includes("list_docs") && !nc.ipc.some((c) => c.startsWith("plugin:opener")), "阴性对照·IPC 观测(CDP 独立一路)看得见命令;被截下的 opener 没到网络层(不会真开浏览器)", nc.ipc);
    ok(nc.nav.some((n) => n[0] === "frame" && n[1] === "child"), "阴性对照·导航观测:故意建的 iframe 导航被看见", nc.nav);
  }
  // 正文那趟:阅读页 → 预览 → 历史比对(恶意版 vs 改过一句的恶意版)
  const w0 = wireMark();
  await ev(`delete window.__pwned, true`);
  if (await openDoc(id, `${TAG}·渲染与安全`)) {
    const o0 = await obs();
    const w1 = wireMark();
    const body = await ev(`(() => {
      const p = document.querySelector("${R} .doc-page .md");
      const q = (s) => p.querySelectorAll(s).length;
      return { h1: q("h1"), h2: q("h2"), h3: q("h3"), strong: q("strong"), em: q("em"), code: q("code.md-code"), pre: q("pre"), ol: q("ol"), ul: q("ul"), task: q("li.md-task"), quote: q("blockquote"), hr: q("hr"),
        link: q(".md-link"), linkOff: q(".md-link-off"), imgRef: q(".img-ref"),
        bad: [...p.querySelectorAll("img,script,iframe,svg,style,base,meta,form,object,embed,link,video,audio")].map((n) => n.tagName),
        attrs: [...p.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.name)).filter((a) => !["class", "type", "disabled", "aria-label", "aria-pressed", "title", "tabindex", "role", "start", "aria-checked"].includes(a)),
        rawKept: ["<img src=", "<script>", "<iframe", "onerror", "javascript:", "mailto:", "file:///", "<b>HTML</b>", "&lt;实体&gt;", "未闭合的围栏"].filter((s) => !p.textContent.includes(s)),
        degraded: !!document.querySelector("${R} .doc-body > .doc-note") };
    })()`);
    ok(body.h1 === 1 && body.h2 === 1 && body.h3 === 1 && body.strong >= 1 && body.em >= 1 && body.code >= 1 && body.pre >= 2 && body.ol === 1 && body.task === 2 && body.quote === 1 && body.hr === 1, "阅读页·合法语法真被认出(标题三级 / 粗斜 / 行内码 / 围栏 / 有序无序 / 方框 / 引用 / 分隔线)", body);
    ok(!body.degraded, "阅读页·没有整篇降级成原文");
    ok(body.bad.length === 0, "阅读页·正文区一个危险元素都没有", body.bad);
    ok(body.attrs.length === 0, "阅读页·正文区没有 href / src / on* / style 一类属性", body.attrs);
    ok(body.rawKept.length === 0, "阅读页·恶意片段作为文字原样还在", body.rawKept);
    ok(PHONE && TARGET === "ohos" ? body.link === 0 && body.linkOff >= 3 : body.link >= 3, `阅读页·链接形:${TARGET === "ohos" ? "鸿蒙只显示文字与地址(.md-link-off),没有可点链接" : "合法 http/https 成 .md-link"}`, { link: body.link, off: body.linkOff });
    note("阅读页 · 认出的链接个数", { link: body.link, off: body.linkOff, imgRef: body.imgRef });

    if (ONLY.includes("links")) {
      // 点每一个可点链接 / 不可点链接,opener 收到什么
      const lk = await ev(`(async () => {
        const out = [];
        const before = window.__zj4b.opener.length;
        for (const a of document.querySelectorAll("${R} .doc-page .md .md-link, ${R} .doc-page .md .md-link-off")) {
          const n0 = window.__zj4b.opener.length;
          a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 250));
          out.push({ cls: a.className, text: a.textContent, got: window.__zj4b.opener.slice(n0), href: a.getAttribute("href") });
        }
        return { out, total: window.__zj4b.opener.length - before, url: location.href };
      })()`);
      if (TARGET === "ohos") {
        ok(lk.total === 0, "鸿蒙·点不可点链接 opener 一发都不调", lk.out);
      } else {
        const links = lk.out.filter((x) => x.cls === "md-link");
        ok(links.length >= 3 && links.every((x) => x.got.length === 1), "每点一个链接 opener 恰收到一发", links.map((x) => [x.text, x.got]));
        ok(links.every((x) => x.got.every((u) => /^https?:\/\//.test(u))), "opener 收到的全是 http/https", links.flatMap((x) => x.got));
        ok(links.every((x) => x.href === null), "链接元素没有 href(目标只在点击闭包里)");
        const want = ["https://zhujian.app/", "https://example.com/a?b=1&c=2", "https://xn--fsqu00a.xn--0zwm56d/%E8%B7%AF%E5%BE%84"];
        const got = links.flatMap((x) => x.got);
        ok(want.every((u) => got.includes(u)), "规范化地址:官网补斜杠、裸地址原样、中文域名转 punycode + 路径百分号", got);
        ok(!got.some((u) => /javascript|data:|file:|mailto|tel:/i.test(u)), "非法协议一个都没进 opener");
      }
      ok(lk.url === (await ev("location.href")), "点链接没让页面导航");
    }

    ok(await barBtn("编辑"), "进编辑器") ;
    await waitFor(`!!document.querySelector("${R} textarea.doc-area")`, "编辑器");
    ok(await anyBtn("预览"), "切预览");
    await sleep(500);
    const pv = await ev(`(() => { const p = document.querySelector("${R} .doc-preview, ${R} .doc-editor .md"); const m = p && (p.matches(".md") ? p : p.querySelector(".md")); return m ? { h1: m.querySelectorAll("h1").length, bad: m.querySelectorAll("img,script,iframe,svg,style,base,meta,form").length, href: m.querySelectorAll("[href],[src]").length, raw: m.textContent.includes("onerror") } : null; })()`);
    ok(pv && pv.h1 === 1 && pv.bad === 0 && pv.href === 0 && pv.raw, "预览·同样认语法、无危险元素、原文在", pv);
    // 离开编辑器(没改字 = 不落版):返回
    ok(await barBtn(BACK), "离开编辑器");
    await waitFor(`!!document.querySelector("${R} .doc-page")`, "回阅读页");
    ok(await barBtn("历史"), "点「历史」");
    await waitFor(`!!document.querySelector("${R} .hv-row")`, "历史目录");
    await waitCompare();
    const hv = await readDiff();
    const pair = await inv("revision_texts", { id, a: "latest", b: "current" });
    ok(hv.old === pair.a.content && hv.neu === pair.b.content, "历史·差异两侧拼回 = 两份原文(逐码元)");
    ok(hv.md === 0, "历史·比对面不渲染 Markdown、不出可导航元素", hv.md);
    ok(hv.text.includes("<img src=") && hv.text.includes("<b>加粗?</b>"), "历史·HTML 字样是字");
    await sleep(1500);
    const o1 = await obsSince(o0);
    const w2 = wireSince(w1);
    const allowed = new Set(["list_docs", "list_revisions", "revision_texts", "list_item_images", "item_images", "comment_counts", "list_comment_counts", "list_topics", "plugin:event|listen", "plugin:event|unlisten", "sync_status"]);
    const cmds = [...new Set(o1.calls.map((c) => c.cmd))];
    note("正文那趟页内看见的命令", cmds);
    ok(o1.dom.length === 0, "正文那趟·整页 DOM 观测零记录(含随即被删的)", o1.dom.slice(0, 10));
    ok(w2.foreign.length === 0, "正文那趟·CDP 网络零外发", w2.foreign);
    ok(w2.nav.length === 0 && w2.open.length === 0, "正文那趟·零导航、零开窗", { nav: w2.nav, open: w2.open });
    ok(!cmds.some((c) => /^plugin:(opener|shell|fs|http|clipboard)/.test(c)) || ONLY.includes("links"), "正文那趟·没有 opener / shell / fs / http / 剪贴板一类命令(links 组主动点的除外)", cmds);
    ok(await ev(`window.__pwned === undefined`), "正文那趟·没有任何一段正文脚本被执行(__pwned 未定义)");
    const unexpected = cmds.filter((c) => !allowed.has(c) && !c.startsWith("plugin:opener"));
    note("白名单外的命令(人看:应只是读命令)", unexpected);
  }
  ok(wireSince(w0).nav.every((n) => n[0] !== "frame" || n[1] !== "main" || /localhost/.test(n[2])), "整组·主框架只在本 app 源里重载");
  ok((await cleanup()).length === 0, "sec·清场");
}

// ======================================================================================
// hist:目录不传正文 / 只取两份 / 翻页不重不漏 / 版本身份
// ======================================================================================
if (ONLY.includes("hist")) {
  console.log(`\n=== hist(${VERSIONS} 版)===`);
  const FILL = "这一行是填充用的正文,长文历史比对的资源验收。\n"; // 每行 UTF-8 约 64 字节
  const big = (v) => {
    const head = `${title("历史接口")}\n\n第 ${v} 版\n\n`;
    const room = 200 * 1024 - 2048 - Buffer.byteLength(head);
    return head + FILL.repeat(Math.floor(room / Buffer.byteLength(FILL)));
  };
  ok(Buffer.byteLength(big(0)) <= 204800 && Buffer.byteLength(big(0)) > 195000, "每版字节数贴着 200 KiB 上限", Buffer.byteLength(big(0)));
  const id = await seedDoc(big(0));
  const t0 = Date.now();
  // 在页内连写,省得每版过一次 CDP(仍是一版一发 edit_note,与用户点保存同一条命令)
  const wrote = await ev(`(async () => {
    const FILL = ${J(FILL)}, head = (v) => ${J(title("历史接口"))} + "\\n\\n第 " + v + " 版\\n\\n";
    const enc = new TextEncoder();
    const big = (v) => { const h = head(v); const room = 200 * 1024 - 2048 - enc.encode(h).length; return h + FILL.repeat(Math.floor(room / enc.encode(FILL).length)); };
    for (let v = 1; v <= ${VERSIONS}; v++) await window.__TAURI__.core.invoke("edit_note", { spaceId: ${J(SP)}, id: ${J(id)}, content: big(v) });
    return ${VERSIONS};
  })()`, 1800000);
  note(`写入 ${wrote} 版用时`, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const o0 = await obs();
  await openHistory(id, `${TAG}·历史接口`);
  await sleep(500);
  let o1 = await obsSince(o0);
  await fillBytes(o1.calls);
  const cat = o1.calls.filter((c) => c.cmd === "list_revisions");
  const tx = o1.calls.filter((c) => c.cmd === "revision_texts");
  note("打开历史页的 IPC", o1.calls.filter((c) => /revision/.test(c.cmd)));
  ok(cat.length === 1 && cat[0].resBytes < 16 * 1024, `打开目录 = 一发 list_revisions、回包 < 16 KiB(${VERSIONS} 版 × 200 KiB 的正文一个字节都没跟来)`, cat.map((c) => c.resBytes));
  ok(tx.length === 1 && tx[0].resBytes > 2 * 195000 && tx[0].resBytes < 3 * 204800, "默认比对 = 一发 revision_texts、回包恰两份全文", tx.map((c) => c.resBytes));
  const rows0 = await ev(`document.querySelectorAll("${R} .hv-row").length`);
  ok(rows0 === 51, "首屏目录 = 当前 + 50 版", rows0);
  // 换一对:old = 最旧可见那一行
  const o2 = await obs();
  await pick(50, 25);
  o1 = await obsSince(o2);
  ok(o1.calls.filter((c) => c.cmd === "revision_texts").length >= 1 && o1.calls.filter((c) => c.cmd === "list_revisions").length === 0, "换一对版本 = 只多取两份,不重拉目录", o1.calls.map((c) => [c.cmd, c.resBytes]));
  const d1 = await readDiff();
  ok(/第 \d+ 版/.test(d1.old ?? "") && d1.hl >= 1, "换的那一对真比出来了(字级高亮落在版本号上)", { hl: d1.hl });
  // 翻页期间新增历史:先翻第一页的游标,中途再存 3 版,再翻 —— 不重不漏
  const cat1 = await inv("list_revisions", { id, before: null });
  const seen = new Set(cat1.entries.map((e) => e.revision_id));
  const all0 = cat1.total;
  for (let v = 1; v <= 3; v++) await inv("edit_note", { id, content: big(VERSIONS + v) });
  let cursor = cat1.entries.at(-1).revision_id;
  let dup = 0;
  let pages = 1;
  for (let more = cat1.has_more; more; ) {
    const p = await inv("list_revisions", { id, before: cursor });
    pages++;
    for (const e of p.entries) {
      if (seen.has(e.revision_id)) dup++;
      seen.add(e.revision_id);
      if (e.revision_id >= cursor) dup++;
    }
    more = p.has_more;
    if (p.entries.length) cursor = p.entries.at(-1).revision_id;
    if (pages > 20) break;
  }
  const after = await inv("list_revisions", { id, before: null });
  ok(dup === 0 && seen.size === all0, `翻页期间新增 3 版:翻完恰是开始那一刻的 ${all0} 版,零重复零遗漏(共 ${pages} 页)`, { dup, seen: seen.size, all0 });
  ok(after.total === all0 + 3 && after.entries.slice(0, 3).every((e) => !seen.has(e.revision_id)), "新增的 3 版在下一次打开时出现在最前面", after.total);
  // UI 的「更多」:点到底,行数 = total + 1,id 不重复
  await openHistory(id, `${TAG}·历史接口`);
  for (let k = 0; k < 10; k++) {
    const more = await ev(`(() => { const b = [...document.querySelectorAll("${R} button")].find((x) => x.classList.contains("hist-more") || x.classList.contains("hv-more")); if (!b || b.hidden) return false; b.click(); return true; })()`);
    if (!more) break;
    await sleep(600);
  }
  const rowsAll = await ev(`document.querySelectorAll("${R} .hv-row").length`);
  ok(rowsAll === after.total + 1, `UI「更多」翻到底:行数 = ${after.total} 版 + 当前`, rowsAll);
  // 版本身份精确:别条的版本 ⇒ 报错;彻底删除后 ⇒ 报错
  const other = await seedDoc(`${title("别条")}\n\n一`);
  await inv("edit_note", { id: other, content: `${title("别条")}\n\n二` });
  const otherRev = (await inv("list_revisions", { id: other, before: null })).entries[0].revision_id;
  const cross = await inv("revision_texts", { id, a: { rev: otherRev }, b: "current" }).then(() => "ok", (e) => String(e));
  ok(cross !== "ok", "拿别条的 revision_id 取本条 ⇒ 报错,不换成别的版本", cross);
  const exact = await inv("revision_texts", { id, a: { rev: cat1.entries[7].revision_id }, b: { rev: cat1.entries[7].revision_id } });
  ok(exact.a.revision_id === cat1.entries[7].revision_id && exact.a.content === exact.b.content, "指定哪一版就精确返回哪一版");
  await inv("archive_note", { id: other });
  await inv("purge_note", { id: other });
  created.delete(other);
  const gone = await inv("revision_texts", { id: other, a: { rev: otherRev }, b: "current" }).then(() => "ok", (e) => String(e));
  ok(gone !== "ok", "条目彻底删除后取它的版本 ⇒ 明确报错", gone);
  ok((await cleanup()).length === 0, "hist·清场");
}

// ======================================================================================
// edge:原文精确还原
// ======================================================================================
if (ONLY.includes("edge")) {
  console.log(`\n=== edge ===`);
  const h = title("原文还原");
  const V = [
    `${h}\n甲`,
    `${h}\n甲\n`, // 只差末尾换行
    `${h}\r\n甲\r\n乙\r\n`, // CRLF
    `${h}\n甲\n乙\n`, // LF(与上一版只差行结束符)
    `${h}\nx\nx\nx\n同\nx\n`, // 重复行
    `${h}\nx\nx\n同\nx\nx\n`,
    `${h}\n一行\n二行\n三行\n`, // 删加等长(逐行配对)
    `${h}\n一列\n二列\n三列\n`,
    `${h}\n一列\n四五六七八九\n`, // 不等长(整行删加)
    `${h}\n生僻 𠀀𪚥𰻞 emoji 😀🙂 组合 é ñ̃ ZWJ 👨‍👩‍👧‍👦 旗 🇨🇳🇯🇵 肤色 👍🏽\n<b>HTML 字样</b> **星号** # 井号\n`,
    `${h}\n生僻 𠀀𪚥𰻝 emoji 😀🙃 组合 é ñ̃ ZWJ 👨‍👩‍👧 旗 🇨🇳🇺🇸 肤色 👍🏿\n<b>HTML 字样!</b> **星号** # 井号\n`,
  ];
  const id = await seedDoc(V[0]);
  for (const v of V.slice(1)) await inv("edit_note", { id, content: v });
  // 目录最新在前:第 0 行 = 当前(V 末),第 k 行 = V[V.length-1-k]
  await openHistory(id, `${TAG}·原文还原`);
  const rowOf = (vi) => V.length - 1 - vi;
  for (let vi = 1; vi < V.length; vi++) {
    await pick(rowOf(vi - 1), rowOf(vi));
    const d = await readDiff();
    const exact = d.old === V[vi - 1] && d.neu === V[vi];
    ok(exact, `V${vi - 1} → V${vi}:差异两侧拼回 = 写进去的原文(逐码元)`, exact ? { hl: d.hl, ws: d.ws } : { old: J(d.old), neu: J(d.neu), want: [J(V[vi - 1]), J(V[vi])], note: d.note });
    ok(d.md === 0, `V${vi - 1} → V${vi}:不渲染 Markdown`);
    if (vi === 1 || vi === 3) ok(d.cls === "diff" && (d.text.length > 0), `V${vi - 1} → V${vi}:只差行结束符也报出差异(不误报「没有变化」)`, d.cls);
    if (vi === 7) ok(d.hl >= 3, "删加等长 ⇒ 逐行配对、字级高亮", d.hl);
    if (vi === 10) {
      // 代理对不被劈开:高亮片段里没有落单的代理码元
      const lone = await ev(`[...document.querySelectorAll("${R} .diff-hl")].some((n) => /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/.test(n.textContent))`);
      ok(!lone, "生僻字 / emoji 的高亮片段里没有落单的代理码元(不乱码)");
      note("组合符 / ZWJ / 旗帜那几处的高亮片段(本期不承诺按字素簇整体高亮,原样记)", await ev(`[...document.querySelectorAll("${R} .diff-hl")].map((n) => n.textContent)`));
    }
  }
  note("空文本:产品不许存空正文(edit_note 拒「内容不能为空」),真调用链上造不出空的一侧;空串那几例在 scripts/test-diff.mjs 单测里");
  ok((await cleanup()).length === 0, "edge·清场");
}

// ======================================================================================
// budget:三种降级 + 不该降级的那一个
// ======================================================================================
if (ONLY.includes("budget")) {
  console.log(`\n=== budget ===`);
  const h = title("降级");
  const blank = "\n".repeat(100000);
  const distinct = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}\n`).join("");
  const cp = (base) => Array.from({ length: 1999 }, (_, i) => String.fromCodePoint(base + i)).join("");
  const many = (ch) => Array.from({ length: 400 }, (_, i) => "同\n" + Array.from({ length: 10 }, () => "a" + ch).join("") + i + "\n").join("");
  const cases = [
    { name: "十万空行夹两处改动", a: `${h}\na\n${blank}b\n`, b: `${h}\nA\n${blank}B\n`, want: "ok" },
    { name: "全异长文(行级 D 到顶)", a: `${h}\n${distinct(3000, "a")}`, b: `${h}\n${distinct(3000, "b")}`, want: "degraded" },
    { name: "贵配对(字级工作预算)", a: `${h}\na1\n${cp(0x4e00)}\nb1\n`, b: `${h}\na2\n${cp(0x6000)}\nb2\n`, want: "limited" },
    { name: "许多小改动段(输出节点预算)", a: `${h}\n${many("b")}`, b: `${h}\n${many("c")}`, want: "degraded" },
  ];
  for (const c of cases) {
    ok(Buffer.byteLength(c.a) <= 204800 && Buffer.byteLength(c.b) <= 204800, `${c.name}:两版都在 200 KiB 内`, [Buffer.byteLength(c.a), Buffer.byteLength(c.b)]);
    const id = await seedDoc(c.a);
    await inv("edit_note", { id, content: c.b });
    await openHistory(id, `${TAG}·降级`);
    const d = await readDiff();
    const exact = d.old === c.a && d.neu === c.b;
    if (c.want === "ok") {
      ok(d.cls === "diff" && !d.note, `${c.name}:不降级`, { cls: d.cls, note: d.note });
      const nodes = await ev(`document.querySelector("${R} .hv-out .diff").querySelectorAll("*").length`);
      ok(nodes <= 20, `${c.name}:相等行合块,元素数不跟行数走`, nodes);
      ok(d.ws === "pre-wrap", `${c.name}:相等块 white-space = pre-wrap(空行不被折叠)`, d.ws);
      const sc = await ev(`(() => { let e = document.querySelector("${R} .hv-out"); while (e && e !== document.body && !(e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement; const s = e === document.body || !e ? document.scrollingElement : e; s.scrollTop = s.scrollHeight; return { sh: s.scrollHeight, st: Math.round(s.scrollTop), ch: s.clientHeight, last: document.querySelector("${R} .hv-out .diff").lastElementChild.getBoundingClientRect().bottom <= innerHeight + 2 }; })()`);
      ok(sc.sh > 100000 / 4 && sc.st > 0, `${c.name}:能滚到底(十万行确实撑出了高度)`, sc);
      const sel = await ev(`(() => { const d = document.querySelector("${R} .hv-out .diff"); const r = document.createRange(); r.selectNodeContents(d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return { nl: (t.match(/\\n/g) || []).length, len: t.length }; })()`);
      ok(sel.nl >= 100000, `${c.name}:整块选中复制,换行一个不少(≥ 10 万)`, sel);
    } else if (c.want === "degraded") {
      ok(d.cls === "diff diff-raw" && d.note && d.note.includes("没算出逐行差异"), `${c.name}:降级成两份原文,文案是「没算出逐行差异」(不是「全部不同」)`, { cls: d.cls, note: d.note });
      ok(exact, `${c.name}:两份原文逐码元`);
      ok(d.ws === "pre-wrap", `${c.name}:降级那条路径也 pre-wrap`, d.ws);
      const lbl = await ev(`document.querySelectorAll("${R} .hv-rawlbl").length`);
      ok(lbl === 2, `${c.name}:两份原文各有本端小标`, lbl);
    } else {
      ok(d.cls === "diff" && d.note && d.note.includes("细化受限"), `${c.name}:标「细化受限」`, { cls: d.cls, note: d.note });
      ok(exact, `${c.name}:拼回两侧逐码元`);
      const first = await ev(`(() => { const k = document.querySelector("${R} .hv-out .diff").children; return [...k].slice(0, 3).map((x) => [x.className, x.querySelectorAll(".diff-hl").length]); })()`);
      ok(first[0][0] === "diff-eq" || first.some(([c, n]) => c === "diff-del" && n > 0), `${c.name}:贵那对之前的配对行已细化到字`, first);
    }
    created.delete(id);
    await inv("archive_note", { id });
    await inv("purge_note", { id });
  }
  ok((await cleanup()).length === 0, "budget·清场");
}

// ======================================================================================
// stale:过期回包
// ======================================================================================
if (ONLY.includes("stale")) {
  console.log(`\n=== stale ===`);
  const h = title("过期回包");
  const V = [1, 2, 3, 4].map((n) => `${h}\n第${n}版的正文\n`);
  const id = await seedDoc(V[0]);
  for (const v of V.slice(1)) await inv("edit_note", { id, content: v });
  await openHistory(id, `${TAG}·过期回包`);
  // ① 第一次换选择的回包拖 2.5 s,紧接着第二次换(不拖):最后屏上必须是第二次那一对
  await rule("revision_texts", "res", 2500, 1);
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[3].querySelectorAll(".hv-pick")[0].click(); return true; })()`); // old = V0(拖慢)
  await sleep(150);
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[2].querySelectorAll(".hv-pick")[0].click(); return true; })()`); // old = V1(快)
  await sleep(3500);
  let d = await readDiff();
  ok(d.old === V[1] && d.neu === V[3], "① 慢回包晚到也不盖新选择:屏上是 V1 → 当前", { old: d.old, head: d.head });
  // ② 回包拖着时当前正文被改:屏上是那一次读取的同一快照(旧版 = 选的那版,新 = 读那一刻的当前),不是两次读拼起来
  await rule("revision_texts", "res", 2500, 1);
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[3].querySelectorAll(".hv-pick")[0].click(); return true; })()`); // old = V0
  await sleep(300);
  const V4 = `${h}\n第5版(读取中途改的)\n`;
  await inv("edit_note", { id, content: V4 });
  await sleep(3200);
  d = await readDiff();
  ok(d.old === V[0] && (d.neu === V[3] || d.neu === V4), "② 读取中当前正文变了:旧侧恰是选的那版、新侧是某一次读取的当前,没有错配", { neu: d.neu });
  note("② 新侧取到的是", d.neu === V[3] ? "读取那一刻的当前(改之前)" : "改之后的当前");
  // ③ 请求拖着时条目被彻底删除:到后端时已不在 ⇒ 屏上是明确的错误,不是别的版本
  await rule("revision_texts", "req", 2500, 1);
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[2].querySelectorAll(".hv-pick")[0].click(); return true; })()`);
  await sleep(300);
  await inv("archive_note", { id });
  await inv("purge_note", { id });
  created.delete(id);
  await sleep(3200);
  d = await readDiff();
  ok(d.cls === null && d.old === null && d.text.length > 0 && d.text !== LOADING, "③ 读取中条目被彻底删除:显示错误、不显示任何版本", d.text.slice(0, 80));
  // ④ 回包拖着时离开历史页(回阅读页 / 列表):旧回包不往新页面里画
  const id2 = await seedDoc(V[0]);
  await inv("edit_note", { id: id2, content: V[1] });
  await openHistory(id2, `${TAG}·过期回包`);
  await rule("revision_texts", "res", 2500, 1);
  await ev(`(() => { const rows = [...document.querySelectorAll("${R} .hv-row")]; rows[0].querySelectorAll(".hv-pick")[0].click(); return true; })()`);
  await sleep(200);
  ok(await barBtn(BACK), "④ 读取中离开历史页");
  await sleep(3200);
  const leak = await ev(`({ diff: document.querySelectorAll(".diff").length, page: !!document.querySelector("${R} .doc-page") })`);
  ok(leak.diff === 0 && leak.page, "④ 晚到的回包没有画进阅读页", leak);
  await clearRules();
  ok((await cleanup()).length === 0, "stale·清场");
}

// ======================================================================================
// res:资源上界(墙钟)
// ======================================================================================
if (ONLY.includes("res")) {
  console.log(`\n=== res ===`);
  // 合法高密度:每行都有粗体 / 链接 / 行内码 / 方框,贴着 200 KiB;节点数会撞 8,192 的语法树预算 ⇒ 另配一份
  // 刚好不撞的(量「真画出来」那条路),两份都量。
  const line = (i) => `- [ ] 第${i}项 **粗** \`码\` [链](https://zhujian.app/${i})\n`;
  const fill = (cap) => {
    let s = `${title("资源")}\n\n`, i = 0;
    while (Buffer.byteLength(s + line(i)) <= cap) s += line(i++);
    return s;
  };
  const dense = fill(204800);
  const under = (() => { let s = `${title("资源")}\n\n`; for (let i = 0; i < 500; i++) s += line(i); return s; })();
  for (const [name, text] of [["200 KiB 高密度(撞语法树预算 ⇒ 按原文)", dense], ["约 500 行合法语法(不撞预算、真画)", under]]) {
    const id = await seedDoc(text);
    await openList();
    const t = await ev(`(async () => {
      const c = ${PHONE ? `document.querySelector('#docs-body .doc-card[data-doc="${id}"]')` : `[...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent === ${J(`${TAG}·资源`)})`};
      const t0 = performance.now(); c.click(); const t1 = performance.now();
      let p = null;
      while (!(p = document.querySelector("${R} .doc-page .md"))) { if (performance.now() - t0 > 20000) break; await new Promise((r) => setTimeout(r, 2)); }
      p && p.getBoundingClientRect();
      const t2 = performance.now();
      return { click: Math.round(t1 - t0), mdNodes: p ? p.querySelectorAll("*").length : -1, painted: Math.round(t2 - t0), degraded: !!document.querySelector("${R} .doc-page .md-plain"), nodes: p ? p.querySelectorAll("*").length : -1 };
    })()`);
    note(`阅读页首画 · ${name}`, { bytes: Buffer.byteLength(text), ...t });
    ok(t.nodes >= 0 && t.painted < 3000, `阅读页首画 < 3 s · ${name}`, t.painted);
    await barBtn("编辑");
    await waitFor(`!!document.querySelector("${R} textarea.doc-area")`, "编辑器");
    const pv = await ev(`(() => { const b = [...document.querySelectorAll("${R} button")].find((x) => x.textContent.trim() === "预览"); const t0 = performance.now(); b.click(); document.body.getBoundingClientRect(); return Math.round(performance.now() - t0); })()`);
    note(`预览一次 · ${name}`, pv + " ms");
    ok(pv < 3000, `预览 < 3 s · ${name}`, pv);
    await ev(`(() => { document.querySelector("${R} .doc-bar button").click(); return true; })()`);
    await sleep(800);
  }
  // 比对最贵族(818 定预算时的那两族)在真 app 里:「满屏同一行稀疏替换」与「字级最贵一对」
  const A = [], B = [];
  for (let i = 0; i < 97000; i++) {
    A.push(i % 200 === 0 ? "m" + i : "x");
    B.push(i % 200 === 0 ? "n" + i : "x");
  }
  const fams = [
    ["满屏同一行、稀疏替换(D≈1000)", `${title("资源")}\n${A.join("\n")}`, `${title("资源")}\n${B.join("\n")}`],
    ["字级最贵一对", `${title("资源")}\n${Array.from({ length: 1999 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("")}\n`, `${title("资源")}\n${Array.from({ length: 1999 }, (_, i) => String.fromCodePoint(0x6000 + i)).join("")}\n`],
  ];
  for (const [name, a, b] of fams) {
    const id = await seedDoc(a);
    await inv("edit_note", { id, content: b });
    const o0 = await obs();
    await openHistory(id, `${TAG}·资源`);
    // 再比一次量纯前端那段:old/new 对调两次,取后一次(IPC + 比对 + 画)
    const t = await ev(`(async () => {
      const rows = [...document.querySelectorAll("${R} .hv-row")];
      const out = document.querySelector("${R} .hv-out");
      const once = async (k) => { const t0 = performance.now(); rows[k].querySelectorAll(".hv-pick")[1].click(); while (out.textContent === "" || out.textContent === ${J(LOADING)}) await new Promise((r) => setTimeout(r, 5)); out.getBoundingClientRect(); return performance.now() - t0; };
      const a = await once(1); const b = await once(0);
      return [Math.round(a), Math.round(b)];
    })()`);
    const o1 = await obsSince(o0);
    const ipcMs = o1.calls.filter((c) => c.cmd === "revision_texts").map((c) => c.ms);
    note(`比对 · ${name}`, { 点选到画完ms: t, 其中IPCms: ipcMs, note: (await readDiff()).note });
    ok(Math.max(...t) < 3000, `比对 < 3 s · ${name}`, t);
  }
  ok((await cleanup()).length === 0, "res·清场");
}

// ======================================================================================
// draftA / draftB:真杀进程重启
// ======================================================================================
const DRAFT_DOC = `${title("草稿")}\n\n保存过的正文。\n`;
const DRAFT_TEXT = `${title("草稿")}\n\n保存过的正文。\n杀进程之前敲的字,还没点保存。🙂\n`;
if (ONLY.includes("draftA")) {
  console.log(`\n=== draftA ===`);
  const id = await seedDoc(DRAFT_DOC);
  await openDoc(id, `${TAG}·草稿`);
  ok(await barBtn("编辑"), "进编辑器");
  await waitFor(`!!document.querySelector("${R} textarea.doc-area")`, "编辑器");
  await ev(`(() => { const a = document.querySelector("${R} textarea.doc-area"); a.value = ${J(DRAFT_TEXT)}; a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(1800);
  const key = `zhujian.doc-draft:${SP}:${id}`;
  const d = await ev(`localStorage.getItem(${J(key)})`);
  ok(d !== null && JSON.parse(d).text === DRAFT_TEXT, "停笔 1 秒后草稿落进本机", key);
  ok((await inv("list_docs")).find((x) => x.id === id).content === DRAFT_DOC, "正文还是上次保存那一版(草稿不进库)");
  console.log(`DRAFT_ID=${id}`);
  console.log("→ 现在真杀进程(桌面 taskkill /F、安卓 am force-stop、鸿蒙 aa force-stop),重启后跑 --only draftB --draft-id " + id);
  process.exit(fails ? 1 : 0); // ⛔ 不清场、不离开编辑器(离开 = 落一版,就不是「没保存」了)
}
if (ONLY.includes("draftB")) {
  console.log(`\n=== draftB ===`);
  const id = arg("--draft-id");
  created.add(id);
  const before = (await inv("list_revisions", { id, before: null })).total;
  ok((await inv("list_docs")).find((x) => x.id === id).content === DRAFT_DOC, "重启后正文仍是上次保存那一版(杀进程没让草稿偷偷落库)");
  await openDoc(id, `${TAG}·草稿`);
  const bar = await ev(`(() => { const b = document.querySelector("${R} .doc-draft"); return b ? { text: b.textContent, btns: [...b.querySelectorAll("button")].map((x) => x.textContent.trim()) } : null; })()`);
  ok(bar && bar.text.includes("有一份没保存的草稿") && bar.btns.join("|") === "接着改|丢掉", "阅读页明说「有一份没保存的草稿」,给「接着改 / 丢掉」", bar);
  ok(await anyBtn("接着改"), "点「接着改」");
  await waitFor(`!!document.querySelector("${R} textarea.doc-area")`, "编辑器");
  ok((await ev(`document.querySelector("${R} textarea.doc-area").value`)) === DRAFT_TEXT, "编辑器里恰是杀进程前敲的字(含 emoji)");
  ok(await anyBtn("保存"), "点「保存」");
  await waitFor(`!!document.querySelector("${R} .doc-page")`, "回阅读页");
  await sleep(800);
  ok((await inv("list_docs")).find((x) => x.id === id).content === DRAFT_TEXT, "保存后正文 = 草稿");
  ok((await inv("list_revisions", { id, before: null })).total === before + 1, "落了恰一版");
  ok((await ev(`localStorage.getItem(${J(`zhujian.doc-draft:${SP}:${id}`)})`)) === null, "草稿键清掉了");
  ok((await cleanup()).length === 0, "draft·清场");
}

console.log(`\n${fails ? `✗ ${fails} 格没过` : "✔ 全过"}(${TARGET})`);
ws.close();
process.exit(fails ? 1 : 0);
