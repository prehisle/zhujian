// 应用评审取舍题(用户 2026-11-13 拍板的两条)手机 P 组 —— R4「归档面的看板筛选排」的真机回归网。
// (R3「删卡片不再先问」那半守在 cdp-acceptance-undo-receipts.js 的 B 段与 cdp-acceptance-p0-confirm.js 的 ⑤b。)
// 驱动形(要换空间、要重载页面;CDP 摆前置、读状态)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-p.mjs                    # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-p.mjs --shots <目录>      # 关键几拍各截一张真屏
//
// 判这几件(全按 core 给的看板 / 列认,⛔ 不认 id 字面量);这台上的每个空间各走一遍,按它有几块活看板分两形:
//  甲 活看板 ≥ 2 块的空间(902 用户拍 R4):
//    ① 从每块活看板进归档面:顶上那排恒在 =「全部看板」+ 当前看板(哪怕它没有归档)+ 其他有归档的看板(core 序);
//       **选着的恒是当前看板**;画出来的只有它的归档;它没有归档 = 那句现成的「这块看板还没有归档的卡片」、一张卡不画。
//    ② 点「全部看板」:整本都在、每张卡挂来处看板名;整本都空 = 照旧那句「还没有归档的卡片。」。
//    ③ 「进面才预选」的那一半(不该发生的):在面里点了「全部看板」之后取消归档一张(面自己重载一趟)⇒ 仍选着「全部看板」,
//       ⛔ 不被重载拽回当前看板;点回执的「撤销」归回去。(用本资产现造的一张成就,见「会写库」。)
//    ④ 正看着「已删除的看板 / 列」(收容区)时进面 = 没有当前看板 ⇒ 选着「全部看板」(收容区有卡才跑,没有记 SKIPPED)。
//    ⑤ 从搜索结果点进一条归档的 ⇒ 落在「全部看板」上并定位到那张(免得它正好被筛掉)。
//  乙 只有一块活看板的空间(保持现状):归档来自 < 2 块看板 ⇒ 不出那排、卡上不挂看板名;整本空 = 「还没有归档的卡片。」。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏。
// 会写库:甲形的空间里现造**一张**卡(正文带 `PICKSP` 记号,落在一块带完成列的活看板上)→ 完成 → 归档;收尾取消归档 →
//   archive_task → purge_task 并自证零残留。⚠ 那个空间若连着同步,这几笔会传给对端(最后是一条销毁)。
//   起跑时各空间「正看着哪块看板」的本机记录(localStorage)收尾逐个放回;人在哪个空间起跑就回到哪个空间。
// 诚实边界:
//  ① 这些都是 JS 行为,页内下不了刀 ⇒ 阴性对照 = 在**改之前的包**上跑这支(甲 ① 的「当前看板恒在」「恒选当前看板」红);
//     ③ 与 ① 互为对照(同一枚状态:进面那下改、重载那下不改),两格同绿才说明分得开;
//  ② 乙形里「一块活看板 + 归档来自两块(另一块已删)⇒ 照旧出那排」这台测试机造不出(手机不建不删看板),只靠代码推;
//  ③ 横屏 / 平板宽屏没跑(那排的版式没动,动的只是出不出、选谁)。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const M = "PICKSP";
const NONE_HERE = "这块看板还没有归档的卡片";
const EMPTY_ALL = "还没有归档的卡片。";
const HOLDING = "@holding";

const out = { pass: false, steps: [] };
const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.error(`${ok === "skip" ? "SKIP" : ok ? "ok  " : "RED "} ${name}`);
    return !!ok;
  };
  let s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
  /** 页面重载后那条连接可能换了:失败一次就重连再来。 */
  const evalJs = async (expression) => {
    for (let i = 0; ; i++) {
      try {
        return await s.evaluate(expression);
      } catch (e) {
        if (i >= 2 || /页面内抛了/.test(String(e?.message))) throw e;
        await sleep(800);
        try {
          s.close();
        } catch {
          /* 旧连接已断 */
        }
        s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
      }
    }
  };
  const J = (v) => JSON.stringify(v);
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evalJs(expr).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  const rawInv = (cmd, args = {}) => evalJs(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, ${J(args)})`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()`);
  const snap = async (name) => {
    if (!SHOTS) return;
    await sleep(350);
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o){if(o[k]===null)localStorage.removeItem(k);else localStorage.setItem(k,o[k])}location.reload();return 1})()`).catch(() => 1);
    await sleep(1500);
    await until(`document.readyState==="complete"&&!!document.getElementById("gate")&&document.getElementById("gate").hidden`, 15000);
    await sleep(1200);
  };
  const toSpace = async (id) => {
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(id)}}).then(()=>1)`);
    await reload({ "zhujian.last-space": id });
  };
  const paneOpen = () => evalJs(`!document.getElementById("sealed-pane").hidden&&document.body.classList.contains("pane-open")`);
  /** 回任务面(开着什么面都收)。 */
  const toTasks = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")||document.body.dataset.view!=="tasks"`)) {
      await click(`[data-mode="tasks"]`);
      await until(`!document.body.classList.contains("pane-open")&&document.body.dataset.view==="tasks"`, 3000);
    }
    await sleep(250);
  };
  const pickBoard = async (id) => {
    await toTasks();
    const hit = await click(`#filter-boards [data-board="${id}"]`);
    await until(`!!document.querySelector('#filter-boards [data-board="${id}"].active')`, 3000);
    await sleep(300);
    return hit;
  };
  /** 开归档面并等它读完(「加载中」那句换掉)。 */
  const openSealed = async () => {
    if (await paneOpen()) await toTasks();
    await click(`[data-pane="sealed"]`);
    await until(`!document.getElementById("sealed-pane").hidden`, 3000);
    // 读库那一拍(列 + 看板 + 成就三条命令并发):画面连读两拍一样了才算读完(「加载中」那句也是一枚 p.empty,认不出来)
    let prev = null;
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      const now = await evalJs(`document.getElementById("sealed-list").innerHTML.length`);
      if (now === prev && i >= 2) break;
      prev = now;
    }
  };
  const view = () =>
    evalJs(`(()=>{const box=document.getElementById("sealed-list");
      const pills=[...box.querySelectorAll("[data-sealed-board]")];
      return {pills:pills.map(b=>b.dataset.sealedBoard),labels:pills.map(b=>b.textContent),
        active:pills.filter(b=>b.classList.contains("active")).map(b=>b.dataset.sealedBoard),
        pressed:pills.filter(b=>b.getAttribute("aria-pressed")==="true").map(b=>b.dataset.sealedBoard),
        cards:[...box.querySelectorAll("[data-sealed]")].map(c=>({id:c.dataset.sealed,tag:c.querySelector("footer .pill")?.textContent??null})),
        empty:box.querySelector("p.empty")?.textContent??null}})()`);

  const spaces = await rawInv("list_spaces");
  const startSpace = spaces.find((x) => x.current)?.id;
  const savedViews = {}; // 空间 → 起跑时「正看着哪块看板」的本机记录(null = 没记过)
  const seeded = []; // { space, id }
  let ranMulti = false;
  let ranSingle = false;

  const runSpace = async (space) => {
    const inv = (cmd, args = {}) => rawInv(cmd, { spaceId: space, ...args });
    const boards = await inv("list_boards");
    const cols = await inv("list_board_columns");
    const live = boards.filter((b) => !b.deleted);
    const boardOf = (st) => cols.find((c) => c.id === st)?.board_id ?? null;
    const nameOf = (b) => (b.title_overridden ? b.title : "任务"); // 种子看板没改过名 = 本端字典那个名字(中文档)
    const sealedNow = () => inv("list_sealed_tasks");
    const tag = `[${space}]`;

    if (live.length < 2) {
      // ── 乙:只有一块活看板 ───────────────────────────────────────────────────
      ranSingle = true;
      const sealed = await sealedNow();
      const from = new Set(sealed.map((r) => boardOf(r.status)));
      await toTasks();
      await openSealed();
      const v = await view();
      if (from.size < 2) {
        step(`${tag} 乙 只有一块活看板:不出筛选排`, v.pills.length === 0, v.pills);
        step(`${tag} 乙 卡上不挂看板名;整本(${sealed.length} 张)都画`, v.cards.length === sealed.length && v.cards.every((c) => c.tag === null), { n: v.cards.length });
        if (sealed.length === 0) step(`${tag} 乙 整本空 = 照旧那句`, v.empty === EMPTY_ALL, v.empty);
      } else step(`${tag} 乙 归档来自 ≥ 2 块看板(另一块已删):照旧出那排、选着「全部看板」`, v.pills.length >= 3 && J(v.active) === J([""]), v);
      await snap(`R4-single-${space}`);
      await toTasks();
      return;
    }

    // ── 甲:活看板 ≥ 2 块 ─────────────────────────────────────────────────────
    ranMulti = true;
    // 现造一张成就:落在一块带完成列的活看板上(优先挑非默认那块,好让「默认看板没有归档」那一形也出现)
    const host = live.find((b) => !b.is_default && b.done !== null && b.landing !== null) ?? live.find((b) => b.done !== null && b.landing !== null);
    let seedId = null;
    if (host) {
      seedId = await inv("capture_todo", { content: `${M}-成就-${Date.now()}`, boardId: host.id });
      seeded.push({ space, id: seedId });
      await inv("complete_task", { id: seedId });
      await inv("seal_task", { id: seedId });
      await reload(); // 页内直调写库后时间轴 / 看板登记是旧快照
    }
    const sealed = await sealedNow();
    const colsNow = await inv("list_board_columns");
    const bOf = (st) => colsNow.find((c) => c.id === st)?.board_id ?? null;
    const countOn = (id) => sealed.filter((r) => bOf(r.status) === id).length;
    step(`${tag} 甲 前置:现造的那张成就在册里`, !host || sealed.some((r) => r.id === seedId), { host: host?.id ?? null });

    // ① 从每块活看板进面(至多四块;必含一块有归档的与一块没有归档的,凑得出的话)
    const withSealed = live.filter((b) => countOn(b.id) > 0);
    const without = live.filter((b) => countOn(b.id) === 0);
    const tour = [...new Set([...withSealed.slice(0, 2), ...without.slice(0, 2)])];
    step(`${tag} 甲 自证前置:巡的几块里既有带归档的、也有没归档的(否则「恒在」那格是空测)`, withSealed.length > 0 && without.length > 0 ? true : "skip", { withSealed: withSealed.length, without: without.length });
    for (const b of tour) {
      const n = countOn(b.id);
      const label = `${tag} 甲 ① 从「${nameOf(b)}」(${n} 张归档)进面`;
      if (!step(`${label}:切得到那块看板`, await pickBoard(b.id))) continue;
      await openSealed();
      const v = await view();
      const want = ["", ...boards.map((x) => x.id).filter((id) => id === b.id || countOn(id) > 0)];
      step(`${label}:那排 =「全部看板」+ 当前看板 + 其他有归档的(core 序)`, J(v.pills) === J(want) && v.labels[0] === "全部看板", { got: v.pills, want, first: v.labels[0] });
      step(`${label}:选着的恰是当前看板(高亮与 aria-pressed 一致)`, J(v.active) === J([b.id]) && J(v.pressed) === J([b.id]), { active: v.active, pressed: v.pressed });
      const mine = sealed.filter((r) => bOf(r.status) === b.id).map((r) => r.id).sort();
      step(`${label}:画的只有它的归档`, J(v.cards.map((c) => c.id).sort()) === J(mine), { shown: v.cards.length, mine: mine.length });
      if (n === 0) step(`${label}:它没有归档 ⇒「${NONE_HERE}」`, v.empty === NONE_HERE && v.cards.length === 0, v.empty);
      await snap(`R4-enter-${space}-${n === 0 ? "none" : "some"}-${b.id.slice(0, 6)}`);

      // ② 点「全部看板」
      await click(`#sealed-list [data-sealed-board=""]`);
      await sleep(300);
      const a = await view();
      step(`${label} → ② 点「全部看板」:整本 ${sealed.length} 张都在、选着「全部看板」`, a.cards.length === sealed.length && J(a.active) === J([""]), { shown: a.cards.length, active: a.active });
      if (sealed.length > 0) {
        const wantTag = (id) => {
          const bd = boards.find((x) => x.id === bOf(sealed.find((r) => r.id === id).status));
          return bd ? nameOf(bd) : null;
        };
        const bad = a.cards.filter((c) => c.tag !== wantTag(c.id));
        step(`${label} → ② 每张卡挂来处看板名`, bad.length === 0, bad.slice(0, 3));
      } else step(`${label} → ② 整本空 = 照旧那句`, a.empty === EMPTY_ALL, a.empty);
    }
    await snap(`R4-all-${space}`);

    // ③ 面里重载不把筛选拽回当前看板
    if (seedId && without.length > 0) {
      const cur = without[0];
      await pickBoard(cur.id);
      await openSealed();
      await click(`#sealed-list [data-sealed-board=""]`);
      await sleep(300);
      await clearBar();
      await click(`#sealed-list [data-sealed="${seedId}"] .content`);
      const btn = await until(`!!document.querySelector('#sealed-list [data-unseal="${seedId}"]')`, 2000);
      await click(`#sealed-list [data-unseal="${seedId}"]`);
      const gone = await until(`window.__TAURI_INTERNALS__.invoke("list_sealed_tasks",{spaceId:${J(space)}}).then(l=>!l.some(x=>x.id===${J(seedId)}))`, 5000);
      await sleep(900); // 面自己那趟 loadSealed()
      const v = await view();
      step(`${tag} 甲 ③ 前置:取消归档真做了(面随之重载)`, !!btn && !!gone && !v.cards.some((c) => c.id === seedId), { btn: !!btn, gone: !!gone });
      // 那张成就若是它那块看板唯一的一张,那块随之退出那排 —— 当前看板(没有归档)仍得在
      step(`${tag} 甲 ③ 重载后仍选着「全部看板」(没被拽回当前看板)、当前看板那枚仍在排里`, J(v.active) === J([""]) && v.pills.includes(cur.id), v);
      // 回执「撤销」= 再归档回去
      const undo = await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&[...e.querySelectorAll(".bar-act")].some(b=>b.textContent==="撤销")})()`, 3000);
      if (undo) await evalJs(`(()=>{[...document.querySelectorAll("#error .bar-act")].find(b=>b.textContent==="撤销").click();return 1})()`);
      const back = await until(`window.__TAURI_INTERNALS__.invoke("list_sealed_tasks",{spaceId:${J(space)}}).then(l=>l.some(x=>x.id===${J(seedId)}))`, 5000);
      await sleep(900);
      const v2 = await view();
      step(`${tag} 甲 ③ 撤销 = 归回去,筛选仍在「全部看板」`, !!undo && !!back && J(v2.active) === J([""]) && v2.cards.some((c) => c.id === seedId), { undo: !!undo, back: !!back, active: v2.active });
      await clearBar();
    } else step(`${tag} 甲 ③ 面里重载不拽回`, "skip", "没有带完成列的活看板可造成就,或每块看板都有归档");

    // ④ 正看着收容区时进面
    const heldN = colsNow.filter((c) => c.held && c.live_items > 0).length;
    if (heldN > 0 && (await pickBoard(HOLDING))) {
      await openSealed();
      const v = await view();
      const want = ["", ...boards.map((x) => x.id).filter((id) => countOn(id) > 0)];
      step(`${tag} 甲 ④ 正看着「已删除的看板 / 列」进面:没有当前看板 ⇒ 选着「全部看板」、那排只有有归档的`, J(v.active) === J([""]) && J(v.pills) === J(want), v);
    } else step(`${tag} 甲 ④ 收容区进面`, "skip", "收容区是空的");

    // ⑤ 从搜索结果点进一条归档的
    if (seedId && without.length > 0) {
      await pickBoard(without[0].id);
      await click("#search-toggle");
      await until(`!document.getElementById("search-pane").hidden`, 3000);
      await evalJs(`(()=>{const i=document.getElementById("search-input");i.value=${J(`${M}-成就`)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      const hit = await until(`!!document.querySelector('#search-results [data-hit="${seedId}"]')`, 6000);
      if (step(`${tag} 甲 ⑤ 前置:搜得到那张成就`, !!hit)) {
        await click(`#search-results [data-hit="${seedId}"] .content`);
        await until(`!document.getElementById("sealed-pane").hidden&&!!document.querySelector('#sealed-list [data-sealed="${seedId}"]')`, 5000);
        await sleep(600);
        const v = await view();
        const located = await evalJs(`(()=>{const c=document.querySelector('#sealed-list [data-sealed="${seedId}"]');if(!c)return null;const r=c.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight})()`);
        step(`${tag} 甲 ⑤ 从搜索点进归档的那张:落在「全部看板」上、那张在屏上(当前看板没有归档,照「恒选当前」它会被筛掉)`, J(v.active) === J([""]) && located === true, { active: v.active, located });
        await snap(`R4-from-search-${space}`);
      }
      // 这一下握着「回搜索」那一层:按返回退干净
      await execFileAsync("adb", ["shell", "input", "keyevent", "111"]).catch(() => null);
      await toTasks();
      if (await evalJs(`document.body.classList.contains("pane-open")`)) await toTasks();
      await evalJs(`(()=>{const i=document.getElementById("search-input");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    } else step(`${tag} 甲 ⑤ 搜索落点`, "skip", "没有现造的成就");
    await toTasks();
  };

  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    for (const sp of spaces) savedViews[sp.id] = await evalJs(`localStorage.getItem(${J(`zhujian.board-current.${sp.id}`)})`);
    // 起跑时所在的空间先跑,再逐个换过去
    const order = [...spaces].sort((a, b) => Number(b.id === startSpace) - Number(a.id === startSpace));
    for (const sp of order) {
      const cur = (await rawInv("list_spaces")).find((x) => x.current)?.id;
      if (cur !== sp.id) await toSpace(sp.id);
      await clearBar();
      await runSpace(sp.id);
    }
    step("覆盖:甲(活看板 ≥ 2 块)这一形跑到了", ranMulti ? true : "skip", "这台上没有多看板的空间");
    step("覆盖:乙(只有一块活看板)这一形跑到了", ranSingle ? true : "skip", "这台上没有单看板的空间");
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    try {
      // 清种子:取消归档(可能已在看板上)→ 删 → 销毁
      // ⚠ 手机只有当前空间是活的(max_live=1):对别的空间发命令一律被拒 ⇒ 先换回种子所在的空间再清,
      //   ⛔ 别把那几条命令的拒吞掉了事(首版就是这么把种子留在册里的)。带记号的一并扫(上一趟崩在半路留下的也清)。
      let left = 0;
      const has = (x) => String(x.content ?? x.title ?? "").includes(M);
      for (const sp of new Set(seeded.map((x) => x.space))) {
        if ((await rawInv("list_spaces")).find((x) => x.current)?.id !== sp) await toSpace(sp);
        const ids = new Set(seeded.filter((x) => x.space === sp).map((x) => x.id));
        for (const c of ["list_tasks", "list_sealed_tasks", "list_trash"]) for (const r of await rawInv(c, { spaceId: sp })) if (has(r)) ids.add(r.id);
        for (const id of ids) for (const c of ["unseal_task", "archive_task", "purge_task"]) await rawInv(c, { spaceId: sp, id }).catch(() => null); // 三条按现状总有拒的(已不在册 / 已在回收站),零残留由下一行判
        for (const c of ["list_tasks", "list_sealed_tasks", "list_trash", "list_timeline"]) left += (await rawInv(c, { spaceId: sp })).filter(has).length;
      }
      step("清场:看板 / 归档 / 回收站 / 时间轴都没有种子", left === 0, { left });
      // 各空间「正看着哪块看板」放回起跑时的记录
      const set = {};
      for (const [sp, v] of Object.entries(savedViews)) set[`zhujian.board-current.${sp}`] = v;
      const cur = (await rawInv("list_spaces")).find((x) => x.current)?.id;
      if (startSpace && cur !== startSpace) await rawInv("activate_space", { spaceId: startSpace });
      if (startSpace) set["zhujian.last-space"] = startSpace;
      await reload(set);
      const now = (await rawInv("list_spaces")).find((x) => x.current)?.id;
      step("收尾:回到起跑时那个空间、没开着面", now === startSpace && !(await evalJs(`document.body.classList.contains("pane-open")`)), { now, startSpace });
    } catch (e) {
      step("收尾没抛异常", false, String(e?.stack ?? e));
    }
    try {
      s.close();
    } catch {
      /* 连接已断 */
    }
  }
};

main()
  .catch((e) => {
    out.steps.push({ name: "驱动没崩", ok: false, detail: String(e?.stack ?? e) });
  })
  .finally(() => {
    out.pass = out.steps.length > 0 && out.steps.every((x) => x.ok === true || x.ok === "SKIPPED");
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.pass ? 0 : 1);
  });
