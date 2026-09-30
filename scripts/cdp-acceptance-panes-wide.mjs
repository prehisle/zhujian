// 覆盖面在宽屏上的验收(tablet-plan 格 5:回收站 / 归档 / 搜索的卡片列表用随记同一套多栏;标签 / 同步 / 空间 / 设置在 720 阅读宽里排好)。
//
// 证的是截图台照不出来的那几条 —— 截图是静态的,这几条要**动**或要逐枚量:
//  ① 三个卡片面(回收站 / 归档 / 搜索)× 六个宽度:宽屏上面板用整根框(不再收 720),列表分成 n 栏(n 同随记:
//     340 一栏下限、最多三栏),各栏卡数 = 轮流分的结果、总数不变;手机竖放没有分栏;
//  ② 开着回收站转屏(不重载):1440 → 800×360 → 360 → 1440,栏数跟着变、卡数不变(列表自己挂的 ResizeObserver);
//  ③ 回收站点开一张:操作面长在那张卡里、在它那栏里放得下;
//  ④ 各面板里的「独占一行的钮」(`.row > .grow`):宽屏上按字的长短、不再拉成 720 的一条;手机上照旧占满一行;
//     搜索那一行宽屏上不超过 720;回收站 / 归档 / 搜索之外的面照旧收在 720。
//
// 跑法(⛔ 只对截图台那只**隔离**实例跑 —— 会写库:往回收站放三条随记一张任务,`finally` 里恢复;开跑先问 identifier):
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/keep --only phone-360x800-ideas --keep
//   node scripts/cdp-acceptance-panes-wide.mjs [--shots <目录>] [--knife N]                  # CDP :9245
// 退出码 0 = 全过。
//
// # 阴性对照(`--knife N` 在每次页面加载时注入一条坏 CSS;格 5 当轮逐把实跑过,红的就是下面写的那几格)
//  刀 1 卡片面照旧收 720 ⇒ 红 ① 的「面板用整根框」四个宽屏宽度 × 三面;栏数那格照绿(它按列表自己的宽判,720 里两栏本来就对)。
//  刀 2 独占一行的钮宽屏上照旧拉满 ⇒ 只红 ④ 的宽屏四格(同步 / 空间 / 设置 / 回收站)。
//  刀 3 分栏摊平(`.tl-cols` / `.tl-col` 成 display:contents,DOM 照旧在)⇒ 红 ① 的栏数(四个宽屏宽度 × 三面)与 ② 的三个多栏格
//       —— 判的是屏上卡片左缘有几个横坐标,只数 `.tl-col` 的话这把刀下恒绿(第一版就是那样,补了才判得到);③ 照绿(`closest` 摊平了也找得到)。
//  JS 那条 CSS 刀够不着:列表不挂 ResizeObserver ⇒ 只红 ② 往窄转的两格(800×360 / 360:栏数停在开面那一刻的 3);
//  格 5 当轮按 mutation-check「手工三步」改源码跑过(摘掉 panes.ts 的三行 watchCols、跑、还原)。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const KNIFE = arg("--knife");
const KNIVES = {
  1: `#trash-pane, #sealed-pane, #search-pane { max-width: 720px !important; }`,
  2: `.row > .grow { flex: 1 1 0% !important; }`,
  3: `.sync .tl-cols { display: contents !important; } .sync .tl-col { display: contents !important; }`,
};
if (KNIFE && !KNIVES[KNIFE]) throw new Error(`没有第 ${KNIFE} 把刀(有 ${Object.keys(KNIVES).join(" / ")})`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// 与 android/src/ui.ts 的 NOTE_COL_MIN / NOTE_COL_GAP / NOTE_COLS_MAX 同一组数(改那边就改这里)
const colsFor = (w) => Math.max(1, Math.min(3, Math.floor((w + 12) / (340 + 12))));
const TRASH_NOTES = ["给阳台装一个晾衣杆", "周六上午带孩子去图书馆还书", "下周三前把房租转给房东"];
const TRASH_TASK = "换掉厨房那只坏了的灯泡";
const SEARCH_Q = "体检";

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const ev = (js) => s.evaluate(js);
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`);
};
async function waitFor(expr, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return;
    } catch {
      /* reload 途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) throw new Error(`等「${what}」超过 ${ms}ms;判据 ${expr}`);
    await sleep(120);
  }
}
const size = async (w, h) => {
  await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await sleep(600);
};
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(700);
  await waitFor(`document.readyState === "complete" && document.body.dataset.view === "ideas" && document.querySelectorAll("#timeline .card").length > 0`, "重载完");
  await sleep(300);
}
async function shot(name) {
  if (!SHOTS) return;
  const png = await s.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(png.data, "base64"));
}
// 三个卡片面怎么开、开好的判据
const PANES = {
  trash: {
    list: "trash-list",
    open: `(async () => { const b = () => document.querySelector('#bottombar [data-pane="trash"]');
      for (let i = 0; i < 50 && b().hidden; i++) await new Promise((r) => setTimeout(r, 100)); b().click(); })()`,
    ready: `document.querySelectorAll("#trash-list .card").length >= 4`,
  },
  sealed: { list: "sealed-list", open: `document.querySelector('#bottombar [data-pane="sealed"]').click()`, ready: `document.querySelectorAll("#sealed-list .card").length >= 3` },
  search: {
    list: "search-results",
    open: `(() => { document.getElementById("search-toggle").click(); document.getElementById("search-input").value = ${JSON.stringify(SEARCH_Q)}; document.getElementById("search-btn").click(); })()`,
    ready: `document.querySelectorAll("#search-results .card").length >= 3`,
  },
};
const LIST = (id) => `(() => { const box = document.getElementById(${JSON.stringify(id)}); const pane = box.closest("section.sync");
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
  const cols = [...box.querySelectorAll(":scope > .tl-cols > .tl-col")];
  return { W: innerWidth, pane: R(pane), box: R(box), n: cols.length, perCol: cols.map((c) => c.querySelectorAll(".card").length),
    total: box.querySelectorAll(".card").length, anyCols: !!box.querySelector(".tl-cols"),
    // 屏上真排成了几栏:卡片左缘有几个不同的横坐标(判到视觉本体,别只数 .tl-col —— 刀 3 把它们摊平了 DOM 照旧在)
    xs: new Set([...box.querySelectorAll(".card")].map((c) => Math.round(c.getBoundingClientRect().left))).size }; })()`;
const rr = (total, n) => Array.from({ length: n }, (_, i) => Math.ceil((total - i) / n));

let knifeId = null;
let space = null;
let trashed = null;
try {
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  if (id !== "app.zhujian.wideshots") throw new Error(`这只实例是 ${id},不是截图台的隔离实例 —— 本资产会写库,拒跑(跑法见头注)`);
  if (KNIFE) {
    await s.send("Page.enable"); // ⚠ 不先 enable,下面那条在 WebView2 上静默不生效(scripts/lib/cdp.mjs 头注)
    knifeId = (
      await s.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.id = "knife"; st.textContent = ${JSON.stringify(KNIVES[KNIFE])}; document.head.append(st); });`,
      })
    ).identifier;
    console.log(`(刀 ${KNIFE}:${KNIVES[KNIFE]})`);
  }
  // ---- 前置:往回收站放三条随记一张任务(展示库原本回收站是空的)----------------------------------
  space = await ev(`localStorage.getItem("zhujian.last-space")`);
  const counts = await ev(`window.__TAURI__.core.invoke("pane_counts", { spaceId: ${JSON.stringify(space)} })`);
  if (counts.trash !== 0 || counts.sealed < 3) throw new Error(`不是展示库的起点(回收站 ${counts.trash} / 归档 ${counts.sealed};要 0 / ≥3)—— 先重起截图台实例`);
  trashed = await ev(`(async () => { const inv = window.__TAURI__.core.invoke, sp = ${JSON.stringify(space)}; const out = [];
    const ideas = await inv("list_ideas", { spaceId: sp });
    for (const c of ${JSON.stringify(TRASH_NOTES)}) { const it = ideas.find((i) => i.content === c); await inv("archive_note", { spaceId: sp, id: it.id }); out.push({ id: it.id, task: false }); }
    const tl = await inv("list_timeline", { spaceId: sp });
    const tk = tl.find((i) => i.content === ${JSON.stringify(TRASH_TASK)}); await inv("archive_task", { spaceId: sp, id: tk.id }); out.push({ id: tk.id, task: true });
    return out; })()`);

  // ---- ① 三个卡片面 × 六个宽度 --------------------------------------------------------------------------
  const SIZES = [[1440, 960], [1280, 800], [960, 1440], [800, 360], [412, 915], [360, 800]];
  for (const [w, h] of SIZES) {
    await size(w, h);
    for (const [name, p] of Object.entries(PANES)) {
      await reload();
      await ev(`${p.open}, true`);
      await waitFor(p.ready, `开 ${name}`);
      await sleep(300);
      const r = await ev(LIST(p.list));
      const n = colsFor(r.box.w);
      const tag = `${w}×${h} ${name}`;
      if (w >= 720) {
        ok(r.pane.w === Math.min(1400, w - 28), `${tag} 面板用整根框(${Math.min(1400, w - 28)})`, r.pane);
        ok(r.n === n && r.xs === Math.min(n, r.total) && JSON.stringify(r.perCol) === JSON.stringify(rr(r.total, n)), `${tag} 分成 ${n} 栏、轮流分`, { n: r.n, xs: r.xs, perCol: r.perCol, total: r.total });
      } else {
        ok(!r.anyCols && r.xs === 1 && r.pane.w === w - 28, `${tag} 手机竖放:没有分栏、面板满宽`, { anyCols: r.anyCols, xs: r.xs, pane: r.pane });
      }
      if (w === 1440 || w === 800) await shot(`${name}-${w}x${h}`);
    }
  }

  // ---- ② 开着回收站转屏(不重载)--------------------------------------------------------------------------
  await size(1440, 960);
  await reload();
  await ev(`${PANES.trash.open}, true`);
  await waitFor(PANES.trash.ready, "开回收站");
  for (const [w, h] of [[1440, 960], [800, 360], [360, 800], [1440, 960]]) {
    await size(w, h);
    const r = await ev(LIST("trash-list"));
    const n = colsFor(r.box.w);
    ok((n === 1 ? !r.anyCols : r.n === n) && r.xs === n && r.total === 4, `开着回收站转到 ${w}×${h}:${n} 栏、四张都在`, { n: r.n, xs: r.xs, perCol: r.perCol, total: r.total });
  }

  // ---- ③ 回收站点开一张 ---------------------------------------------------------------------------------
  await ev(`document.querySelector("#trash-list .card .body").click(), true`);
  await sleep(300);
  const pnl = await ev(`(() => { const p = document.querySelector("#trash-list .panel"); if (!p) return null;
    const col = p.closest(".tl-col"), card = p.closest(".card"); const cb = card.getBoundingClientRect();
    const btns = [...p.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return { inCol: !!col, rows: new Set(btns.map((b) => Math.round(b.top))).size, inside: btns.every((b) => b.left >= cb.left && b.right <= cb.right) }; })()`);
  ok(pnl && pnl.inCol && pnl.rows === 1 && pnl.inside, "1440 回收站点开一张:操作面长在那张卡里、在它那栏里一排放得下", pnl);
  await shot("trash-panel-1440x960");

  // ---- ④ 独占一行的钮 / 搜索那一行 / 其余面照旧 720 --------------------------------------------------------
  const GROW = `(() => [...document.querySelectorAll("section.sync:not([hidden]) .row > .grow")].filter((b) => b.getClientRects().length)
    .map((b) => ({ id: b.id, w: Math.round(b.getBoundingClientRect().width), row: Math.round(b.parentElement.getBoundingClientRect().width), n: b.parentElement.children.length })))()`;
  const FORMS = {
    sync: `document.getElementById("sync-toggle").click()`,
    spaces: `document.getElementById("space-chip").click()`,
    settings: `document.getElementById("settings-toggle").click()`,
    trash: PANES.trash.open,
  };
  for (const [w, h] of [[1440, 960], [412, 915]]) {
    await size(w, h);
    for (const [name, open] of Object.entries(FORMS)) {
      await reload();
      await ev(`${open}, true`);
      await sleep(700);
      const g = await ev(GROW);
      const paneW = await ev(`Math.round(document.querySelector("section.sync:not([hidden])").getBoundingClientRect().width)`);
      if (w >= 720) {
        ok(g.length > 0 && g.every((x) => x.w < x.row), `${w}×${h} ${name}:独占一行的钮按字的长短、不拉满`, g);
        if (name !== "trash") ok(paneW === 720, `${w}×${h} ${name}:面板收在 720`, paneW);
      } else {
        ok(g.length > 0 && g.every((x) => x.n > 1 || x.w === x.row), `${w}×${h} ${name}:手机上独占一行的钮照旧占满`, g);
      }
      if (w === 1440 && SHOTS) await shot(`form-${name}-1440x960`);
    }
  }
  await size(1440, 960);
  await reload();
  await ev(`${PANES.search.open}, true`);
  await waitFor(PANES.search.ready, "开搜索");
  const srow = await ev(`Math.round(document.querySelector("#search-pane > .row").getBoundingClientRect().width)`);
  ok(srow <= 720, "1440 搜索那一行不超过 720", srow);
} finally {
  if (trashed) {
    await ev(`(async () => { const inv = window.__TAURI__.core.invoke, sp = ${JSON.stringify(space)};
      for (const t of ${JSON.stringify(trashed)}) await inv(t.task ? "restore_task" : "restore_note", { spaceId: sp, id: t.id }); return true; })()`);
    console.log(`(回收站里放的 ${trashed.length} 条已恢复)`);
  }
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
}
console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(fails ? 1 : 0);
