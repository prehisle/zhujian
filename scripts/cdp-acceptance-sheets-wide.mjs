// 三座底部层在宽屏上的验收(tablet-plan 格 4,用户 2026-09-30 拍 ④A「手机横放跟宽屏同一套,底部层仍从屏底升起」)。
//
// 高屏 = 宽屏(≥ 720)且高 ≥ 600:记一笔 / 编辑 / 留言三座浮在屏中;其余(手机横放、手机竖放、分屏拖窄拖矮)照旧从屏底升起。
// 证的是截图台(ui-shots-wide.mjs)照不出来的那几条 —— 截图是静态的、键盘弹不出来,这几条要**动**才看得见:
//  ① 各尺寸 × 三座:高屏的五档(1440×960 / 1280×800 / 960×1440 / 800×1280 / 720×600 边界)浮在屏中 —— 上下左右都居中、
//     宽 ≤ 640、不贴屏底;其余六档(800×360 / 915×412 / 720×599 / 719×1000 / 412×915 / 360×800)贴屏底;
//  ② 收起态:浮窗淡出、`pointer-events: none`、屏中那一点点不到它;贴底的滑出屏外;
//  ③ 800×1280(格 4 新进来的那一档):真点当前那一面 = 「一步回捕获」(收起态 focus 输入框开层)照样开浮窗
//     (浮窗收起态不能用 visibility 藏,见 index.html);
//  ④ 键盘让出去的那截不算:1280×800 打着字把视口压到 440(= 平板横放弹键盘),浮窗照旧、在剩下那截里居中;捕获框的
//     「给足高度」退回手机那档;放回 800 仍是浮窗、给足高度回来。不打字时压到 440(= 分屏拖矮)⇒ 翻成贴底;
//  ⑤ 最挤的那一档:1024×600 打着字压到 330(7 寸平板横放弹键盘),编辑层的「保存」那排仍在层里、层仍在屏里。
//
// 跑法(只读,不写库;但期望值对着展示库写 —— 带清单那张任务、上面两句留言 —— 开跑先问 identifier,不是截图台那只就拒):
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/keep --only phone-360x800-ideas --keep   # 起实例、灌展示库、留着
//   node scripts/cdp-acceptance-sheets-wide.mjs [--shots <目录>] [--knife N]                 # CDP :9245
//   taskkill …(--keep 打印的那行)                                                             # ⛔ 用完就杀,vite 会涨到 GB 级
// 退出码 0 = 全过。
//
// # 诚实边界
//  · 引擎是 WebView2,不是平板上的 ArkWeb / 安卓 WebView ⇒ 证的是排法与判据;「键盘」是拿 `Emulation` 把视口压矮代演的
//    (真机上视口真缩是原生 ime inset 做的,那半靠 tablet-plan 格 4 的 vivo 横放、格 6 的 MatePad 模拟器)。
//  · ④⑤ 代演的是「视口一步缩到位」;真机上键盘升起若分几帧发 resize,中间那几帧走的是同一条「打着字、比基准矮」的路,判据相同。
//  · 焦点靠页面里 `focus()`,窗口本身是隐藏的 ⇒ `document.activeElement` 照样是输入框,但系统焦点那半不在本资产里。
//
// # 阴性对照(`--knife N` 在每次页面加载时注入一条坏 CSS;格 4 当轮逐把实跑过,红的就是下面写的那几格)
//  刀 1 浮窗回到 789 的旧判据(宽 < 900 时贴底)⇒ 红 ① 800×1280 / 720×600 两档的三座 + ③;
//  刀 2 浮窗不看高(宽屏一律浮)⇒ 红 ① 800×360 / 915×412 / 720×599 三档的三座,连带 ② 800×360 收起(浮着收 = 原地
//       往下挪、不滑出屏外)与 ④ 末格(不打字压矮后开记一笔照样浮);
//  刀 3 「给足高度」挂在类上、不随视口退档 ⇒ 红 ④ 压矮时的捕获框、⑤ 的「保存」在层里;
//  刀 4 收起态用 visibility 藏 ⇒ 红 ③(focus 不上,开不了层)。
//  JS 那条 CSS 刀够不着:不锁存(打着字也照视口翻)⇒ 红 ④「压到 440 浮窗照旧」与 ⑤「编辑层仍是浮窗」两格(给足高度那格照绿 ——
//  它挂在 `@media` 上,本来就不靠锁存);格 4 当轮按 mutation-check「手工三步」改源码跑过一次(摘掉 main.ts `tall()` 头一行、跑、还原)。
import { mkdirSync, writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";
import { SHOWCASE } from "./lib/showcase.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const KNIFE = arg("--knife");
const FLOAT_OFF =
  `top: auto !important; bottom: 0 !important; height: auto !important; margin-block: 0 !important; max-width: var(--content-max) !important; ` +
  `transform: translateY(110%) !important; opacity: 1 !important; pointer-events: auto !important;`;
const KNIVES = {
  1:
    `@media (max-width: 899px) { body.tallscreen .compose, body.tallscreen .cmsheet { ${FLOAT_OFF} } ` +
    `body.tallscreen .compose.open, body.tallscreen .cmsheet.open { transform: translateY(0) !important; } }`,
  2:
    `@media (min-width: 720px) { .compose, .cmsheet { top: 0 !important; bottom: 0 !important; height: fit-content !important; margin-block: auto !important; ` +
    `max-width: 640px !important; margin-inline: auto !important; } }`,
  3: `body.tallscreen .compose textarea { min-height: 6em !important; } body.tallscreen .compose.editsheet textarea { min-height: 12em !important; }`,
  4: `body.tallscreen .compose:not(.open), body.tallscreen .cmsheet:not(.open) { visibility: hidden !important; }`,
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
  await sleep(400);
};
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(600);
  await waitFor(
    `document.readyState === "complete" && document.body.dataset.view === "ideas" && document.querySelectorAll("#timeline .card").length > 0`,
    "重载完",
  );
  await sleep(300);
}
async function shot(name) {
  if (!SHOTS) return;
  const png = await s.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(png.data, "base64"));
}

// 三座怎么开:记一笔 = 点 ＋;编辑 / 留言 = 任务面点开带清单那张、在操作面上点那枚钮
const LIST_TASK = SHOWCASE.zh.tasks.find(([title]) => title.includes("\n"))[0].split("\n")[0];
const SHEETS = {
  compose: { el: "compose-card", ready: `document.getElementById("compose-card").classList.contains("open")` },
  edit: { el: "edit-sheet", act: "edit", ready: `document.getElementById("edit-sheet").classList.contains("open")` },
  comments: {
    el: "comments-sheet",
    act: "comment",
    ready: `document.getElementById("comments-sheet").classList.contains("open") && document.querySelectorAll("#comments-sheet .cm-item").length > 0`,
  },
};
async function openSheet(kind) {
  const k = SHEETS[kind];
  if (!k.act) await ev(`document.getElementById("capture-fab").click(), true`);
  else {
    await ev(`(() => { document.querySelector('#bottombar [data-mode="tasks"]').click();
      const c = [...document.querySelectorAll("#timeline .card")].find((e) => e.innerText.includes(${JSON.stringify(LIST_TASK)}));
      c.querySelector(".body").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
    await waitFor(`!!document.querySelector('#timeline .panel [data-pact="${k.act}"]')`, `操作面上的「${k.act}」`);
    await ev(`document.querySelector('#timeline .panel [data-pact="${k.act}"]').click(), true`);
  }
  await waitFor(k.ready, `开 ${kind}`);
  await sleep(450); // 0.22s 的过场 + 留言列表落位
}
// 层的盒 + 不透明度 + 点不点得到;hit = 层中心那一点落在层里没有
const GEO = (id) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  const cx = Math.round((b.left + b.right) / 2), cy = Math.round((b.top + b.bottom) / 2);
  const at = document.elementFromPoint(Math.min(Math.max(cx, 0), innerWidth - 1), Math.min(Math.max(cy, 0), innerHeight - 1));
  return { W: innerWidth, H: innerHeight, l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom),
    op: cs.opacity, pe: cs.pointerEvents, hit: !!at && el.contains(at), tall: document.body.classList.contains("tallscreen") }; })()`;
const floating = (g) =>
  g.tall && g.t > 0 && g.b < g.H && Math.abs(g.t - (g.H - g.b)) <= 1 && Math.abs(g.l - (g.W - g.r)) <= 1 && g.r - g.l <= 640 && g.op === "1";
const docked = (g) => !g.tall && g.b === g.H && g.op === "1";
const TEXTAREA_MIN = (sel) => `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).minHeight)`;

let knifeId = null;
try {
  // ---- 前置:隔离实例 + 展示库 ---------------------------------------------------------
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  if (id !== "app.zhujian.wideshots") throw new Error(`这只实例是 ${id},不是截图台的隔离实例(期望值对着展示库写;跑法见头注)`);
  if (KNIFE) {
    // ⚠ 不先 Page.enable,下面那条在 WebView2 上**静默不生效**(scripts/lib/cdp.mjs 头注)
    await s.send("Page.enable");
    knifeId = (
      await s.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.id = "knife"; st.textContent = ${JSON.stringify(KNIVES[KNIFE])}; document.head.append(st); });`,
      })
    ).identifier;
    console.log(`(刀 ${KNIFE}:${KNIVES[KNIFE]})`);
  }
  if ((await ev(`localStorage.getItem("zhujian.lang")`)) !== "zh") throw new Error("界面不是中文 —— 上一趟没还原?先重起截图台实例");

  // ---- ① 各尺寸 × 三座 ------------------------------------------------------------------------
  const SIZES = [
    [1440, 960, true], [1280, 800, true], [960, 1440, true], [800, 1280, true], [720, 600, true],
    [800, 360, false], [915, 412, false], [720, 599, false], [719, 1000, false], [412, 915, false], [360, 800, false],
  ];
  for (const [w, h, tall] of SIZES) {
    await size(w, h);
    for (const kind of Object.keys(SHEETS)) {
      await reload();
      await openSheet(kind);
      const g = await ev(GEO(SHEETS[kind].el));
      const tag = `${w}×${h} ${kind}`;
      if (tall) ok(floating(g), `${tag} 浮在屏中(上下左右居中、宽 ≤ 640、不贴底)`, g);
      else ok(docked(g), `${tag} 贴屏底`, g);
      if (w === 800 && h === 1280) await shot(`port-800x1280-${kind}`);
    }
  }

  // ---- ② 收起态 ---------------------------------------------------------------------------------
  for (const [w, h, tall] of [[1280, 800, true], [800, 360, false]]) {
    await size(w, h);
    await reload();
    await openSheet("compose");
    await sleep(300); // 过了遮罩的防漏点窗口(kbsheet SCRIM_GRACE_MS)再点
    await ev(`document.getElementById("capture-scrim").click(), true`);
    await sleep(450);
    const g = await ev(GEO("compose-card"));
    if (tall) ok(g.op === "0" && g.pe === "none" && !g.hit, `${w}×${h} 收起:浮窗淡出、点不到`, g);
    else ok(g.t >= g.H, `${w}×${h} 收起:滑出屏外`, g);
  }

  // ---- ③ 800×1280 一步回捕获(收起态 focus 输入框开层)----------------------------------------------
  // 真点当前那一面(onModeButton → focus 输入框 → kbsheet 的 openOnFocus 开层)。⚠ 别在页面里直接 `focus()`:
  // 截图台的窗口是隐藏的、页面没有系统焦点,那样 activeElement 变了、`focus` 事件却不发 —— 格 4 当轮第一版就红在这
  await size(800, 1280);
  await reload();
  {
    const b = await ev(`(() => { const r = document.querySelector('#bottombar [data-mode="ideas"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await sleep(450);
  {
    const g = await ev(GEO("compose-card"));
    const focus = await ev(`document.activeElement?.id ?? null`);
    ok(floating(g) && focus === "text", "800×1280 收起态 focus 输入框 → 开浮窗、焦点在框里", { ...g, focus });
  }

  // ---- ④ 键盘让出去的那截不算 ---------------------------------------------------------------------
  await size(1280, 800);
  await reload();
  await openSheet("compose"); // ＋ 开层会 focus 输入框
  ok((await ev(`document.activeElement?.id ?? null`)) === "text", "1280×800 开记一笔:焦点在输入框(下面几格的前置)");
  const full = await ev(TEXTAREA_MIN("#compose-card textarea"));
  await size(1280, 440); // 平板横放弹键盘
  await sleep(300);
  {
    const g = await ev(GEO("compose-card"));
    const mh = await ev(TEXTAREA_MIN("#compose-card textarea"));
    ok(floating(g), "1280×800 打着字压到 440:浮窗照旧、在剩下那截里居中", g);
    ok(mh < full, "  …捕获框的「给足高度」退回手机那档", { full, squeezed: mh });
    await shot("kb-1280x440-compose");
  }
  await size(1280, 800); // 收键盘
  await sleep(300);
  {
    const g = await ev(GEO("compose-card"));
    const mh = await ev(TEXTAREA_MIN("#compose-card textarea"));
    ok(floating(g) && mh === full, "放回 1280×800:仍是浮窗、给足高度回来", { ...g, mh, full });
  }
  // 不打字时压矮(分屏拖矮)⇒ 照视口翻
  await ev(`document.getElementById("capture-scrim").click(), true`);
  await sleep(450);
  await ev(`document.activeElement?.blur(), true`);
  await size(1280, 440);
  await sleep(300);
  ok((await ev(`document.body.classList.contains("tallscreen")`)) === false, "不打字时压到 1280×440:不再是高屏(照视口翻)");
  await openSheet("compose");
  {
    const g = await ev(GEO("compose-card"));
    ok(docked(g), "  …这时开记一笔:贴屏底", g);
  }

  // ---- ⑤ 1024×600 打着字压到 330:编辑层的「保存」仍在层里 -------------------------------------------------
  await size(1024, 600);
  await reload();
  await openSheet("edit");
  await ev(`document.getElementById("edit-text").focus(), true`);
  await sleep(200);
  await size(1024, 330);
  await sleep(500);
  {
    const r = await ev(`(() => { const sh = document.getElementById("edit-sheet").getBoundingClientRect();
      const b = document.querySelector("#edit-sheet .compose-row .primary").getBoundingClientRect();
      return { H: innerHeight, tall: document.body.classList.contains("tallscreen"), sheet: [Math.round(sh.top), Math.round(sh.bottom)], save: [Math.round(b.top), Math.round(b.bottom)] }; })()`);
    ok(r.tall && r.sheet[0] >= 0 && r.sheet[1] <= r.H, "1024×600 打着字压到 330:编辑层仍是浮窗、整层在屏里", r);
    ok(r.save[0] >= r.sheet[0] && r.save[1] <= r.sheet[1], "  …「保存」那排在层里(没被正文框挤出去)", r);
    await shot("kb-1024x330-edit");
  }
} finally {
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
}
console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(fails ? 1 : 0);
