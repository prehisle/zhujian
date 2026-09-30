// 随记分栏在「多日子」库上的验收(tablet-plan 1b)。
//
// 格 1 的分栏是「每个日子里轮流分」—— 真库里一两条的日子占多数(用户库 23 个日子里 15 个只有一条),一条的日子只能进
// 第一栏,横放右半屏整片空着。1b 起:条数 ≥ 栏数的「大日子」照旧节头横跨整排、组内轮流分;条数 < 栏数的「小日子」连成一段
// (`.tl-flow`),整块(节头 + 它那几张卡)落进这一段里条数最少的那栏(节头按半张卡记,一样少就靠左)。main.ts::renderDayGroups。
// 截图台的展示库全是「今天」一个日子(截图台头注 ④),照不出这一格 ⇒ 本资产自己造日子。
//
// 两种跑法(按 identifier 自动分):
//  · 截图台 `--keep` 的隔离实例(app.zhujian.wideshots):**夹具**把展示库的随记改成分散在七个日子上 —— 直接改这只实例
//    隔离库里的 `created_at`(产品里造不出过去的条目;每条只挪日期、时刻原样),重载页面再核;`finally` 里原样改回、再重载。
//    ⚠ core 开库时会逐字段比「表列 == create 那条日志的初值」,改过的库**别重启进程**(重载页面不重启,改回之后才算干净);
//    截图台每趟开跑都清空自己的数据目录,就算中途崩了也不会带到下一趟。
//  · 装着真库的设备(其余 identifier):**只读**,不写库、不改日子。先把视口压到 360 读出现有的日子分布,再按它核多栏。
//    ⚠ 设备上用 `Emulation` 改视口只为读 DOM,⛔ 别拿它截横屏图(安卓 629:截出来是 360 那张 surface 平铺的废图)。
//
// 每个宽度核这几格(1440×960 / 1280×800 三栏,960×1440 / 800×360 两栏,412×915 / 360×800 一栏;栏数照 main.ts 的
// NOTE_COL_MIN 340 / NOTE_COL_GAP 12 / NOTE_COLS_MAX 3 从时间轴宽推):
//  ① 一栏:没有 `.tl-cols`,每个日子一节,节里的卡数与分布逐个相同(= 1b 之前的标记);
//  ② 多栏:时间轴的直接子元素按日子顺序依次是「大日子的节」或「一段小日子」—— 大日子的节里 `.tl-cols` 恰 n 栏、
//     各栏卡数 = 轮流分的结果;连着的小日子在同一段里,段也恰 n 栏;
//  ③ 段里各栏的块序列(每块几张卡)与「落进条数最少那栏」推出来的逐个相同;
//  ④ 空栏只许出现在「块数少于栏数」的段里 —— 日子的节不会有空栏,段只要块数够就每栏都有(这就是 1b 要治的那个样子:
//     一条的日子成节、右边几栏空着);
//  ⑤ 卡的总数 = 一栏时的总数(一张没丢、一张没重);
//  ⑥ 段跟在大日子后面时,段里每栏第一枚节头上内距 8(与节和节之间一样宽);段在时间轴最前面时是 0。
//
// 跑法:
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/keep --only phone-360x800-ideas --keep   # 截图台实例
//   node scripts/cdp-acceptance-notes-flow.mjs [--shots <目录>] [--knife 4]                  # CDP :9245
//   CDP_PORT=9222 node scripts/cdp-acceptance-notes-flow.mjs                                  # 设备(先 android-cdp.mjs forward)
// 退出码 0 = 全过;设备上日子太少(没有一段两块以上的小日子)⇒ 报 {error} 退 2,不算过也不算红。
//
// # 阴性对照(1b 当轮在截图台实例上逐把实跑过)
//  JS 三把按 mutation-check「手工三步」改 main.ts(截图台的前端是 vite 从工作树现拼的,重载即生效)、跑、还原:
//   刀 1 小日子也各自成节(= 格 1 原样)⇒ 红 ②③④ 四个多栏宽度(④ 就是那个症状:一条的日子成节、右边几栏空着);
//   刀 2 大日子也进段(一律整块落栏)⇒ 红 ②③ 四个多栏宽度;
//   刀 3 段里按序号轮流落栏、不看条数 ⇒ 只红 ③ 的三栏两档(夹具中间那段是 2 + 1 + 1 + 1;两栏时两种落法恰好一样)。
//  CSS 一把页内注入:刀 4 段首节头不补上内距 ⇒ 只红 ⑥。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const KNIFE = arg("--knife");
const KNIVES = { 4: `.timeline > .tl-flow:not(:first-child) > .tl-col > .tl-group:first-child .tl-sec { padding-top: 0 !important; }` };
if (KNIFE && !KNIVES[KNIFE]) throw new Error(`没有第 ${KNIFE} 把 CSS 刀(有 ${Object.keys(KNIVES).join(" / ")};JS 那三把见头注)`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// 与 main.ts 同一组数(改那边就改这里)
const NOTE_COL_MIN = 340, NOTE_COL_GAP = 12, NOTE_COLS_MAX = 3;
const colsFor = (w) => Math.max(1, Math.min(NOTE_COLS_MAX, Math.floor((w + NOTE_COL_GAP) / (NOTE_COL_MIN + NOTE_COL_GAP))));
// 夹具:按现序(新 → 旧)给每条随记往前挪几天 ⇒ 今天 1 / 昨天 4 / 前天 2 / 3 天前 1 / 5 天前 1 / 6 天前 1 / 7 天前 3。
// 今天只有一条 ⇒ 时间轴最前面就是一段(⑥ 的「0」那一半);三栏时昨天、7 天前是大日子,中间那段是 2 + 1 + 1 + 1
// (刀 3 分得开);两栏时前天也是大日子,后面那段是 1 + 1 + 1。
const OFFSETS = [0, 1, 1, 1, 1, 2, 2, 3, 5, 6, 7, 7, 7];
const SIZES = [[1440, 960], [1280, 800], [960, 1440], [800, 360], [412, 915], [360, 800]];

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
const READY = `document.readyState === "complete" && document.body.dataset.view === "ideas" && document.querySelectorAll("#timeline .card").length > 0`;
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(READY, "重载完");
  await sleep(300);
}
let dpr = 1;
async function size(w, h) {
  await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
  await sleep(700); // 时间轴的 ResizeObserver 栏数变了才重投影
}

// 读时间轴的结构:直接子元素逐个 → { kind: "day", cols: [每栏卡数] | null(一栏), cards } 或 { kind: "flow", cols: [[每块卡数…]…], heads: [每栏首节头上内距] }
const READ = `(() => {
  const tl = document.getElementById("timeline");
  const out = [];
  for (const el of tl.children) {
    if (el.matches("section.tl-group")) {
      const cols = el.querySelector(":scope > .tl-cols");
      out.push({ kind: "day", cards: el.querySelectorAll(".card").length,
        cols: cols ? [...cols.children].map((c) => c.querySelectorAll(".card").length) : null });
    } else if (el.matches(".tl-cols.tl-flow")) {
      out.push({ kind: "flow",
        cols: [...el.children].map((c) => [...c.children].map((g) => g.querySelectorAll(".card").length)),
        heads: [...el.children].map((c) => { const h = c.querySelector(":scope > .tl-group:first-child > .tl-sec"); return h ? parseFloat(getComputedStyle(h).paddingTop) : null; }),
        first: el === tl.firstElementChild });
    } else out.push({ kind: "other", tag: el.tagName, cls: el.className });
  }
  return { w: tl.clientWidth, items: out, total: tl.querySelectorAll(".card").length, anyCols: !!tl.querySelector(".tl-cols") };
})()`;

// 按日子分布推期望:大日子轮流分;连着的小日子成段、整块落进条数最少的那栏
function expected(days, n) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const cols = Array.from({ length: n }, () => []);
    const load = Array(n).fill(0);
    for (const k of run) {
      const i = load.indexOf(Math.min(...load));
      cols[i].push(k);
      load[i] += k + 0.5;
    }
    out.push({ kind: "flow", cols });
    run = [];
  };
  for (const k of days) {
    if (k < n) run.push(k);
    else {
      flush();
      out.push({ kind: "day", cards: k, cols: Array.from({ length: n }, (_, i) => Math.ceil((k - i) / n)) });
    }
  }
  flush();
  return out;
}

let restore = null; // 夹具:[{ id, created_at }] 原值
let knifeId = null;
let dbPath = null;
try {
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  const bench = id === "app.zhujian.wideshots";
  console.log(`实例 ${id}(${bench ? "截图台:夹具造日子" : "设备:只读"})`);
  if (await ev(`document.body.classList.contains("pane-open")`)) throw new Error("开着面板 —— 先关掉再跑");
  if (!bench) dpr = 0; // 设备上保持原生 dpr,只改 CSS 宽高
  if (KNIFE) {
    await s.send("Page.enable"); // ⚠ 不先 enable,下面那条在 WebView2 上静默不生效(scripts/lib/cdp.mjs 头注)
    knifeId = (
      await s.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.id = "knife"; st.textContent = ${JSON.stringify(KNIVES[KNIFE])}; document.head.append(st); });`,
      })
    ).identifier;
    console.log(`(刀 ${KNIFE}:${KNIVES[KNIFE]})`);
  }

  if (bench) {
    // ---- 夹具:展示库的随记挪到七个日子上(只挪日期,时刻与小数位原样)---------------------------------
    const space = await ev(`localStorage.getItem("zhujian.last-space")`);
    dbPath = join(process.env.APPDATA, "app.zhujian.wideshots", `${space}.sqlite3`);
    const ideas = await ev(`window.__TAURI__.core.invoke("list_ideas", { spaceId: ${JSON.stringify(space)} }).then((r) => r.map((i) => ({ id: i.id, created_at: i.created_at })))`);
    if (ideas.length < OFFSETS.length) throw new Error(`展示库只有 ${ideas.length} 条随记,夹具要 ${OFFSETS.length} 条 —— 先重起截图台实例`);
    if (new Set(ideas.map((i) => i.created_at.slice(0, 10))).size !== 1) throw new Error("随记不在同一个日子上 —— 上一趟夹具没改回?先重起截图台实例");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const upd = db.prepare("UPDATE items SET created_at = ? WHERE id = ?");
    restore = ideas.map((i) => ({ id: i.id, created_at: i.created_at }));
    ideas.forEach((it, i) => {
      const k = OFFSETS[Math.min(i, OFFSETS.length - 1)];
      const d = new Date(it.created_at.slice(0, 10) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - k);
      upd.run(d.toISOString().slice(0, 10) + it.created_at.slice(10), it.id);
    });
    db.close();
    await size(360, 800);
    await reload();
  } else {
    if ((await ev(`document.body.dataset.view`)) !== "ideas") {
      // ⚠ 别对当前那一面再点一次(= 一步回捕获);不在随记面才点
      await ev(`document.querySelector('#bottombar [data-mode="ideas"]').click(), true`);
      await waitFor(READY, "进随记面");
    }
    await size(360, 800);
  }

  // ---- 日子分布:一栏时每节几张卡 --------------------------------------------------------------------
  const one = await ev(READ);
  const days = one.items.filter((x) => x.kind === "day").map((x) => x.cards);
  console.log(`日子分布(新 → 旧,每个日子几条):${days.join(" ")}  共 ${one.total} 张`);
  const smallRun = (n) => expected(days, n).some((x) => x.kind === "flow" && x.cols.flat().length >= 2);
  if (!bench && !smallRun(2)) {
    console.log(JSON.stringify({ error: "这台上的日子分布里没有「两块以上连着的小日子」,多栏那几格无从验起" }));
    process.exitCode = 2;
  } else {
    for (const [w, h] of SIZES) {
      await size(w, h);
      const r = await ev(READ);
      const n = colsFor(r.w);
      const tag = `${w}×${h}(时间轴 ${r.w} ⇒ ${n} 栏)`;
      ok(r.total === one.total, `${tag} ⑤ 卡的总数不变`, { here: r.total, one: one.total });
      if (n === 1) {
        ok(!r.anyCols && r.items.every((x) => x.kind === "day" && x.cols === null) && JSON.stringify(r.items.map((x) => x.cards)) === JSON.stringify(days),
          `${tag} ① 一栏:没有分栏,每个日子一节、卡数逐个相同`, r.items.map((x) => x.cards));
        continue;
      }
      const exp = expected(days, n);
      const shape = (xs) => xs.map((x) => (x.kind === "day" ? `D${x.cards}[${x.cols}]` : `F${JSON.stringify(x.cols)}`)).join(" ");
      const gotDays = r.items.filter((x) => x.kind === "day").map((x) => `D${x.cards}[${x.cols}]`).join(" ");
      const expDays = exp.filter((x) => x.kind === "day").map((x) => `D${x.cards}[${x.cols}]`).join(" ");
      ok(gotDays === expDays && r.items.length === exp.length && r.items.every((x, i) => x.kind === exp[i].kind && (x.kind !== "flow" || x.cols.length === n)),
        `${tag} ② 大日子成节、轮流分 ${n} 栏;小日子成段、段也 ${n} 栏`, { got: shape(r.items), exp: shape(exp) });
      const gotFlows = r.items.filter((x) => x.kind === "flow").map((x) => JSON.stringify(x.cols));
      const expFlows = exp.filter((x) => x.kind === "flow").map((x) => JSON.stringify(x.cols));
      ok(JSON.stringify(gotFlows) === JSON.stringify(expFlows), `${tag} ③ 段里整块落进条数最少的那栏`, { got: gotFlows, exp: expFlows });
      const holes = r.items.filter((x) =>
        x.kind === "day" ? x.cols.some((c) => c === 0) : x.kind === "flow" && x.cols.flat().length >= n && x.cols.some((c) => c.length === 0));
      ok(holes.length === 0, `${tag} ④ 空栏只在块数少于栏数的段里`, holes.map((x) => x.cols));
      const heads = r.items.filter((x) => x.kind === "flow").map((x) => ({ first: x.first, heads: x.heads.filter((v) => v !== null) }));
      ok(heads.every((x) => x.heads.every((v) => v === (x.first ? 0 : 8))), `${tag} ⑥ 段首节头上内距(段在最前 0、跟在大日子后 8)`, heads);
      if (bench && SHOTS && [1440, 960, 800].includes(w)) {
        const png = await s.send("Page.captureScreenshot", { format: "png", fromSurface: true });
        writeFileSync(join(SHOTS, `notes-flow-${w}x${h}.png`), Buffer.from(png.data, "base64"));
      }
    }
  }
} finally {
  if (restore) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const upd = db.prepare("UPDATE items SET created_at = ? WHERE id = ?");
    for (const r of restore) upd.run(r.created_at, r.id);
    db.close();
    console.log(`(夹具已改回 ${restore.length} 条的 created_at)`);
  }
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  if (restore) await reload();
  s.close();
}
if (process.exitCode !== 2) console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(process.exitCode === 2 ? 2 : fails ? 1 : 0);
