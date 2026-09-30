// 宽屏看板的验收(tablet-plan 格 2,用户 2026-09-30 拍 ③「放不下全部列就均匀折成几排」)。
//
// 证的是截图台(ui-shots-wide.mjs)照不出来的那几条 —— 截图是静态的,这几条要**动**才看得见:
//  ① 各尺寸排成几排几列(1440 / 1280 一排四列;960 / 800 竖放、手机横放、720 分屏 2 + 2;719 起回到窄屏)、
//     列头计数 = 列里卡数、「状态」那排收掉而到期汇总钮并进标签行;窄屏(719 / 412 / 360)照旧;
//  ② 把一列的卡挪光:四列的左缘与宽逐个不变、那一列画「空」计数 0;窄屏上那一节照旧不画;
//  ③ 状态筛选跨断点:窄屏选「进行中」→ 拖宽成看板时它不算(九张全在)→ 拖回窄屏它照旧选着、照旧生效
//     (不重载,走转屏 / 分屏拖宽窄那条 ResizeObserver 路);
//  ④ 列里点开卡片:操作面左缘 = 卡片内容左缘、1280 那档四枚动作钮一排;点操作面顶上那条空白(原勾框那一竖条里)
//     真点 + 真触都不会勾完成、也不弹选择行;
//  ⑤ 横滑改状态:目标印与卡左右对齐(列有 8 的内边距),滑回原位松手不改状态;
//  ⑥ 看板上的标签摊开态:到期钮与摊开钮同一行,标签块在下一行、与到期钮左对齐。
//
// 跑法(⛔ 只对截图台那只**隔离**实例跑 —— ②③ 会写库、改语言与摊开开关;开跑先问 identifier,不是 wideshots 就拒):
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/keep --only phone-360x800-ideas --keep   # 起实例、灌展示库、留着
//   node scripts/cdp-acceptance-board-wide.mjs [--shots <目录>] [--knife N]                  # CDP :9245
//   taskkill …(--keep 打印的那行)                                                           # ⛔ 用完就杀,vite 会涨到 GB 级
// 退出码 0 = 全过。跑完把改过的东西都还回去(挪走的卡、选中的状态、语言、摊开开关),可连跑。
//
// # 诚实边界
//  · 引擎是 WebView2,不是平板上的 ArkWeb / 安卓 WebView —— 证的是排法与交互,⛔ 不证老引擎认不认某条 CSS
//    (`display: contents` 要 Chrome 65、grid 57,都远低于 MuMu 的 110;真机那半在 tablet-plan 格 4 / 格 6)。
//  · 期望值是对着**展示库**写死的(四列、4 / 2 / 1 / 2 张、一张带清单的「出差要带的东西」在进行中)—— 开头先核这个前置,
//    不是展示库就拒,⛔ 别改成「按实际列数现算期望」:那等于把被测的公式抄一遍来验它自己。
//  · 英文界面 1280 那档动作钮折两行(要 287、列里 262)—— 与英文在 360 手机竖放上一样(行宽 260 也折两行),
//    「列不比手机窄 ⇒ 操作面不比手机上乱」这条前提照样成立;本资产只判中文。
//
// # 阴性对照(`--knife N` 在每次页面加载时注入一条坏 CSS;格 2 当轮逐把实跑过,红的就是下面写的那几格)
//  刀 1 操作面左缩进收回原样(`.panel { margin-left: 0 }`)⇒ 红 ④ 的「一排」(两行)与「左缘」(59);
//  刀 2 网格改成 auto-fill 按 300 塞满(= 不均匀折)⇒ 只红 ① 的 960 那档(3 + 1)—— 800 / 915 / 720 那几档
//       auto-fill 也恰好只塞得下两列、同样 2 + 2,照绿;⇒ 960 是唯一分得开「均匀折」与「能塞几列塞几列」的尺寸,别删;
//  刀 3 状态钮不藏(`#filter-stages > * { display: inline-flex }`)⇒ 红 ① 七个宽档的「状态那排收掉」;
//  刀 4 目标印铺满整列(`.swipe-track { left: 0; right: 0 }`)⇒ 红 ⑤ 的「对齐」(14–318 对 22–310)。
//  JS 那三条 CSS 刀够不着,格 2 当轮按 mutation-check「手工三步」改源码各跑一次(先提交、node 改、跑、checkout 还原):
//  看板上照样应用状态维 ⇒ 红 ③「拖宽」([0,2,0,0]);看板上也不画空列 ⇒ 红 ②「左缘与宽不变」(三列各 409)与
//  「画一枚空」;进看板就把状态维清掉 ⇒ 红 ③「拖回 412 照旧选着」。
import { mkdirSync, writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const KNIFE = arg("--knife");
const KNIVES = {
  1: `body.board #timeline .panel { margin-left: 0 !important; }`,
  2: `body.board #timeline { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)) !important; }`,
  3: `body.board #filter-stages > * { display: inline-flex !important; }`,
  4: `body.board #timeline .swipe-track { left: 0 !important; right: 0 !important; }`,
};
if (KNIFE && !KNIVES[KNIFE]) throw new Error(`没有第 ${KNIFE} 把刀(有 ${Object.keys(KNIVES).join(" / ")})`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
  await sleep(500);
};
async function toTasks() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(600);
  await waitFor(
    `document.readyState === "complete" && document.body.dataset.view === "ideas" && document.querySelectorAll("#timeline .card").length > 0`,
    "重载完",
  );
  // ⚠ 从随记面点「任务」是切面;⛔ 别对当前面再点一次底栏(那是「一步回捕获」,会开记一笔 —— ui-shots-wide 头注 ③)
  await ev(`document.querySelector('#bottombar [data-mode="tasks"]').click(), true`);
  await waitFor(`document.body.dataset.view === "tasks"`, "进任务面");
  await sleep(400);
}
async function shot(name) {
  if (!SHOTS) return;
  const png = await s.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(png.data, "base64"));
}
const openPanel = (title) =>
  ev(`(() => { const c = [...document.querySelectorAll("#timeline .card")].find((e) => e.innerText.includes(${JSON.stringify(title)}));
    c.querySelector(".body").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);

// 一次读全:几排几列、每列的位置 / 计数 / 卡数 / 空、状态钮露着几枚、到期钮与标签行的盒
const BOARD = `(() => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width) }; };
  const gs = [...document.querySelectorAll("#timeline > .tl-group")];
  const tops = [...new Set(gs.map((g) => Math.round(g.getBoundingClientRect().top)))];
  const due = document.querySelector("#filter-stages .fdue");
  return {
    board: document.body.classList.contains("board"),
    rows: tops.map((t) => gs.filter((g) => Math.round(g.getBoundingClientRect().top) === t).length),
    groups: gs.map((g) => ({ name: g.querySelector(".tl-sec").firstChild.textContent, ...R(g),
      count: g.querySelector(".tl-count")?.textContent ?? null, cards: g.querySelectorAll(":scope > .card").length,
      empty: !!g.querySelector(":scope > .tl-empty") })),
    stagePills: [...document.querySelectorAll("#filter-stages .fpill:not(.fdue)")].filter((b) => b.getClientRects().length).length,
    due: due && due.getClientRects().length ? R(due) : null,
    topics: R(document.getElementById("filter-topics")),
    activeStage: document.querySelector("#filter-stages .fpill.active")?.dataset.stage ?? null,
  };
})()`;
const mid = (r) => r.t + r.b; // 竖向中线 × 2(整数比较):到期钮 33 高、标签行带 4px 光晕,按上沿比会差 4
let knifeId = null;

try {
  // ---- 前置:隔离实例 + 展示库 ---------------------------------------------------------
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  if (id !== "app.zhujian.wideshots") throw new Error(`这只实例是 ${id},不是截图台的隔离实例 —— 本资产会写库,拒跑(跑法见头注)`);
  if (KNIFE) {
    // ⚠ 不先 Page.enable,下面那条在 WebView2 上**静默不生效**(返回 identifier、什么都不注入)⇒ 四把刀全绿、
    //   像是资产太松 —— 格 2 第一趟就栽在这,单独拿 `window.__x` 探针量出来的。
    await s.send("Page.enable");
    knifeId = await s.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.id = "knife"; st.textContent = ${JSON.stringify(KNIVES[KNIFE])}; document.head.append(st); });`,
    });
    knifeId = knifeId.identifier;
    console.log(`(刀 ${KNIFE}:${KNIVES[KNIFE]})`);
  }
  await size(1280, 800);
  await toTasks();
  const space = await ev(`localStorage.getItem("zhujian.last-space")`);
  const pre = await ev(BOARD);
  const shape = pre.groups.map((g) => `${g.name}${g.cards}`).join(" ");
  if (shape !== "待办4 进行中2 待确认1 已完成2") throw new Error(`不是展示库的四列(${shape})—— 期望值是对着展示库写死的,先重起截图台实例`);

  // ---- ① 各尺寸排法 ---------------------------------------------------------------------
  const SIZES = [
    [1440, 960, [4]], [1280, 800, [4]], [960, 1440, [2, 2]], [800, 1280, [2, 2]],
    [800, 360, [2, 2]], [915, 412, [2, 2]], [720, 1000, [2, 2]], [719, 1000, null], [412, 915, null], [360, 800, null],
  ];
  let base1280 = null;
  for (const [w, h, rows] of SIZES) {
    await size(w, h);
    await toTasks();
    const b = await ev(BOARD);
    const tag = `${w}×${h}`;
    if (rows) {
      ok(b.board && JSON.stringify(b.rows) === JSON.stringify(rows), `${tag} 看板排成 ${rows.join(" + ")}`, b.rows);
      ok(b.groups.every((g) => g.count === String(g.cards)), `${tag} 列头计数 = 列里卡数`, b.groups.map((g) => `${g.count}/${g.cards}`));
      ok(b.stagePills === 0, `${tag} 状态那排收掉`, b.stagePills);
      ok(b.due && Math.abs(mid(b.due) - mid(b.topics)) <= 2 && b.due.r < b.topics.l, `${tag} 到期钮在标签行最前`, { due: b.due, topics: b.topics });
      if (w === 1280) base1280 = b;
    } else {
      ok(
        !b.board && b.rows.every((n) => n === 1) && b.stagePills === 5 && b.groups.every((g) => g.count === null), // 全部 + 四列
        `${tag} 窄屏照旧(一节一行、状态那排在、节头不带计数)`,
        { rows: b.rows, stagePills: b.stagePills },
      );
    }
    if (w === 720) await shot("split-720x1000-tasks");
  }

  // ---- ② 挪光一列 -----------------------------------------------------------------------
  await size(1280, 800);
  await toTasks();
  const cid = await ev(`document.querySelector('#timeline .card[data-stage="confirming"]').dataset.id`);
  const move = (to) => ev(`window.__TAURI__.core.invoke("update_task_status", { spaceId: ${JSON.stringify(space)}, id: ${JSON.stringify(cid)}, to: ${JSON.stringify(to)} }).then(() => true)`);
  await move("todo");
  try {
    await toTasks();
    const b = await ev(BOARD);
    const same = b.groups.length === 4 && b.groups.every((g, i) => g.l === base1280.groups[i].l && g.w === base1280.groups[i].w);
    ok(same, "1280 挪光「待确认」后四列的左缘与宽逐个不变", b.groups.map((g) => [g.name, g.l, g.w]));
    const c = b.groups.find((g) => g.name === "待确认");
    ok(!!c && c.empty && c.count === "0", "「待确认」画一枚「空」、计数 0", c);
    await shot("moved-1280-tasks");
    await size(412, 915);
    await toTasks();
    const n = await ev(BOARD);
    ok(!n.board && n.groups.map((g) => g.name).join() === "待办,进行中,已完成", "412 上空节照旧不画", n.groups.map((g) => g.name));
  } finally {
    await move("confirming");
  }

  // ---- ③ 状态筛选跨断点(不重载)--------------------------------------------------------
  await size(412, 915);
  await toTasks();
  await ev(`document.querySelector('#filter-stages .fpill[data-stage="doing"]').click(), true`);
  await sleep(300);
  try {
    ok((await ev(BOARD)).groups.map((g) => g.name).join() === "进行中", "412 选「进行中」后只剩那一节");
    await size(1280, 800);
    await sleep(400);
    const w = await ev(BOARD);
    ok(w.board && w.groups.reduce((n, g) => n + g.cards, 0) === 9, "拖宽到 1280:看板上状态维不算(九张全在)", w.groups.map((g) => g.cards));
    await size(412, 915);
    await sleep(400);
    const n = await ev(BOARD);
    ok(!n.board && n.groups.map((g) => g.name).join() === "进行中" && n.activeStage === "doing", "拖回 412:「进行中」照旧选着、照旧生效", { groups: n.groups.map((g) => g.name), active: n.activeStage });
  } finally {
    await ev(`(() => { const b = document.querySelector('#filter-stages .fpill.active[data-stage="doing"]'); if (b) b.click(); return true; })()`);
  }

  // ---- ④ 列里的操作面 --------------------------------------------------------------------
  await size(1280, 800);
  await toTasks();
  await openPanel("出差要带的东西");
  await waitFor(`!!document.querySelector("#timeline .panel")`, "操作面开");
  await sleep(300);
  const geo = await ev(`(() => {
    const p = document.querySelector("#timeline .panel"), card = p.closest(".card"), R = (el) => el.getBoundingClientRect();
    return { panelL: R(p).left, panelT: R(p).top, cardL: R(card).left, id: card.dataset.id,
      rows: new Set([...p.querySelectorAll(".acts button")].map((b) => Math.round(R(b).top))).size };
  })()`);
  ok(geo.rows === 1, "1280 操作面四枚动作钮一排", geo.rows);
  ok(Math.round(geo.panelL - geo.cardL) === 13, "操作面左缘 = 卡片内容左缘(边 1 + 内边距 12)", Math.round(geo.panelL - geo.cardL));
  await shot("panel-1280");
  // 操作面顶上那条内边距(虚线下 3px)、x 落在原勾框那一竖条里:收回左缩进之后这块归操作面,不许再是勾框的触区
  const px = Math.round(geo.panelL + 6);
  const py = Math.round(geo.panelT + 3);
  const hit = await ev(`(() => { const e = document.elementFromPoint(${px}, ${py}); return { inTick: !!e.closest(".tick"), inPanel: !!e.closest(".panel") }; })()`);
  ok(!hit.inTick && hit.inPanel, `(${px},${py}) 命中操作面、不是勾框`, hit);
  for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", clickCount: 1 });
  await sleep(300);
  await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: px, y: py }] });
  await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(800);
  const after = await ev(`(() => { const c = document.querySelector('#timeline .card[data-id="${geo.id}"]');
    return { stage: c.dataset.stage, checked: c.querySelector(".tick input").checked, lane: !!c.querySelector(".panel .lane") }; })()`);
  ok(after.stage === "doing" && !after.checked && !after.lane, "真点 + 真触那条空白:没勾完成、没弹选择行", after);

  // ---- ⑤ 横滑的目标印 --------------------------------------------------------------------
  await toTasks();
  {
    const before = await ev(`document.querySelectorAll('#timeline .card[data-stage="todo"]').length`);
    const c = await ev(`(() => { const b = document.querySelector('#timeline .card[data-stage="todo"]').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: Math.round(b.left), r: Math.round(b.right) }; })()`);
    const touch = (type, dx) => s.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: c.x + dx, y: c.y }] });
    await touch("touchStart", 0);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", i * 8);
      await sleep(16);
    }
    await sleep(100);
    const tr = await ev(`(() => { const t = document.querySelector("#timeline .swipe-track"); if (!t) return null; const b = t.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })()`);
    await shot("swipe-1280");
    for (let i = 7; i >= 0; i--) {
      await touch("touchMove", i * 8);
      await sleep(16);
    }
    await touch("touchEnd", 0);
    ok(!!tr && tr.l === c.l && tr.r === c.r, "滑动时目标印与卡左右对齐", { track: tr, card: [c.l, c.r] });
    await sleep(500);
    ok((await ev(`document.querySelectorAll('#timeline .card[data-stage="todo"]').length`)) === before, "滑回原位松手 = 不改状态");
  }

  // ---- ⑥ 标签摊开态 ----------------------------------------------------------------------
  await size(800, 1280);
  await toTasks();
  ok(await ev(`!document.getElementById("filter-expand").hidden`), "800 竖放标签行放不下 ⇒ 摊开钮在");
  await ev(`document.getElementById("filter-expand").click(), true`);
  await sleep(300);
  try {
    const g = await ev(`(() => { const R = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), b: Math.round(b.bottom) }; };
      return { due: R("#filter-stages .fdue"), expand: R("#filter-expand"), topics: R("#filter-topics") }; })()`);
    ok(Math.abs(mid(g.due) - mid(g.expand)) <= 2 && g.topics.t > g.due.b && g.due.l === g.topics.l, "摊开态:到期钮与摊开钮同一行,标签块在下一行、左对齐", g);
    await shot("tags-open-800");
  } finally {
    await ev(`document.getElementById("filter-expand").click(), true`); // 这个开关落 localStorage,收回去
  }
} finally {
  // 刀随会话注入,摘掉再走(否则下一趟不带刀的也会吃到它,直到有人重起实例)
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
}
console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(fails ? 1 : 0);
