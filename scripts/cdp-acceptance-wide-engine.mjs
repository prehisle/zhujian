// 宽屏排法在「这台引擎」上认不认(tablet-plan 格 1–4 + 1b;mobile.md 643「写手机端 CSS 前先问最老那台认不认」)。
//
// 截图台是 WebView2(Edge 13x),证的是排法;真机上的老引擎认不认那几样 CSS,只有在那台上量才算数 —— 手上最老的是
// MuMu 的 Chrome 110,其次是 MatePad 模拟器的 ArkWeb。本资产**只读**(不写库):按宽度用 `Emulation` 改视口,只量 DOM /
// computed style(⛔ 别拿它截横屏图 —— 安卓 629:截出来是原生那张 surface 平铺的废图),量完把视口与所在的面还原。
// 期望值与字体无关(读的是旗子、类、display、栏数、居中与贴底关系),所以同一份判据在哪台上都一样。
//
//  ① 1440×960 随记面:`--wide` / `--tall` 两面旗子都翻成 1(后一面住在套着的 `@media` 里)、body 上 widescreen / tallscreen、
//     导航在顶栏里、顶栏是三栏网格、悬浮 ＋ 离屏底 16 + 屏底安全区(`--nav-h` 里的 `env()` 解得出来;ArkWeb 报手势条高);
//  ② 1440×960 任务面:看板网格的栏数 = `--board-cols`、`#filter-stages` 是 `display: contents`、状态钮藏着(到期钮在);
//  ③ 1440×960 记一笔:屏中浮窗(上下左右居中、宽 ≤ 640、不透明);
//  ④ 800×360:宽屏、不是高屏,记一笔贴屏底;
//  ⑤ 360×640:不是宽屏,导航在屏底。
//
// 跑法:设备先 `node scripts/android-cdp.mjs forward`(鸿蒙走 `hdc fport`,见 skill zhujian-ohos-verify),再
//   CDP_PORT=9222 node scripts/cdp-acceptance-wide-engine.mjs
// 截图台实例:`node scripts/cdp-acceptance-wide-engine.mjs`(默认 :9245)。退出码 0 = 全过。
// ⚠ 前置:别开着面板、别开着层;库里要有至少一条任务(看板才画得出列)—— 没有就报 {error} 退 2。
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const PORT = Number(process.env.CDP_PORT || 9245);
const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const ev = (js) => s.evaluate(js);
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`);
};
async function waitFor(expr, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`等「${what}」超过 ${ms}ms;判据 ${expr}`);
    await sleep(120);
  }
}
const size = async (w, h) => {
  await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 0, mobile: true });
  await sleep(700);
};
const face = async (mode) => {
  if ((await ev(`document.body.dataset.view`)) === mode) return; // ⚠ 别对当前那一面再点一次(= 一步回捕获)
  await ev(`document.querySelector('#bottombar [data-mode="${mode}"]').click(), true`);
  await waitFor(`document.body.dataset.view === "${mode}"`, `进 ${mode}`);
  await sleep(400);
};
const STATE = `(() => {
  const root = getComputedStyle(document.documentElement), head = document.querySelector("body > header");
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
  const fab = document.getElementById("capture-fab");
  // 屏底安全区此刻解出来多少(ArkWeb 报手势条高,安卓只映挖孔、多半是 0)—— ＋ 离屏底 = 16 + 它
  const probe = document.createElement("div"); probe.style.cssText = "position:fixed;height:env(safe-area-inset-bottom, 0px)";
  document.body.append(probe); const sab = Math.round(probe.getBoundingClientRect().height); probe.remove();
  return { W: innerWidth, sab, H: innerHeight, engine: navigator.userAgent.match(/(?:Chrome|ArkWeb)\\/[\\d.]+/g),
    wideVar: root.getPropertyValue("--wide").trim(), tallVar: root.getPropertyValue("--tall").trim(),
    wide: document.body.classList.contains("widescreen"), tall: document.body.classList.contains("tallscreen"),
    navInHead: document.getElementById("bottombar").parentElement === head, nav: R(document.getElementById("bottombar")),
    headDisplay: getComputedStyle(head).display, headTracks: getComputedStyle(head).gridTemplateColumns.split(" ").length,
    fab: fab.getClientRects().length ? R(fab) : null };
})()`;

const origView = await ev(`document.body.dataset.view`);
try {
  if (await ev(`document.body.classList.contains("pane-open") || !!document.querySelector(".compose.open, .cmsheet.open")`)) {
    throw new Error("开着面板或层 —— 先关掉再跑");
  }
  // ---- ① 1440×960 随记面 ---------------------------------------------------------------------
  await face("ideas");
  await size(1440, 960);
  const a = await ev(STATE);
  console.log(`引擎 ${JSON.stringify(a.engine)}`);
  ok(a.wideVar === "1" && a.tallVar === "1", "① 两面旗子都翻了(--tall 住在套着的 @media 里)", { wide: a.wideVar, tall: a.tallVar });
  ok(a.wide && a.tall, "① body 上 widescreen / tallscreen", { wide: a.wide, tall: a.tall });
  ok(a.navInHead && a.headDisplay === "grid" && a.headTracks === 3, "① 导航搬进顶栏、顶栏三栏网格", { navInHead: a.navInHead, display: a.headDisplay, tracks: a.headTracks });
  ok(a.fab && a.fab.b === a.H - 16 - a.sab, "① 悬浮 ＋ 离屏底 16 + 安全区(--nav-h 里的 env() 解得出来)", a.fab && { gap: a.H - a.fab.b, sab: a.sab });

  // ---- ② 1440×960 任务面 ---------------------------------------------------------------------
  await face("tasks");
  const b = await ev(`(() => { const tl = document.getElementById("timeline"); const cs = getComputedStyle(tl);
    const stages = document.getElementById("filter-stages");
    return { board: document.body.classList.contains("board"), groups: tl.querySelectorAll(":scope > .tl-group").length, display: cs.display,
      tracks: cs.gridTemplateColumns.split(" ").length, cols: tl.style.getPropertyValue("--board-cols").trim(),
      stagesDisplay: getComputedStyle(stages).display,
      hiddenPills: [...stages.children].filter((x) => !x.classList.contains("fdue")).every((x) => getComputedStyle(x).display === "none") }; })()`);
  if (!b.groups) {
    console.log(JSON.stringify({ error: "库里没有任务,看板画不出列 —— ② 无从验起" }));
    process.exitCode = 2;
  } else {
    ok(b.board && b.display === "grid" && String(b.tracks) === b.cols, "② 看板网格的栏数 = --board-cols", b);
    ok(b.stagesDisplay === "contents" && b.hiddenPills, "② 状态排拆成 display: contents、状态钮藏着", { stages: b.stagesDisplay, hiddenPills: b.hiddenPills });
  }
  await face("ideas");

  // ---- ③ 1440×960 记一笔浮窗 ------------------------------------------------------------------
  const SHEET = `(() => { const c = document.getElementById("compose-card"); const r = c.getBoundingClientRect();
    return { W: innerWidth, H: innerHeight, l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), op: getComputedStyle(c).opacity }; })()`;
  const close = async () => {
    await sleep(500); // 过了遮罩的防漏点窗口(kbsheet SCRIM_GRACE_MS)
    await ev(`document.getElementById("capture-scrim").click(), true`);
    await sleep(400);
  };
  await ev(`document.getElementById("capture-fab").click(), true`);
  await sleep(450);
  const c = await ev(SHEET);
  ok(Math.abs(c.l - (c.W - c.r)) <= 1 && Math.abs(c.t - (c.H - c.b)) <= 1 && c.r - c.l <= 640 && c.op === "1", "③ 记一笔是屏中浮窗", c);
  await close();

  // ---- ④ 800×360 -------------------------------------------------------------------------------
  await size(800, 360);
  const d = await ev(STATE);
  ok(d.wide && !d.tall && d.navInHead, "④ 800×360:宽屏、不是高屏、导航在顶栏", { wide: d.wide, tall: d.tall, navInHead: d.navInHead });
  await ev(`document.getElementById("capture-fab").click(), true`);
  await sleep(450);
  const e = await ev(SHEET);
  ok(e.b === e.H && e.op === "1", "④ 记一笔贴屏底", e);
  await close();

  // ---- ⑤ 360×640 -------------------------------------------------------------------------------
  await size(360, 640);
  const f = await ev(STATE);
  ok(!f.wide && !f.tall && !f.navInHead && f.nav.b === f.H && f.wideVar === "0", "⑤ 360×640:不是宽屏、导航在屏底", { wide: f.wide, navInHead: f.navInHead, nav: f.nav, H: f.H });
} finally {
  await s.send("Emulation.clearDeviceMetricsOverride");
  await sleep(500);
  await face(origView).catch(() => {});
  s.close();
}
if (process.exitCode !== 2) console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(process.exitCode === 2 ? 2 : fails ? 1 : 0);
