// 滑动改状态的回执条(402):操作型回执 actionBar 替换 confirmBar 挪用——
// 断言「恰一枚『撤销』钮、条上无『取消』、#confirmbar 全程不出场」+ 点撤销真回退。
//
// 跑法(一条命令跑完;多台设备同连时 `export ANDROID_SERIAL=<serial>` 再 forward):
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-swipe-undo.mjs      # 打印 {pass, steps, residue}
//
// ⭐⭐ **91 把它从页内两相形改成了驱动形,别改回去。** 从前它是一支 `@cdp-run single` 的
// 页内脚本,靠 `window.__swipeUndoProbe` 认第二相、中间要人手工发一条 CLI swipe。
// 于是跑手(`cdp-run.mjs`)一发跑到的永远只有第一相 —— **播下探针任务、三格全绿、报 PASS**,
// 而那张卡就留在库里了(641 在 MuMu 上量到的 `timeline 2→3` 就是它)。
// ⇒ 判据全绿的资产照样能往用户库里写,而「两相形」正是这种假绿的温床。
// 真触摸滑动要走 `Input.dispatchTouchEvent`(协议层)⇒ 按 skill 的分界它本来就该是驱动形:
// 三相(播种 → 滑 → 断言)全在**同一条 CDP 会话**里连着跑,撤销窗口 6s 再也磨蹭不掉。
//
// 断言与语言无关:前后态以卡头顶那段节头的文本自证(swipe 前记下、swipe 后必变、撤销后必回;85 ④ 起卡上没有 .pill 了),
// 「没有取消钮」以结构自证(恰一枚 .bar-act + #confirmbar 全程 hidden)——别绑死中文词,
// 模拟器常是 en 界面。
// ⭐ 清场**恒跑**(driver 的 finally),且自己做一次六面库普查对账 —— 判据不是「资产说它清干净了」
// 而是「库回没回到起跑时的样子」(80 那格设计,驱动形跑手不经手 `cdp-run` 就得自己带一份)。
import { openSession, pageTarget, sleep, touchSwipe } from "./lib/cdp.mjs";
import { JS_CENSUS, censusDiff, censusEqual } from "./lib/cdp-assets.mjs";

const PORT = Number(process.env.CDP_PORT || 9222);
const TIMEOUT = Number(process.env.CDP_TIMEOUT_MS || 20000);

// 三段页内脚本共用的助手。⛔ 每段各自 IIFE 包起来(391:`Runtime.evaluate` 的每一发都跑在
// 同一个全局作用域里,顶层 const 第二次就 SyntaxError,而且**整段一行不执行**)。
const HELPERS = `
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const err = document.getElementById("error");
  const cb = document.getElementById("confirmbar");
  const cardOf = (id) => document.querySelector('#timeline [data-id="' + id + '"]');
  // 卡的状态读它头顶那段的节头(任务面恒按状态分段,.tl-sec 就是 stageLabel 那行字)。
  // ⛔ 85 ④ 起卡上不再盖 .pill —— 节头是屏上唯一写着状态名的地方,回执文案点名的也是它。
  // ⚠ 这段住在模板字符串里,注释里别写反引号。
  const pillOf = (id) => {
    const c = cardOf(id);
    const h = c && c.closest(".tl-group") && c.closest(".tl-group").querySelector(".tl-sec");
    return h ? h.textContent : null;
  };
  const trashRow = (id) => document.querySelector('[data-trash="' + id + '"]');
  const trashOpen = () => !document.getElementById("trash-pane").hidden;
  const setTrash = async (want) => {
    if (trashOpen() === want) return true;
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    return (await until(() => trashOpen() === want, 1500)) !== null;
  };
  const openCardAct = async (id, act) => {
    for (let i = 0; i < 3; i++) {
      const c = cardOf(id);
      const hit = c && c.querySelector('.panel [data-pact="' + act + '"]');
      if (hit) return hit;
      const body = c && c.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => {
        const cc = cardOf(id);
        return cc && cc.querySelector('.panel [data-pact="' + act + '"]');
      }, 1500);
      if (got) return got;
    }
    return null;
  };
  const openTrashAct = async (id, act) => {
    for (let i = 0; i < 3; i++) {
      const r = trashRow(id);
      const hit = r && r.querySelector('[data-trash-act="' + act + '"]');
      if (hit) return hit;
      const body = r && r.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => {
        const rr = trashRow(id);
        return rr && rr.querySelector('[data-trash-act="' + act + '"]');
      }, 1500);
      if (got) return got;
    }
    return null;
  };
`;

// ── 第一相:切任务面、种一张待办卡、算滑动坐标 ────────────────────────────────
const JS_SEED = `(async () => {
  ${HELPERS}
  const out = { ok: false, steps: [] };
  const ok = (name, cond) => { out.steps.push({ name, ok: !!cond }); return !!cond; };
  const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
  click(tasksBtn);
  if (!ok("切到任务面", await until(() => tasksBtn.classList.contains("active"), 2000))) return out;
  const marker = "【CDP验收】滑动撤销 " + Date.now();
  const ta = document.getElementById("text");
  ta.value = marker;
  click(document.getElementById("save"));
  const card = await until(() =>
    [...document.querySelectorAll("#timeline [data-id]")].find((c) => {
      const p = c.querySelector(".content");
      return p && p.textContent.includes(marker);
    }),
  );
  if (!ok("探针任务入时间轴", !!card)) return out;
  out.id = card.dataset.id;
  out.fromLabel = pillOf(out.id);
  if (!ok("出生落在带状态节头的段里(待办)", !!out.fromLabel)) return out;
  card.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 200));
  const r = cardOf(out.id).getBoundingClientRect();
  // 起点取卡宽 35% 处(躲开左侧勾框),右滑 170px(> COMMIT_MIN 84 与卡宽 35% 阈值)。
  const x = Math.round(r.left + r.width * 0.35);
  const y = Math.round(r.top + r.height / 2);
  out.swipe = { x1: x, y1: y, x2: x + 170, y2: y };
  out.ok = true;
  return out;
})()`;

// ── 第二相:swipe 已发(同一条会话,撤销窗口 6s 内)。断言回执形态 → 点撤销 → 断言回退 ──
const jsVerify = (id, fromLabel) => `(async () => {
  ${HELPERS}
  const out = { steps: [] };
  const ok = (name, cond) => { out.steps.push({ name, ok: !!cond }); return !!cond; };
  const id = ${JSON.stringify(id)};
  const fromLabel = ${JSON.stringify(fromLabel)};
  const toLabel = await until(() => {
    const p = pillOf(id);
    return p && p !== fromLabel ? p : null;
  }, 3000);
  ok("滑动已提交:stage 前进一档", !!toLabel);
  if (!ok("回执条在场(6s 窗口内)", !err.hidden)) return out;
  ok("回执是 notice + with-act 形", err.classList.contains("notice") && err.classList.contains("with-act"));
  ok("文案点名新状态", !!toLabel && err.textContent.includes(toLabel));
  const btns = err.querySelectorAll("button");
  ok("恰一枚动作钮(.bar-act,无取消钮)", btns.length === 1 && btns[0].className === "bar-act");
  ok("confirmbar 没被挪用(全程 hidden)", cb.hidden);
  click(err.querySelector(".bar-act"));
  ok("撤销后回到原状态", (await until(() => pillOf(id) === fromLabel, 3000)) !== null);
  ok("点撤销即收条", await until(() => err.hidden, 1500));
  ok("撤销不弹确认(confirmbar 仍 hidden)", cb.hidden);
  return out;
})()`;

// ── 清场(恒跑):删进回收站 → 回收站彻底删。⭐ 取「彻底删除」前先点卡片开面板 ──────
//    (51 起那两枚离场钮不常驻;从前直接取 = 恒 null = 崩在清场路上,正是 91 那条账)
const jsCleanup = (id) => `(async () => {
  ${HELPERS}
  const id = ${JSON.stringify(id)};
  const out = {};
  try {
    if (!cb.hidden) click(document.getElementById("confirmbar-no"));
    if (cardOf(id)) {
      const del = await openCardAct(id, "del");
      if (del) {
        click(del);
        await until(() => !cb.hidden, 1500);
        click(document.getElementById("confirmbar-yes"));
        await until(() => !cardOf(id), 2000);
      }
    }
    await setTrash(true);
    await until(() => trashRow(id), 2500);
    const purge = await openTrashAct(id, "purge");
    if (purge) {
      click(purge);
      await until(() => !cb.hidden, 1500);
      click(document.getElementById("confirmbar-yes"));
      await until(() => !trashRow(id), 2000);
    }
    // ⚠ 趁面还开着量 —— 收了面之后 [data-trash] 本来就不在 DOM 里,那时再问恒「干净」。
    out.residueSeen = !!trashRow(id);
    await setTrash(false);
    out.onTimeline = !!cardOf(id);
  } catch (e) {
    out.error = String(e);
  }
  return out;
})()`;

/** 后端两拍读数一样才算静下来(⛔ 别拿 sleep 顶,632 撞过两次)。 */
async function settledCensus(s, tries = 15, gapMs = 400) {
  let prev = await s.evaluate(JS_CENSUS);
  if (prev?.error) throw new Error(`库普查读不到:${prev.error}`);
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    const now = await s.evaluate(JS_CENSUS);
    if (now?.error) throw new Error(`库普查读不到:${now.error}`);
    if (censusEqual(prev, now)) return now;
    prev = now;
  }
  throw new Error(`库普查 ${tries} 拍还没静下来(最后一拍 ${JSON.stringify(prev)})`);
}

async function main() {
  const out = { pass: false, steps: [] };
  const t = await pageTarget(PORT);
  const s = await openSession(t.webSocketDebuggerUrl, { timeoutMs: TIMEOUT });
  let id = null;
  try {
    out.census = { before: await settledCensus(s) };
    const seed = await s.evaluate(JS_SEED);
    out.steps.push(...seed.steps);
    id = seed.id ?? null;
    if (!seed.ok) throw new Error("第一相没摆好局(见 steps)——⛔ 别往下跑,滑的会是别人的卡");
    out.swipe = seed.swipe;
    // 真触摸滑动:同一条会话上连着发,撤销窗口 6s ⇒ ⛔ 别拆成两条 CLI 调用。
    await touchSwipe(s, seed.swipe.x1, seed.swipe.y1, seed.swipe.x2, seed.swipe.y2);
    const verify = await s.evaluate(jsVerify(id, seed.fromLabel));
    out.steps.push(...verify.steps);
  } catch (e) {
    out.runError = String(e?.message ?? e);
  } finally {
    if (id) {
      out.cleanup = await s.evaluate(jsCleanup(id)).catch((e) => ({ error: String(e?.message ?? e) }));
      out.steps.push({
        name: "清场:探针条目零残留",
        ok: out.cleanup?.residueSeen === false && out.cleanup?.onTimeline === false,
      });
    }
    out.census.after = await settledCensus(s).catch((e) => ({ error: e.message }));
    out.residue = censusDiff(out.census.before, out.census.after);
    s.close();
  }
  // ⭐ 库普查那一格压过资产自己的话:判据全绿而库里多了东西,照样不算过(641 逮的就是这一形)。
  out.pass =
    out.steps.length > 0 && out.steps.every((x) => x.ok) && !out.runError && out.residue.length === 0;
  return out;
}

const res = await main().catch((e) => ({ pass: false, error: String(e?.stack ?? e) }));
console.log(JSON.stringify(res, null, 2));
if (res.residue?.length) {
  console.error(`\n⚠⚠⚠ 用户库有残留:${res.residue.map((d) => `${d.key} ${d.before}→${d.after}`).join(",")}`);
  process.exit(3);
}
process.exit(res.pass ? 0 : 1);
