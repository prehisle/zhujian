// 165(W5「横切」走查,用户 2026-11-06 全取推荐)手机那组 M1 —— 回执与一致性 —— 的真机回归网。
// 驱动形(要真按返回键、真按键盘的回车那一下,CDP 只摆前置、读状态、量几何);⚠ 只在 vivo 这类真机上有意义。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-walk165-m1.mjs          # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   W165_KNIFE=css node scripts/cdp-acceptance-walk165-m1.mjs   # 阴性对照:页内把几处 CSS 修法改回坏的样子,对应那几格应当红
//
// 逐条(编号同 .zjshots/W5-walk/清单.md):
//  Q14  时间写法:今天的写「今天 HH:MM」(回收站「删于 …」、已完成卡「完成于 …」、长文「写于 …」);挪列回执「已移到「…」」。
//  Q6   点了【撤销】、撤成了 ⇒「已撤销」(随记删除 / 挪列 / 截止 / 优先级 / 长文删除五处)。
//  Q5   (查到手机同病)改截止 / 优先级:「已设截止 M月D日」「已设优先级 高」带撤销(903 起三档读作高 / 中 / 低),撤销 = 旧值写回。
//  A20  卡内「新标签名」按键盘的回车(页内合成回车;真按输入法那颗键见回报截图)= 新建并打上 + 回执「已建标签「…」并打上」;同名再来一次 =「已打上标签「…」」。
//  A45  没改过的卡「更多…」里不列「历史」。
//  A55  卡在屏下半截时开「历史」、点开一版比对:面板(连同「返回」)整个在底栏上沿之上。
//  A31  回执条落在吸顶区(顶栏 + 筛选条)之下:筛选条不被盖住、条上的钮不压在筛选条上。
//  A22  还原回执:「已还原到随记」/「已还原到看板「…」列」带【去看看】(操作型、6 s 那档),不写「底栏」。
//  Q15  彻底删除写出删的是哪条「已彻底删除「…」」;长文列表卡 / 阅读页「改于 …」;历史里旧版写它写成的那一刻;
//       再次编辑(停在篇首)光标在末尾;长文列表第一行没写 # 时不加粗。
//  A44  归档卡画标签。
//  A50  「全部归档」不是朱砂字(规范:红色不用于常驻入口)。
//  Q1   长文编辑:新篇左上那枚也叫「← 回到正文」;顶上那行「草稿已存在本机 · 离开就存成一版」;离开说「已存成一篇,在「长文」页」/「已存成一版」。
//  Q4   删长文不问、给【撤销】。
//  A32  上一版末行没带换行、补一段之后比对:那一行不再先红一遍再绿一遍。
//  A46  从回收站进搜索 → 点结果 → 返回两下 = 回到回收站(真返回键)。
//  A33  政策面板切页签从顶上读起;A52 关政策面板(「关闭」/ 返回键)焦点回到打开它的那枚。
//  Q9   搜索 /「过滤…」真点进框(键盘起)后按回车 = 收键盘、焦点离框。
//  A41  (查到手机同病)设置里的分段钮读屏读得出哪段选中(aria-pressed)。
//  A34  同步第一屏说「这台设备」(安卓这一端有备份,那句仍指去 设置 → 备份;鸿蒙那句由 M2 在模拟器上验)。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏手机宽、没开任何面。
//   本资产会写库:建几条带标记「W165M1-<时刻>」的随记 / 任务 / 长文与一枚同名标签,收尾全部彻底删掉(连回收站与归档),
//   最后一格核「零残留」。⛔ 别在用户日常那台上跑。
//
// 诚实边界:
//  ① 「过滤…」/ 搜索 / 卡内标签框的回车是**页内合成**的 keydown(isComposing=false):V1986A + 搜狗上 `adb keyevent 66` 在组字态下
//     进来恒是 isComposing=true(§3.3:那一下是上屏不是提交,处理器照规矩不理),判不了「接没接上」。输入法右下那颗动作键
//     真按的那一趟是手走截图(.zjshots/W5-fix/M1/);用户那台输入法上那颗键写什么、会不会先吞一下,只有真手按得出(清单 D 节)。
//  ② A31 只量了手机竖放(筛选条在屏上时);平板 / 横放的那半用 `ui-shots-wide.mjs` 截图量(见回报),鸿蒙平板那半归 M2。
//  ③ 任务空态底下那句「归档了 N 张」要在一张活任务都没有的库上才出,种子库上判不了 ⇒ 本资产不判,真机手走。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const PORT = 9222;
const PKG = "app.zhujian.notebook";
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function imeShown() {
  const out = await adb(["shell", "dumpsys", "input_method"]).catch(() => null);
  const m = out?.stdout.match(/mInputShown=(true|false)/);
  return m ? m[1] === "true" : null;
}
async function focusedPkg() {
  const out = await adb(["shell", "dumpsys", "window"]).catch(() => null);
  const m = out?.stdout.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/);
  return m ? m[1] : null;
}
const back = () => adb(["shell", "input", "keyevent", "4"]);
async function dropIme() {
  if (await imeShown()) {
    await back();
    await sleep(700);
  }
}

async function connect() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null);
    const page = r ? (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
      });
      let id = 0;
      const send = (method, params) =>
        new Promise((res, rej) => {
          const myId = ++id;
          const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 30000);
          const onMsg = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id !== myId) return;
            ws.removeEventListener("message", onMsg);
            clearTimeout(to);
            if (m.error) return rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
            res(m.result);
          };
          ws.addEventListener("message", onMsg);
          ws.send(JSON.stringify({ id: myId, method, params }));
        });
      return { send, close: () => ws.close() };
    }
    await sleep(500);
  }
  throw new Error("无 page target——先 `node scripts/android-cdp.mjs forward`,且 app 在前台");
}

const out = { pass: false, steps: [] };

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    return !!ok;
  };
  const cdp = await connect();
  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
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
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI__.core.invoke(${J(cmd)}, Object.assign({spaceId: window.__w165sp}, ${J(args)}))`);
  const barText = () => evalJs(`(()=>{const e=document.getElementById("error");return e.hidden?"":e.textContent})()`);
  const barActs = () => evalJs(`[...document.querySelectorAll("#error .bar-act")].map(b=>b.textContent)`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  /** 条上那句话本身(操作型回执的字在第一枚 span 里,后面跟着钮;判句子别把钮上的字连进来)。 */
  const MSG = `(()=>{const e=document.getElementById("error");const s=e.querySelector(":scope > span");return s?s.textContent:e.textContent})()`;
  const barIs = (re, ms = 5000) => until(`(()=>{const e=document.getElementById("error");return !e.hidden&&${re}.test(${MSG})})()`, ms);
  const clickBarAct = (label) => evalJs(`(()=>{const b=[...document.querySelectorAll("#error .bar-act")].find(x=>x.textContent===${J(label)});if(!b)return false;b.click();return true})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()`);
  const paneOpen = () => evalJs(`document.body.classList.contains("pane-open")`);
  const closePanes = async () => {
    if (await paneOpen()) {
      await click(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
  };
  const mode = async (m) => {
    await closePanes();
    await click(`#bottombar [data-mode="${m}"]`);
    await until(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`, 3000);
  };
  /** 记一条(走 UI 的「记下」,这样整轴会重拉、卡进快照;IPC 建的不推动刷新)。返回新卡 id。 */
  const capture = async (text) => {
    await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(text)};t.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("save").click();return 1})()`);
    const id = await until(`(()=>{const c=[...document.querySelectorAll("#timeline [data-id]")].find(c=>c.querySelector(".content")?.textContent===${J(text)});return c?c.dataset.id:""})()`, 6000);
    await dropIme();
    return id || null;
  };
  const card = (id) => `document.querySelector('#timeline [data-id="${id}"]')`;
  // 906:「更多…」是屏底菜单层 ⇒ 面里没有的那几枚到层里找(#more-list [data-more-act])
  const pact = (id, p) => `(${card(id)}?.querySelector('.panel [data-pact="${p}"]') ?? (${card(id)}?.querySelector(".panel") && document.getElementById("more-sheet").classList.contains("open") ? document.querySelector('#more-list [data-more-act="${p}"]') : null))`;
  /** 开卡片面板并停在主面(面板可能本来就开着,点正文是收 ⇒ 先看在不在)。 */
  const openPanel = async (id) => {
    for (let i = 0; i < 4; i++) {
      if (await evalJs(`!!${pact(id, "more")}`)) return true;
      if (await evalJs(`!!${pact(id, "back")}`)) await evalJs(`${pact(id, "back")}.click()`);
      else await evalJs(`${card(id)}?.querySelector(".content")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
      await until(`!!${pact(id, "more")}`, 1500);
    }
    return evalJs(`!!${pact(id, "more")}`);
  };
  /** 页内合成一记回车(isComposing=false;组字中的那一记见 A20 头注)。 */
  const ENTER = (el) => `(()=>{const i=${el};if(!i)return false;i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));return true})()`;
  const doPact = async (id, p) => {
    await until(`!!${pact(id, p)}`, 2000);
    return evalJs(`(()=>{const b=${pact(id, p)};if(!b)return false;b.click();return true})()`);
  };

  /** `--shots <目录>`:关键几拍各截一张真屏(设备像素)当回报证据;不给就不截。 */
  const SHOTS = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
  const snap = async (name) => {
    if (!SHOTS) return;
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };

  const KNIFE_CSS = [
    ".error.notice,.error.neutral{top:max(calc(8px + var(--sat)),calc(var(--head-h,0px) + 8px)) !important}", // A31 回执贴回顶栏下沿(压筛选条)
    ".tl-act{color:var(--seal-ink) !important}", // A50 朱砂字回来
    ".doc-card .doc-title.plain{font-weight:600 !important}", // Q15 没写 # 的第一行又加粗
  ].join("\n");
  if (process.env.W165_KNIFE === "css") {
    await evalJs(`(()=>{let k=document.getElementById("w165-knife");if(!k){k=document.createElement("style");k.id="w165-knife";document.head.appendChild(k)}k.textContent=${J(KNIFE_CSS)};return 1})()`);
  }

  // ── 前置 ────────────────────────────────────────────────────────────────────
  if (!step("前置-app 在前台", (await focusedPkg()) === PKG, await focusedPkg())) return out;
  if (!step("前置-界面语言中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return out;
  if (!step("前置-首启告知已同意", (await evalJs(`document.documentElement.dataset.privacy`)) === "ok")) return out;
  if (!step("前置-竖屏手机宽", !(await evalJs(`document.body.classList.contains("widescreen")`)))) return out;
  await evalJs(`(async()=>{window.__w165sp=(await window.__TAURI__.core.invoke("list_spaces")).find(x=>x.current).id;return 1})()`);
  await dropIme();
  await clearBar();
  const M = `W165M1-${Date.now().toString(36)}`;
  const made = { notes: [], tasks: [], docs: [], topics: [] };
  const HM = /\d{2}:\d{2}/.source;

  try {
    // ── 随记:A45 / A20 / Q6 / A31 ────────────────────────────────────────────
    await mode("ideas");
    const n1 = await capture(`${M} 随记一`);
    if (!step("前置-随记一记下了", !!n1)) return out;
    made.notes.push(n1);
    await openPanel(n1);
    await doPact(n1, "more");
    await until(`!!${pact(n1, "copy")}`, 2000);
    step("A45 没改过的随记「更多…」里不列「历史」", await evalJs(`!${pact(n1, "history")} && !!${pact(n1, "copy")}`));
    await doPact(n1, "back");
    await until(`!!${pact(n1, "tags")}`, 2000);
    // A20:卡内「新标签名」按回车。⚠ 回车走页内合成的 keydown(isComposing=false)—— 真机上 `keyevent 66` 在搜狗组字态下进来恒是
    // isComposing=true(按 §3.3 那一下是上屏、不是提交,处理器照规矩不理),合成键判的是「回车接没接上」;输入法右下那颗键真按一次的截图在回报里。
    await doPact(n1, "tags");
    if (step("A20 标签面开了(前置)", await until(`!!${card(n1)}?.querySelector("input.tagnew")`, 4000))) {
      const T = `${M}-tag`;
      made.topics.push(T);
      await clearBar();
      await evalJs(`(()=>{const i=${card(n1)}.querySelector("input.tagnew");i.value=${J(T)};i.dispatchEvent(new Event("input",{bubbles:true}));i.focus();return 1})()`);
      await sleep(300);
      await evalJs(ENTER(`${card(n1)}.querySelector("input.tagnew")`));
      step("A20 回车 = 新建并打上,回执「已建标签「…」并打上」", await barIs(new RegExp(`^已建标签「${T}」并打上$`).toString(), 5000), await barText());
      await snap("A20-tag-created");
      const linked = await until(`(async()=>{const r=(await window.__TAURI__.core.invoke("list_timeline",{spaceId:window.__w165sp})).find(x=>x.id===${J(n1)});return !!r&&r.topics.some(t=>t.title===${J(T)})})()`, 4000);
      step("A20 …库里真挂上了", linked);
      // 回车那一下没接上(阴性刀下就是这样)⇒ 下面几格的前提不在,判 SKIP 往后走,别让后面整段断掉
      if (!linked) {
        step("A20 同名那三格", "skip", "回车没建成标签,前提不在");
        await evalJs(`(()=>{const i=${card(n1)}?.querySelector("input.tagnew");if(i){i.value="";i.dispatchEvent(new Event("input",{bubbles:true}))}return 1})()`);
      } else {
      // 这一张上已打着它、又打一次同名 = 不写库、说「已打上标签」(此前 core 复用那一枚后再挂一次撞 UNIQUE、报「和已有的数据对不上」)
      await until(`!!${card(n1)}?.querySelector("input.tagnew")&&!${card(n1)}.querySelector("input.tagnew").disabled`, 3000);
      await clearBar();
      await evalJs(`(()=>{const i=${card(n1)}.querySelector("input.tagnew");i.value=${J(T)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await evalJs(ENTER(`${card(n1)}.querySelector("input.tagnew")`));
      step("A20 这一张已打着同名标签再回车 = 「已打上标签「…」」、不报错", await barIs(new RegExp(`^已打上标签「${T}」$`).toString(), 5000), await barText());
      // 摘掉它,再用另一种大小写的同名打一次 = core 复用那一枚(不另建),说「已打上标签」
      const tid = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_topics",{spaceId:window.__w165sp})).find(t=>t.title===${J(T)})?.id??"")()`);
      await until(`!!${card(n1)}?.querySelector('[data-topic="${tid}"]')`, 3000);
      await evalJs(`${card(n1)}.querySelector('[data-topic="${tid}"]').click()`);
      await until(`(async()=>{const r=(await window.__TAURI__.core.invoke("list_timeline",{spaceId:window.__w165sp})).find(x=>x.id===${J(n1)});return !!r&&r.topics.length===0})()`, 4000);
      await until(`!!${card(n1)}?.querySelector("input.tagnew")&&!${card(n1)}.querySelector("input.tagnew").disabled`, 3000);
      await clearBar();
      await evalJs(`(()=>{const i=${card(n1)}.querySelector("input.tagnew");i.value=${J(T.toUpperCase())};i.dispatchEvent(new Event("input",{bubbles:true}));i.focus();return 1})()`);
      await sleep(300);
      await evalJs(ENTER(`${card(n1)}.querySelector("input.tagnew")`));
      step("A20 同名(不分大小写)再来 = 回执「已打上标签「…」」(不说已建)", await barIs(new RegExp(`^已打上标签「${T}」$`).toString(), 5000), await barText());
      }
      await dropIme();
    }
    await doPact(n1, "back");
    // Q6:随记删除 → 撤销 →「已撤销」;A31:回执条在筛选条之下
    await openPanel(n1);
    await doPact(n1, "more");
    await clearBar();
    await doPact(n1, "del");
    const delBar = await barIs(/^已移入回收站/.toString(), 5000);
    step("Q6 前置:删随记出「已移入回收站 撤销」", delBar && (await barActs()).includes("撤销"), await barText());
    const geo = JSON.parse(
      await evalJs(`(()=>{const fb=document.getElementById("filterbar");const e=document.getElementById("error").getBoundingClientRect();
        const f=fb.hidden?null:fb.getBoundingClientRect();const a=[...document.querySelectorAll("#error .bar-act")].map(b=>b.getBoundingClientRect());
        return JSON.stringify({bar:[e.top,e.bottom],fbar:f?[f.top,f.bottom]:null,acts:a.map(r=>[r.top,r.bottom])})})()`),
    );
    if (geo.fbar && geo.fbar[1] - geo.fbar[0] > 1) {
      step("A31 回执条落在筛选条下沿之下(不盖筛选条)", geo.bar[0] >= geo.fbar[1] - 0.5, geo);
      step("A31 …条上的钮不压在筛选条上", geo.acts.every((r) => r[0] >= geo.fbar[1] - 0.5), geo);
      await snap("A31-bar-below-filter");
    } else step("A31 回执条与筛选条", "skip", "筛选条没显示(这一面没东西可筛)");
    await clickBarAct("撤销");
    step("Q6 点【撤销】撤成了 ⇒「已撤销」", await barIs(/^已撤销$/.toString(), 5000), await barText());
    await snap("Q6-undone");
    step("Q6 …随记回来了", await until(`!!${card(n1)}`, 4000));
    await clearBar();

    // ── A55:改过的随记在屏下半截开历史 ────────────────────────────────────────
    await openPanel(n1);
    await doPact(n1, "edit");
    if (step("A55 前置:编辑层开了", await until(`document.getElementById("edit-sheet").classList.contains("open")`, 3000))) {
      await evalJs(`(()=>{const t=document.getElementById("edit-text");t.value=${J(`${M} 随记一 改`)};t.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("edit-save").click();return 1})()`);
      await until(`!!${card(n1)}?.querySelector(".edited-mark")`, 5000);
      await dropIme();
      await clearBar();
      // 卡摆到屏下半截(底栏上沿之上一点点)
      await evalJs(`(()=>{const c=${card(n1)};const nav=document.getElementById("bottombar").getBoundingClientRect();window.scrollBy(0,c.getBoundingClientRect().bottom-(nav.top-8));return 1})()`);
      await sleep(400);
      await openPanel(n1);
      await doPact(n1, "more");
      await doPact(n1, "history");
      await until(`!!${card(n1)}?.querySelector(".hist .rev")`, 4000);
      await sleep(300);
      const inView = `(()=>{const p=${card(n1)}.querySelector(".panel").getBoundingClientRect();const nav=document.getElementById("bottombar").getBoundingClientRect();
        const b=${pact(n1, "back")}?.getBoundingClientRect();return JSON.stringify({panelBottom:p.bottom,back:b?b.bottom:null,nav:nav.top})})()`;
      const g1 = JSON.parse(await evalJs(inView));
      step("A55 开「历史」后「返回」在底栏上沿之上", g1.back !== null && g1.back <= g1.nav + 0.5, g1);
      await evalJs(`${card(n1)}.querySelector(".hist [data-rev]").click()`);
      await until(`!!${card(n1)}?.querySelector(".rev.open .diff")`, 4000);
      await sleep(300);
      const g2 = JSON.parse(await evalJs(inView));
      step("A55 点开一版比对后,面板连同「返回」整个在底栏上沿之上", g2.back !== null && g2.panelBottom <= g2.nav + 0.5, g2);
      await snap("A55-history-diff");
      step("A45 改过的随记「更多…」里有「历史」(前置成立)", true);
      await doPact(n1, "back");
    }
    await clearBar();

    await evalJs(`window.scrollTo(0,0)`);

    // ── 任务:Q14 挪列 / Q6 / Q5 / A50 / A44 / Q14 时间 ─────────────────────────
    await mode("tasks");
    const t1 = await capture(`${M} 任务一`);
    if (!step("前置-任务一记下了", !!t1)) return out;
    made.tasks.push(t1);
    await openPanel(t1);
    await doPact(t1, "status");
    await until(`!!${card(t1)}?.querySelector('[data-status="doing"]')`, 2000);
    await clearBar();
    await evalJs(`${card(t1)}.querySelector('[data-status="doing"]').click()`);
    step("Q14 换列回执「已移到「进行中」」(不再是「已改为」)", await barIs(/^已移到「进行中」$/.toString(), 5000), await barText());
    await snap("Q14-moved");
    await clickBarAct("撤销");
    step("Q6 挪列点撤销 ⇒「已撤销」", await barIs(/^已撤销$/.toString(), 5000), await barText());
    step("Q6 …卡回到「待办」", await until(`(async()=>(await window.__TAURI__.core.invoke("list_tasks",{spaceId:window.__w165sp})).find(x=>x.id===${J(t1)})?.status==="todo")()`, 4000));
    await clearBar();
    // Q5 截止
    await openPanel(t1);
    await doPact(t1, "due");
    // 截止那一格不再是日期框:点那枚钮开应用自己的月历层,选日 → 「确定」才写(月历层本身的验收在 picks-r 的 R2)。
    await until(`!!${card(t1)}?.querySelector('[data-pact="due-pick"]')`, 2000);
    const d = new Date(Date.now() + 2 * 86400000);
    const dueIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await evalJs(`${card(t1)}.querySelector('[data-pact="due-pick"]').click()`);
    await until(`document.getElementById("date-sheet").classList.contains("open")`, 2000);
    if (!(await evalJs(`!!document.querySelector('#dp-days [data-day=${J(dueIso)}]')`))) await evalJs(`(()=>{document.getElementById("dp-next").click();return 1})()`); // 后天跨了月
    await evalJs(`(()=>{document.querySelector('#dp-days [data-day=${J(dueIso)}]').click();document.getElementById("dp-ok").click();return 1})()`);
    step("Q5 改截止回执「已设截止 M月D日」带撤销", await barIs(new RegExp(`^已设截止 ${d.getMonth() + 1}月${d.getDate()}日$`).toString(), 5000) && (await barActs()).includes("撤销"), await barText());
    await snap("Q5-due");
    await clickBarAct("撤销");
    step("Q5 撤销 = 旧值(没设)写回,说「已撤销」", (await barIs(/^已撤销$/.toString(), 5000)) && (await until(`(async()=>(await window.__TAURI__.core.invoke("list_tasks",{spaceId:window.__w165sp})).find(x=>x.id===${J(t1)})?.due_on===null)()`, 4000)), await barText());
    await clearBar();
    // Q5 优先级
    await openPanel(t1);
    await doPact(t1, "prio");
    await until(`!!${card(t1)}?.querySelector('[data-prio="3"]')`, 2000);
    await evalJs(`${card(t1)}.querySelector('[data-prio="3"]').click()`);
    step("Q5 改优先级回执「已设优先级 高」带撤销", (await barIs(/^已设优先级 高$/.toString(), 5000)) && (await barActs()).includes("撤销"), await barText());
    await snap("Q5-priority");
    await clickBarAct("撤销");
    step("Q5 撤销优先级 ⇒「已撤销」、库里回到没设", (await barIs(/^已撤销$/.toString(), 5000)) && (await until(`(async()=>(await window.__TAURI__.core.invoke("list_tasks",{spaceId:window.__w165sp})).find(x=>x.id===${J(t1)})?.priority===null)()`, 4000)), await barText());
    await clearBar();
    // 完成 → Q14「完成于 今天 HH:MM」+ A50
    await inv("add_task_topic_by_title", { id: t1, title: `${M}-tag` });
    // 906:卡左边那枚勾完成的圆圈撤了 ⇒ 开操作面、点最前面那枚「完成」(同一条写口,回执照旧)
    await evalJs(`(async()=>{if(!${card(t1)}.querySelector(".panel"))${card(t1)}.querySelector(".content").click();
      for(let i=0;i<40;i++){const b=${card(t1)}?.querySelector('.panel [data-pact="complete"]');if(b){b.click();return true}await new Promise(r=>setTimeout(r,50))}return false})()`);
    await barIs(/^已完成/.toString(), 5000);
    await sleep(500);
    const doneAt = await until(`${card(t1)}?.querySelector(".done-at")?.textContent ?? ""`, 4000);
    step("Q14 已完成卡写「完成于 今天 HH:MM」", new RegExp(`^完成于 今天 ${HM}$`).test(doneAt || ""), doneAt);
    const seal = JSON.parse(
      await evalJs(`(()=>{const b=document.querySelector("#timeline .tl-act");if(!b)return "null";const p=document.createElement("i");document.body.appendChild(p);
        p.style.color="var(--seal-ink)";const seal=getComputedStyle(p).color;p.style.color="var(--ink-soft)";const soft=getComputedStyle(p).color;p.remove();
        const cs=getComputedStyle(b);return JSON.stringify({color:cs.color,seal,soft,deco:cs.textDecorationLine})})()`),
    );
    step("A50 「全部归档」不是朱砂字(节头同色 + 下划线标可点)", !!seal && seal.color !== seal.seal && seal.color === seal.soft && /underline/.test(seal.deco), seal);
    await snap("A50-seal-all");
    await clearBar();
    // 单张归档 → A44 归档卡画标签
    await openPanel(t1);
    await doPact(t1, "more");
    await doPact(t1, "seal");
    await barIs(/^已归档$/.toString(), 5000);
    await clearBar();
    await click(`#bottombar [data-pane="sealed"]`);
    await until(`!!document.querySelector('#sealed-list [data-sealed="${t1}"]')`, 5000);
    step("A44 归档卡画标签", await evalJs(`[...document.querySelector('#sealed-list [data-sealed="${t1}"]').querySelectorAll("footer .chip")].some(c=>c.textContent===${J(`${M}-tag`)})`));
    await snap("A44-sealed-chips");
    const sealedTime = await evalJs(`document.querySelector('#sealed-list [data-sealed="${t1}"] footer time').textContent`);
    step("Q14 归档卡「完成于 今天 HH:MM」(此前写「11月6日 …」)", new RegExp(`^完成于 今天 ${HM}$`).test(sealedTime), sealedTime);
    await closePanes();

    // ── 回收站:A22 还原回执 / Q15 彻底删除 / Q14 删于 ─────────────────────────
    await mode("ideas");
    const n2 = await capture(`${M} 随记二(还原用)`);
    const t2 = await (async () => {
      await mode("tasks");
      return capture(`${M} 任务二(还原用)`);
    })();
    if (n2) made.notes.push(n2);
    if (t2) made.tasks.push(t2);
    await inv("archive_note", { id: n2 });
    await inv("archive_task", { id: t2 });
    await click(`#bottombar [data-pane="trash"]`);
    await until(`!!document.querySelector('#trash-list [data-trash="${n2}"]')`, 5000);
    const del = await evalJs(`document.querySelector('#trash-list [data-trash="${n2}"] footer time').textContent`);
    step("Q14 回收站「删于 今天 HH:MM」", new RegExp(`^删于 今天 ${HM}$`).test(del), del);
    await snap("Q14-trash-time");
    // 还原随记
    await evalJs(`document.querySelector('#trash-list [data-trash="${n2}"] .body').click()`);
    await until(`!!document.querySelector('#trash-list [data-trash="${n2}"] [data-trash-act="restore"]')`, 2000);
    await clearBar();
    await evalJs(`document.querySelector('#trash-list [data-trash="${n2}"] [data-trash-act="restore"]').click()`);
    step("A22 还原随记回执「已还原到随记」", await barIs(/^已还原到随记$/.toString(), 5000), await barText());
    await snap("A22-restored-note");
    step("A22 …带【去看看】、是操作型那档(不写「底栏」)", (await barActs()).join() === "去看看" && (await evalJs(`document.getElementById("error").classList.contains("with-act")`)) && !/底栏/.test(await barText()));
    await sleep(4500);
    step("A22 …4.5 秒后还在、没进余温(操作型 6 s 那档;此前约 3.5 秒就走)", !!(await barText()) && !(await evalJs(`document.getElementById("error").classList.contains("retiring")`)));
    // 还原任务
    await until(`!!document.querySelector('#trash-list [data-trash="${t2}"]')`, 4000);
    await evalJs(`document.querySelector('#trash-list [data-trash="${t2}"] .body').click()`);
    await until(`!!document.querySelector('#trash-list [data-trash="${t2}"] [data-trash-act="restore"]')`, 2000);
    await clearBar();
    await evalJs(`document.querySelector('#trash-list [data-trash="${t2}"] [data-trash-act="restore"]').click()`);
    step("A22 还原任务回执「已还原到看板「待办」列」+【去看看】", (await barIs(/^已还原到看板「待办」列$/.toString(), 5000)) && (await barActs()).join() === "去看看", await barText());
    await snap("A22-restored-task");
    // 去看看 = 收面、落到那张卡
    await clickBarAct("去看看");
    step("A22 点【去看看】收回收站、落到那张任务卡", await until(`!document.body.classList.contains("pane-open")&&!!${card(t2)}`, 5000));
    // 彻底删除写出名字
    await inv("archive_task", { id: t2 });
    await closePanes(); // 上一格「去看看」没收面时(阴性刀下)回收站还开着,再点一下是收
    await click(`#bottombar [data-pane="trash"]`);
    await until(`!!document.querySelector('#trash-list [data-trash="${t2}"]')`, 5000);
    await evalJs(`document.querySelector('#trash-list [data-trash="${t2}"] .body').click()`);
    await until(`!!document.querySelector('#trash-list [data-trash="${t2}"] [data-trash-act="purge"]')`, 2000);
    await clearBar();
    await evalJs(`document.querySelector('#trash-list [data-trash="${t2}"] [data-trash-act="purge"]').click()`);
    await until(`!document.getElementById("confirmbar").hidden`, 2000);
    await evalJs(`document.getElementById("confirmbar-yes").click()`);
    const t2name = `${M} 任务二(还原用)`;
    const t2snip = [...t2name].length > 20 ? `${[...t2name].slice(0, 20).join("")}…` : t2name; // 同 ui.ts::itemSnippet:20 字封顶加「…」
    step(
      "Q15 彻底删除回执写出删的是哪条「已彻底删除「…」」(长了截到 20 字加「…」)",
      await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&e.textContent===${J(`已彻底删除「${t2snip}」`)}})()`, 5000),
      await barText(),
    );
    made.tasks = made.tasks.filter((x) => x !== t2);
    await clearBar();
    await closePanes();

    // ── 长文:Q1 / Q15 / A32 / Q4 ─────────────────────────────────────────────
    await click(`#bottombar [data-pane="docs"]`).then(async (ok) => {
      if (!ok || !(await until(`document.body.classList.contains("pane-open")&&!document.getElementById("docs-pane").hidden`, 2000))) {
        // 一篇长文都没有时「长文」格不在:经「记一笔 → 长文」进(同用户那条路)
        await evalJs(`document.getElementById("capture-fab").click()`);
        await sleep(400);
        await evalJs(`document.getElementById("compose-doc").click()`);
      } else await evalJs(`document.getElementById("docs-new").click()`);
    });
    await dropIme();
    step("Q14「+ 新建长文」带加号", (await evalJs(`document.getElementById("docs-new").textContent`)) === "+ 新建长文");
    if (step("Q1 前置:新篇编辑器开了", await until(`!!document.querySelector("#docs-body textarea.doc-area")`, 4000))) {
      step("Q1 新篇左上那枚叫「‹ 正文」", await evalJs(`document.querySelector("#docs-body .doc-bar button").textContent==="‹ 正文"`));
      const v1 = `${M} 长文\n第一段`; // 末行不带换行(A32 的前提)
      await evalJs(`(()=>{const a=document.querySelector("#docs-body textarea.doc-area");a.value=${J(v1)};a.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      step("Q1 顶上那行「草稿已存在本机 · 离开就存成一版」", await until(`document.querySelector("#docs-body .doc-status")?.textContent==="草稿已存在本机 · 离开就存成一版"`, 3000));
      await snap("Q1-draft-line");
      await dropIme();
      await clearBar();
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-bar button")].find(b=>b.textContent==="保存").click()`);
      step("Q1 新篇离开说「已存成一篇,在「长文」页」", await barIs(/^已存成一篇,在「长文」页$/.toString(), 5000), await barText());
      await snap("Q1-saved-new");
      await until(`!!document.querySelector("#docs-body .doc-meta")`, 4000);
      const docId = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_docs",{spaceId:window.__w165sp})).find(x=>x.content===${J(v1)})?.id??"")()`);
      if (docId) made.docs.push(docId);
      const written = await evalJs(`document.querySelector("#docs-body .doc-meta time").textContent`);
      step("Q14 阅读页「写于 今天 HH:MM」", new RegExp(`^写于 今天 ${HM}$`).test(written), written);
      step("Q15 没改过不写「改于」", await evalJs(`!document.querySelector("#docs-body .doc-meta .doc-edited")`));
      // 再编辑:停在篇首 ⇒ 光标在末尾(Q15)
      await clearBar();
      await evalJs(`window.scrollTo(0,0)`);
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-bar button")].find(b=>b.textContent==="编辑").click()`);
      await until(`!!document.querySelector("#docs-body textarea.doc-area")`, 4000);
      await sleep(400);
      const caret = JSON.parse(await evalJs(`(()=>{const a=document.querySelector("#docs-body textarea.doc-area");return JSON.stringify([a.selectionStart,a.value.length])})()`));
      step("Q15 再次编辑(停在篇首)光标在全文末尾", caret[0] === caret[1] && caret[1] > 0, caret);
      const v2 = `${v1}\n第二段`;
      await evalJs(`(()=>{const a=document.querySelector("#docs-body textarea.doc-area");a.value=${J(v2)};a.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await dropIme();
      await clearBar();
      await back(); // 真返回键离开(Q1:四条离开的路之一)
      step("Q1 返回键离开改过的篇说「已存成一版」", await barIs(/^已存成一版$/.toString(), 5000), await barText());
      await until(`!!document.querySelector("#docs-body .doc-meta .doc-edited")`, 5000);
      const edited = await evalJs(`document.querySelector("#docs-body .doc-meta .doc-edited")?.textContent??""`);
      step("Q15 阅读页「改于 今天 HH:MM」", new RegExp(`^改于 今天 ${HM}$`).test(edited), edited);
      await snap("Q15-edited-at-reader");
      // 历史:A32 + 旧版写它写成的那一刻
      await clearBar();
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-bar button")].find(b=>b.textContent==="历史").click()`);
      await until(`!!document.querySelector("#docs-body .hv-out .diff")`, 5000);
      const diff = JSON.parse(await evalJs(`(()=>{const o=document.querySelector("#docs-body .hv-out");return JSON.stringify({del:[...o.querySelectorAll(".diff-del")].map(e=>e.textContent),ins:[...o.querySelectorAll(".diff-ins")].map(e=>e.textContent)})})()`));
      step("A32 上一版末行没带换行、补一段后比对:那一行不再先红后绿(只绿新的一段)", diff.del.length === 0 && diff.ins.length === 1 && /第二段/.test(diff.ins[0]), diff);
      await snap("A32-diff");
      const created = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_docs",{spaceId:window.__w165sp})).find(x=>x.id===${J(docId)})?.created_at??"")()`);
      const cd = new Date(created);
      const want = `今天 ${String(cd.getHours()).padStart(2, "0")}:${String(cd.getMinutes()).padStart(2, "0")}`;
      const rowWhen = await evalJs(`[...document.querySelectorAll("#docs-body .hv-row .hv-when")].map(e=>e.textContent)`);
      step("Q15 历史里旧版写它写成的那一刻(最早那版 = 建篇那一刻)", rowWhen.length === 2 && rowWhen[1] === want, { rowWhen, want });
      await back(); // 回阅读页
      await until(`!!document.querySelector("#docs-body .doc-meta")`, 4000);
      // 列表:「改于」+ 第一行没写 # 不加粗
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-bar button")].find(b=>b.textContent==="‹ 长文").click()`);
      await until(`!!document.querySelector('#docs-body [data-doc="${docId}"]')`, 4000);
      const li = JSON.parse(await evalJs(`(()=>{const c=document.querySelector('#docs-body [data-doc="${docId}"]');const h=c.querySelector(".doc-title");
        return JSON.stringify({edited:c.querySelector("footer .doc-edited")?.textContent??"",plain:h.classList.contains("plain"),fw:getComputedStyle(h).fontWeight})})()`));
      step("Q15 长文列表卡写「改于 今天 HH:MM」", new RegExp(`^改于 今天 ${HM}$`).test(li.edited), li);
      await snap("Q15-list-edited-plain");
      step("Q15 第一行没写 # 时列表卡上不加粗(同阅读页)", li.plain && Number(li.fw) < 600, li);
      // Q4:删长文不问、给撤销;Q6 撤销说「已撤销」
      await evalJs(`document.querySelector('#docs-body [data-doc="${docId}"]').click()`);
      await until(`!!document.querySelector("#docs-body .doc-acts")`, 4000);
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-acts button")].find(b=>b.textContent==="更多…").click()`);
      await until(`[...document.querySelectorAll("#docs-body .doc-acts button")].some(b=>b.textContent==="删除")`, 2000);
      await clearBar();
      await evalJs(`[...document.querySelectorAll("#docs-body .doc-acts button")].find(b=>b.textContent==="删除").click()`);
      await sleep(400);
      step("Q4 删长文不弹确认条", await evalJs(`document.getElementById("confirmbar").hidden`));
      const docsLeft = (await inv("list_docs")).length;
      step(
        docsLeft === 0 ? "Q4 / Q13 删的是最后一篇:回执补半句「「长文」格会收起…」带撤销" : "Q4 回执「已移入回收站」带撤销",
        (await barIs((docsLeft === 0 ? /^已移入回收站。「长文」格会收起,再写一篇点 ＋ → 长文/ : /^已移入回收站/).toString(), 5000)) && (await barActs()).includes("撤销"),
        await barText(),
      );
      await snap("Q4-doc-deleted");
      await clickBarAct("撤销");
      step("Q6 长文删除点撤销 ⇒「已撤销」", await barIs(/^已撤销$/.toString(), 5000), await barText());
      await snap("Q6-doc-undone");
      await clearBar();
    }
    await closePanes();

    // ── A46:回收站 → 搜索 → 点结果 → 返回两下 = 回到回收站(真返回键)──────────────
    await click(`#bottombar [data-pane="trash"]`);
    await until(`!document.getElementById("trash-pane").hidden`, 3000);
    await click("#search-toggle");
    await until(`!document.getElementById("search-pane").hidden`, 3000);
    await evalJs(`(()=>{const i=document.getElementById("search-input");i.value=${J(`${M} 随记二`)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    await until(`!!document.querySelector('#search-results [data-hit="${n2}"]')`, 5000);
    await dropIme();
    await evalJs(`document.querySelector('#search-results [data-hit="${n2}"] .body').click()`);
    step("A46 前置:点结果落到时间轴那张卡", await until(`!document.body.classList.contains("pane-open")&&!!${card(n2)}`, 5000));
    await sleep(600);
    await back();
    step("A46 返回一下 = 回到搜索结果", await until(`!document.getElementById("search-pane").hidden`, 3000));
    await sleep(500);
    await back();
    step("A46 再返回一下 = 回到回收站(此前落回主视图)", await until(`!document.getElementById("trash-pane").hidden&&document.body.classList.contains("pane-open")`, 3000));
    await snap("A46-back-to-trash");
    await sleep(500);
    await back();
    step("A46 再返回 = 关掉回收站回主视图", await until(`!document.body.classList.contains("pane-open")`, 3000));

    // ── Q9:搜索 /「过滤…」按回车 = 收键盘 ───────────────────────────────────────
    await mode("tasks");
    await evalJs(`(()=>{const i=document.getElementById("filter-text");i.scrollIntoView({block:"center"});return 1})()`);
    const fc = JSON.parse(await evalJs(`(()=>{const r=document.getElementById("filter-text").getBoundingClientRect();return JSON.stringify([Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)])})()`));
    await adb(["shell", "input", "tap", String(fc[0]), String(fc[1])]);
    await sleep(900);
    const imeUp = await imeShown();
    await evalJs(ENTER(`document.getElementById("filter-text")`)); // 真点进框、键盘起来之后按回车(合成键,理由见 A20 头注)
    await sleep(900);
    step("Q9 「过滤…」按回车 = 焦点离框、键盘收", (await evalJs(`document.activeElement?.id!=="filter-text"`)) && (await imeShown()) === false, { imeBefore: imeUp });
    await dropIme();
    await click("#search-toggle");
    await until(`!document.getElementById("search-pane").hidden`, 3000);
    const sc = JSON.parse(await evalJs(`(()=>{const r=document.getElementById("search-input").getBoundingClientRect();return JSON.stringify([Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)])})()`));
    await adb(["shell", "input", "tap", String(sc[0]), String(sc[1])]);
    await sleep(900);
    await evalJs(ENTER(`document.getElementById("search-input")`));
    await sleep(900);
    step("Q9 搜索框按回车 = 焦点离框、键盘收", (await evalJs(`document.activeElement?.id!=="search-input"`)) && (await imeShown()) === false);
    await dropIme();
    await evalJs(`(()=>{const i=document.getElementById("search-input");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    await closePanes();

    // ── 设置:A41 / A34 / A33 / A52 ──────────────────────────────────────────────
    await click("#settings-toggle");
    await until(`!document.getElementById("settings-pane").hidden`, 3000);
    // 906:「压缩大图」那一排住进了二级页(进页才画选中态)⇒ 进去一趟再回首页,三排都画过了再判
    await click(`#settings-pane [data-set-page="set-compress"]`);
    await until(`!document.getElementById("set-compress").hidden`, 3000);
    await click("#set-compress [data-set-back]");
    await until(`!document.getElementById("settings-pane").hidden`, 3000);
    step("A41 设置里的分段钮读屏读得出选中段(每排恰一枚 aria-pressed=true)", await evalJs(`["theme-seg","lang-seg","compress-seg"].every(id=>{const s=document.getElementById(id);if(!s)return true;const b=[...s.querySelectorAll("button")];return b.length>0&&b.filter(x=>x.getAttribute("aria-pressed")==="true").length===1&&b.every(x=>x.hasAttribute("aria-pressed"))})`));
    // 906:那三枚政策钮在「关于」那一页(设置的二级页)⇒ 先从首页那一行进去
    await click(`#settings-pane [data-set-page="set-about"]`);
    await until(`!document.getElementById("set-about").hidden`, 3000);
    const pb = await evalJs(`(()=>{const b=document.querySelector('[data-policy="privacy.html"]');b.scrollIntoView({block:"center"});return !!b})()`);
    if (pb) {
      await sleep(400);
      await evalJs(`(()=>{const b=document.querySelector('[data-policy="privacy.html"]');b.focus();b.click();return 1})()`);
      await until(`!document.getElementById("policy-view").hidden&&document.getElementById("policy-frame").dataset.page==="privacy.html"`, 4000);
      await sleep(500);
      await evalJs(`(()=>{document.getElementById("policy-frame").contentWindow.scrollTo(0,900);return 1})()`);
      await sleep(300);
      const y0 = await evalJs(`document.getElementById("policy-frame").contentWindow.scrollY`);
      await evalJs(`(()=>{const a=[...document.getElementById("policy-frame").contentDocument.querySelectorAll("a[href]")].find(x=>/privacy-rights/.test(x.getAttribute("href")));a.click();return 1})()`);
      await until(`document.getElementById("policy-frame").dataset.page==="privacy-rights.html"`, 4000);
      await sleep(400);
      const y1 = await evalJs(`document.getElementById("policy-frame").contentWindow.scrollY`);
      step("A33 政策面板切页签从顶上读起", y0 > 100 && y1 === 0, { before: y0, after: y1 });
      await snap("A33-policy-tab-top");
      await evalJs(`document.getElementById("policy-close").click()`);
      await sleep(300);
      step("A52 点「关闭」焦点回到打开它的那枚", await evalJs(`document.activeElement===document.querySelector('[data-policy="privacy.html"]')`), await evalJs(`document.activeElement?.outerHTML?.slice(0,80)??""`));
      // 返回键那条路
      await evalJs(`(()=>{const b=document.querySelector('[data-policy="terms.html"]');b.focus();b.click();return 1})()`);
      await until(`!document.getElementById("policy-view").hidden`, 4000);
      await sleep(500);
      await back();
      await until(`document.getElementById("policy-view").hidden`, 3000);
      await sleep(300);
      step("A52 返回键收面板,焦点回到打开它的那枚(不停在藏起来的框里)", await evalJs(`document.activeElement===document.querySelector('[data-policy="terms.html"]')`), await evalJs(`document.activeElement?.tagName??""`));
    } else step("A33 / A52 政策面板", "skip", "设置里没有「隐私政策」钮");
    await closePanes();
    await click("#sync-toggle");
    await until(`!document.getElementById("sync-pane")?.hidden`, 3000);
    const intro = await evalJs(`document.getElementById("sync-intro")?.textContent??""`);
    step("A34 同步第一屏说「这台设备」不说「这台手机」", /这台设备/.test(intro) && !/这台手机/.test(intro), intro.slice(0, 40));
    await snap("A34-sync-intro");
    await closePanes();
  } catch (e) {
    out.runError = String(e?.stack ?? e);
  } finally {
    // ── 清场:建过的条目一律彻底删(活的先进回收站 / 归档的先取消归档),标签删掉 ──
    try {
      await clearBar();
      await closePanes();
      const tl = await inv("list_timeline");
      const trash = await inv("list_trash");
      const sealed = await inv("list_sealed_tasks");
      const docs = await inv("list_docs");
      const mine = (x) => (x.content ?? x.title ?? "").startsWith(M);
      for (const r of sealed.filter(mine)) await inv("unseal_task", { id: r.id }).catch(() => {});
      for (const r of (await inv("list_tasks")).filter(mine)) await inv("archive_task", { id: r.id }).catch(() => {});
      for (const r of tl.filter((x) => mine(x) && x.kind !== "task")) await inv("archive_note", { id: r.id }).catch(() => {});
      for (const r of docs.filter(mine)) await inv("archive_note", { id: r.id }).catch(() => {});
      for (const r of (await inv("list_trash")).filter(mine)) {
        if (["todo", "doing", "confirming", "done"].includes(r.stage)) await inv("purge_task", { id: r.id }).catch(() => {});
        else await inv("purge_note", { id: r.id }).catch(() => {});
      }
      for (const tp of (await inv("list_topics")).filter((x) => x.title.toLowerCase().startsWith(M.toLowerCase()))) await inv("delete_topic", { id: tp.id }).catch(() => {});
      void trash;
      const left = [
        ...(await inv("list_timeline")).filter(mine),
        ...(await inv("list_trash")).filter(mine),
        ...(await inv("list_sealed_tasks")).filter(mine),
        ...(await inv("list_docs")).filter(mine),
        ...(await inv("list_topics")).filter((x) => x.title.toLowerCase().startsWith(M.toLowerCase())),
      ];
      step("清场:探针条目 / 标签零残留(时间轴、回收站、归档、长文、标签)", left.length === 0, left.map((x) => x.id));
      await evalJs(`(()=>{document.getElementById("w165-knife")?.remove();window.scrollTo(0,0);return 1})()`);
    } catch (e) {
      step("清场", false, String(e?.message ?? e));
    }
    cdp.close();
  }
  out.pass = !out.runError && out.steps.length > 0 && out.steps.every((s) => s.ok === true || s.ok === "SKIPPED");
  return out;
};

main()
  .then((o) => {
    console.log(JSON.stringify(o, null, 1));
    process.exit(o.pass ? 0 : 1);
  })
  .catch((e) => {
    console.log(JSON.stringify({ ...out, pass: false, error: String(e?.stack ?? e) }, null, 1));
    process.exit(1);
  });
