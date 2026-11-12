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
//   ⑪–⑳(多看板优化 mbopt,手机组 M1–M13;要两块**空着的**看板:对端 `board flow 空板` / `board one 空类`,缺了整段跳过):
//   ⑪ M1 「挪到看板」「放进看板」的候选不含落点 ⊥ 的看板;⑫ M2 当前看板落点 ⊥ ⇒ ＋ 与「记下」事前灰、灰字 / 点 ＋ 说原因、
//      空态不再指 ＋(落点 ⊥ 造不出来 ⇒ 另开一条 CDP 连接用 Fetch 截 `ipc.localhost/list_boards` 把那块的 landing 读成 null,
//      见 mbopt() 头注;要 --peer-* 触发刷新,没给就跳过 ⑪ ⑫);⑬ M3 空态只说这块看板(归档数只数它的成就、无完成列不提归档、
//      「转待办」只在默认看板;来回切空看板一轮刷新只问一次成就册);⑭ M12 横放空看板画各列、空态在第一列,单列看板 ≤ 560 居中;
//      ⑮ M4 横滚位置按看板记;⑯ M5 对照(⑦ 里那格判收容卡长按不拎起);⑰ M9 过滤框不单占一行(横放并进切换排右端、
//      有标签时标签行在下一行;竖放无标签并进「列」那排);⑱ M13 切过去的那枚看板钮滚进视野;⑲ M8 切看板清标签筛选;
//      ⑳ M11 横放收起顶栏后屏顶细条写当前看板名。⑦ 另加:M10 说明的位置(竖放 = 时间轴首行、横放 = 筛选条一行)、M5。
//   阴性对照(mbopt 当轮按 mutation-check「手工三步」逐把实跑过,红的就是写的那几格):候选改回 liveBoards ⇒ ⑪ 两格;
//   landingBlocked 恒 null ⇒ ⑫ 四格;成就数不按看板滤 ⇒ ⑬「只数这块」;不缓存 ⇒ ⑬「不再重问」(3 → 5);横滚只按空间记 ⇒ ⑮;
//   carddrag 不判收容 ⇒ ⑦ M5;删 `.boards-on .ftext { order }` ⇒ ⑰「有标签」那格;emptyBoardCols 恒 false ⇒ ⑭;
//   enterBoard 不清标签 ⇒ ⑲;细条不读看板名 ⇒ ⑳;revealActiveBoard 恒早退 ⇒ ⑱(360);heldNote 恒空 ⇒ ⑦(360);
//   stagesInline 恒 false ⇒ ⑰ 竖放那格(360)。
//   ㉑–㉕(多看板优化第二波,手机组 N1–N5;同要两块空看板 + --peer-*,在 ⑳ 之后、同一条 IPC 截口上):
//   ㉑ N1 前端只认 core 的 `accepts_cards` / `held`:截 `list_board_columns` 把流程板中间那列的 accepts_cards 读成 false ⇒ 状态那排
//      不再有它;把真收容列的 held 读成 false、流程板落点列读成 held ⇒ 收容那枚的数 = 落点列的活卡数(两向都只看字段,不看 deleted 拼);
//   ㉒ N2 切换排上看板名旁的灰小字 = core `open_items`(不在完成列的活卡;先把 Y 勾进完成列,好让 open ≠ live),0 不显;
//   ㉓ N3 空态那句归档数改问 `sealed_counts_by_board`(⑬ 里数的就是它的调用次数;另核数 = 它给 E 那一组);
//   ㉔ N5 落点 ⊥ 时再点当前页签(「一步回捕获」)也拦:不开记一笔、说原因(在 ⑫ 里);
//   ㉕ N5 默认看板落点 ⊥ ⇒ 随记「转待办」事前灰(.blocked + aria-disabled)、点了说原因、不打后端(卡仍是随记);恢复后不灰。
//   另 N4:底栏 / 宽屏导航那枚 data-mode=tasks 写「看板」(中文界面)。
//   阴性对照(第二波按「手工三步」逐把实跑,红的就是写的那几格):boardColumns 改回 deleted 拼 ⇒ ㉑「中间那列」;holdingColumns 改回
//   deleted 拼 ⇒ ㉑「收容数」;切换排改用 live_items ⇒ ㉒「每枚的数」;0 也显 ⇒ ㉒「0 不显」;onModeButton 不拦 ⇒ ㉔;promoteBlocked 恒 null ⇒ ㉕;
//   空态归档数取 sealed_counts_by_board 各组之和 ⇒ ⑬「只数这块」与 ㉓。
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
//   ⚠ 对端 `account` 之后再建看板要先 `latch`(headless-peer 头注);⑦ 挪出来的收容卡留在流程板落点 —— 连跑几趟攒多了,
//   横放 360 高里一列装不下,「去看看」的平滑滚动会把刚点开的面收掉(openPanel 已重试三回),仍抖就先把那几张删进回收站。
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
// 点开后再等一拍看它还在不在:「去看看」那一下的平滑滚动还没停时点开,滚动会把刚开的面收掉(滚走 = 收面)—— 列里卡一多就撞上
// (mbopt 连跑几趟、流程板攒到七张时实撞)⇒ 没开住就隔一会儿再点,至多三回。
const openPanel = (id) =>
  page(`for (let i = 0; i < 3; i++) {
      const c = cardOf(${J(id)}); if (!c) return false;
      if (!c.querySelector(".panel")) click(c.querySelector(".body"));
      await new Promise((r) => setTimeout(r, 350));
      if (cardOf(${J(id)})?.querySelector(".panel")) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;`);
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
// 收容区非空 = 有 `held && live_items > 0` 的列(core 解析;mbopt 第二波起资产也只认字段)。
const heldCols = cols.filter((c) => c.held && c.live_items > 0);
if (!flow || !one) {
  console.error("前置不满足:要一块带完成列的非默认看板 + 一块纯分类看板(见头注)", J(live));
  process.exit(2);
}
const flowCols = cols.filter((c) => c.board_id === flow.id && c.accepts_cards).map((c) => c.id);
const t0 = await tasks();
const onFlow = t0.filter((t) => t.status === flow.landing);
if (onFlow.length < 2) {
  console.error("前置不满足:流程板落点列里要至少两张卡", J(onFlow));
  process.exit(2);
}
const [X, Y] = onFlow.map((t) => t.id);
const created = [];
/** 长按一张卡(合成 pointer,LONG_PRESS_MS 380 之后看拎没拎起),随即 pointercancel 放下。返回拎没拎起。 */
const longPress = (id) =>
  page(`const c = cardOf(${J(id)}).querySelector(".body"); const r = c.getBoundingClientRect();
    const o = { bubbles: true, isPrimary: true, button: 0, pointerId: 77, pointerType: "touch", clientX: r.left + 30, clientY: r.top + 12 };
    c.dispatchEvent(new PointerEvent("pointerdown", o));
    await new Promise((res) => setTimeout(res, 600));
    const lifted = document.body.classList.contains("card-dragging");
    document.dispatchEvent(new PointerEvent("pointercancel", o));
    await new Promise((res) => setTimeout(res, 200));
    return lifted;`);

try {
  // N4:底栏 / 宽屏导航那枚写「看板」(用户 2026-11-12 拍;中文界面)
  const navLabel = await page(`return document.querySelector('[data-mode="tasks"]').textContent.trim();`);
  ok(navLabel === "看板", "N4 底栏「任务」页签改叫「看板」", navLabel);
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
    // 说明住哪儿(mbopt M10):横放的看板 = 筛选条里那一行(#board-note);竖放 = 时间轴首行(p.held-note,随内容滚走、不吸顶)。
    const hv = await page(`const c = cardOf(${J(held.id)}); const board = document.body.classList.contains("board");
      const tlNote = document.querySelector("#timeline > p.held-note");
      return { tick: !!c.querySelector(".tick"), board, note: board ? !document.getElementById("board-note").hidden && !tlNote : !!tlNote && document.getElementById("board-note").hidden && document.getElementById("timeline").firstElementChild === tlNote };`);
    ok(!hv.tick && hv.note, "⑦ 收容卡没有勾、顶上有说明(横放在筛选条里一行,竖放是时间轴首行)", hv);
    if (hv.board) {
      const nh = await page(`const n = document.getElementById("board-note"); return { h: n.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(n).lineHeight) || 18 };`);
      ok(nh.h <= nh.lh + 2, "⑦ (mbopt M10)横放:那句说明压成一行", nh);
    }
    // mbopt M5:收容卡长按不拎起(只出不进、无处可放);对照(⑪ 之后那段)= 别的看板上的卡长按照常拎起。
    ok((await longPress(held.id)) === false, "⑦ (mbopt M5)收容卡长按:不拎起替身");
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
    const heldNow = (st) => colsNow.some((c) => c.id === st && c.held);
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
  // ⑪–⑲ 多看板优化(mbopt;手机组 M1–M13)。要两块**空着的**看板:一块带完成列的(下称「空流程板」)、一块一列纯分类的
  // (「空分类板」),对端 `board flow 空板` / `board one 空类` 种;缺了整段跳过。
  await mbopt();
} finally {
  for (const id of created) {
    await inv("archive_task", { spaceId: space, id }).catch(() => {});
    await inv("purge_task", { spaceId: space, id }).catch(() => {});
  }
}
// ---- ⑪–⑳ 多看板优化(mbopt,手机组 M1–M13)--------------------------------------------------------------------
// 落点 ⊥ 的看板造不出来(core 命令层前置挡着,只有并发能造出;手机也不建列)⇒ 这一段另开一条 CDP 连接,用 `Fetch` 域截 IPC
// (Tauri 2 在 Windows 上走 `http://ipc.localhost/<命令>`;页里的 `__TAURI_INTERNALS__.invoke` 不可写、包不了),把 `list_boards`
// 回来的某块看板的 `landing` 改成 null(= core 解析出 ⊥ 时壳给的样子),再让对端动一下触发一轮真刷新。
// ⚠ 只改**读**到的那一格,写命令照常走 core;它证的是「前端照 core 给的 ⊥ 怎么画」,⛔ 不证 core 怎么解析出 ⊥。
// ⚠ **真机上这几段恒红,是资产边界不是产品红**(894 V1986A 实跑:竖放 51 过 / 15 红、横放 55 过 / 15 红,15 红全是
//   「等对端改动触发本机刷新超过 20s」及其后 ⑪ ⑫ ㉑ ㉔ ㉕ 那几格)—— 截不到;推断是安卓 IPC 不走 `ipc.localhost`(未单独量)。
//   ⇒ 这几段只在截图台(WebView2)上作数;真机跑这支时把那 15 格当已知边界,看其余各格。
// 同一层顺带数 `sealed_counts_by_board` 调了几回(M3:一轮刷新只问一次;第二波起空态问的是它,不再拉整本成就册)。
async function mbopt() {
  const live2 = (await boards()).filter((b) => !b.deleted);
  const colsNow = await inv("list_board_columns", { spaceId: space });
  const liveCount = (b) => colsNow.filter((c) => c.board_id === b.id && c.accepts_cards).reduce((n, c) => n + c.live_items, 0);
  const E = live2.find((b) => !b.is_default && b.done !== null && b.id !== flow.id && liveCount(b) === 0);
  const S = live2.find((b) => b.done === null && b.id !== one.id && liveCount(b) === 0);
  if (!E || !S) {
    console.log("· ⑪–⑳ 跳过(要一块空流程板 + 一块空分类板,见 ⑪ 头注)");
    return;
  }
  const board = await page(`return document.body.classList.contains("board");`);
  // 前面几段造的卡(⑧ 记的一笔、⑨ 默认看板那条成就)先删进回收站:⑬ 要默认看板空着(finally 里还会再删一遍,幂等地吞错)。
  for (const id of created) await inv("archive_task", { spaceId: space, id }).catch(() => {});
  await page(`const b = document.querySelector('[data-mode="tasks"]'); if (document.body.dataset.view !== "tasks") click(b); return true;`);
  await sleep(400);
  const ipc = await ipcTap();
  const calls = async (cmd) => ipc.calls[cmd] || 0;
  const bookId = (await tasks()).find((t) => t.title === "书一")?.id ?? null;
  /** 让对端动一下(给「书一」上 / 去色),等本机刷新一轮(list_boards 又被调过)。没给对端就只能跳过要刷新的那几格。 */
  let colorOn = false;
  const nudge = async () => {
    if (!PEER_CMDS || !bookId) return false;
    const n0 = await calls("list_boards");
    colorOn = !colorOn;
    await peer(colorOn ? `color ${bookId} #336699` : `uncolor ${bookId}`, colorOn ? "OK color" : "OK uncolor");
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if ((await calls("list_boards")) > n0) return true;
      await sleep(150);
    }
    ok(false, "等对端改动触发本机刷新超过 20s");
    return false;
  };
  const nameE = E.title;

  // ⑪ M1 + ⑫ M2:空流程板的落点 ⊥
  ipc.nullLanding = [E.id];
  if (await nudge()) {
    await sleep(500);
    // ⑪ 挪到看板 / 放进看板的候选不含放不进卡的那块
    await pickBoard(flow.id);
    await waitFor(`!!cardOf(${J(X)})`, "X 在流程板上");
    await openPanel(X);
    await clickPact(X, "more");
    await clickPact(X, "board");
    const candT = await page(`return [...cardOf(${J(X)}).querySelectorAll("[data-board-to]")].map((b) => b.dataset.boardTo);`);
    ok(!candT.includes(E.id) && candT.includes(one.id), "⑪ (M1)挪到看板:落点 ⊥ 的那块不在候选里", candT);
    const ideaId = await inv("capture_idea", { spaceId: space, content: `mbopt 随记 ${Date.now()}` });
    await nudge(); // 让新随记上屏(同一轮也把 ⊥ 再落一次)
    await page(`const b = document.querySelector('[data-mode="ideas"]'); click(b); return true;`);
    await waitFor(`!!cardOf(${J(ideaId)})`, "随记面上那条新随记");
    await openPanel(ideaId);
    await clickPact(ideaId, "more");
    await clickPact(ideaId, "board");
    const candI = await page(`return [...cardOf(${J(ideaId)}).querySelectorAll("[data-board-to]")].map((b) => b.dataset.boardTo);`);
    ok(!candI.includes(E.id) && candI.includes(flow.id), "⑪ (M1)放进看板:落点 ⊥ 的那块不在候选里", candI);
    await inv("archive_note", { spaceId: space, id: ideaId });
    await inv("purge_note", { spaceId: space, id: ideaId }).catch(() => {});
    await page(`const b = document.querySelector('[data-mode="tasks"]'); click(b); return true;`);
    await sleep(400);

    // ⑫ 当前看板落点 ⊥ ⇒ ＋ 与「记下」事前灰、说原因;空态那句不再指 ＋
    await pickBoard(E.id);
    const g = await page(`const f = document.getElementById("capture-fab");
      return { blocked: f.classList.contains("blocked"), aria: f.getAttribute("aria-disabled"), save: document.getElementById("save").disabled,
        ph: document.getElementById("text").placeholder, empty: document.getElementById("timeline").textContent };`);
    ok(g.blocked && g.aria === "true" && g.save, "⑫ (M2)落点 ⊥:＋ 灰着、「记下」灰着", g);
    ok(g.ph.includes(nameE) && g.ph.includes("没有能放新卡片的列"), "⑫ (M2)记一笔框的灰字说原因", g.ph);
    ok(g.empty.includes("没有能放新卡片的列") && !g.empty.includes("＋"), "⑫ (M2)空态那句说放不进、不再指 ＋", g.empty);
    await page(`click(document.getElementById("capture-fab")); await new Promise((r) => setTimeout(r, 400)); return true;`);
    const after = await page(`return { open: document.getElementById("compose-card").classList.contains("open"), bar: document.getElementById("error").hidden ? "" : document.getElementById("error").textContent };`);
    ok(!after.open && after.bar.includes(nameE), "⑫ (M2)点灰 ＋:不开记一笔、提示条说原因", after);
    // ㉔ N5:再点当前页签 =「一步回捕获」(在顶上时聚焦记一笔框)—— 落点 ⊥ 时它也得拦,同点灰 ＋。
    await page(`window.scrollTo(0, 0); const e = document.getElementById("error"); e.hidden = true; e.textContent = ""; return true;`);
    await sleep(300);
    await page(`click(document.querySelector('[data-mode="tasks"]')); await new Promise((r) => setTimeout(r, 500)); return true;`);
    const re = await page(`return { open: document.getElementById("compose-card").classList.contains("open"), focus: document.activeElement === document.getElementById("text"),
      bar: document.getElementById("error").hidden ? "" : document.getElementById("error").textContent };`);
    ok(!re.open && !re.focus && re.bar.includes(nameE), "㉔ (N5)落点 ⊥ 时再点当前页签:不开记一笔、提示条说原因", re);
    if (re.open) await page(`document.getElementById("capture-scrim").click(); document.getElementById("text").blur(); return true;`);
    await pickBoard(flow.id);
    const g2 = await page(`return { blocked: document.getElementById("capture-fab").classList.contains("blocked"), save: document.getElementById("save").disabled };`);
    ok(!g2.blocked && !g2.save, "⑫ (M2)切回放得进的看板:＋ 与「记下」恢复", g2);
  } else console.log("· ⑪ ⑫ 跳过(没给 --peer-cmds / --peer-log,触发不了刷新)");
  ipc.nullLanding = [];
  await nudge();

  // ⑬ M3:空态只说这块看板。空分类板:不提归档、不提「转待办」;默认看板(空着时)才提「转待办」;
  //   空流程板的归档数只数它自己的成就(默认看板上也造一条,它不许被数进来)。
  const sealedIds = [];
  for (const b of [E, dflt]) {
    const id = await inv("capture_todo", { spaceId: space, content: `mbopt 成就 ${b.title} ${Date.now()}`, boardId: b.id });
    created.push(id);
    await inv("complete_task", { spaceId: space, id });
    await inv("seal_task", { spaceId: space, id });
    sealedIds.push(id);
  }
  const dfltEmpty = (await tasks()).every((t) => colsNow.find((c) => c.id === t.status)?.board_id !== dflt.id);
  await nudge();
  await sleep(400);
  const emptyText = () =>
    page(`await new Promise((r) => setTimeout(r, 300)); const h = document.querySelector("#timeline [data-sealed-hint]");
      return { text: document.getElementById("timeline").textContent, sealed: h && !h.hidden ? h.textContent : null, hasHint: !!h };`);
  await pickBoard(S.id);
  const eS = await emptyText();
  ok(!eS.hasHint && !eS.text.includes("归档") && !eS.text.includes("转待办") && eS.text.includes("放进看板"), "⑬ (M3)空分类板:不提归档、不提「转待办」(指「放进看板」)", eS);
  await pickBoard(E.id);
  const eE = await waitFor(`(() => { const h = document.querySelector("#timeline [data-sealed-hint]"); return h && !h.hidden ? h.textContent : null; })()`, "空流程板的归档那句");
  const sealedAll = await inv("list_sealed_tasks", { spaceId: space });
  const colsS = await inv("list_board_columns", { spaceId: space });
  const onE = sealedAll.filter((r) => colsS.find((c) => c.id === r.status)?.board_id === E.id).length;
  ok(eE !== null && eE.includes(`归档了 ${onE} 张`) && onE < sealedAll.length, "⑬ (M3)空流程板:归档数只数这块看板的成就(默认看板那条不算)", { eE, onE, all: sealedAll.length });
  const nE = sealedByBoard(await inv("sealed_counts_by_board", { spaceId: space }), E.id);
  ok(eE !== null && nE === onE && eE.includes(`归档了 ${nE} 张`), "㉓ (N3)那句的数 = core sealed_counts_by_board 给这块看板那一组(= 成就册里按列归它的条数)", { eE, nE, onE });
  const n1 = await calls("sealed_counts_by_board");
  for (const b of [S, E, S, E]) await pickBoard(b.id);
  await sleep(400);
  const n2 = await calls("sealed_counts_by_board");
  ok(n2 === n1, "⑬ (M3)来回切几次空看板:同一轮刷新里不再重问后端", { n1, n2 });
  if (dfltEmpty) {
    await pickBoard(dflt.id);
    const eD = await emptyText();
    ok(eD.text.includes("转待办"), "⑬ (M3)默认看板空着:提「转待办」", eD.text);
  } else console.log("· ⑬ 默认看板那格跳过(默认看板上有卡)");

  // ⑭ M12:横放的空看板画列(空态那几句在第一列);单列看板限宽居中。竖放照旧一句话。
  await pickBoard(E.id);
  const lay = await page(`const gs = [...document.querySelectorAll("#timeline > .tl-group")];
    return { n: gs.length, lead: !!gs[0]?.querySelector(".tl-empty-lead"), rest: gs.slice(1).every((g) => !!g.querySelector(".tl-empty") && !g.querySelector(".tl-empty-lead")), p: !!document.querySelector("#timeline > p.empty") };`);
  const eCols = colsNow.filter((c) => c.board_id === E.id && c.accepts_cards).length;
  if (board) ok(lay.n === eCols && lay.lead && lay.rest && !lay.p, "⑭ (M12)横放空看板:各列都画、空态那几句在第一列", lay);
  else ok(lay.n === 0 && lay.p, "⑭ (M12)竖放空看板:照旧一句话", lay);
  if (board) {
    await pickBoard(S.id);
    // 居中按时间轴的**内容盒**量(横放右边让出 ＋ 那条边距,body.fab-gutter)。
    const solo = await page(`const el = document.getElementById("timeline"); const tl = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      const g = document.querySelector("#timeline > .tl-group")?.getBoundingClientRect();
      return g ? { w: Math.round(g.width), l: Math.round(g.left - tl.left - parseFloat(cs.paddingLeft)), r: Math.round(tl.right - parseFloat(cs.paddingRight) - g.right), tlw: Math.round(tl.width) } : null;`);
    ok(solo !== null && solo.w <= 560 && Math.abs(solo.l - solo.r) <= 2, "⑭ (M12)单列看板:限宽 ≤ 560、居中", solo);
  }

  // ⑮ M4:横滚位置按看板记(横放)
  if (board) {
    await pickBoard(flow.id);
    await sleep(300);
    await page(`document.getElementById("timeline").scrollLeft = 9999; return true;`);
    await sleep(700);
    const leftFlow = await page(`return document.getElementById("timeline").scrollLeft;`);
    await pickBoard(E.id);
    await sleep(400);
    const leftE = await page(`return document.getElementById("timeline").scrollLeft;`);
    await pickBoard(flow.id);
    await sleep(400);
    const leftBack = await page(`return document.getElementById("timeline").scrollLeft;`);
    ok(leftFlow > 0 && leftE === 0 && Math.abs(leftBack - leftFlow) <= 2, "⑮ (M4)切看板:新那块从头起、切回来还它自己的横滚位置", { leftFlow, leftE, leftBack });
    await page(`document.getElementById("timeline").scrollLeft = 0; return true;`);
    await sleep(300);
  }

  // ⑯ M5 对照:放得进的看板上的卡长按照常拎起(⑦ 判的是收容卡不拎)
  await pickBoard(flow.id);
  await waitFor(`!!cardOf(${J(Y)})`, "Y 在流程板上");
  ok((await longPress(Y)) === true, "⑯ (M5 对照)流程板上的卡长按:照常拎起");
  await sleep(300);

  // ⑰ M9:过滤框不单占一行
  const fl = await page(`const r = (e) => { const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) }; };
    return { boards: r(document.getElementById("filter-boards")), stages: r(document.getElementById("filter-stages")), text: r(document.getElementById("filter-text")),
      topics: document.getElementById("filter-topics").childElementCount, kinds: document.getElementById("filter-kinds").childElementCount };`);
  const sameLine = (a, b) => a.t < b.b && b.t < a.b;
  if (board) ok(sameLine(fl.boards, fl.text) && fl.boards.r <= fl.text.l, "⑰ (M9)横放:过滤框并进看板切换那排右端", fl);
  else if (fl.topics === 0 && fl.kinds === 0) ok(sameLine(fl.stages, fl.text) && fl.stages.r <= fl.text.l, "⑰ (M9)竖放无标签:过滤框并进「列」那排右端", fl);
  else console.log("· ⑰ 竖放那格跳过(有标签 / 类型行,过滤框本就在标签行右端)");

  // ⑱ M13:切到切换排里屏外那一块 ⇒ 那枚滚进视野
  const lastId = live2[live2.length - 1].id;
  await pickBoard(dflt.id);
  await page(`document.getElementById("filter-boards").scrollLeft = 0; return true;`);
  await sleep(200);
  const was = await page(`const row = document.getElementById("filter-boards").getBoundingClientRect(); const p = document.querySelector('#filter-boards [data-board=${J(lastId)}]').getBoundingClientRect(); return p.right > row.right;`);
  await pickBoard(lastId);
  await sleep(200);
  const rv = await page(`const row = document.getElementById("filter-boards").getBoundingClientRect(); const p = document.querySelector('#filter-boards [data-board=${J(lastId)}]').getBoundingClientRect();
    return { row: [Math.round(row.left), Math.round(row.right)], pill: [Math.round(p.left), Math.round(p.right)] };`);
  ok(rv.pill[0] >= rv.row[0] - 1 && rv.pill[1] <= rv.row[1] + 1, `⑱ (M13)切过去的那枚看板钮在视野里(切之前${was ? "在屏外" : "本就在屏上"})`, rv);

  // ⑲ M8:切看板清标签筛选(R5)
  const topicId = await inv("create_topic", { spaceId: space, title: `mbopt标签${Date.now() % 10000}` });
  await inv("add_task_topic", { spaceId: space, id: X, topicId });
  await nudge();
  await pickBoard(flow.id);
  await waitFor(`!!document.querySelector('#filter-topics [data-topic-id=${J(topicId)}]')`, "那枚标签钮");
  if (board) {
    // ⑰ 续:有标签时(第二行有东西)过滤框仍在切换排那一行右端,标签行断到下一行(index.html `.boards-wrap`)。
    const f2 = await page(`const r = (e) => { const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) }; };
      return { boards: r(document.getElementById("filter-boards")), text: r(document.getElementById("filter-text")), topics: r(document.getElementById("filter-topics")) };`);
    ok(sameLine(f2.boards, f2.text) && f2.boards.r <= f2.text.l && f2.topics.t >= f2.boards.b - 4, "⑰ (M9)横放有标签:过滤框仍在切换排右端、标签行在下一行", f2);
  }
  await page(`click(document.querySelector('#filter-topics [data-topic-id=${J(topicId)}]')); return true;`);
  await sleep(300);
  const filtered = await page(`return !document.getElementById("filter-sum").hidden;`);
  await pickBoard(one.id);
  const r8 = await page(`return { sum: !document.getElementById("filter-sum").hidden, cards: document.querySelectorAll("#timeline article.card").length };`);
  await pickBoard(flow.id);
  const r8b = await page(`return { sum: !document.getElementById("filter-sum").hidden, active: !!document.querySelector("#filter-topics .fpill.active[data-topic-id]") };`);
  ok(filtered && !r8.sum && r8.cards > 0 && !r8b.sum && !r8b.active, "⑲ (M8)切看板:标签筛选回「所有」(切回来也不再筛着)", { filtered, r8, r8b });
  await inv("delete_topic", { spaceId: space, id: topicId }).catch((e) => console.log("· 删标签失败", String(e)));

  // ⑳ M11:横放收起顶栏后屏顶细条写当前看板名(空列上往上推 = 收,892 的手势兜底)
  if (board) {
    await pickBoard(E.id);
    await sleep(500);
    await s.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const pt = await page(`const g = document.querySelectorAll("#timeline > .tl-group")[1].getBoundingClientRect(); return [Math.round(g.left + g.width / 2), Math.round(g.top + 150)];`);
    const tp = (type, x, y) => s.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await tp("touchStart", pt[0], pt[1]);
    for (let i = 1; i <= 8; i++) {
      await tp("touchMove", pt[0], pt[1] - i * 12);
      await sleep(16);
    }
    await tp("touchEnd", 0, 0);
    await sleep(500);
    const pk = await page(`const p = document.getElementById("chrome-peek"); return { hidden: document.body.classList.contains("chrome-hidden"), peek: p.hidden ? null : p.textContent };`);
    ok(pk.hidden && pk.peek === nameE, "⑳ (M11)横放收起顶栏:屏顶细条写着当前看板名", pk);
    await page(`const p = document.getElementById("chrome-peek"); if (!p.hidden) click(p); return true;`);
    await s.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await sleep(400);
  }

  await wave2(ipc, nudge, E, S);

  // 清场:那两条成就取消归档(finally 里删掉);卸下包装
  for (const id of sealedIds) await inv("unseal_task", { spaceId: space, id }).catch(() => {});
  await ipc.close();
  await pickBoard(dflt.id);
}

/** core `sealed_counts_by_board` 里某块看板那一组的条数(没有那组 = 这块看板一张成就都没有)。 */
function sealedByBoard(groups, boardId) {
  return groups.find((g) => g.board_id === boardId)?.n ?? 0;
}

// ---- ㉑ ㉒ ㉕ 多看板优化第二波(手机组 N1 / N2 / N5;N3 那格 ㉓ 在 ⑬、N5 前半 ㉔ 在 ⑫ 里)-----------------------------------
async function wave2(ipc, nudge, E, S) {
  if (!PEER_CMDS) {
    console.log("· ㉑ ㉒ ㉕ 跳过(没给 --peer-cmds / --peer-log,触发不了刷新)");
    return;
  }
  const pillN = (id) =>
    page(`const p = document.querySelector('#filter-boards [data-board=${J(id)}]'); if (!p) return "nopill"; const n = p.querySelector(".fn"); return n ? n.textContent : null;`);

  // ㉑ N1:看板上画哪几列 / 收容区有没有、几张 —— 只认 core 的字段
  const cols0 = await inv("list_board_columns", { spaceId: space });
  const mid = flowCols.find((c) => c !== flow.landing && c !== flow.done);
  ipc.colPatch = { [mid]: { accepts_cards: false } };
  await nudge();
  await pickBoard(flow.id);
  await sleep(300);
  const secs = await sections();
  ok(!secs.includes(mid) && secs.includes(flow.landing), "㉑ (N1)某列的 accepts_cards 读成 false ⇒ 状态那排没有它(不拿 deleted 自己拼)", { secs, mid });
  const landCol = cols0.find((c) => c.id === flow.landing);
  const realHeld = cols0.filter((c) => c.held);
  ipc.colPatch = {
    [flow.landing]: { held: true, accepts_cards: false },
    ...Object.fromEntries(realHeld.map((c) => [c.id, { held: false, accepts_cards: false }])),
  };
  await nudge();
  await sleep(300);
  const hn = await page(`const p = document.querySelector('#filter-boards [data-board="@holding"] .fn'); return p ? Number(p.textContent) : null;`);
  ok(landCol.live_items > 0 && hn === landCol.live_items, "㉑ (N1)收容那枚的数 = held 且有卡的那几列(真收容列读成 held=false 就不算)", {
    hn,
    want: landCol.live_items,
    realHeld: realHeld.map((c) => c.id),
  });
  ipc.colPatch = {};
  await nudge();
  await sleep(300);

  // ㉒ N2:看板名旁的灰小字 = open_items(不在完成列的),0 不显。先把 Y 勾进流程板的完成列,好让流程板 open ≠ live。
  await inv("complete_task", { spaceId: space, id: Y });
  await nudge();
  await pickBoard(flow.id);
  await sleep(300);
  const bs2 = await boards();
  const flowRow = bs2.find((b) => b.id === flow.id);
  const tasksNow = await tasks();
  const colsNow = await inv("list_board_columns", { spaceId: space });
  const flowAcc = new Set(colsNow.filter((c) => c.board_id === flow.id && c.accepts_cards).map((c) => c.id));
  const r7 = tasksNow.filter((t) => flowAcc.has(t.status) && t.status !== flow.done).length;
  const liveBs = bs2.filter((b) => !b.deleted);
  const got = {};
  for (const b of liveBs) got[b.id] = await pillN(b.id);
  const want = Object.fromEntries(liveBs.map((b) => [b.id, b.open_items > 0 ? String(b.open_items) : null]));
  ok(flowRow.open_items === r7 && flowRow.live_items > flowRow.open_items, "㉒ (N2)前置:流程板 open_items = 不在完成列的活卡(R7),且完成列里有卡(open ≠ live)", {
    open: flowRow.open_items,
    live: flowRow.live_items,
    r7,
  });
  ok(J(got) === J(want), "㉒ (N2)切换排每枚的数 = core open_items", { got, want });
  ok(got[E.id] === null && got[S.id] === null, "㉒ (N2)0 不显(两块空看板不写数)", { E: got[E.id], S: got[S.id] });
  const fnCls = await page(`const n = document.querySelector('#filter-boards [data-board=${J(flow.id)}] .fn'); return n ? n.className : null;`);
  ok(fnCls === "fn", "㉒ (N2)数用收容那枚同一款灰小字(.fn)", fnCls);
  await inv("update_task_status", { spaceId: space, id: Y, to: flow.landing });

  // ㉕ N5:默认看板落点 ⊥ ⇒ 随记「转待办」事前灰、点了说原因、不打后端
  ipc.nullLanding = [dflt.id];
  const ideaId = await inv("capture_idea", { spaceId: space, content: `mbopt 转待办 ${Date.now()}` });
  await nudge();
  await page(`const b = document.querySelector('[data-mode="ideas"]'); click(b); return true;`);
  await waitFor(`!!cardOf(${J(ideaId)})`, "随记面上那条新随记");
  await openPanel(ideaId);
  const pb = await page(
    `const b = cardOf(${J(ideaId)})?.querySelector('.panel [data-pact="promote"]'); return b ? { blocked: b.classList.contains("blocked"), aria: b.getAttribute("aria-disabled"), op: getComputedStyle(b).opacity } : null;`,
  );
  ok(pb !== null && pb.blocked && pb.aria === "true" && Number(pb.op) < 1, "㉕ (N5)默认看板落点 ⊥:「转待办」事前灰", pb);
  await page(`const e = document.getElementById("error"); e.hidden = true; e.textContent = ""; return true;`);
  await clickPact(ideaId, "promote");
  await sleep(800);
  const why = await errText();
  ok(why.includes("转待办") && why.includes("没有能放新卡片的列") && (await isIdea(ideaId)), "㉕ (N5)点灰「转待办」:说原因、卡仍是随记", { why });
  ipc.nullLanding = [];
  await nudge();
  await sleep(300);
  await openPanel(ideaId);
  const pb2 = await page(
    `const b = cardOf(${J(ideaId)})?.querySelector('.panel [data-pact="promote"]'); return b ? { blocked: b.classList.contains("blocked"), aria: b.getAttribute("aria-disabled") } : null;`,
  );
  ok(pb2 !== null && !pb2.blocked && pb2.aria === null, "㉕ (N5)落点恢复:「转待办」不灰", pb2);
  await inv("archive_note", { spaceId: space, id: ideaId });
  await inv("purge_note", { spaceId: space, id: ideaId }).catch(() => {});
  await page(`const b = document.querySelector('[data-mode="tasks"]'); click(b); return true;`);
  await sleep(400);
}

/** 另开一条 CDP 连接截 IPC(见 mbopt 头注):`nullLanding` 里那几块看板的落点读成 null;`colPatch`(列 id → 要盖的字段)改读到的列行
 *  (㉑ 用:证前端只认 `accepts_cards` / `held`);`calls` 数每条命令的真请求(不含预检)。 */
async function ipcTap() {
  const ws = new WebSocket((await pageTarget(PORT)).webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error("ipcTap 连不上"));
  });
  let n = 0;
  const pend = new Map();
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++n;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const tap = { nullLanding: [], colPatch: {}, calls: {}, close: async () => { await send("Fetch.disable"); ws.close(); } };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      pend.get(m.id)?.(m.result ?? m);
      pend.delete(m.id);
      return;
    }
    if (m.method !== "Fetch.requestPaused") return;
    const p = m.params;
    const cmd = new URL(p.request.url).pathname.slice(1);
    if (p.request.method !== "OPTIONS") tap.calls[cmd] = (tap.calls[cmd] || 0) + 1;
    const patchBoards = cmd === "list_boards" && tap.nullLanding.length > 0;
    const patchCols = cmd === "list_board_columns" && Object.keys(tap.colPatch).length > 0;
    if (!(patchBoards || patchCols) || p.request.method === "OPTIONS" || p.responseStatusCode !== 200) {
      await send("Fetch.continueRequest", { requestId: p.requestId });
      return;
    }
    const b = await send("Fetch.getResponseBody", { requestId: p.requestId });
    const rows = JSON.parse(b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body);
    const out = JSON.stringify(
      patchBoards
        ? rows.map((x) => (tap.nullLanding.includes(x.id) ? { ...x, landing: null } : x))
        : rows.map((x) => (tap.colPatch[x.id] ? { ...x, ...tap.colPatch[x.id] } : x)),
    );
    await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: p.responseHeaders, body: Buffer.from(out, "utf8").toString("base64") });
  };
  await send("Fetch.enable", {
    patterns: ["list_boards", "list_board_columns", "sealed_counts_by_board"].map((c) => ({ urlPattern: `*ipc.localhost/${c}*`, requestStage: "Response" })),
  });
  return tap;
}

console.log(fails === 0 ? "\nPASS" : `\nFAIL(${fails} 格)`);
process.exit(fails === 0 ? 0 : 1);
