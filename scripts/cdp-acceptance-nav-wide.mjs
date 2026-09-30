// 宽屏导航并进顶栏的验收(tablet-plan 格 3,用户 2026-09-30 拍 ①A「底栏那几枚并进顶栏中间,屏底只剩 ＋」)。
//
// 证的是截图台(ui-shots-wide.mjs)照不出来的那几条 —— 截图是静态的、只拍中文、回收站是空的,这几条要**动**或换条件才看得见:
//  ① 各尺寸导航住哪儿:宽屏(1440 / 1280 / 960 / 800 竖放、手机横放、720 分屏)在顶栏里、屏底没有栏,悬浮 ＋ 离屏底 16;
//     窄屏(719 / 412 / 360)照旧在屏底、＋ 坐在它上方 16;当前那一面带朱砂短线只在宽屏;
//  ② 手机横放 800×360 任务面:顶栏 + 筛选条之下的可见内容 ≥ 260(改前 175,tablet-plan 诊断 ⑦);
//  ③ 「一步回捕获」:宽屏上**真点**当前那一面(点在钮盒外、halo 里)→ 开记一笔、焦点在输入框(横放 1440 浮窗 / 手机横放屏底);
//  ④ 最挤的那一档:英文、回收站有东西(导航五枚)、720 宽 —— 「朱简」/ 导航 / 右边四枚三块左右不叠,且没有哪枚折行
//     (顶栏与 1440 中文一样高);中文 720 同判;
//  ⑤ 面板开着转屏(不重载):开着设置 1440 → 412 → 960 → 360,导航每次都跟着搬、设置面一直开着;
//  ⑥ 键盘起着(`html.kb-up`):顶栏里的导航不藏,屏底那一形照旧让位;
//  ⑦ 贴屏底的三座:宽屏上确认条离屏底 16、更新条在 ＋ 上方 12(＋ 让位时落到离屏底 16);窄屏照旧贴着底栏上沿。
//
// 跑法(⛔ 只对截图台那只**隔离**实例跑 —— ④ 会写库(挪一条随记进回收站)、改语言;开跑先问 identifier,不是 wideshots 就拒):
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/keep --only phone-360x800-ideas --keep   # 起实例、灌展示库、留着
//   node scripts/cdp-acceptance-nav-wide.mjs [--shots <目录>] [--knife N]                    # CDP :9245
//   taskkill …(--keep 打印的那行)                                                            # ⛔ 用完就杀,vite 会涨到 GB 级
// 退出码 0 = 全过。跑完把改过的东西都还回去(回收站那条、语言),可连跑。
//
// # 诚实边界
//  · 引擎是 WebView2,不是平板上的 ArkWeb / 安卓 WebView,字体是 Windows 的 —— 证的是排法与交互;② 的 260 是这台量的,
//    真机字体(Noto Sans CJK 的行高比雅黑高)与 textZoom 字号档都会让顶栏再高几 px,那半在 tablet-plan 格 4 / 格 6。
//  · ⑥ 是手挂 `kb-up` 类判 CSS 那半;「键盘起没起」的判据(main.ts 那段)在真机上才照得出,不归本资产。
//  · ⑦ 的更新条与确认条是把 `hidden` 摘掉量位置(真要等到有新版 / 两拍确认),证的是几何、不是它们什么时候出现。
//  · 期望值对着**展示库**写(归档里有东西 ⇒ 导航至少四枚);开头核这个前置,不是展示库就拒。
//
// # 阴性对照(`--knife N` 在每次页面加载时注入一条坏 CSS;格 3 当轮逐把实跑过,红的就是下面写的那几格)
//  刀 1 顶栏回到 flex、导航绝对定位在正中(790 否掉的那一形:叠在顶栏正中、不管两边)⇒ 只红 ④ 英文 720 的「三块不叠」
//       (导航右缘 503 压过右边四枚的 497);中文 720 照绿 —— 正是 790 候选实拍时撞到的那一档;
//  刀 2 顶栏里的导航钮照旧 `min-height: 44px` ⇒ 红 ② 的可见高度(246),连带 ③ 四格(钮盒自己就 44 高、halo 与盒重合,盒外 6px 落空);
//  刀 3 两组钮不 nowrap ⇒ 只红 ④ 英文 720 的「没有哪枚折行」(Sync 在圆点后折下去,顶栏 47 → 65);
//  刀 4 摘掉顶栏导航钮的 halo ⇒ 红 ③ 四格(命中落空、没开记一笔);
//  刀 5 键盘起着时顶栏里的导航也藏 ⇒ 只红 ⑥ 的 1440;
//  刀 6 宽屏上不改写 `--nav-h` / `--nav-clear` ⇒ 红 ① 七个宽档的「＋ 离屏底 16」(73)与 ⑦ 的 1440。
//  JS 那条 CSS 刀够不着:只在启动时搬一次、不挂 resize ⇒ 红 ⑤ 往窄转的两格(412 / 360 上导航仍在顶栏);格 3 当轮按
//  mutation-check「手工三步」改源码跑过一次(注释掉那行、跑、还原)。
import { mkdirSync, writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const KNIFE = arg("--knife");
const KNIVES = {
  1:
    `body.widescreen > header { display: flex !important; } ` +
    `body.widescreen #bottombar { position: absolute !important; left: 50% !important; right: auto !important; top: 10px !important; transform: translateX(-50%) !important; }`,
  2: `body.widescreen #bottombar button { min-height: 44px !important; }`,
  3: `body.widescreen .head-acts, body.widescreen #bottombar { white-space: normal !important; }`,
  4: `body.widescreen #bottombar button::before { content: none !important; }`,
  5: `html.kb-up #bottombar { visibility: hidden !important; }`,
  6: `body.widescreen { --nav-h: 57px !important; --nav-clear: 64px !important; }`,
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

// 一次读全:导航住哪儿、三块的盒、顶栏高、＋ 的盒、当前那一面的短线
const NAV = `(() => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left * 10) / 10, r: Math.round(b.right * 10) / 10, t: Math.round(b.top), b: Math.round(b.bottom) }; };
  const nav = document.getElementById("bottombar");
  const fab = document.getElementById("capture-fab");
  const shown = [...nav.querySelectorAll("button")].filter((b) => !b.hidden);
  return {
    h: innerHeight, wide: document.body.classList.contains("widescreen"), inHead: nav.parentElement === document.querySelector("body > header"),
    head: R(document.querySelector("body > header")), h1: R(document.querySelector("body > header h1")), nav: R(nav),
    acts: R(document.querySelector(".head-acts")), fab: fab.getClientRects().length ? R(fab) : null,
    buttons: shown.length,
    // 每枚钮一格:带短线且是当前那一面 = on;带短线却不是 = stray;不带 = -
    underline: shown.map((b) => (getComputedStyle(b, "::after").content !== "none" ? (b.classList.contains("active") ? "on" : "stray") : "-")),
  };
})()`;
const lineOnFirstOnly = (u) => u[0] === "on" && u.slice(1).every((x) => x === "-");

let knifeId = null;
let trashed = null;
let space = null;
try {
  // ---- 前置:隔离实例 + 展示库 ---------------------------------------------------------
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  if (id !== "app.zhujian.wideshots") throw new Error(`这只实例是 ${id},不是截图台的隔离实例 —— 本资产会写库,拒跑(跑法见头注)`);
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
  space = await ev(`localStorage.getItem("zhujian.last-space")`);
  const counts = await ev(`window.__TAURI__.core.invoke("pane_counts", { spaceId: ${JSON.stringify(space)} })`);
  if (counts.trash !== 0 || counts.sealed < 1) throw new Error(`不是展示库的起点(回收站 ${counts.trash} / 归档 ${counts.sealed};要 0 / ≥1)—— 先重起截图台实例`);
  if ((await ev(`localStorage.getItem("zhujian.lang")`)) !== "zh") throw new Error("界面不是中文 —— 上一趟没还原?先重起截图台实例");

  // ---- ① 各尺寸导航住哪儿 ------------------------------------------------------------------
  const SIZES = [
    [1440, 960, true], [1280, 800, true], [960, 1440, true], [800, 1280, true], [800, 360, true], [915, 412, true],
    [720, 1000, true], [719, 1000, false], [412, 915, false], [360, 800, false],
  ];
  let base = null;
  for (const [w, h, wide] of SIZES) {
    await size(w, h);
    await reload();
    const n = await ev(NAV);
    const tag = `${w}×${h}`;
    if (wide) {
      ok(n.wide && n.inHead && n.nav.b <= n.head.b, `${tag} 导航在顶栏里、屏底没有栏`, { inHead: n.inHead, nav: n.nav, head: n.head });
      ok(n.fab && n.fab.b === n.h - 16, `${tag} 悬浮 ＋ 离屏底 16`, n.fab && n.h - n.fab.b);
      ok(lineOnFirstOnly(n.underline), `${tag} 当前那一面(随记)带短线、别的不带`, n.underline);
      if (w === 1440) base = n;
    } else {
      ok(!n.wide && !n.inHead && n.nav.b === n.h, `${tag} 窄屏照旧:导航在屏底`, { inHead: n.inHead, nav: n.nav });
      ok(n.fab && n.fab.b === n.nav.t - 16, `${tag} 窄屏照旧:＋ 坐在底栏上方 16`, n.fab && n.nav.t - n.fab.b);
      ok(n.underline.every((x) => x === "-"), `${tag} 窄屏没有短线`, n.underline);
    }
    if (w === 800 && h === 360) await shot("phland-800x360-ideas");
  }

  // ---- ② 手机横放的可见内容 ------------------------------------------------------------------
  await size(800, 360);
  await reload();
  await ev(`document.querySelector('#bottombar [data-mode="tasks"]').click(), true`);
  await waitFor(`document.body.dataset.view === "tasks"`, "进任务面");
  await sleep(300);
  const vis = await ev(`innerHeight - Math.round(document.getElementById("filterbar").getBoundingClientRect().bottom)`);
  ok(vis >= 260, "800×360 任务面:筛选条之下的可见内容 ≥ 260(改前 175)", vis);
  await shot("phland-800x360-tasks");

  // ---- ③ 一步回捕获(真点,点在钮盒外、halo 里)---------------------------------------------
  for (const [w, h] of [[1440, 960], [800, 360]]) {
    await size(w, h);
    await reload();
    const b = await ev(`(() => { const r = document.querySelector('#bottombar [data-mode="ideas"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), t: r.top, b: r.bottom }; })()`);
    const y = Math.round(b.t) - 6; // halo 上探 (44 - 钮高) / 2 ≈ 8;6 落在 halo 里、钮盒外
    const hit = await ev(`document.elementFromPoint(${b.x}, ${y})?.closest("button")?.dataset.mode ?? null`);
    ok(hit === "ideas", `${w}×${h} 钮盒上沿再往上 6px 仍命中「随记」(halo)`, hit);
    for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x: b.x, y, button: "left", clickCount: 1 });
    await sleep(600);
    const r = await ev(`({ open: document.getElementById("compose-card").classList.contains("open"), focus: document.activeElement?.id ?? null })`);
    ok(r.open && r.focus === "text", `${w}×${h} 再点一次当前那一面 → 开记一笔、焦点在输入框`, r);
    if (w === 1440) await shot("recapture-1440");
    await ev(`document.getElementById("capture-scrim").click(), true`);
    await sleep(300);
  }

  // ---- ④ 最挤的那一档:英文 + 回收站有东西 + 720 ----------------------------------------------
  trashed = await ev(`(async () => { const sp = ${JSON.stringify(space)};
    const it = (await window.__TAURI__.core.invoke("list_ideas", { spaceId: sp })).find((i) => i.content.includes("晾衣杆"));
    await window.__TAURI__.core.invoke("archive_note", { spaceId: sp, id: it.id }); return it.id; })()`);
  for (const lang of ["zh", "en"]) {
    await ev(`localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)}), true`);
    await size(720, 1000);
    await reload();
    // 回收站那枚按 pane_counts 显形(renderBottomBar),与卡片落 DOM 不是同一刻 ⇒ 等它出来再量
    await waitFor(`!document.querySelector('#bottombar [data-pane="trash"]').hidden`, "回收站那枚钮显形");
    const n = await ev(NAV);
    ok(n.buttons === 4, `720 ${lang}:回收站有东西 ⇒ 导航四枚钮 + 分隔(五枚)`, n.buttons);
    ok(n.h1.r <= n.nav.l && n.nav.r <= n.acts.l, `720 ${lang}:「朱简」/ 导航 / 右边四枚三块左右不叠`, { h1: [n.h1.l, n.h1.r], nav: [n.nav.l, n.nav.r], acts: [n.acts.l, n.acts.r] });
    ok(n.head.b === base.head.b, `720 ${lang}:没有哪枚折行(顶栏与 1440 中文一样高)`, { here: n.head.b, base: base.head.b });
    await shot(`crowded-720-${lang}`);
  }
  await ev(`localStorage.setItem("zhujian.lang", "zh"), true`);

  // ---- ⑤ 面板开着转屏(不重载)----------------------------------------------------------------
  await size(1440, 960);
  await reload();
  await ev(`document.getElementById("settings-toggle").click(), true`);
  await waitFor(`!document.getElementById("settings-pane").hidden`, "开设置面");
  for (const [w, h, wide] of [[412, 915, false], [960, 1440, true], [360, 800, false], [1440, 960, true]]) {
    await size(w, h);
    await sleep(200);
    const n = await ev(NAV);
    const pane = await ev(`!document.getElementById("settings-pane").hidden`);
    ok(n.inHead === wide && n.wide === wide && pane, `开着设置转到 ${w}×${h}:导航${wide ? "在顶栏" : "回屏底"}、设置面仍开着`, { inHead: n.inHead, pane });
  }
  await ev(`document.getElementById("settings-toggle").click(), true`);

  // ---- ⑥ 键盘起着 ---------------------------------------------------------------------------
  const KB = `(() => { document.documentElement.classList.add("kb-up"); const v = getComputedStyle(document.getElementById("bottombar")).visibility;
    document.documentElement.classList.remove("kb-up"); return v; })()`;
  await size(1440, 960);
  await reload();
  ok((await ev(KB)) === "visible", "1440 键盘起着:顶栏里的导航不藏");
  await size(412, 915);
  await reload();
  ok((await ev(KB)) === "hidden", "412 键盘起着:屏底的导航照旧让位");

  // ---- ⑦ 贴屏底的三座 -----------------------------------------------------------------------
  const BARS = `(() => { const R = (id) => Math.round(document.getElementById(id).getBoundingClientRect().bottom);
    const cb = document.getElementById("confirmbar"), up = document.getElementById("update"), nav = document.getElementById("bottombar");
    cb.hidden = false; up.hidden = false;
    const out = { h: innerHeight, navT: Math.round(nav.getBoundingClientRect().top), fabT: Math.round(document.getElementById("capture-fab").getBoundingClientRect().top), confirm: R("confirmbar"), update: R("update") };
    document.body.classList.add("pane-open"); out.updateNoFab = R("update"); document.body.classList.remove("pane-open");
    cb.hidden = true; up.hidden = true; return out; })()`;
  await size(1440, 960);
  await reload();
  const wb = await ev(BARS);
  ok(wb.confirm === wb.h - 16 && wb.update === wb.fabT - 12 && wb.updateNoFab === wb.h - 16, "1440 确认条离屏底 16、更新条在 ＋ 上方 12(＋ 让位时离屏底 16)", wb);
  await size(412, 915);
  await reload();
  const nb = await ev(BARS);
  ok(nb.confirm === nb.h - 64 && nb.update === nb.fabT - 12 && nb.updateNoFab === nb.h - 64, "412 照旧:确认条离屏底 64、更新条在 ＋ 上方 12(＋ 让位时离屏底 64)", nb);
} finally {
  if (trashed) await ev(`window.__TAURI__.core.invoke("restore_note", { spaceId: ${JSON.stringify(space)}, id: ${JSON.stringify(trashed)} }).then(() => true)`);
  await ev(`localStorage.setItem("zhujian.lang", "zh"), true`);
  // 刀随会话注入,摘掉再走(否则下一趟不带刀的也会吃到它,直到有人重起实例)
  if (knifeId) await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: knifeId });
  await s.send("Emulation.clearDeviceMetricsOverride");
  s.close();
}
console.log(fails ? `\n${fails} 条不过` : "\n全部通过");
process.exit(fails ? 1 : 0);
