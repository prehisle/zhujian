// 手机端多看板验收(multiboard-plan §9 第 4 段;安卓 / 鸿蒙共用 android/src/,桌面构型的隔离实例也跑得动)。
//
// 判这几件(全按 core 解析出的角色认,⛔ 不认列 id 字面量):
//   ① 看板切换那排:活看板各一枚(core 给的序)+ 收容区有卡时一枚「已删除的看板 / 列 N」;切过去任务面只画那块的活列。
//   ② 带完成列的看板(下称「流程板」):卡上有勾;勾 = 进它**自己的**完成列(不是种子 `done`)、盖 done_at;
//      取消勾 = 回它的落点;完成列节头有「全部归档」,归的是这块看板(撤销逐条取消归档回来)。
//   ③ 纯分类看板(下称「分类板」):卡上没有勾、没有「全部归档」。
//   ④ 「撤回为随记」的撤销 = 回**原来那块看板**的原列(走 core `promote_back_to`),⛔ 不落默认看板。
//   ⑤ (给了 --peer-* 才跑)撤回与撤销之间对端把那块看板的落点改了 ⇒ 撤销被拒、照实报、卡仍是随记(⛔ 不落新落点还说已撤销);
//      对端改回落点后,随记「更多… → 放进看板」点名流程板 ⇒ 落它的落点。
//   ⑥ 「更多… → 挪到看板」:候选不含卡自己那块;挪到分类板 ⇒ 落它的落点、回执「去看看」切到那块并定位;再挪回来。
//   ⑦ 收容区的卡:状态 chip 不画、没有勾;「挪到看板」把它挪出去 ⇒ 收容区那一格的计数少一。⚠ 这一格**消耗**一张收容卡(见前置)。
//   ⑧ 在分类板上用「记一笔」记一条 ⇒ 落分类板的落点(不是默认看板);清场删掉。
//   ⑨ (backlog 170)归档册按看板筛:流程板与默认看板各有一条成就 ⇒ 顶上一排「全部看板 / 各块」(core 序、只列有成就的)、
//      每条挂来处看板名;点流程板只剩它的、点「全部看板」回来。成就是本资产现造的,清场还原(X 回落点、默认看板那条删掉)。
//   ⑩ (backlog 170,要前置里那张「回收卡」)回收站「还原」一张原看板已删的卡 ⇒ 回执照实说进了「已删除的看板 / 列」、
//      「去看看」切到收容区并定位;清场再把它删回回收站(下次还能跑)。
//
// 前置(⛔ 手机自己建不了看板,用户拍 ⑩):当前空间是从一台能建看板的对端引导来的。台架 = 本机 syncd + headless-peer:
//   server/target/release/zhujian-syncd.exe --listen 127.0.0.1:18902 --data-dir <临时目录>(目录里放空 banlist.txt)
//   tail -f cmds.txt | core/target/debug/examples/headless-peer.exe --server ws://127.0.0.1:18902 --dir <目录> --solo-first > peer.log
//   往 cmds.txt 追加:`board flow 项目甲` / `board one 书单` / `board one 临时` / `newin <甲> 甲卡一` / `newin <甲> 甲卡二` /
//   `newin <书单> 书一` / `newin <临时> 临时卡` / `archive <临时卡>` / `delboard <临时>` / `restore <临时卡>` / `account` / `pair`
//   ⑩ 另要一张「回收站里、原看板已删」的卡,同在 `account` 之前种:`board one 回收` / `newin <回收> 回收卡` / `archive <回收卡>` / `delboard <回收>`
//   (⛔ 不 restore;没有它 ⑩ 跳过并说一声)。
//   → 被测端 `join_space` 用那枚码加入、`activate_space`、回到任务面。真机另 `adb reverse tcp:18902 tcp:18902`。
//   ⚠ 收容卡会被 ⑦ 挪走且随同步传开 ⇒ 下一台被测端开跑前对端再造一张(同上 board / newin / archive / delboard / restore 五条)。
//
// 跑法:
//   桌面构型:node scripts/ui-shots-wide.mjs <目录> --only phone-360x800-ideas --keep → CDP_PORT=9245 node scripts/cdp-acceptance-multiboard.mjs --emulate 360x800 [--peer-cmds cmds.txt --peer-log peer.log]
//   真机 devtools 包:node scripts/android-cdp.mjs forward → node scripts/cdp-acceptance-multiboard.mjs [--peer-cmds … --peer-log …]
// 清场:建的随记 / 卡都删进回收站再销毁;流程板 / 分类板上原有的卡回到原列(位置不保证,列首)。退出码 0 = 全过。
// @cdp-run driver
import { appendFileSync, readFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9222);
const PEER_CMDS = arg("--peer-cmds");
const PEER_LOG = arg("--peer-log");
const J = JSON.stringify;

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const EMU = arg("--emulate");
if (EMU) {
  const [w, h] = EMU.split("x").map(Number);
  await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
}
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + J(extra) : ""}`);
};
const ev = (js) => s.evaluate(js);
const inv = async (cmd, args = {}) => {
  const r = await ev(`window.__TAURI__.core.invoke(${J(cmd)}, ${J(args)}).then((v) => ({ v }), (e) => ({ e: String(e) }))`);
  if (r.e !== undefined) throw new Error(`${cmd}: ${r.e}`);
  return r.v;
};
async function waitFor(expr, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await ev(`(async () => { ${H} return (${expr}); })()`);
      if (v) return v;
    } catch {
      /* 重画途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`);
      return null;
    }
    await sleep(120);
  }
}

// 页内助手(每发 IIFE;⛔ 391:顶层 const 第二次就 SyntaxError)。
const H = `
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const cardOf = (id) => document.querySelector('#timeline article.card[data-id="' + id + '"]');
  const pact = (el, a) => el?.querySelector('.panel [data-pact="' + a + '"]') ?? null;
`;
const page = (body) => ev(`(async () => { ${H} ${body} })()`);

const space = await inv("foreground_space");
const tasks = () => inv("list_tasks", { spaceId: space });
const boards = () => inv("list_boards", { spaceId: space });
const statusOf = async (id) => (await tasks()).find((t) => t.id === id)?.status ?? null;
const isIdea = async (id) => (await inv("list_timeline", { spaceId: space })).some((i) => i.id === id && i.kind === "idea");

/** 点看板切换那排里的一枚(id 或 "@holding")。 */
const pickBoard = (id) =>
  page(`const b = document.querySelector('#filter-boards [data-board="${id}"]'); if (!b) return false; click(b); await new Promise((r) => setTimeout(r, 300)); return true;`);
// 状态那排(窄屏)= 当前看板的全部活列;时间轴本身不画空列(146 §2.1),拿它判「画了哪几列」会漏空列。
const sections = () => page(`return [...document.querySelectorAll("#filter-stages [data-stage]")].map((b) => b.dataset.stage).filter((x) => x !== "all");`);
const openPanel = (id) =>
  page(`const c = cardOf(${J(id)}); if (!c) return false; if (!c.querySelector(".panel")) click(c.querySelector(".body")); return !!c.querySelector(".panel");`);
const clickPact = (id, a) => page(`const b = pact(cardOf(${J(id)}), ${J(a)}); if (!b) return false; click(b); return true;`);
// 回执条在写命令回来、整轴重拉之后才挂 ⇒ 真机上比库里的状态晚一拍:先等那枚钮出现再点(V1986A 上撞过点空)。
// `msg` = 回执正文里必须有的字:上一枚回执(勾完那条也带「撤销」)还挂着时,只认钮名会点到**旧**那条(MuMu 上撞过:
// 撤的是「勾」、不是「全部归档」,卡已在成就册里 ⇒ 报「这条记录已不在」)。
const clickBarAct = async (label, msg = "") => {
  const sel = `(document.getElementById("error").textContent.includes(${J(msg)}) ? [...document.querySelectorAll("#error .bar-act")].find((x) => x.textContent.includes(${J(label)})) : null)`;
  if (!(await waitFor(`!!${sel}`, `回执条上的「${label}」`))) return false;
  return page(`const b = ${sel}; if (!b) return false; click(b); return true;`);
};
const confirmYes = () => page(`const b = document.getElementById("confirmbar-yes"); if (!b || document.getElementById("confirmbar").hidden) return false; click(b); return true;`);
const errText = () => page(`return document.getElementById("error").hidden ? "" : document.getElementById("error").textContent;`);
const peer = async (line, expect) => {
  const before = readFileSync(PEER_LOG, "utf8").length;
  appendFileSync(PEER_CMDS, line + "\n");
  const t0 = Date.now();
  for (;;) {
    const tail = readFileSync(PEER_LOG, "utf8").slice(before);
    if (tail.includes(expect)) return tail;
    if (tail.includes("\nERR ")) throw new Error(`对端拒了「${line}」:${tail}`);
    if (Date.now() - t0 > 8000) throw new Error(`对端没回「${expect}」`);
    await sleep(100);
  }
};

// 起跑:回到任务面(底栏 / 宽屏导航那枚 data-mode=tasks)
await page(`const b = document.querySelector('[data-mode="tasks"]'); if (b && document.body.dataset.view !== "tasks") click(b); return true;`);
await sleep(500);

const bs = await boards();
const live = bs.filter((b) => !b.deleted);
const dflt = live.find((b) => b.is_default);
const flow = live.find((b) => !b.is_default && b.done !== null);
const one = live.find((b) => b.done === null);
const cols = await inv("list_board_columns", { spaceId: space });
const heldCols = cols.filter((c) => c.kind === "task" && (c.deleted || c.board_deleted) && c.live_items > 0);
if (!flow || !one) {
  console.error("前置不满足:要一块带完成列的非默认看板 + 一块纯分类看板(见头注)", J(live));
  process.exit(2);
}
const flowCols = cols.filter((c) => c.board_id === flow.id && !c.deleted).map((c) => c.id);
const t0 = await tasks();
const onFlow = t0.filter((t) => t.status === flow.landing);
if (onFlow.length < 2) {
  console.error("前置不满足:流程板落点列里要至少两张卡", J(onFlow));
  process.exit(2);
}
const [X, Y] = onFlow.map((t) => t.id);
const created = [];

try {
  // ① 切换那排
  const pills = await page(`return [...document.querySelectorAll("#filter-boards [data-board]")].map((b) => b.dataset.board);`);
  const wantPills = [...live.map((b) => b.id), ...(heldCols.length ? ["@holding"] : [])];
  ok(J(pills) === J(wantPills), "① 切换那排 = 活看板(core 序)+ 收容区", { pills, wantPills });
  await pickBoard(flow.id);
  ok(J(await sections()) === J(flowCols), "① 切到流程板:状态那排 = 它的活列(别的看板的列不在)", { got: await sections(), flowCols });

  // ② 勾 / 取消勾 / 全部归档
  ok(await page(`return !!cardOf(${J(X)})?.querySelector(".tick input")`), "② 流程板的卡上有勾");
  await page(`click(cardOf(${J(X)}).querySelector(".tick input")); return true;`);
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(X)})?.status === ${J(flow.done)})()`, "勾完进流程板自己的完成列");
  const xt = (await tasks()).find((t) => t.id === X);
  ok(xt.status === flow.done && xt.status !== "done" && xt.done_at !== null, "② 勾 = 进它自己的完成列、盖 done_at", { status: xt.status, done_at: xt.done_at });
  ok(!!(await waitFor(`!!document.querySelector('#timeline .tl-group[data-col=${J(flow.done)}] [data-seal-all]')`, "完成列节头的「全部归档」")), "② 完成列节头有「全部归档」");
  await page(`click(document.querySelector('#timeline .tl-group[data-col=${J(flow.done)}] [data-seal-all]')); return true;`);
  await waitFor(`!document.getElementById("confirmbar").hidden`, "全部归档的确认条");
  await confirmYes();
  ok(!!(await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_sealed_tasks", { spaceId: ${J(space)} })).some((t) => t.id === ${J(X)}))()`, "X 进了成就册")), "② 全部归档归的是流程板的完成列");
  await clickBarAct("撤销", "已归档");
  ok(!!(await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(X)})?.status === ${J(flow.done)})()`, "撤销全部归档 → X 回完成列")), "② 撤销全部归档 → 回流程板完成列");
  await waitFor(`!!cardOf(${J(X)})?.querySelector(".tick input:checked")`, "X 的勾在屏上");
  await page(`click(cardOf(${J(X)}).querySelector(".tick input")); return true;`);
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(X)})?.status === ${J(flow.landing)})()`, "取消勾回落点");
  ok((await statusOf(X)) === flow.landing, "② 取消勾 = 回流程板的落点");

  // ③ 分类板
  await pickBoard(one.id);
  const oneView = await page(`return { ticks: document.querySelectorAll("#timeline .tick").length, cards: document.querySelectorAll("#timeline article.card").length, sealAll: document.querySelectorAll("#timeline [data-seal-all]").length };`);
  ok(oneView.cards > 0 && oneView.ticks === 0 && oneView.sealAll === 0, "③ 分类板:有卡、没有勾、没有全部归档", oneView);

  // ④ 撤回为随记 → 撤销回原看板原列
  await pickBoard(flow.id);
  await sleep(300);
  await openPanel(X);
  await clickPact(X, "more");
  ok(await clickPact(X, "revert"), "④ 落点里的卡「更多…」有「撤回为随记」");
  await waitFor(`!document.getElementById("confirmbar").hidden`, "撤回的确认条");
  await confirmYes();
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_timeline", { spaceId: ${J(space)} })).some((i) => i.id === ${J(X)} && i.kind === "idea"))()`, "X 成了随记");
  await clickBarAct("撤销");
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(X)})?.status === ${J(flow.landing)})()`, "撤销回流程板落点");
  ok((await statusOf(X)) === flow.landing && flow.landing !== dflt.landing, "④ 撤销 = 回原来那块看板的原列(不是默认看板)", { status: await statusOf(X) });

  // ⑤ 撤回与撤销之间对端改了落点 ⇒ 撤销被拒
  if (PEER_CMDS && PEER_LOG) {
    const other = flowCols.find((c) => c !== flow.landing && c !== flow.done);
    await waitFor(`!!cardOf(${J(X)})`, "X 回到屏上");
    await openPanel(X);
    await clickPact(X, "more");
    await clickPact(X, "revert");
    await waitFor(`!document.getElementById("confirmbar").hidden`, "撤回的确认条");
    await confirmYes();
    await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_timeline", { spaceId: ${J(space)} })).some((i) => i.id === ${J(X)} && i.kind === "idea"))()`, "X 又成了随记");
    await peer(`landing ${flow.id} ${other}`, "OK landing");
    await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_boards", { spaceId: ${J(space)} })).find((b) => b.id === ${J(flow.id)})?.landing === ${J(other)})()`, "对端改的落点同步到本机", 20000);
    await clickBarAct("撤销");
    await sleep(1500);
    const why = await errText();
    ok((await isIdea(X)) && !why.includes("已撤销"), "⑤ 落点被改 ⇒ 撤销被拒、卡仍是随记、没说「已撤销」", { why });
    await peer(`landing ${flow.id} ${flow.landing}`, "OK landing");
    await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_boards", { spaceId: ${J(space)} })).find((b) => b.id === ${J(flow.id)})?.landing === ${J(flow.landing)})()`, "落点改回同步到本机", 20000);
    // 随记「放进看板 ▸」点名流程板
    await page(`const b = document.querySelector('[data-mode="ideas"]'); click(b); return true;`);
    await waitFor(`!!cardOf(${J(X)})`, "随记面上的 X");
    await openPanel(X);
    await clickPact(X, "more");
    ok(await clickPact(X, "board"), "⑤ 随记「更多…」有「放进看板」(活看板 ≥ 2)");
    const cand = await page(`return [...cardOf(${J(X)}).querySelectorAll("[data-board-to]")].map((b) => b.dataset.boardTo);`);
    ok(J(cand) === J(live.map((b) => b.id)), "⑤ 放进看板的候选 = 全部活看板", cand);
    await page(`click(cardOf(${J(X)}).querySelector('[data-board-to=${J(flow.id)}]')); return true;`);
    await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(X)})?.status === ${J(flow.landing)})()`, "放进流程板");
    ok((await statusOf(X)) === flow.landing, "⑤ 放进看板 = 落点名那块的落点");
    await clickBarAct("去看看");
    ok(!!(await waitFor(`document.body.dataset.view === "tasks" && !!document.querySelector('#filter-boards [data-board=${J(flow.id)}].active') && !!cardOf(${J(X)})`, "去看看切到流程板并定位")), "⑤ 回执「去看看」切到流程板并定位");
  } else {
    console.log("· ⑤ 跳过(没给 --peer-cmds / --peer-log)");
  }

  // ⑥ 挪到看板
  await pickBoard(flow.id);
  await openPanel(Y);
  await clickPact(Y, "more");
  ok(await clickPact(Y, "board"), "⑥ 任务卡「更多…」有「挪到看板」");
  const cand = await page(`return [...cardOf(${J(Y)}).querySelectorAll("[data-board-to]")].map((b) => b.dataset.boardTo);`);
  ok(!cand.includes(flow.id) && cand.includes(one.id), "⑥ 候选不含卡自己那块", cand);
  await page(`click(cardOf(${J(Y)}).querySelector('[data-board-to=${J(one.id)}]')); return true;`);
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(Y)})?.status === ${J(one.landing)})()`, "Y 挪到分类板");
  ok((await statusOf(Y)) === one.landing, "⑥ 挪到分类板 = 落它的落点");
  await clickBarAct("去看看");
  ok(!!(await waitFor(`!!document.querySelector('#filter-boards [data-board=${J(one.id)}].active') && !!cardOf(${J(Y)})`, "去看看切到分类板")), "⑥ 回执「去看看」切到分类板并定位");
  await openPanel(Y);
  await clickPact(Y, "more");
  await clickPact(Y, "board");
  await page(`click(cardOf(${J(Y)}).querySelector('[data-board-to=${J(flow.id)}]')); return true;`);
  await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(Y)})?.status === ${J(flow.landing)})()`, "Y 挪回流程板");
  ok((await statusOf(Y)) === flow.landing, "⑥ 再挪回流程板");

  // ⑦ 收容区
  if (heldCols.length) {
    const held = (await tasks()).find((t) => heldCols.some((c) => c.id === t.status));
    const n0 = heldCols.reduce((n, c) => n + c.live_items, 0);
    ok(await pickBoard("@holding"), "⑦ 切到收容区");
    await waitFor(`!!cardOf(${J(held.id)})`, "收容卡在屏上");
    const hv = await page(`const c = cardOf(${J(held.id)}); return { tick: !!c.querySelector(".tick"), note: !document.getElementById("board-note").hidden };`);
    ok(!hv.tick && hv.note, "⑦ 收容卡没有勾、顶上有说明", hv);
    await openPanel(held.id);
    const hasStatus = await page(`return !!cardOf(${J(held.id)}).querySelector('.panel [data-pact="status"]');`);
    ok(!hasStatus, "⑦ 收容卡没有状态 chip");
    await clickPact(held.id, "more");
    ok(await clickPact(held.id, "board"), "⑦ 收容卡「更多…」有「挪到看板」");
    await page(`click(cardOf(${J(held.id)}).querySelector('[data-board-to=${J(flow.id)}]')); return true;`);
    await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.id === ${J(held.id)})?.status === ${J(flow.landing)})()`, "收容卡挪出");
    ok((await statusOf(held.id)) === flow.landing, "⑦ 收容卡挪到流程板 = 落它的落点");
    const pillN = await waitFor(
      `(() => { const p = document.querySelector('#filter-boards [data-board="@holding"] .fn'); const n = p ? Number(p.textContent) : 0; return n === ${n0 - 1} ? { n } : null; })()`,
      "收容区计数少一",
    );
    ok(pillN !== null, "⑦ 收容区计数少一(空了那一枚就不画)", { pillN, n0 });
  } else {
    console.log("· ⑦ 跳过(收容区是空的;见头注怎么再造一张)");
  }

  // ⑧ 在分类板上记一笔
  await pickBoard(one.id);
  const MARK = `多看板验收-${Date.now()}`;
  await page(`
    click(document.getElementById("capture-fab"));
    await new Promise((r) => setTimeout(r, 400));
    const ta = document.getElementById("text");
    ta.value = ${J(MARK)}; ta.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("save")); return true;`);
  const newId = await waitFor(`(async () => (await window.__TAURI__.core.invoke("list_tasks", { spaceId: ${J(space)} })).find((t) => t.title === ${J(MARK)})?.id ?? null)()`, "记下的那张");
  if (newId) {
    created.push(newId);
    ok((await statusOf(newId)) === one.landing, "⑧ 在分类板上记一笔 = 落分类板的落点(不是默认看板)", { status: await statusOf(newId) });
  }

  // ⑨ 归档册按看板筛(backlog 170)。X 此刻在流程板落点(⑤ / ⑥ 之后);默认看板那条现造。
  {
    const D = `多看板验收-成就-${Date.now()}`;
    const dId = await inv("capture_todo", { spaceId: space, content: D, boardId: dflt.id });
    created.push(dId);
    for (const id of [X, dId]) {
      await inv("complete_task", { spaceId: space, id });
      await inv("seal_task", { spaceId: space, id });
    }
    const sealed = await inv("list_sealed_tasks", { spaceId: space });
    const colsNow = await inv("list_board_columns", { spaceId: space });
    const boardOf = (st) => colsNow.find((c) => c.id === st)?.board_id ?? null;
    const wantPills = ["", ...bs.map((b) => b.id).filter((id) => sealed.some((r) => boardOf(r.status) === id))];
    await page(`const b = document.querySelector('[data-pane="sealed"]'); click(b); return true;`);
    const got = await waitFor(
      `(() => { const p = [...document.querySelectorAll("#sealed-list [data-sealed-board]")].map((b) => b.dataset.sealedBoard); return p.length ? p : null; })()`,
      "归档册顶上的看板那排",
    );
    ok(J(got) === J(wantPills), "⑨ 归档册那排 = 「全部看板」+ 有成就的各块(core 序)", { got, wantPills });
    const tags = await page(`return { x: cardOf2(${J(X)})?.querySelector("footer .pill")?.textContent ?? null, d: cardOf2(${J(dId)})?.querySelector("footer .pill")?.textContent ?? null };
      function cardOf2(id) { return document.querySelector('#sealed-list [data-sealed="' + id + '"]'); }`);
    ok(tags.x === flow.title && tags.d !== null && tags.d !== flow.title, "⑨ 每条挂来处看板名", tags);
    await page(`const b = document.querySelector('#sealed-list [data-sealed-board=${J(flow.id)}]'); if (b) click(b); return !!b;`);
    const onlyFlow = await page(`return [...document.querySelectorAll("#sealed-list [data-sealed]")].map((c) => c.dataset.sealed);`);
    const flowSealed = sealed.filter((r) => boardOf(r.status) === flow.id).map((r) => r.id);
    ok(onlyFlow.includes(X) && !onlyFlow.includes(dId) && onlyFlow.every((id) => flowSealed.includes(id)), "⑨ 点流程板 ⇒ 只剩它的成就", { onlyFlow });
    ok(await page(`return !!document.querySelector('#sealed-list [data-sealed-board=${J(flow.id)}].active');`), "⑨ 点中的那枚高亮");
    await page(`const b = document.querySelector('#sealed-list [data-sealed-board=""]'); if (b) click(b); return !!b;`);
    const all = await page(`return [...document.querySelectorAll("#sealed-list [data-sealed]")].map((c) => c.dataset.sealed);`);
    ok(all.includes(X) && all.includes(dId), "⑨ 点「全部看板」两条都回来");
    // 清场:X 取消归档、回落点;默认看板那条在 finally 里删
    await inv("unseal_task", { spaceId: space, id: X });
    await inv("update_task_status", { spaceId: space, id: X, to: flow.landing });
    await inv("unseal_task", { spaceId: space, id: dId });
    await page(`const b = document.querySelector('[data-mode="tasks"]'); click(b); return true;`);
    await sleep(500);
  }

  // ⑩ 回收站还原进收容区(backlog 170)
  {
    const trash = await inv("list_trash", { spaceId: space });
    const colsNow = await inv("list_board_columns", { spaceId: space });
    const heldNow = (st) => colsNow.some((c) => c.id === st && c.kind === "task" && (c.deleted || c.board_deleted));
    const R = trash.find((r) => heldNow(r.stage));
    if (R) {
      await page(`const b = document.querySelector('[data-pane="trash"]'); click(b); return true;`);
      await waitFor(`!!document.querySelector('#trash-list [data-trash=${J(R.id)}]')`, "回收站里那张回收卡");
      await page(`const b = document.querySelector('#trash-list [data-trash=${J(R.id)}] .body'); if (b) click(b); return !!b;`);
      await waitFor(`!!document.querySelector('#trash-list [data-trash=${J(R.id)}] [data-trash-act="restore"]')`, "还原钮");
      await page(`const b = document.querySelector('#trash-list [data-trash=${J(R.id)}] [data-trash-act="restore"]'); if (b) click(b); return !!b;`);
      const bar = await waitFor(`(() => { const e = document.getElementById("error"); return !e.hidden && e.textContent.includes("已删除的看板") ? e.textContent : null; })()`, "还原回执");
      ok(bar !== null && !bar.includes("已还原到看板「"), "⑩ 原看板已删 ⇒ 回执说进了「已删除的看板 / 列」", { bar });
      await clickBarAct("去看看", "已删除的看板");
      ok(
        !!(await waitFor(`document.body.dataset.view === "tasks" && !!document.querySelector('#filter-boards [data-board="@holding"].active') && !!cardOf(${J(R.id)})`, "去看看切到收容区并定位")),
        "⑩ 「去看看」切到收容区并定位",
      );
      await inv("archive_task", { spaceId: space, id: R.id }); // 删回回收站,下次还能跑
    } else {
      console.log("· ⑩ 跳过(回收站里没有原看板 / 列已删的卡;见头注怎么种)");
    }
  }
} finally {
  for (const id of created) {
    await inv("archive_task", { spaceId: space, id }).catch(() => {});
    await inv("purge_task", { spaceId: space, id }).catch(() => {});
  }
}
console.log(fails === 0 ? "\nPASS" : `\nFAIL(${fails} 格)`);
process.exit(fails === 0 ? 0 : 1);
