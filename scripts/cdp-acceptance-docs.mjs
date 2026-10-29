// 手机长文面验收(longform-plan 第 4 格):随记「展开成长文」→ 长文面列表 → Markdown 阅读页 → 编辑(停笔存本机草稿)
// → 预览 → 保存落一版、清草稿 → 阅读页勾方框落一版 → 历史比对(原文、删 / 增与字级高亮)→ 返回键逐层回退 →
// 搜索命中「长文」跳进阅读页 → 新建一篇、不点保存直接关面也落了 → 收回随记、底栏「长文」钮随数据消失。
// 照桌面 e2e/specs/docs.e2e.js 那条路,外加手机才有的两格:返回键账本(`__zhujianHandleBack`)与底栏按数据显形。
//
// ⛔ **会写库**。两种跑法:
//  · 截图台 `--keep` 的隔离实例(app.zhujian.wideshots,每趟开跑清空自己的数据目录):拿展示库第一条随记当靶子,
//    开跑先把上一趟中断留下的长文收回(夹具复位)。
//  · 真机(`--device`,devtools 包):**只动自己种的条目** —— 先种一条标明「验完即删」的随记当靶子,库里已有长文就拒跑
//    (① ⑩ 两格判的是「一篇都没有」);收尾把本趟建过的每一条 archive + purge、清掉本趟的草稿键。
//    ⚠ purge 留下的墓碑照常同步到这个空间的其它设备(与别的真机资产同形);视口不改(设备原生 360 宽)。
//
// 跑法:
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/wide --only phone --keep   # 截图台实例(CDP :9245)
//   node scripts/cdp-acceptance-docs.mjs [--shots <目录>]
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs.mjs --device              # 真机(先 android-cdp.mjs forward)
// 退出码 0 = 全过。
//
// 判据都读 DOM / localStorage / 命令回包,⛔ 不拿「没弹窗」当证据:恶意那行(`<img onerror>`)要核的是阅读页与预览里
// **一个 img 元素都没有**、原文作为文字还在。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9245);
const SHOTS = arg("--shots");
const DEVICE = argv.includes("--device");
/** 本趟建出来的条目(真机收尾按它清场)。 */
const created = new Set();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
    try {
      if (await ev(expr)) return true;
    } catch {
      /* 重画途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`, expr);
      return false;
    }
    await sleep(120);
  }
}
async function shot(name) {
  if (!SHOTS) return;
  const r = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
}
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
/** 点文字恰为 `text` 的那枚按钮(在 scope 里找)。 */
const clickText = (scope, text) =>
  ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.hidden); if (!b) return false; b.click(); return true; })()`);
const back = () => ev(`window.__zhujianHandleBack()`);
const pane = () => ev(`document.body.classList.contains("pane-open") && !document.getElementById("docs-pane").hidden`);
const docsBtnShown = () => ev(`!document.querySelector('#bottombar [data-pane="docs"]').hidden`);
const space = () => ev(`localStorage.getItem("zhujian.last-space")`);
const draftKeys = () => ev(`Object.keys(localStorage).filter((k) => k.startsWith("zhujian.doc-draft:"))`);
/** 编辑框里换一份正文(走 input 事件,同用户敲字)。 */
const typeArea = (text) =>
  ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

const MD = [
  "# 长文验收标题",
  "",
  "第一段有 **粗体** 和 `行内码`,还有一个链接 [官网](https://zhujian.app)。",
  "",
  "- [ ] 待办甲",
  "- [x] 待办乙",
  "",
  "> 引用一句",
  "",
  '<img src=x onerror="window.__pwned=1">',
  "",
].join("\n");

try {
  const id = await ev(`window.__TAURI__.app.getIdentifier()`);
  const bench = id === "app.zhujian.wideshots";
  if (!bench && !DEVICE) throw new Error(`实例 ${id} 不是截图台 —— 本资产会写库;真机要显式带 --device(头注)`);
  if (bench && DEVICE) throw new Error("截图台实例别带 --device");
  // 截图台跑完停在最后一张的面上 ⇒ 先重载回随记面(重载不丢任何东西;真机上同样只是重画)
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar")`, "页面就绪", 30000);
  if (await ev(`document.body.dataset.view !== "ideas"`)) await click(`#bottombar [data-mode="ideas"]`);
  await waitFor(`document.body.dataset.view === "ideas"`, "随记面", 10000);
  if (bench) {
    await s.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
  }
  if (await ev(`document.body.classList.contains("pane-open")`)) throw new Error("开着面板 —— 先关掉再跑");
  const sp = await space();
  const docsNow = await ev(`window.__TAURI__.core.invoke("list_docs", { spaceId: ${JSON.stringify(sp)} }).then((d) => d.length)`);
  if (DEVICE && docsNow > 0) throw new Error(`这台的库里已有 ${docsNow} 篇长文 —— ① ⑩ 判的是「一篇都没有」,真机上不替用户收回,换台机或先清`);
  // 夹具复位(只在截图台):上一趟中途断了会留下长文(隔离库,收回即可)⇒ 每趟都从「一篇长文都没有」起跑
  const left = !bench
    ? 0
    : await ev(`(async () => { const sp = ${JSON.stringify(sp)}; const ds = await window.__TAURI__.core.invoke("list_docs", { spaceId: sp }); for (const d of ds) await window.__TAURI__.core.invoke("set_doc", { spaceId: sp, id: d.id, on: false }); return ds.length; })()`);
  if (left > 0) {
    console.log(`(夹具复位:收回上一趟留下的 ${left} 篇长文)`);
    await ev(`setTimeout(() => location.reload(), 0), true`);
    await sleep(800);
    await waitFor(`document.readyState === "complete" && document.querySelectorAll("#timeline .card").length > 0`, "复位后重载", 30000);
  }
  await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k); return true; })()`);

  // ---- ① 没有长文时底栏没有「长文」钮(408-A1)----------------------------------------------------
  ok(!(await docsBtnShown()), "① 没有长文:底栏「长文」钮不显形");

  // ---- ② 随记卡 → 更多… → 展开成长文 ---------------------------------------------------------------
  let target;
  if (DEVICE) {
    // 真机:种一条自己的靶子(别碰用户的随记),重载让它进时间轴
    target = await ev(`window.__TAURI__.core.invoke("capture_idea", { spaceId: ${JSON.stringify(sp)}, content: "长文验收临时条目(验完即删)" })`);
    created.add(target);
    await ev(`setTimeout(() => location.reload(), 0), true`);
    await sleep(800);
    await waitFor(`!!document.querySelector('#timeline .card[data-id="${target}"]')`, "种下的靶子进了时间轴", 30000);
  } else {
    await waitFor(`document.querySelectorAll("#timeline .card[data-id]").length > 0`, "随记面有卡", 30000);
    target = await ev(`document.querySelector("#timeline .card[data-id]").dataset.id`);
  }
  await click(`#timeline .card[data-id="${target}"] .body`);
  await waitFor(`!!document.querySelector('#timeline .panel [data-pact="more"]')`, "卡片操作面");
  await click(`#timeline .panel [data-pact="more"]`);
  await waitFor(`!!document.querySelector('#timeline .panel [data-pact="expand"]')`, "更多… 里有「展开成长文」");
  await click(`#timeline .panel [data-pact="expand"]`);
  await waitFor(`!document.querySelector('#timeline .card[data-id="${target}"]')`, "展开后那张卡离开随记面");
  ok(await ev(`!document.getElementById("error").hidden && document.getElementById("error").textContent.includes("长文")`), "② 回执指路(提到「长文」)");
  ok(await docsBtnShown(), "② 底栏「长文」钮显形");
  // 任务面也不许出现它(主归属是长文)
  ok(await ev(`!document.querySelector('[data-id="${target}"]')`), "② 时间轴上任何一面都没有这条");

  // ---- ③ 长文面列表 → 阅读页 -----------------------------------------------------------------------
  await click(`#bottombar [data-pane="docs"]`);
  await waitFor(`document.querySelectorAll("#docs-body .doc-card").length === 1`, "长文面列出一篇");
  ok(await pane(), "③ 长文面开着(随记面收起)");
  ok(await ev(`!document.getElementById("docs-new").hidden`), "③ 列表页有「新建长文」");
  await shot("01-list");
  await click(`#docs-body .doc-card[data-doc="${target}"]`);
  await waitFor(`!!document.querySelector("#docs-body .doc-page .md")`, "阅读页画出 Markdown 根");
  ok(await ev(`document.getElementById("docs-new").hidden`), "③ 阅读页收起「新建长文」");

  // ---- ④ 编辑:停笔存草稿 → 预览 → 保存 ----------------------------------------------------------------
  ok(await clickText("#docs-body .doc-bar", "编辑"), "④ 点「编辑」");
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑框");
  await typeArea(MD);
  await sleep(1400); // 停笔 1 秒存一代草稿
  const dk = await draftKeys();
  ok(dk.length === 1 && dk[0] === `zhujian.doc-draft:${sp}:${target}`, "④ 停笔 1 秒存进本机草稿(键 = 空间 + 条目)", dk);
  ok(await ev(`document.querySelector("#docs-body .doc-status").textContent === "草稿已存在本机"`), "④ 状态写「草稿已存在本机」");
  ok(await clickText("#docs-body .doc-seg", "预览"), "④ 切到预览");
  const pv = await ev(`(() => { const p = document.querySelector("#docs-body .doc-preview"); return { h1: p.querySelector("h1")?.textContent, strong: p.querySelector("strong")?.textContent, code: p.querySelector("code.md-code")?.textContent, tasks: p.querySelectorAll("li.md-task").length, disabled: [...p.querySelectorAll(".ckbox")].every((b) => b.disabled), img: p.querySelectorAll("img").length, raw: p.textContent.includes("onerror"), href: p.querySelectorAll("[href]").length }; })()`);
  ok(pv.h1 === "长文验收标题" && pv.strong === "粗体" && pv.code === "行内码" && pv.tasks === 2, "④ 预览认出标题 / 粗体 / 行内码 / 两个方框", pv);
  ok(pv.disabled, "④ 预览里的方框只读(禁用)");
  ok(pv.img === 0 && pv.raw && pv.href === 0, "④ 恶意那行:没有 img 元素、原文当文字留着、全页没有一个 href", pv);
  await shot("02-preview");
  ok(await clickText("#docs-body .doc-bar", "保存"), "④ 点「保存」");
  await waitFor(`!!document.querySelector("#docs-body .doc-page .md h1")`, "保存后回阅读页");
  ok((await draftKeys()).length === 0, "④ 保存成功后清掉草稿");
  ok(await ev(`window.__pwned === undefined && document.querySelectorAll("#docs-body img").length === 0`), "④ 阅读页同样没有 img、也没执行");
  const link = await ev(`(() => { const a = document.querySelector("#docs-body .md .md-link, #docs-body .md .md-link-off"); return a ? { tag: a.tagName, href: a.getAttribute("href"), text: a.textContent } : null; })()`);
  ok(link !== null && link.href === null, "④ 链接画出来了、没有 href(目标只在点击闭包里)", link);
  await shot("03-reader");

  // ---- ⑤ 阅读页勾方框 = 改正文但**不进历史**(纯勾选变更那条豁免,0039);再改一个字落一版 -------------------
  const revs = async () => (await ev(`window.__TAURI__.core.invoke("list_revisions", { spaceId: ${JSON.stringify(sp)}, id: ${JSON.stringify(target)}, before: null })`)).total;
  const before5 = await revs();
  await click(`#docs-body .doc-page li.md-task:not(.on) .ckbox`);
  await waitFor(`document.querySelectorAll("#docs-body .doc-page li.md-task.on").length === 2`, "勾上之后两项都是已勾");
  await sleep(600);
  const cur = await ev(`window.__TAURI__.core.invoke("revision_texts", { spaceId: ${JSON.stringify(sp)}, id: ${JSON.stringify(target)}, a: "current", b: "current" })`);
  ok(cur.a.content.includes("- [x] 待办甲"), "⑤ 勾选写进正文");
  ok((await revs()) === before5, "⑤ 纯勾选不新增历史版本(0039 豁免)", { before5 });
  ok(await clickText("#docs-body .doc-bar", "编辑"), "⑤ 再进编辑器");
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑框");
  await ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.value = a.value.replace("引用一句", "引用两句"); a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  ok(await clickText("#docs-body .doc-bar", "保存"), "⑤ 改一个字、保存");
  await waitFor(`(document.querySelector("#docs-body .doc-page blockquote") || {}).textContent === "引用两句"`, "阅读页显示改后的引用");
  ok((await revs()) === before5 + 1, "⑤ 改字落一版");

  // ---- ⑥ 历史比对 ----------------------------------------------------------------------------------
  ok(await clickText("#docs-body .doc-bar", "历史"), "⑥ 点「历史」");
  await waitFor(`!!document.querySelector("#docs-body .diff")`, "画出差异");
  const hv = await ev(`(() => { const r = document.querySelector("#docs-body"); return { rows: r.querySelectorAll(".hv-row").length, on: [...r.querySelectorAll(".hv-pick.on")].map((b) => b.textContent), del: r.querySelectorAll(".diff-del").length, ins: r.querySelectorAll(".diff-ins").length, hl: [...r.querySelectorAll(".diff-hl")].map((x) => x.textContent), md: r.querySelectorAll(".diff strong, .diff h1").length, head: r.querySelector(".hv-head").textContent }; })()`);
  ok(hv.rows === before5 + 2 && hv.on.length === 2, "⑥ 目录 = 当前 + 每一版历史,默认选中一旧一新", hv);
  ok(hv.del === 1 && hv.ins === 1 && hv.hl.join("|") === "一|两", "⑥ 默认「上一版 → 当前」只比出改的那一行,字级高亮到那一个字", hv);
  ok(hv.md === 0, "⑥ 比对面显示原文、不渲染 Markdown");
  // 换一对:最早那版(展开前的随记原文)作旧 ⇒ 改动量大、仍是原文
  await ev(`(() => { const rows = [...document.querySelectorAll("#docs-body .hv-row")]; rows[rows.length - 1].querySelector(".hv-pick").click(); return true; })()`);
  // ⚠ 别拿表头文字判「重比了」:两版存在同一分钟里时表头一字不差
  await waitFor(`(() => { const rows = [...document.querySelectorAll("#docs-body .hv-row")]; return rows[rows.length - 1].querySelector(".hv-pick").classList.contains("on") && !!document.querySelector("#docs-body .diff"); })()`, "换选择后重比");
  ok(await ev(`document.querySelector("#docs-body .diff").textContent.includes("**粗体**")`), "⑥ 换一对再比:差异里是原文(带 ** 记号)");
  await shot("04-history");

  // ---- ⑦ 返回键逐层回退:历史 → 阅读 → 列表 → 关面 ------------------------------------------------------
  ok((await back()) === true, "⑦ 返回键(历史页)被页面消费");
  await waitFor(`!!document.querySelector("#docs-body .doc-page") && !document.querySelector("#docs-body .hv-list")`, "回到阅读页");
  ok(await pane(), "⑦ 面还开着");
  await back();
  await waitFor(`document.querySelectorAll("#docs-body .doc-card").length === 1`, "回到列表");
  ok(await pane(), "⑦ 面还开着(列表页)");
  await back();
  await waitFor(`!document.body.classList.contains("pane-open")`, "列表页再按返回 = 关面");
  ok(await ev(`document.body.dataset.view === "ideas"`), "⑦ 关面回到随记面");
  await sleep(400);
  ok((await back()) === false, "⑦ 守门条目没留残账(再按一次交还系统)");

  // ---- ⑧ 搜索命中长文 → 跳进阅读页 ---------------------------------------------------------------------
  await click(`#search-toggle`);
  await ev(`(() => { const i = document.getElementById("search-input"); i.value = "长文验收标题"; return true; })()`);
  await click(`#search-btn`);
  await waitFor(`!!document.querySelector('#search-results [data-hit-status="doc"]')`, "命中标「长文」");
  ok(await ev(`document.querySelector('#search-results [data-hit-status="doc"] .pill').textContent === "长文"`), "⑧ 命中徽记写「长文」");
  await click(`#search-results [data-hit-status="doc"]`);
  await waitFor(`!!document.querySelector("#docs-body .doc-page .md h1")`, "跳进那一篇的阅读页");
  ok(await pane(), "⑧ 落在长文面");

  // ---- ⑨ 新建一篇,不点保存、直接关面 = 也落了(离开编辑器即落一版)---------------------------------------
  await back();
  await waitFor(`document.querySelectorAll("#docs-body .doc-card").length === 1`, "回列表");
  await click(`#docs-new`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新建的编辑框");
  await typeArea("# 第二篇\n\n关面也要落下来");
  await click(`#bottombar [data-pane="docs"]`); // 再点同一入口 = 收面(toggle)
  await waitFor(`!document.body.classList.contains("pane-open")`, "收面");
  await sleep(800);
  const all = await ev(`window.__TAURI__.core.invoke("list_docs", { spaceId: ${JSON.stringify(sp)} })`);
  for (const d of all) created.add(d.id);
  ok(all.length === 2 && all.some((d) => d.content.startsWith("# 第二篇")), "⑨ 收面那一发把新篇存成长文", all.map((d) => d.content.slice(0, 8)));
  ok((await draftKeys()).length === 0, "⑨ 存成之后 new 那份草稿也清了");
  // ⑨b 新建一篇,停笔存了草稿再点「保存」:那份草稿的键是 new,阅读页「与正文相同的草稿静默收掉」那条路够不着它
  // ⇒ 只有编辑器自己「保存成功后清本次那一代」能清(已有那篇的两条路分不开,同桌面 819 的记法)。
  await click(`#bottombar [data-pane="docs"]`);
  await waitFor(`document.querySelectorAll("#docs-body .doc-card").length === 2`, "列表两篇");
  await click(`#docs-new`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新建的编辑框");
  await typeArea("# 第三篇\n\n点保存落下");
  await sleep(1400);
  ok((await draftKeys()).some((k) => k.endsWith(":new")), "⑨b 新篇停笔存进 new 草稿");
  ok(await clickText("#docs-body .doc-bar", "保存"), "⑨b 点「保存」");
  await waitFor(`(document.querySelector("#docs-body .doc-page .md h1") || {}).textContent === "第三篇"`, "落到新篇的阅读页");
  ok((await draftKeys()).length === 0, "⑨b 保存成功后 new 那份草稿清了");
  await back();
  await back();
  await waitFor(`!document.body.classList.contains("pane-open")`, "关面");
  all.splice(0, all.length, ...(await ev(`window.__TAURI__.core.invoke("list_docs", { spaceId: ${JSON.stringify(sp)} })`)));
  for (const d of all) created.add(d.id);
  ok(all.length === 3, "⑨b 现在三篇长文", all.length);

  // ---- ⑩ 收回随记:回到随记面;两篇都收回后底栏钮消失 ----------------------------------------------------
  for (const d of all) {
    await click(`#bottombar [data-pane="docs"]`);
    await waitFor(`!!document.querySelector('#docs-body .doc-card[data-doc="${d.id}"]')`, "列表里有这篇");
    await click(`#docs-body .doc-card[data-doc="${d.id}"]`);
    await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页动作排");
    await clickText("#docs-body .doc-acts", "更多…");
    ok(await clickText("#docs-body .doc-acts", "收回随记"), `⑩ 「收回随记」(${d.content.slice(0, 6)})`);
    await waitFor(`!document.querySelector('#docs-body .doc-card[data-doc="${d.id}"]') && !document.querySelector("#docs-body .doc-page")`, "收回后回列表、这篇不在了");
    await back(); // 关面
    await waitFor(`!document.body.classList.contains("pane-open")`, "关面");
    await waitFor(`!!document.querySelector('#timeline .card[data-id="${d.id}"]')`, "随记面重新出现这条");
  }
  ok(!(await docsBtnShown()), "⑩ 一篇长文都没有了:底栏「长文」钮消失");
  await shot("05-back-to-notes");
} catch (e) {
  fails++;
  console.log(`✗ 中断:${e.message}`);
} finally {
  if (DEVICE && created.size > 0) {
    // 真机清场:本趟建过的每一条进回收站再彻底删;草稿键一并清。剩下几条照实印出来(⛔ 不吞)
    const left = await ev(`(async () => { const sp = localStorage.getItem("zhujian.last-space"); const bad = []; for (const id of ${JSON.stringify([...created])}) { try { await window.__TAURI__.core.invoke("archive_note", { spaceId: sp, id }); } catch {} try { await window.__TAURI__.core.invoke("purge_note", { spaceId: sp, id }); } catch (e) { bad.push(id + ":" + e); } } for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k); return bad; })()`).catch((e) => [String(e)]);
    ok(left.length === 0, `清场:本趟建的 ${created.size} 条已彻底删除`, left);
    await ev(`setTimeout(() => location.reload(), 0), true`).catch(() => {});
  }
  await s.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  s.close?.();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 处没过`);
process.exit(fails === 0 ? 0 : 1);
