// 应用评审取舍题(用户 2026-11-13 拍板的四条)手机 Q 组的真机回归网。
// 驱动形(要重载页面换语言、要换空间;CDP 摆前置、读状态、量几何)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-q.mjs                    # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-q.mjs --shots <目录>      # 关键几拍各截一张真屏
//   PICKSQ_KNIFE=css node scripts/cdp-acceptance-picks-q.mjs   # 阴性对照:页内把三处改坏,对应那几格应当红
//     (Q1 角标与选择钮放开折行并夹窄 / Q3 重置入口抹回一行淡字 / Q4 筛选排改成不可滚 ⇒ 选中那枚挪不进来)
//
// 逐条(编号同 .zjshots/903-fix/mob-q.md):
//  Q1  优先级三档读作「高 / 中 / 低」(英文 High / Medium / Low):卡片角标「优先级·高」、操作面的值、选择排「无 · 高 · 中 · 低」、
//      改完的回执「已设优先级 中」;卡与操作面里不再有 P0 / P1 / P2 字样。英文档 + 字号最大档(130)下:角标「Priority · Medium」
//      不折行、没被截成省略号、同卡的截止角标也没被挤短;选择排四枚钮各自单行(钮内不折字)、不出屏 —— 挤不下时整枚换到下一行是规矩
//      (ui-guidelines §3.6),排成几行只记不判。
//  Q2  每次打开设置都从最上面开始(划到中段 → 关 → 再开 = 顶);**不该变的那半**:设置 → 诊断 → 返回,回到进子面前的位置。
//  Q3  空间页「⋯」展开的重置入口是一枚钮:与同页白钮(「全部同步…」)同字号同边框、整行宽、高 ≥ 44、五点打得到;文案逐字没动;
//      只展开、⛔ 不点它。
//  Q4  归档面看板筛选排:把那排夹窄到只容得下一枚(页内 CSS,造「看板很多」的形)后进面 ⇒ 选中的当前看板整枚在可视区里、
//      整页没有竖向滚;点别的枚(全部看板 / 最后一枚)同样跟进来;再点已在视野里的那枚 ⇒ 那排不跳。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面。
// 会写库:只在**默认空间**(main)现造一张卡(正文带 `PICKSQ` 记号,带截止与优先级),收尾 archive → purge 并自证零残留。
//   ⚠ 起跑时人在别的空间就切到 main 跑,跑完切回起跑时那个空间、中文档、字号放回起跑时那一档。Q4 不写库(只切看筛选)。
// 诚实边界:
//  ① Q2 与 Q4 的「滚到哪儿」是 JS 行为,页内下不了刀:Q2 靠自证前置(关之前真的不在顶)+ 子面返回那半互为对照;
//     Q4 的刀是把那排改成不可滚(证明判据真看几何),「没有那几行代码会红」另由一格自证(手动把 scrollLeft 归零 ⇒ 选中那枚出界);
//  ② Q4 需要活看板 ≥ 2 块的空间(手机不建看板)—— 这台没有就整段 SKIPPED;「看板真的多到溢出」是用夹窄那排造的,不是真有那么多块;
//  ③ Q1 的几何只量了这台(视口 360 宽);更窄的屏、鸿蒙没量;「读得通不通」靠 --shots 的图;
//  ④ Q3 只核几何与 computed,不点重置(那是删本机数据的入口);确认流归 cdp-acceptance-p1-touch.js。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.PICKSQ_KNIFE === "css";
const M = "PICKSQ";
const KNIFE_CSS = [
  ".card footer .chip,.panel button.p{white-space:normal !important;max-width:4.5em !important;overflow:visible !important}",
  ".space-row.sub .act{border:none !important;min-height:0 !important;padding:2px 6px !important;flex:none !important;font-size:12px !important}",
  "#sealed-list > .sealed-boards{overflow:visible !important}",
].join("\n");

const out = { pass: false, knife: KNIFE, steps: [] };
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
  const barText = () => evalJs(`(()=>{const e=document.getElementById("error");if(e.hidden)return "";const c=e.cloneNode(true);c.querySelectorAll(".bar-act").forEach(b=>b.remove());return c.textContent.trim()})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()`);
  const snap = async (name) => {
    if (!SHOTS) return;
    await sleep(400);
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}${KNIFE ? "-knife" : ""}.png`, stdout);
  };
  const knife = async () => {
    if (KNIFE) await evalJs(`(()=>{if(document.getElementById("picksq-knife"))return 1;const st=document.createElement("style");st.id="picksq-knife";st.textContent=${J(KNIFE_CSS)};document.head.appendChild(st);return 1})()`);
  };
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o){if(o[k]===null)localStorage.removeItem(k);else localStorage.setItem(k,o[k])}location.reload();return 1})()`).catch(() => 1);
    await sleep(1500);
    await until(`document.readyState==="complete"&&!!document.getElementById("gate")&&document.getElementById("gate").hidden`, 15000);
    await sleep(1200);
    await knife();
  };
  const toSpace = async (id) => {
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(id)}}).then(()=>1)`);
    await reload({ "zhujian.last-space": id });
  };
  const curSpace = async () => (await rawInv("list_spaces")).find((x) => x.current)?.id;
  const toTasks = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")||document.body.dataset.view!=="tasks"`)) {
      await click(`[data-mode="tasks"]`);
      await until(`!document.body.classList.contains("pane-open")&&document.body.dataset.view==="tasks"`, 3000);
    }
    await sleep(250);
  };
  const pickBoard = async (id) => {
    await toTasks();
    if (!(await evalJs(`!!document.querySelector('#filter-boards [data-board="${id}"]')`))) return true; // 只有一块看板 = 没有那排,本来就在它上面
    await click(`#filter-boards [data-board="${id}"]`);
    await until(`!!document.querySelector('#filter-boards [data-board="${id}"].active')`, 3000);
    await sleep(300);
    return true;
  };
  const card = (id) => `document.querySelector('#timeline [data-id="${id}"]')`;
  const pact = (id, p) => `${card(id)}?.querySelector('[data-pact="${p}"]')`;
  const openPanel = async (id) => {
    for (let i = 0; i < 4; i++) {
      if (await evalJs(`!!${pact(id, "more")}`)) return true;
      if (await evalJs(`!!${pact(id, "back")}`)) await evalJs(`${pact(id, "back")}.click()`);
      else await evalJs(`${card(id)}?.querySelector(".content")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
      await until(`!!${pact(id, "more")}`, 1500);
    }
    return evalJs(`!!${pact(id, "more")}`);
  };
  const openPrio = async (id) => {
    await openPanel(id);
    await evalJs(`${pact(id, "prio")}?.click()`);
    return until(`!!${card(id)}?.querySelector('[data-prio="3"]')`, 2500);
  };
  /** 卡上角标与(开着的话)优先级选择排的几何。 */
  const prioGeom = (id) =>
    evalJs(`(()=>{const c=${card(id)};if(!c)return null;
      const rect=e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,h:r.height,w:r.width}};
      const chips=[...c.querySelectorAll("footer .chip")].map(e=>({text:e.textContent,due:e.classList.contains("due"),cut:e.scrollWidth>e.clientWidth+1,lh:parseFloat(getComputedStyle(e).lineHeight),...rect(e)}));
      const ps=[...c.querySelectorAll("[data-prio]")].map(e=>({text:e.textContent,key:e.dataset.prio,cut:e.scrollWidth>e.clientWidth+1,...rect(e)}));
      const prop=c.querySelector('[data-pact="prio"] .v')?.textContent??null;
      return {chips,ps,prop,vw:innerWidth,all:c.textContent}})()`);

  const spaces = await rawInv("list_spaces");
  const startSpace = spaces.find((x) => x.current)?.id;
  const startSize = await evalJs(`Number(localStorage.getItem("zhujian.textsize"))||100`);
  let seedId = null;
  const savedViews = {};

  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    for (const sp of spaces) savedViews[sp.id] = await evalJs(`localStorage.getItem(${J(`zhujian.board-current.${sp.id}`)})`);
    if (startSpace !== "main") await toSpace("main");
    else await knife();
    await clearBar();

    // ── Q1 ────────────────────────────────────────────────────────────────────
    const d = new Date(Date.now() + 9 * 86400000);
    const dueIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    seedId = await rawInv("create_task", { spaceId: "main", title: `${M}-优先级角标 ${Date.now()}`, dueOn: dueIso, priority: 3, topicId: null });
    await reload();
    const boards = await rawInv("list_boards", { spaceId: "main" });
    const cols = await rawInv("list_board_columns", { spaceId: "main" });
    const mine = (await rawInv("list_tasks", { spaceId: "main" })).find((x) => x.id === seedId);
    const homeBoard = cols.find((c) => c.id === mine?.status)?.board_id ?? boards.find((b) => b.is_default)?.id;
    await pickBoard(homeBoard);
    if (step("Q1 前置:现造的那张卡在看板上", !!(await until(`!!${card(seedId)}`, 5000)), { homeBoard })) {
      await evalJs(`(()=>{${card(seedId)}.scrollIntoView({block:"center"});return 1})()`);
      await sleep(400);
      let g = await prioGeom(seedId);
      step("Q1 卡片角标「优先级·高」", g.chips.some((c) => c.text === "优先级·高"), g.chips.map((c) => c.text));
      await snap("Q1-zh-chip");
      step("Q1 前置:优先级选择排打得开", !!(await openPrio(seedId)));
      g = await prioGeom(seedId);
      step("Q1 选择排 = 无 · 高 · 中 · 低(键 空/3/2/1)", J(g.ps.map((p) => [p.text, p.key])) === J([["无", ""], ["高", "3"], ["中", "2"], ["低", "1"]]), g.ps.map((p) => [p.text, p.key]));
      await snap("Q1-zh-picker");
      await clearBar();
      await evalJs(`${card(seedId)}.querySelector('[data-prio="2"]').click()`);
      const rec = await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&/已设优先级/.test(e.textContent)})()`, 5000);
      step("Q1 改成中档的回执「已设优先级 中」", !!rec && (await barText()) === "已设优先级 中", await barText());
      await snap("Q1-zh-receipt");
      await clearBar();
      await until(`[...(${card(seedId)}?.querySelectorAll("footer .chip")??[])].some(c=>c.textContent==="优先级·中")`, 4000);
      await openPanel(seedId);
      g = await prioGeom(seedId);
      step("Q1 角标与操作面的值跟着变(优先级·中 / 中)", g.chips.some((c) => c.text === "优先级·中") && g.prop === "中", { chips: g.chips.map((c) => c.text), prop: g.prop });
      step("Q1 卡与操作面里没有 P0 / P1 / P2 字样", !/P[012](?![0-9A-Za-z])/.test(g.all.replace(M, "")), g.all.slice(0, 120));

      // 英文档 + 字号最大档
      await reload({ "zhujian.lang": "en" });
      if (step("Q1 英文档已生效", (await evalJs(`document.documentElement.lang`)) === "en")) {
        // 鸿蒙没有字号桥(`HAS_TEXT_ZOOM` 关着,905 真机上撞到)⇒ 那台只验默认字号,报在 skipped 里。
        if (await evalJs(`typeof window.__zhujianTextSize?.set==="function"`)) await evalJs(`(()=>{window.__zhujianTextSize.set(130);return 1})()`);
        else (out.skipped ??= []).push("Q1 / Q3 最大字号:这台没有字号桥,按默认字号量的");
        await sleep(900);
        await pickBoard(homeBoard);
        await until(`!!${card(seedId)}`, 5000);
        await evalJs(`(()=>{${card(seedId)}.scrollIntoView({block:"center"});return 1})()`);
        await sleep(500);
        g = await prioGeom(seedId);
        const pc = g.chips.find((c) => c.text === "Priority · Medium");
        const dc = g.chips.find((c) => c.due);
        step("Q1 en 角标「Priority · Medium」", !!pc, g.chips.map((c) => c.text));
        step("Q1 en 最大字号:自证前置 —— 同卡还有一枚截止角标(否则「挤掉别的」是空测)", !!dc, g.chips.map((c) => c.text));
        if (pc && dc) {
          step("Q1 en 最大字号:角标单行(高 < 两行)、没截成省略号、不出屏", pc.h < pc.lh * 1.9 && !pc.cut && pc.r <= g.vw + 0.5 && pc.l >= 0, pc);
          step("Q1 en 最大字号:截止角标没被挤短(单行、没截字)", dc.h < dc.lh * 1.9 && !dc.cut && dc.w > 20, dc);
          out.q1ChipRowShared = Math.abs(pc.t - dc.t) < 2; // 只记不判:footer 本来就许折到下一行
        }
        await snap("Q1-en-130-chip");
        step("Q1 en 前置:优先级选择排打得开", !!(await openPrio(seedId)));
        await sleep(300);
        g = await prioGeom(seedId);
        step("Q1 en 选择排 = None · High · Medium · Low", J(g.ps.map((p) => p.text)) === J(["None", "High", "Medium", "Low"]), g.ps.map((p) => p.text));
        const h0 = g.ps[0]?.h ?? 0;
        step(
          "Q1 en 最大字号:四枚钮各自单行(与「None」同高)、没截字、不出屏",
          g.ps.length === 4 && g.ps.every((p) => Math.abs(p.h - h0) < 1.5 && !p.cut && p.r <= g.vw + 0.5 && p.l >= 0),
          g.ps,
        );
        out.q1PickerRows = new Set(g.ps.map((p) => Math.round(p.t))).size; // 只记不判:挤不下时整枚换到下一行是规矩(ui-guidelines §3.6),钮自己不折字才是判据
        await snap("Q1-en-130-picker");
        await evalJs(`${pact(seedId, "back")}?.click()`);
        await evalJs(`(()=>{window.__zhujianTextSize?.set(${startSize});return 1})()`);
      }
      await reload({ "zhujian.lang": "zh" });
      step("Q1 回到中文档", (await evalJs(`document.documentElement.lang`)) === "zh");
    }

    // ── Q2 ────────────────────────────────────────────────────────────────────
    await toTasks();
    const settingsOpen = `(!document.getElementById("settings-pane").hidden&&document.body.classList.contains("pane-open"))`;
    await click("#settings-toggle");
    if (step("Q2 前置:设置面开了", !!(await until(settingsOpen, 3000)))) {
      await sleep(500);
      const top0 = await evalJs(`document.scrollingElement.scrollTop`);
      const y0 = await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=Math.round((se.scrollHeight-innerHeight)*0.6);return se.scrollTop})()`);
      await sleep(300);
      step("Q2 自证前置:设置面够长,关之前真的不在顶", top0 < 2 && y0 > 150, { top0, y0 });
      await snap("Q2-scrolled");
      await click("#settings-toggle");
      await until(`!document.body.classList.contains("pane-open")`, 3000);
      await sleep(300);
      await click("#settings-toggle");
      await until(settingsOpen, 3000);
      await sleep(600);
      const y1 = await evalJs(`document.scrollingElement.scrollTop`);
      step("Q2 关了再开:从最上面开始", y1 < 2, `${y0} → ${y1}`);
      await snap("Q2-reopened");
      // 不该变的那半:进子面再返回 = 回原位置
      const yd = await evalJs(`(()=>{document.getElementById("settings-diag-btn").scrollIntoView({block:"center"});return 1})()`).then(async () => {
        await sleep(500);
        return evalJs(`document.scrollingElement.scrollTop`);
      });
      await click("#settings-diag-btn");
      const inDiag = await until(`!document.getElementById("diag").hidden&&document.body.classList.contains("pane-open")`, 3000);
      await sleep(300);
      if (process.argv.includes("--ohos")) await execFileAsync(process.env.HDC ?? "G:/ohos-sdk/toolchains/hdc.exe", ["shell", "uitest uiInput keyEvent Back"]); // 鸿蒙:返回键走 hdc(905)
      else await execFileAsync("adb", ["shell", "input", "keyevent", "4"]);
      const backOk = await until(settingsOpen, 4000);
      await sleep(600);
      const yb = await evalJs(`document.scrollingElement.scrollTop`);
      step("Q2 设置 → 诊断 → 返回键:回到进子面前的位置(照旧)", !!inDiag && !!backOk && yd > 150 && Math.abs(yb - yd) < 6, { yd, yb, inDiag: !!inDiag });
      // 从别的面换到设置也是「打开设置面」:同样在顶
      await click("#search-toggle");
      await until(`!document.getElementById("search-pane").hidden`, 3000);
      await evalJs(`(()=>{document.activeElement?.blur?.();return 1})()`);
      await click("#settings-toggle");
      await until(settingsOpen, 3000);
      await sleep(500);
      step("Q2 从搜索面换到设置:也在顶", (await evalJs(`document.scrollingElement.scrollTop`)) < 2);
      await click("#settings-toggle");
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }

    // ── Q3 ────────────────────────────────────────────────────────────────────
    await toTasks();
    const spacesOpen = `(!document.getElementById("spaces").hidden&&document.body.classList.contains("pane-open"))`;
    if (await evalJs(`!document.getElementById("space-chip").hidden`)) await click("#space-chip");
    else {
      await click("#sync-toggle");
      await until(`!document.getElementById("sync-spaces-btn").hidden`, 3000);
      await click("#sync-spaces-btn");
    }
    if (step("Q3 前置:空间页开了", !!(await until(spacesOpen, 4000)))) {
      await until(`!!document.querySelector("#space-list .space-row [data-more]")`, 3000);
      step("Q3 默认不常驻重置入口", await evalJs(`!document.querySelector("#space-list [data-reset]")`));
      await click("#space-list .space-row [data-more]");
      const has = await until(`!!document.querySelector("#space-list [data-reset]")`, 2000);
      await evalJs(`(()=>{document.querySelector("#space-list [data-reset]")?.scrollIntoView({block:"center"});return 1})()`);
      await sleep(500);
      if (step("Q3 「⋯」展开出重置入口", !!has)) {
        const q = await evalJs(`(()=>{const b=document.querySelector("#space-list [data-reset]");const ref=document.getElementById("sync-all-btn");
          const cs=getComputedStyle(b),rs=getComputedStyle(ref);const r=b.getBoundingClientRect(),rr=ref.getBoundingClientRect();
          const sub=b.closest(".space-row"),ss=getComputedStyle(sub);const prev=sub.previousElementSibling.getBoundingClientRect();const next=sub.nextElementSibling?.getBoundingClientRect()??null;
          const pts=[[r.left+r.width/2,r.top+r.height/2],[r.left+2,r.top+2],[r.right-2,r.top+2],[r.left+2,r.bottom-2],[r.right-2,r.bottom-2]];
          const hits=pts.map(([x,y])=>{const e=document.elementFromPoint(x,y);return !!e&&(e===b||b.contains(e))});
          return {text:b.textContent,h:r.height,w:r.width,refW:rr.width,refH:rr.height,
            bw:parseFloat(cs.borderTopWidth),bs:cs.borderTopStyle,bc:cs.borderTopColor,refBc:rs.borderTopColor,refBw:parseFloat(rs.borderTopWidth),
            fs:cs.fontSize,refFs:rs.fontSize,color:cs.color,refColor:rs.color,radius:cs.borderTopLeftRadius,refRadius:rs.borderTopLeftRadius,
            subBorder:parseFloat(ss.borderTopWidth),gapPrev:r.top-prev.bottom,gapNext:next?next.top-r.bottom:null,hits}})()`);
        step("Q3 文案逐字没动", q.text === "重置(删除本机此空间数据)…", q.text);
        step("Q3 高 ≥ 44、整行宽(与「全部同步…」同宽)", q.h >= 44 && Math.abs(q.w - q.refW) < 2, { h: q.h, w: q.w, refW: q.refW });
        step("Q3 与同页白钮同一形:实线边框同色同粗、同字号、同字色、同圆角", q.bs === "solid" && q.bw >= 0.5 && Math.abs(q.bw - q.refBw) < 0.1 && q.bc === q.refBc && q.fs === q.refFs && q.color === q.refColor && q.radius === q.refRadius, q);
        step("Q3 子行自己不再画框(不框套框)", q.subBorder === 0, q.subBorder);
        step("Q3 五点都打在它身上;与上下邻不叠", q.hits.every(Boolean) && q.gapPrev >= 0 && (q.gapNext === null || q.gapNext >= 0), { hits: q.hits, gapPrev: q.gapPrev, gapNext: q.gapNext });
        await snap("Q3-reset-entry");
        // 最大字号档再量一眼高与单行
        await evalJs(`(()=>{window.__zhujianTextSize?.set(130);return 1})()`);
        await sleep(800);
        const big = await evalJs(`(()=>{const b=document.querySelector("#space-list [data-reset]");const r=b.getBoundingClientRect();return {h:r.height,r:r.right,vw:innerWidth}})()`);
        step("Q3 字号最大档:仍 ≥ 44、不出屏", big.h >= 44 && big.r <= big.vw + 0.5, big);
        await snap("Q3-reset-entry-130");
        await evalJs(`(()=>{window.__zhujianTextSize?.set(${startSize});return 1})()`);
        await sleep(500);
        await click("#space-list .space-row [data-more]"); // 收回去
      }
    }
    await toTasks();

    // ── Q4 ────────────────────────────────────────────────────────────────────
    let multi = null;
    for (const sp of spaces) {
      // 手机只有当前空间是活的 ⇒ 先看当前这本,不够再换
      const cur = await curSpace();
      if (cur !== sp.id) await toSpace(sp.id);
      const bs = (await rawInv("list_boards", { spaceId: sp.id })).filter((b) => !b.deleted);
      if (bs.length >= 2) {
        multi = { space: sp.id, boards: bs };
        break;
      }
    }
    if (!multi) step("Q4 归档面筛选排:选中那枚滚进视野", "skip", "这台上没有活看板 ≥ 2 块的空间");
    else {
      const sealedOpen = `(!document.getElementById("sealed-pane").hidden&&document.body.classList.contains("pane-open"))`;
      const openSealed = async () => {
        if (await evalJs(`document.body.classList.contains("pane-open")`)) await toTasks();
        await click(`[data-pane="sealed"]`);
        await until(sealedOpen, 3000);
        let prev = null;
        for (let i = 0; i < 12; i++) {
          await sleep(250);
          const now = await evalJs(`document.getElementById("sealed-list").innerHTML.length`);
          if (now === prev && i >= 2) break;
          prev = now;
        }
      };
      const strip = () =>
        evalJs(`(()=>{const st=document.querySelector("#sealed-list .sealed-boards");if(!st)return null;const a=st.querySelector(".fpill.active");
          const s=st.getBoundingClientRect(),r=a?.getBoundingClientRect();
          return {n:st.querySelectorAll(".fpill").length,active:a?.dataset.sealedBoard??null,sl:st.scrollLeft,sw:st.scrollWidth,cw:st.clientWidth,
            inView:!!r&&r.left>=s.left-1&&r.right<=s.right+1,al:r?r.left-s.left:null,ar:r?s.right-r.right:null,y:scrollY}})()`);
      // 挑当前看板:排在最后的那块活看板(它在那排里也靠后)
      const b = multi.boards[multi.boards.length - 1];
      await pickBoard(b.id);
      await openSealed();
      // 把那排夹窄到只容得下最宽那一枚再多一点(造「看板很多」)
      const widest = await evalJs(`Math.max(...[...document.querySelectorAll("#sealed-list .sealed-boards .fpill")].map(e=>e.getBoundingClientRect().width))`);
      await evalJs(`(()=>{const st=document.createElement("style");st.id="picksq-narrow";st.textContent="#sealed-list > .sealed-boards{max-width:${Math.ceil(widest) + 30}px}";document.head.appendChild(st);return 1})()`);
      await toTasks();
      await openSealed();
      let v = await strip();
      step("Q4 自证前置:那排溢出了、选着的是当前看板且不是第一枚", !!v && v.sw > v.cw + 20 && v.active === b.id && v.n >= 2, v);
      step("Q4 进面:选中那枚整枚在可视区里", !!v && v.inView && v.sl > 0, v);
      step("Q4 进面:整页没有竖向滚", !!v && v.y === 0, v?.y);
      await snap("Q4-enter");
      // 自证:没有那一下(手动归零)它就在界外
      const off = await evalJs(`(()=>{const st=document.querySelector("#sealed-list .sealed-boards");const keep=st.scrollLeft;st.scrollLeft=0;const a=st.querySelector(".fpill.active").getBoundingClientRect(),s=st.getBoundingClientRect();const out=a.right>s.right+1;st.scrollLeft=keep;return out})()`);
      step("Q4 自证:把那排滚回最左,选中那枚就出界(判据不是恒绿)", KNIFE ? "skip" : off === true, off);
      // 切选:全部看板(在最左、此刻在界外)
      await click(`#sealed-list [data-sealed-board=""]`);
      await sleep(350);
      v = await strip();
      step("Q4 点「全部看板」:它滚进视野", v.active === "" && v.inView, v);
      // 切选:最后一枚
      const lastId = await evalJs(`[...document.querySelectorAll("#sealed-list [data-sealed-board]")].pop().dataset.sealedBoard`);
      await click(`#sealed-list [data-sealed-board="${lastId}"]`);
      await sleep(350);
      v = await strip();
      step("Q4 点最后一枚:它滚进视野、整页仍没竖向滚", v.active === lastId && v.inView && v.y === 0, v);
      await snap("Q4-pick-last");
      const sl1 = v.sl;
      await click(`#sealed-list [data-sealed-board="${lastId}"]`);
      await sleep(350);
      v = await strip();
      step("Q4 再点已在视野里的那枚:那排不跳(重画后摆回原位)", Math.abs(v.sl - sl1) < 1.5 && v.inView, { before: sl1, after: v.sl });
      await evalJs(`(()=>{document.getElementById("picksq-narrow")?.remove();return 1})()`);
      // 不夹窄时(真实宽度)进面:不溢出就不动
      await toTasks();
      await openSealed();
      v = await strip();
      step("Q4 真实宽度下进面:选中那枚在视野里(不溢出时那排停在最左)", v.inView && (v.sw > v.cw + 1 || v.sl === 0), v);
      await snap("Q4-real-width");
      await toTasks();
    }
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    try {
      await evalJs(`(()=>{document.getElementById("picksq-narrow")?.remove();window.__zhujianTextSize?.set(${startSize});return 1})()`).catch(() => null);
      if ((await curSpace()) !== "main") await toSpace("main");
      const has = (x) => String(x.content ?? x.title ?? "").includes(M);
      const ids = new Set(seedId ? [seedId] : []);
      for (const c of ["list_tasks", "list_trash"]) for (const r of await rawInv(c, { spaceId: "main" })) if (has(r)) ids.add(r.id);
      for (const id of ids) for (const c of ["archive_task", "purge_task"]) await rawInv(c, { spaceId: "main", id }).catch(() => null); // 已在回收站的那条 archive 会被拒,零残留由下一行判
      let left = 0;
      for (const c of ["list_tasks", "list_sealed_tasks", "list_trash", "list_timeline"]) left += (await rawInv(c, { spaceId: "main" })).filter(has).length;
      step("清场:看板 / 归档 / 回收站 / 时间轴都没有种子", left === 0, { left });
      const set = { "zhujian.lang": "zh" };
      for (const [sp, v] of Object.entries(savedViews)) set[`zhujian.board-current.${sp}`] = v;
      if (startSpace && (await curSpace()) !== startSpace) await rawInv("activate_space", { spaceId: startSpace });
      if (startSpace) set["zhujian.last-space"] = startSpace;
      await reload(set);
      await evalJs(`(()=>{document.getElementById("picksq-knife")?.remove();return 1})()`);
      step("收尾:中文档、回到起跑时那个空间、没开着面", (await evalJs(`document.documentElement.lang`)) === "zh" && (await curSpace()) === startSpace && !(await evalJs(`document.body.classList.contains("pane-open")`)), { startSpace });
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
