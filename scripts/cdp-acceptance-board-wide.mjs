// 宽屏看板的验收(tablet-plan 格 2;889 起「一排 + 横滚 + 每列自滚」,此前是 ③A「放不下全部列就均匀折成几排」)。
//
// 证的是截图台(ui-shots-wide.mjs)照不出来的那几条 —— 截图是静态的,这几条要**动**才看得见:
//  ① 各尺寸都排一排、屏上露几整列(1440 / 1280 四列全露;960 竖放三列;800 竖放、手机横放、720 分屏两列,其余横滚;
//     719 起回到窄屏)、
//     列头计数 = 列里卡数、「状态」那排收掉而到期汇总钮并进标签行;窄屏(719 / 412 / 360)照旧;
//  ② 把一列的卡挪光:四列的左缘与宽逐个不变、那一列画「空」计数 0;窄屏上那一节照旧不画;
//  ③ 状态筛选跨断点:窄屏选「进行中」→ 拖宽成看板时它不算(九张全在)→ 拖回窄屏它照旧选着、照旧生效
//     (不重载,走转屏 / 分屏拖宽窄那条 ResizeObserver 路);
//  ④ 列里点开卡片:操作面左缘 = 卡片内容左缘、1280 那档四枚动作钮一排;点操作面顶上那条空白(原勾框那一竖条里)
//     真点 + 真触都不会勾完成、也不弹选择行;
//  ⑤ 横滑改状态:目标印与卡左右对齐(列有 8 的内边距),滑回原位松手不改状态;
//  ⑥ 看板上的标签摊开态:到期钮与摊开钮同一行,标签块在下一行、与到期钮左对齐;
//  ⑦(889)手机横放 800×360 的滚动:整页不滚;在一列上竖划只有那一列动;按住列头横拖 = 看板横滚、松手按列对齐;
//     切随记再回来、开设置再关,列竖滚与横滚都摆回原处;长按拿起一张卡 = 浮出替身、原卡淡下去,拖到看板右沿看板自己横滚,
//     落进屏外那一列、替身收干净;回执上的「撤销」放回原列;
//  ⑧(890)手机横放顶栏随滚动收 / 露:列里往下划 = 顶栏与筛选条滑走、看板长到状态栏下;收着时筛上 = 屏顶细条写着筛的是什么、
//     看板让到它下面、筛选条不漏;点细条 = 回来;短列(收了就滚不动)不收不抖;往上划一点 = 回来;横划列头不收;随记整页滚也收、
//     点导航切面还原位置那一下不收;1280×800 / 360×800 不收;
//  ⑧b(892)空列上往上推收、往下拉露(手势兜底:空列不发 scroll);宽屏回执屏底居中窄、不碰 ＋,确认条在时退回上方不叠,
//     确认条居中窄;顶栏收着时错误条贴状态栏下;360 竖屏回执照旧满幅贴顶。
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
//  刀 2(889 换)看板折回多排(`flex-wrap: wrap` + 高度放开)⇒ 红 ① 放不下全部列那几档的「一排」;
//       (889 前的刀 2 是 auto-fill 网格,判「均匀折」,那条规矩已随 ③A 一起退役)
//  刀 3 状态钮不藏(`#filter-stages > * { display: inline-flex }`)⇒ 红 ① 七个宽档的「状态那排收掉」;
//  刀 4 目标印铺满整列(`.swipe-track { left: 0; right: 0 }`)⇒ 红 ⑤ 的「对齐」(14–318 对 22–310);
//  刀 5(889)列不自己滚(`.tl-group { overflow: visible }`;⚠ 只写 overflow-y 不算数 —— 另一轴是 hidden 时 visible 被算成 auto,889 实撞)⇒ 红 ⑦ 的「只有那一列动」;
//  刀 6(889)替身不 fixed(`.drag-ghost { position: relative }`,= 被列裁掉的原地平移)⇒ 红 ⑦ 的「替身跟手」;
//  刀 8(891)列头吸回 top 0(`.tl-sec { top: 0 }`)⇒ 红 ⑦ 的「顶上没有透出卡的缝」(缝 4);
//  刀 9(892)宽屏回执不落屏底(`.error.notice { bottom: auto }`)⇒ 红 ⑧b 的「屏底居中」;
//  刀 7(890)收起时看板不借地方(`#timeline { margin-top: 0 }`)⇒ 红 ⑧ 的「看板长到状态栏下」「让到细条下面」。
//  JS 那两条(去掉收 / 露之后的静默窗、去掉「收了还滚得动」那道判)按 mutation-check「手工三步」各跑过一次,见 progress-log 890。
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
  2: `body.board #timeline { flex-wrap: wrap !important; height: auto !important; }`,
  3: `body.board #filter-stages > * { display: inline-flex !important; }`,
  4: `body.board #timeline .swipe-track { left: 0 !important; right: 0 !important; }`,
  5: `body.board #timeline > .tl-group { overflow: visible !important; }`,
  6: `.card.lifted.drag-ghost { position: relative !important; }`,
  7: `body.chrome-hidden.board #timeline { margin-top: 0 !important; }`,
  8: `body.board #timeline .tl-sec { top: 0 !important; }`,
  9: `html body.widescreen .error.notice { top: 60px !important; bottom: auto !important; }`,
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
    // 屏上露着的整列数(889 起看板横滚:列的左右都落在时间轴盒里才算)
    vis: (() => { const tr = document.getElementById("timeline").getBoundingClientRect();
      return gs.filter((g) => { const r = g.getBoundingClientRect(); return r.left >= tr.left - 1 && r.right <= tr.right + 1; }).length; })(),
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
  // [宽, 高, 屏上露几整列];null = 窄屏。全都排一排(889)。
  const SIZES = [
    [1440, 960, 4], [1280, 800, 4], [960, 1440, 3], [800, 1280, 2],
    [800, 360, 2], [915, 412, 2], [720, 1000, 2], [719, 1000, null], [412, 915, null], [360, 800, null],
  ];
  let base1280 = null;
  for (const [w, h, vis] of SIZES) {
    await size(w, h);
    await toTasks();
    const b = await ev(BOARD);
    const tag = `${w}×${h}`;
    if (vis) {
      ok(b.board && b.rows.length === 1 && b.rows[0] === 4 && b.vis === vis, `${tag} 看板一排四列、屏上露 ${vis} 整列`, { rows: b.rows, vis: b.vis });
      ok(b.groups.every((g) => g.count === String(g.cards)), `${tag} 列头计数 = 列里卡数`, b.groups.map((g) => `${g.count}/${g.cards}`));
      ok(b.stagePills === 0, `${tag} 状态那排收掉`, b.stagePills);
      ok(b.due && Math.abs(mid(b.due) - mid(b.topics)) <= 2 && b.due.r < b.topics.l, `${tag} 到期钮在标签行最前`, { due: b.due, topics: b.topics });
      if (w === 1280) base1280 = b;
    } else {
      // 158 G3 起竖屏节头也带计数(同宽屏列头那条:计数 = 这一节的卡数)。
      ok(
        !b.board && b.rows.every((n) => n === 1) && b.stagePills === 5 && b.groups.every((g) => g.count === String(g.cards)), // 全部 + 四列
        `${tag} 窄屏照旧(一节一行、状态那排在、节头计数 = 卡数)`,
        { rows: b.rows, stagePills: b.stagePills, counts: b.groups.map((g) => `${g.count}/${g.cards}`) },
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

  // ---- ⑦ 手机横放的滚动(889)--------------------------------------------------------------
  await size(800, 360);
  await toTasks();
  await sleep(3200); // 「已切到」那条提示自己收(它盖在列头上,横拖要按在列头上)
  {
    const GEO = `(() => { const tl = document.getElementById("timeline"), tr = tl.getBoundingClientRect(), gs = [...tl.querySelectorAll(":scope > .tl-group")];
      return { docH: document.scrollingElement.scrollHeight, vh: innerHeight, sy: scrollY, left: tl.scrollLeft, max: tl.scrollWidth - tl.clientWidth, tl: [tr.left, tr.right],
        cols: gs.map((g) => { const r = g.getBoundingClientRect(); return { c: g.dataset.col, l: Math.round(r.left), w: Math.round(r.width), t: Math.round(r.top), b: Math.round(r.bottom), st: Math.round(g.scrollTop) }; }) }; })()`;
    const tp = (type, x, y) => s.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const swipe = async (x1, y1, x2, y2, steps) => {
      await tp("touchStart", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await tp("touchMove", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await sleep(16);
      }
      await tp("touchEnd");
    };
    let g = await ev(GEO);
    ok(g.docH <= g.vh + 1 && g.max > 0, "800×360 整页不滚、看板横向放不下全部列", { docH: g.docH, vh: g.vh, max: g.max });
    const c0 = g.cols[0];
    await swipe(c0.l + c0.w / 2, c0.b - 20, c0.l + c0.w / 2, c0.t + 40, 10);
    await sleep(600);
    g = await ev(GEO);
    ok(g.cols[0].st > 0 && g.cols.slice(1).every((c) => c.st === 0) && g.sy === 0, "在「待办」上竖划:只有那一列动", g.cols.map((c) => c.st).concat(g.sy));
    // 滚过的那一列:列头吸在列的上沿,中间没有能透出卡的缝(891 用户真机截图:吸顶从内边距内沿算,top 0 漏出 4px)
    const gap = await ev(`(() => { const g = document.querySelector('#timeline > .tl-group'); const h = g.querySelector(':scope > .tl-sec');
      const t = g.getBoundingClientRect().top; const x = g.getBoundingClientRect().left + 40; const hit = document.elementFromPoint(x, t + 1);
      return { gap: Math.round((h.getBoundingClientRect().top - t) * 10) / 10, hitCard: !!hit?.closest(".card") }; })()`);
    ok(gap.gap <= 0.5 && !gap.hitCard, "滚过的列:列头贴着列的上沿,顶上没有透出卡的缝", gap);
    const st0 = g.cols[0].st;
    await swipe(g.tl[1] - 80, c0.t + 14, g.tl[0] + 60, c0.t + 14, 14);
    await sleep(900);
    g = await ev(GEO);
    ok(g.left > 0 && (g.left >= g.max - 1 || g.cols.some((c) => Math.abs(c.l - g.tl[0]) <= 1)), "按住列头横拖:看板横滚、松手按列对齐(或到头)", { left: g.left, ls: g.cols.map((c) => c.l) });
    await shot("phland-scrolled");
    const left0 = g.left;
    await ev(`document.querySelector('#bottombar [data-mode="ideas"]').click(), true`);
    await sleep(500);
    await ev(`document.querySelector('#bottombar [data-mode="tasks"]').click(), true`);
    await sleep(700);
    g = await ev(GEO);
    ok(g.cols[0].st === st0 && g.left === left0, "切随记再回任务:列竖滚与横滚都摆回去", [g.cols[0].st, st0, g.left, left0]);
    await ev(`document.getElementById("settings-toggle").click(), true`);
    await sleep(500);
    await ev(`document.getElementById("settings-toggle").click(), true`);
    await sleep(700);
    g = await ev(GEO);
    ok(g.cols[0].st === st0 && g.left === left0, "开设置再关:列竖滚与横滚都摆回去", [g.cols[0].st, g.left]);

    // 长按拖卡去屏外那一列(「待确认」):先回最左、各列回顶
    await ev(`(() => { const tl = document.getElementById("timeline"); tl.scrollLeft = 0; for (const c of tl.children) c.scrollTop = 0; return true; })()`);
    await sleep(600);
    g = await ev(GEO);
    const goal = g.cols.find((c) => c.c === "confirming");
    const card = await ev(`(() => { const c = document.querySelector('#timeline > .tl-group[data-col="todo"] > .card'); const r = c.getBoundingClientRect();
      return { id: c.dataset.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(30, r.height / 2)) }; })()`);
    ok(goal.l + goal.w > g.tl[1] + 40, "「待确认」起先大半在屏外(至多露出一截)", [goal.l, goal.w, g.tl[1]]);
    await tp("touchStart", card.x, card.y);
    await sleep(500); // 过 380 拿起
    const lifted = await ev(`({ ghost: !!document.querySelector(".drag-ghost"), src: !!document.querySelector(".card.drag-src") })`);
    ok(lifted.ghost && lifted.src, "长按拿起:浮出替身、原卡淡下去", lifted);
    const ex = g.tl[1] - 6;
    for (let i = 1; i <= 10; i++) {
      await tp("touchMove", card.x + ((ex - card.x) * i) / 10, card.y + 20);
      await sleep(16);
    }
    const gr = await ev(`(() => { const e = document.querySelector(".drag-ghost"); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`);
    const fy = card.y + 20;
    ok(!!gr && gr.r > ex - 40 && gr.t <= fy && gr.b >= fy, "替身跟手(拖到右沿时它也在右沿、手指压在它身上)", { ghost: gr, finger: [ex, fy] });
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && (await ev(`document.querySelector('#timeline > .tl-group[data-col="confirming"]').getBoundingClientRect().left`)) > g.tl[1] - 160) await sleep(100);
    g = await ev(GEO);
    const t2 = g.cols.find((c) => c.c === "confirming");
    ok(g.left > 0 && t2.l < g.tl[1] - 120, "拖到右沿停住:看板自己横滚,「待确认」露出来", [g.left, t2.l]);
    const tx = Math.max(g.tl[0] + 120, Math.min(t2.l + t2.w / 2, g.tl[1] - 120));
    for (let i = 1; i <= 8; i++) {
      await tp("touchMove", ex + ((tx - ex) * i) / 8, card.y + 40);
      await sleep(30);
    }
    await sleep(300);
    await shot("phland-dragging");
    await tp("touchEnd");
    await sleep(1500);
    const dropped = await ev(`(() => { const c = document.querySelector('#timeline article.card[data-id="${card.id}"]');
      return { col: c?.closest(".tl-group")?.dataset.col, ghost: !!document.querySelector(".drag-ghost"), src: !!document.querySelector(".drag-src") }; })()`);
    ok(dropped.col === "confirming" && !dropped.ghost && !dropped.src, "松手:落进屏外那一列,替身收干净", dropped);
    await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "撤销" && x.getClientRects().length); b?.click(); return !!b; })()`);
    await sleep(1200);
    const back = await ev(`document.querySelector('#timeline article.card[data-id="${card.id}"]')?.closest(".tl-group")?.dataset.col`);
    ok(back === "todo", "回执上的「撤销」:放回「待办」", back);
  }

  // ---- ⑧ 手机横放顶栏随滚动收 / 露(890,chromehide.ts)---------------------------------------
  {
    const tp = (type, x, y) => s.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const swipe = async (x1, y1, x2, y2, steps = 10) => {
      await tp("touchStart", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await tp("touchMove", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await sleep(16);
      }
      await tp("touchEnd");
      await sleep(1000);
    };
    const ST = `(() => { const R = (q) => { const r = document.querySelector(q).getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom) }; };
      return { hidden: document.body.classList.contains("chrome-hidden"), head: R("body > header"), bar: R("#filterbar"), tl: R("#timeline"), vh: innerHeight,
        docH: document.scrollingElement.scrollHeight, sy: Math.round(scrollY), peek: document.getElementById("chrome-peek").hidden ? null : document.getElementById("chrome-peek").textContent }; })()`;
    const COL = `(() => { const g = document.querySelector('#timeline > .tl-group'); const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, t: r.top, b: r.bottom }; })()`;
    const pill = (name) => ev(`(() => { const b = [...document.querySelectorAll("#filter-topics .fpill")].find((x) => x.textContent.includes(${JSON.stringify(name)})); b.click(); return 1; })()`);
    const unpill = () => ev(`(() => { const b = document.querySelector("#filter-topics .fpill.active"); if (b) b.click(); return 1; })()`);
    await size(800, 360);
    await toTasks();
    await sleep(3200);
    let g = await ev(ST);
    ok(!g.hidden && g.head.t === 0, "⑧ 看板起手:顶栏露着", g.head);
    let c = await ev(COL);
    await swipe(c.x, c.b - 20, c.x, c.t + 40);
    g = await ev(ST);
    ok(g.hidden && g.head.b <= 0 && g.bar.b <= 0, "⑧ 在一列上往下划:顶栏与筛选条滑出屏", { head: g.head, bar: g.bar });
    ok(Math.abs(g.tl.t - 8) <= 1 && Math.abs(g.tl.b - (g.vh - 16)) <= 1 && g.docH <= g.vh + 1, "⑧ 看板长到状态栏下 8、底边不动、整页不滚", { tl: g.tl, docH: g.docH });
    await shot("phland-chrome-hidden");
    // 收着时筛选变了(点卡上的标签胶囊就会):细条写着筛的是什么、看板让到它下面、筛选条不从屏顶漏下来
    await pill("家里");
    await sleep(800);
    g = await ev(ST);
    ok(g.hidden && /家里/.test(g.peek ?? "") && Math.abs(g.tl.t - 36) <= 1 && g.bar.b <= 0, "⑧ 收着时筛上:细条写着筛的是什么、看板让到它下面、筛选条不漏", { peek: g.peek, tl: g.tl, bar: g.bar });
    await shot("phland-chrome-peek");
    await ev(`document.getElementById("chrome-peek").click(), true`);
    await sleep(600);
    g = await ev(ST);
    ok(!g.hidden && g.peek === null && g.head.t === 0, "⑧ 点细条:顶栏回来、细条收掉", { hidden: g.hidden, peek: g.peek });
    // 筛完只比看板高一点的那一列:往下划不收、也不来回抖(收了它就滚不动 → 夹回顶 → 露 → 再收)
    c = await ev(COL);
    await ev(`(() => { window.__flips = 0; new MutationObserver(() => window.__flips++).observe(document.body, { attributes: true, attributeFilter: ["class"] }); return 1; })()`);
    await swipe(c.x, c.b - 15, c.x, c.t + 30);
    g = await ev(ST);
    const flips = await ev(`window.__flips`);
    ok(!g.hidden && flips <= 1, "⑧ 短列(收了就滚不动)往下划:不收、不抖", { hidden: g.hidden, flips });
    await unpill();
    await sleep(600);
    // 往上划一点 = 露;按住列头横划(看板横滚)不收
    c = await ev(COL);
    await swipe(c.x, c.b - 20, c.x, c.t + 40);
    c = await ev(COL);
    await swipe(c.x, c.t + 60, c.x, c.t + 100, 6);
    g = await ev(ST);
    ok(!g.hidden && g.head.t === 0 && g.tl.t > 100, "⑧ 往上划一点:顶栏回来、看板退回原位", { head: g.head, tl: g.tl });
    await swipe(700, g.tl.t + 14, 100, g.tl.t + 14, 14);
    g = await ev(ST);
    ok(!g.hidden && (await ev(`document.getElementById("timeline").scrollLeft`)) > 0, "⑧ 按住列头横划:看板横滚、顶栏不收", g.hidden);
    // 随记:整页滚也收;切面还原位置那一下不收
    await ev(`document.querySelector('#bottombar [data-mode="ideas"]').click(), true`);
    await sleep(800);
    await ev(`window.scrollTo(0, 0), true`);
    await sleep(500);
    await swipe(400, 300, 400, 120);
    g = await ev(ST);
    ok(g.hidden && g.head.b <= 0 && g.sy > 0, "⑧ 随记往下划:顶栏收", { head: g.head, sy: g.sy });
    await swipe(400, 150, 400, 190, 6);
    await ev(`document.querySelector('#bottombar [data-mode="tasks"]').click(), true`);
    await sleep(600);
    await ev(`document.querySelector('#bottombar [data-mode="ideas"]').click(), true`);
    await sleep(800);
    g = await ev(ST);
    ok(!g.hidden && g.sy > 0, "⑧ 点导航切回随记:还原位置那一下不收顶栏", { hidden: g.hidden, sy: g.sy });
    await ev(`window.scrollTo(0, 0), true`);
    // 高屏 / 竖屏不收
    // ---- ⑧b(892)空列手势兜底 + 宽屏浮条 ----
    await size(800, 360);
    await toTasks();
    await sleep(3200);
    {
      const COLR = (col) => `(() => { const r = document.querySelector('#timeline > .tl-group[data-col="${col}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), t: Math.round(r.top), b: Math.round(r.bottom) }; })()`;
      const HID = `document.body.classList.contains("chrome-hidden")`;
      const BAR = `(() => { const e = document.getElementById("error"); if (e.hidden) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), cls: e.className }; })()`;
      await pill("读书");
      await sleep(800);
      let e = await ev(COLR("doing"));
      ok(await ev(`!!document.querySelector('#timeline > .tl-group[data-col="doing"] > .tl-empty')`), "⑧b 前置:筛「读书」后「进行中」是空列");
      await swipe(e.x, e.b - 30, e.x, e.t + 30);
      ok(await ev(HID), "⑧b 空列上往上推:顶栏收(空列不发 scroll,走手势兜底)");
      e = await ev(COLR("doing"));
      await swipe(e.x, e.t + 40, e.x, e.b - 30);
      ok(!(await ev(HID)), "⑧b 空列上往下拉:顶栏回来");
      await unpill();
      await sleep(800);
      // 回执:横滑一张「待办」卡进「进行中」⇒ 屏底居中、窄、不碰 ＋
      const cd = await ev(`(() => { const x = [...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > .card')].find((c) => !c.querySelector(".ckbox")); const r = x.getBoundingClientRect(); return { id: x.dataset.id, x: r.left + r.width / 2, y: r.top + Math.min(28, r.height / 2), w: r.width }; })()`);
      await swipe(cd.x - cd.w * 0.3, cd.y, cd.x + cd.w * 0.35, cd.y, 10);
      let b = await ev(BAR);
      ok(!!b && /notice/.test(b.cls) && Math.abs(b.b - (360 - 16)) <= 1 && Math.abs((b.l + b.r) / 2 - 400) <= 1 && b.w <= 560 && b.r <= 800 - 88, "⑧b 横放回执:屏底居中、窄、不碰 ＋", b);
      await shot("phland-receipt");
      await ev(`(() => { const x = document.querySelector("#error .bar-act"); x && x.click(); return 1; })()`);
      await sleep(1200);
      ok((await ev(`document.querySelector('#timeline article.card[data-id="${cd.id}"]').closest(".tl-group").dataset.col`)) === "todo", "⑧b 回执上的「撤销」:回「待办」");
      // 确认条在屏上:回执退回上方、不叠;确认条自己居中窄
      await ev(`document.querySelector("[data-seal-all]").click(), true`);
      await sleep(500);
      const cb = await ev(`(() => { const x = document.getElementById("confirmbar"); const r = x.getBoundingClientRect(); return { hidden: x.hidden, l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), up: document.body.classList.contains("confirm-up") }; })()`);
      ok(!cb.hidden && cb.up && Math.abs((cb.l + cb.r) / 2 - 400) <= 1 && cb.r - cb.l <= 560, "⑧b 确认条:居中、窄", cb);
      await ev(`(() => { const x = document.getElementById("error"); x.textContent = "已重新连上"; x.className = "error notice"; x.hidden = false; return 1; })()`);
      await sleep(200);
      b = await ev(BAR);
      ok(!!b && b.b < cb.t, "⑧b 确认条在时:回执退回上方、不与它叠", { bar: b, cb });
      await ev(`(() => { document.getElementById("confirmbar-no").click(); document.getElementById("error").hidden = true; return 1; })()`);
      await sleep(300);
      // 顶栏收着时:错误条(红)贴到状态栏下
      e = await ev(COLR("todo"));
      await swipe(e.x, e.b - 20, e.x, e.t + 40);
      await ev(`(() => { const x = document.getElementById("error"); x.textContent = "演示"; x.className = "error"; x.hidden = false; return 1; })()`);
      await sleep(300);
      b = await ev(BAR);
      ok((await ev(HID)) && !!b && Math.abs(b.t - 8) <= 1, "⑧b 顶栏收着:错误条贴在状态栏下 8", b);
      await ev(`document.getElementById("error").hidden = true, true`);
    }
    // 竖屏回执照旧满幅贴顶
    await size(360, 800);
    await toTasks();
    await ev(`(() => { const x = document.getElementById("error"); x.textContent = "已重新连上"; x.className = "error notice"; x.hidden = false; return 1; })()`);
    await sleep(200);
    {
      const b = await ev(`(() => { const r = document.getElementById("error").getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top) }; })()`);
      ok(b.l === 14 && b.r === 346 && b.t < 200, "⑧b 360 竖屏:回执照旧左右各 14、贴上方", b);
    }
    await ev(`document.getElementById("error").hidden = true, true`);
    for (const [w, h] of [[1280, 800], [360, 800]]) {
      await size(w, h);
      await toTasks();
      await ev(`document.querySelector('#bottombar [data-mode="ideas"]').click(), true`);
      await sleep(800);
      await swipe(w / 2, h - 100, w / 2, 150);
      g = await ev(ST);
      ok(!g.hidden, `⑧ ${w}×${h} 往下划不收`, g.hidden);
    }
  }
} finally {
  // 刀随会话注入,摘掉再走(否则下一趟不带刀的也会吃到它,直到有人重起实例)
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
}
console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(fails ? 1 : 0);
