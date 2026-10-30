// 手机长文面「移动到其他空间」验收(backlog 152:820 留下的手机缺口,824 补):阅读页「更多…」里的「移动」,照卡片
// 操作面那套(cross-space-move §2.7)。
//
// 分两半,判据都读 DOM / localStorage / 命令回包:
//   真移动(真后端,不拦截):单空间时「更多…」里没有「移动」→ 建一个测试空间、重载后出现 → 选择器先亮
//     「历史版本会永久删除」→ 点目标出两拍确认 → 确认后回列表、回执「已移到「…」」、**没有**多报「已不在长文里」、
//     源空间 list_docs 里没了 → 切到目标空间,那篇**还是长文**(list_docs 里有、正文逐字相同)→ 切回。
//   结果分道(页内假造回包):部分成功两态与预检拒在真后端上造不出来 ⇒ 在 `window.ipc.postMessage`(安卓的 IPC 走
//     postMessage,不走 fetch)截下 `move_item_to_space`,按要的 outcome 直接回调。⭐ 先自证拦截真生效了:假造 moved
//     之后那篇在真库里**还在**(823 栽过:拦截静默无效时读到的是真结果)。
//     kept / unconfirmed → 先落登记(localStorage `zhujian.move-partial` 有 `<空间>/<id>`)、回主行显常驻提示、「更多…」
//     里没有「移动」;「我已处理」→ 提示消失、入口回来。images_pending / dangling_refs → 报错条、停在选择器、可再点。
//
// ⛔ **会写库、会建删空间**:只动自己种的(一篇题目带「移动验收」的长文 + 一个叫「移动验收」的空间);开跑前已有同名
//    空间就拒跑;收尾 purge 种的长文、reset_space 删测试空间(目标空间里那份随空间一起没了)。种子不同步出去的前提是
//    当前空间没配过账户(配过就拒跑,`--allow-synced` 放行 —— 墓碑会同步到同账户的其它设备)。
//
// 跑法(MuMu / 真机的 devtools 包;先 `node scripts/android-cdp.mjs forward`):
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs-move.mjs [--shots <目录>]
// 退出码 0 = 全过。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9222);
const SHOTS = arg("--shots");
const ALLOW_SYNCED = argv.includes("--allow-synced");
const SPACE_NAME = "移动验收";
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
      /* 重画 / 重载途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`, expr);
      return false;
    }
    await sleep(150);
  }
}
const inv = (cmd, args) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
/** 点 `#docs-body` 里文字恰为 `text` 的那枚按钮。 */
const clickText = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll("#docs-body button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
const hasBtn = (text) => ev(`[...document.querySelectorAll("#docs-body button")].some((x) => x.textContent.trim() === ${JSON.stringify(text)})`);
const bar = () => ev(`(() => { const e = document.getElementById("error"); return e.hidden ? null : e.textContent; })()`);
const hideBar = () => ev(`document.getElementById("error").hidden = true`);
const shot = async (name) => {
  if (!SHOTS) return;
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
};
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar") && !!window.__TAURI__`, "页面就绪", 30000);
}
/** 开长文面、点进那一篇的阅读页、展开「更多…」。 */
async function openReader(id) {
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!!document.querySelector('#docs-body [data-doc="${id}"]')`, "列表里有种的那篇");
  await ev(`document.querySelector('#docs-body [data-doc="${id}"]').click()`);
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页");
}
async function openMore() {
  await clickText("更多…");
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-acts button")].some((b) => b.textContent.trim() === "删除")`, "「更多…」那排");
}
/** 截下下一发 move_item_to_space,回 `fake`(安卓 IPC = window.ipc.postMessage(JSON 串))。 */
const armFake = (fake) =>
  ev(`(() => {
    if (!window.__moveReal) window.__moveReal = window.ipc;
    window.__moveHits = 0;
    const real = window.__moveReal;
    window.ipc = { postMessage(d) {
      const m = JSON.parse(d);
      if (m.cmd === "move_item_to_space") { window.__moveHits++; setTimeout(() => window.__TAURI_INTERNALS__.runCallback(m.callback, ${JSON.stringify(fake)}), 200); return; }
      real.postMessage(d);
    } };
    return window.ipc !== real;
  })()`);
const disarm = () => ev(`window.__moveReal && (window.ipc = window.__moveReal), true`);

let tid = null;
let sp = null;
const seeded = [];
try {
  sp = await ev(`localStorage.getItem("zhujian.last-space")`);
  const spaces = await inv("list_spaces", {});
  const cur = spaces.find((x) => x.id === sp);
  if (!cur) throw new Error(`当前空间 ${sp} 不在 list_spaces 里`);
  if (cur.configured && !ALLOW_SYNCED) throw new Error(`当前空间配过账户,种子与墓碑会同步出去 —— 确认是测试账户再带 --allow-synced`);
  if (spaces.some((x) => x.name === SPACE_NAME)) throw new Error(`已有名为「${SPACE_NAME}」的空间(上一趟没收尾?)—— 先手工 reset_space`);
  const single = spaces.length === 1;

  const BODY = "# 移动验收\n\n第二段 **粗体**,验完即删。\n";
  const id = await inv("capture_doc", { spaceId: sp, content: BODY });
  seeded.push(id);
  await inv("edit_note", { spaceId: sp, id, content: BODY + "\n改过一版。\n" });
  const TEXT = BODY + "\n改过一版。\n";

  // ① 单空间:「更多…」里没有「移动」(多空间的机器上跳过这格)
  await reload();
  if (single) {
    await openReader(id);
    await openMore();
    ok(!(await hasBtn("移动")), "① 只有一个空间时「更多…」里没有「移动」");
    await ev(`window.__zhujianHandleBack(); window.__zhujianHandleBack(); window.__zhujianHandleBack()`);
  } else console.log("· ① 跳过:这台本来就不止一个空间");

  // ② 建测试空间,重载后出现
  tid = await inv("create_space", { name: SPACE_NAME });
  await reload();
  await openReader(id);
  await openMore();
  ok(await hasBtn("移动"), "② 有第二个空间后「更多…」里出现「移动」");
  const order = await ev(`[...document.querySelectorAll("#docs-body .doc-acts .acts:first-child button")].map((b) => b.textContent.trim())`);
  ok(order[order.length - 1] === "删除" && order.indexOf("移动") === order.length - 2, "② 「移动」在「删除」前、删除仍在最后", order);

  // ③ 选择器:警示在选之前、目标是测试空间、返回回「更多…」
  await clickText("移动");
  await waitFor(`!!document.querySelector("#docs-body .movewarn")`, "选择器");
  const warn = await ev(`document.querySelector("#docs-body .movewarn").textContent`);
  ok(/历史版本会随移动永久删除/.test(warn), "③ 选择器先说历史版本随移动永久删除", warn);
  ok(await hasBtn(SPACE_NAME), "③ 目标列出测试空间");
  await shot("move-picker");
  await ev(`window.__zhujianHandleBack()`);
  ok(await ev(`!document.querySelector("#docs-body .movewarn") && [...document.querySelectorAll("#docs-body button")].some((b) => b.textContent.trim() === "删除")`), "③ 返回键从选择器回到「更多…」");

  // ④ 结果分道:先假造(拦截自证),最后再真移
  await clickText("移动");
  await waitFor(`!!document.querySelector("#docs-body .movewarn")`, "选择器");
  const pick = async () => {
    await hideBar();
    ok(await clickText(SPACE_NAME), "点目标");
    await waitFor(`!document.getElementById("confirmbar").hidden`, "两拍确认条");
    const q = await ev(`document.getElementById("confirmbar-q").textContent + " / " + document.getElementById("confirmbar-yes").textContent`);
    ok(q === `移到「${SPACE_NAME}」?历史版本会永久删除 / 确认移动`, "两拍确认条的问句与钮", q);
    await ev(`document.getElementById("confirmbar-yes").click()`);
  };

  // ④a moved(假):拦截生效 = 回执出、回列表,而真库里那篇还在
  ok(await armFake({ outcome: "moved", new_id: "x", source_already_gone: false }), "④ 装上拦截");
  await pick();
  await waitFor(`!document.querySelector("#docs-body .doc-acts")`, "回列表");
  const b1 = await bar();
  ok(b1 === `已移到「${SPACE_NAME}」`, "④a moved → 回执、回列表", b1);
  ok((await ev(`window.__moveHits`)) === 1, "④a 拦截真截下了那一发");
  const still = (await inv("list_docs", { spaceId: sp })).some((d) => d.id === id);
  ok(still, "④a 自证:真库里那篇还在(回执来自假回包)");
  await sleep(600);
  ok(!/已不在长文里/.test((await bar()) ?? ""), "④a 没有多报「已不在长文里」");

  // ④b kept:先落登记、回主行显提示、「更多…」没有「移动」;我已处理 → 回来
  await ev(`document.querySelector('#docs-body [data-doc="${id}"]').click()`);
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页");
  await openMore();
  await clickText("移动");
  await armFake({ outcome: "copied_but_source_kept", new_id: "x", reason: "原条目有未同步的改动" });
  await pick();
  await waitFor(`!!document.querySelector("#docs-body .movenote")`, "常驻提示");
  const reg = await ev(`JSON.parse(localStorage.getItem("zhujian.move-partial") || "{}")[${JSON.stringify(`${sp}/${id}`)}] ?? null`);
  ok(reg !== null && reg.includes("原条目已保留"), "④b kept → 登记落在 <空间>/<id>", reg);
  ok((await ev(`document.querySelector("#docs-body .movenote span").textContent`)) === reg, "④b 阅读页显登记原话");
  ok((await bar()) === `已复制到「${SPACE_NAME}」,原条目保留`, "④b 回执", await bar());
  await shot("move-partial");
  await openMore();
  ok(!(await hasBtn("移动")), "④b 登记在场时「更多…」里没有「移动」");
  await ev(`window.__zhujianHandleBack()`);
  ok(await clickText("我已处理"), "④b 点「我已处理」");
  await waitFor(`!document.querySelector("#docs-body .movenote")`, "提示消失");
  ok((await ev(`JSON.parse(localStorage.getItem("zhujian.move-partial") || "{}")[${JSON.stringify(`${sp}/${id}`)}] ?? null`)) === null, "④b 解除后登记清掉");
  await openMore();
  ok(await hasBtn("移动"), "④b 解除后「移动」回来");

  // ④c unconfirmed:同形,话术不谎报「保留」
  await clickText("移动");
  await armFake({ outcome: "copied_but_source_unconfirmed", new_id: "x", error: "超时" });
  await pick();
  await waitFor(`!!document.querySelector("#docs-body .movenote")`, "常驻提示");
  const n2 = await ev(`document.querySelector("#docs-body .movenote span").textContent`);
  ok(/删除未确认/.test(n2) && !/已保留/.test(n2), "④c unconfirmed → 提示说未确认、不说保留", n2);
  await clickText("我已处理");
  await waitFor(`!document.querySelector("#docs-body .movenote")`, "提示消失");

  // ④d images_pending / dangling_refs:报错条、停在选择器、可再点
  await openMore();
  await clickText("移动");
  for (const [fake, want] of [
    [{ outcome: "images_pending", count: 2 }, "有 2 张配图还没同步到齐,等完成再移"],
    [{ outcome: "dangling_refs", seqs: [3] }, "正文引用了已删除的配图,暂不支持跨空间移动"],
  ]) {
    await armFake(fake);
    await pick();
    await waitFor(`!!document.getElementById("error") && !document.getElementById("error").hidden`, "报错条");
    ok((await bar()) === want, `④d ${fake.outcome} → 报原话`, await bar());
    await waitFor(`[...document.querySelectorAll("#docs-body .movewarn ~ .lane button")].some((b) => b.textContent.trim() === ${JSON.stringify(SPACE_NAME)} && !b.disabled)`, `${fake.outcome} 后停在选择器、目标可再点`);
  }
  await disarm();
  ok((await ev(`window.ipc === window.__moveReal`)) === true, "④ 拦截已撤");

  // ⑤ 真移动
  await pick();
  await waitFor(`!document.querySelector("#docs-body .doc-acts")`, "回列表", 20000);
  const b5 = await bar();
  ok(b5 === `已移到「${SPACE_NAME}」`, "⑤ 真移动 → 回执、回列表", b5);
  await shot("moved-list");
  ok(!(await inv("list_docs", { spaceId: sp })).some((d) => d.id === id), "⑤ 源空间 list_docs 里没了");
  ok(!(await ev(`!!document.querySelector('#docs-body [data-doc="${id}"]')`)), "⑤ 列表里没了");
  await sleep(600);
  ok(!/已不在长文里/.test((await bar()) ?? ""), "⑤ 没有多报「已不在长文里」");
  seeded.length = 0; // 源那份已删(墓碑),不再 purge

  // ⑥ 目标空间里还是长文
  await inv("activate_space", { spaceId: tid });
  const there = await inv("list_docs", { spaceId: tid });
  ok(there.length === 1 && there[0].content === TEXT, "⑥ 目标空间里是一篇长文、正文逐字相同", there.map((d) => d.content.slice(0, 20)));
  await inv("activate_space", { spaceId: sp });
} catch (e) {
  ok(false, `中断:${e.message}`);
} finally {
  try {
    await disarm();
  } catch {
    /* 页面可能在重载 */
  }
  try {
    for (const id of seeded) {
      await inv("archive_note", { spaceId: sp, id });
      await inv("purge_note", { spaceId: sp, id });
    }
    if ((await ev(`localStorage.getItem("zhujian.last-space")`)) !== sp) await inv("activate_space", { spaceId: sp });
    if (tid) await inv("reset_space", { spaceId: tid });
    const left = await inv("list_spaces", {});
    ok(!left.some((x) => x.name === SPACE_NAME), "收尾:测试空间已删", left.map((x) => x.name ?? x.id));
    await reload();
  } catch (e) {
    ok(false, `收尾失败:${e.message}(手工清:测试空间 ${tid}、长文 ${seeded.join(",")})`);
  }
  s.close();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 处不过`);
process.exit(fails === 0 ? 0 : 1);
