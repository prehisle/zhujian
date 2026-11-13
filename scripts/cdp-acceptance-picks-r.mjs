// 应用评审取舍题(用户 2026-11-13 拍板)手机 R 组的真机回归网:R1「随记面记完自动滚回顶」+ R2「选截止日期用应用自己的月历层」。
// 驱动形(要重载页面、要真转屏、要真划一下;CDP 摆前置、读状态、量几何)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-r.mjs                     # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-r.mjs --shots <目录>       # 关键几拍各截一张真屏
//   PICKSR_KNIFE=scroll node scripts/cdp-acceptance-picks-r.mjs # 阴性对照:页内把 window.scrollTo / scrollIntoView 换成空操作
//     (= 产品那一下滚不动,等于没有那几行)⇒ 「滚回了顶」「新卡在眼前」「不挂去看看」那几格应当红;任务面那半与在顶上记下那半应当照绿。
//   PICKSR_KNIFE=date node scripts/cdp-acceptance-picks-r.mjs   # 阴性对照(R2):页内注入 —— 选中那天的朱砂底抹掉、日格压矮到 30、六行定高撤掉、
//     「确定」那一下吞掉、「取消」改成去点「确定」⇒ 应当红:「日格触区 ≥ 44」「月历恒六行高」「选中那天朱砂实心」「确定后写进库」(连带回执 / 角标 / 重开落点,以及拿「库里还是设的那天」当判据的返回键 / 点遮罩 / 清除那几格 —— 刀下根本没写进去)
//     「取消不写」;R1 全部与 R2 的换月 / 没选时的样子那几格应当照绿。
//
// 逐条(编号同 .zjshots/904-fix/mob-r.md):
//  R1-P 竖放随记:列表滚到中段记下 ⇒ 页面回到顶、新卡整张露在吸顶条(顶栏 + 筛选条)之下并闪一下、回执「已记下」**不挂**「去看看」;
//       对照:本来就在顶上记下 ⇒ 不滚、新卡闪、不出带钮的回执。
//  R1-T **不该变的那半**:竖放任务面滚到页底记下 ⇒ 不拉(位置原样)、回执「已记下」带「去看看」(新卡落在「待办」那一节头上,不在页顶)。
//  R1-W 横放随记(多栏瀑布流;真转屏):真划一下把列表划下去(顶栏随之收起)再记下,记下期间装成「键盘还没落完」
//       (页面读到的视口高只有 130)⇒ 回到顶、顶栏露回来、新卡在眼前且挂常亮描边(.flash-hold,165 Q15)、回执不挂钮。
//       首版在这儿栽过:那一刻哪张卡都量成不在眼前,又一记 scrollIntoView 把页面推离了顶、回执挂回「去看看」。
//
//  R2   竖放任务面:「截止」那一排不再有日期框,是一枚钮(没设 = 「未设」);点它开月历层(周日起、恒六行、今天有标记、没选时「确定」灰、
//       没设过不出「清除」);换月标题跟着变、换回来;真点一天 = 只选中不写(朱砂实心圆,色 = 悬浮 ＋ 那枚的朱砂);「确定」⇒ 写进库(`YYYY-MM-DD`)、
//       回执「已设截止 …」带撤销、卡上出截止角标、操作面回主面;重开落在那个月那天、出「清除」;另选一天点「取消」/ 真按返回键 / 真点遮罩都不写
//       (返回键之后 app 还在前台、「截止」那一排还在);「清除」⇒ 库里清掉、回执「已清除截止」。日格 / 换月钮触区 ≥ 44 且打点命中。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面。
// 会写库:只写**默认空间**(main)—— 播种 14 条随记 + 12 张待办(撑出能滚的长度)+ 本趟 UI 记下的几条,正文都带 `PICKSR` 记号,
//   收尾 archive → purge 并自证零残留。⚠ 起跑时人在别的空间就切到 main 跑,跑完切回;转屏设置(自动旋转 / 方向)用前读、用后还。
// 诚实边界:
//  ① 滚不滚是 JS 行为,页内改不了打包后的分支 ⇒ 刀下在它脚下(把滚动原语换成空操作),证的是「判据真看滚动位置与几何」,
//     不是「删掉那几行会红」的逐字对照;后者 = 在修之前的包上跑这支(R1-P / R1-W 红)。
//  ② 「对端同步来的新条目不拉回顶」没验:那条路不经 save(),本支造不出对端;靠代码构造保证(滚回顶只写在 save() 里)。
//  ③ 横放只量了这台(手机横放、矮屏、两栏);平板竖放 / 分屏没量。R1-W 那一下真划若没把顶栏划收(机型差异),只记不判。
//  ④ 记下时图 / 标签没挂上的那句报错与「已记下」同走一条提示条,后到的盖先到的(修之前带「去看看」那条同样盖)—— 本支不判。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep, touchSwipe } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
// --ohos(905):鸿蒙真机上跑(9222 那条转发照 skill `zhujian-ohos-verify` 自己建)。设备侧只有三样要换:返回键走 hdc、截图走 CDP、
// 转屏没有命令行入口 ⇒ 横放那一段(R1-W)不跑、报在 skipped 里。HDC 环境变量 = hdc.exe 的完整路径。
const OHOS = process.argv.includes("--ohos");
const HDC = process.env.HDC ?? "G:/ohos-sdk/toolchains/hdc.exe";
const shell = async (...a) => {
  if (!OHOS) return (await adb(["shell", ...a])).stdout.trim();
  if (a[0] === "settings") return "0";
  if (a.join(" ") === "input keyevent 4") return (await execFileAsync(HDC, ["shell", "uitest uiInput keyEvent Back"], { encoding: "utf8" })).stdout.trim();
  throw new Error(`--ohos 下没有这条设备命令:${a.join(" ")}`);
};
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.PICKSR_KNIFE === "scroll";
const KNIFE_DATE = process.env.PICKSR_KNIFE === "date";
const M = "PICKSR";

const out = { pass: false, knife: process.env.PICKSR_KNIFE ?? null, steps: [] };
process.exitCode = 2; // 转发没建好时连接永不兑现、node 会一声不响地以 0 退出(实撞:三趟「全过」其实一格没跑)⇒ 先垫一个非零,跑完由末尾改写
const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.error(`${ok === "skip" ? "SKIP" : ok ? "ok  " : "RED "} ${name}`);
    return !!ok;
  };
  let s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
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
      await sleep(120);
    }
  };
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, Object.assign({spaceId: "main"}, ${J(args)}))`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.click();return true})()`);
  const snap = async (name) => {
    if (!SHOTS) return;
    if (OHOS) {
      const r = await s.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
      return;
    }
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };
  // 资产自己摆位置一律写 scrollTop(不走 scrollTo)⇒ 刀只砍产品那一下,砍不到台架。
  const scrollPage = async (y) => {
    await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=${y === "end" ? "se.scrollHeight" : y};return 1})()`);
    await sleep(400);
    return evalJs(`scrollY`);
  };
  const armKnife = async () => {
    if (KNIFE) await evalJs(`(()=>{window.scrollTo=()=>{};Element.prototype.scrollIntoView=()=>{};return 1})()`);
    if (KNIFE_DATE)
      await evalJs(`(()=>{if(document.getElementById("picksr-knife"))return 1;const st=document.createElement("style");st.id="picksr-knife";
        st.textContent=".dp-day.on span{background:none!important}.dp-day{height:30px!important}#dp-days{grid-template-rows:none!important}";document.head.append(st);
        document.getElementById("dp-ok").addEventListener("click",e=>{e.stopImmediatePropagation()},true);
        document.getElementById("dp-cancel").addEventListener("click",e=>{e.stopImmediatePropagation();document.getElementById("dp-ok").dispatchEvent(new MouseEvent("click"))},true);
        return 1})()`);
  };
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o)localStorage.setItem(k,o[k]);location.reload();return 1})()`).catch(() => 1);
    await sleep(1500);
    await until(`document.readyState==="complete"&&!!document.getElementById("gate")&&document.getElementById("gate").hidden`, 15000);
    await sleep(1200);
    await armKnife();
  };
  const toSpace = async (id) => {
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(id)}}).then(()=>1)`);
    await reload({ "zhujian.last-space": id });
  };
  const mode = async (m) => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await click(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
    if (!(await evalJs(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`))) {
      await click(`#bottombar [data-mode="${m}"]`);
      await until(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`, 3000);
      await sleep(300);
    }
  };
  const made = [];
  /** 走界面记下一条;回 {id, flashed}。闪不闪要趁热读(1.2 s 那记),所以和等卡出现写在一拍里。 */
  const save = async (text, { shortViewport = false } = {}) => {
    await click("#capture-fab");
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(text)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    // 「键盘还没落完」那一形(真机上全看时序:点「记下」时键盘正在起 ⇒ 新卡落地那一刻视口还是让过键盘的一百来高,十趟撞三四趟)
    // ⇒ 装成恒定的:记下期间让页面读到的 innerHeight 是 130(产品那把 inView 尺子在宽屏上拿它当地板),卡一落 DOM 就还回去。
    if (shortViewport) await evalJs(`(()=>{window.__picksrIH=Object.getOwnPropertyDescriptor(window,"innerHeight");Object.defineProperty(window,"innerHeight",{get:()=>130,configurable:true});return 1})()`);
    await click("#save");
    const hit = await until(
      `(()=>{const c=[...document.querySelectorAll("#timeline article.card[data-id]")].find(c=>c.querySelector(".content")?.textContent===${J(text)});
        return c?{id:c.dataset.id,flash:c.classList.contains("flash"),hold:c.classList.contains("flash-hold")}:false})()`,
      6000,
    );
    if (shortViewport) await evalJs(`(()=>{Object.defineProperty(window,"innerHeight",window.__picksrIH);delete window.__picksrIH;return innerHeight})()`);
    if (!hit) return null;
    made.push(hit.id);
    // 卡一落 DOM 那一拍可能还没挂上闪的类(挂在同一个任务里,但读在两条 CDP 之间)⇒ 再趁热读一拍
    const again = await until(`(()=>{const c=document.querySelector('#timeline [data-id="${hit.id}"]');return c&&(c.classList.contains("flash")||c.classList.contains("flash-hold"))?{flash:c.classList.contains("flash"),hold:c.classList.contains("flash-hold")}:false})()`, 900);
    return { id: hit.id, flash: hit.flash || !!again?.flash, hold: hit.hold || !!again?.hold };
  };
  /** 记下之后那一刻的读数:滚到哪儿、回执、新卡在不在「看得见的那一段」里(同 taskmove.ts::inView 那把尺子,另写一份当独立判据)。 */
  const after = (id) =>
    evalJs(`(()=>{const e=document.getElementById("error");const c=document.querySelector('#timeline [data-id="${id}"]');const r=c.getBoundingClientRect();
      const cs=getComputedStyle(document.documentElement);const chrome=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0);
      const nav=document.getElementById("bottombar");const nr=nav&&nav.getClientRects().length?nav.getBoundingClientRect():null;const floor=nr&&nr.top>innerHeight/2?nr.top:innerHeight;
      return {y:scrollY,barHidden:e.hidden,text:e.hidden?"":e.textContent,acts:e.hidden?[]:[...e.querySelectorAll(".bar-act")].map(b=>b.textContent),
        top:r.top,bottom:r.bottom,chrome,floor,whole:r.top>=chrome-1&&r.bottom<=floor+1,shown:r.bottom>chrome+24&&r.top<floor-24,
        chromeHidden:document.body.classList.contains("chrome-hidden"),cols:new Set([...document.querySelectorAll("#timeline article.card")].map(x=>Math.round(x.getBoundingClientRect().left))).size}})()`);

  const spaces = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
  const startSpace = spaces.find((x) => x.current)?.id;
  const rot0 = { auto: await shell("settings", "get", "system", "accelerometer_rotation"), user: await shell("settings", "get", "system", "user_rotation") };
  let rotated = false;
  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    if (!step("前置:竖屏", await evalJs(`innerWidth < innerHeight`))) return;
    if (startSpace !== "main") await toSpace("main");
    // 播种:随记与待办各一批,撑出能滚的长度(页内直调写库后时间轴是旧快照 ⇒ 重载)
    for (let i = 1; i <= 14; i++) made.push(await inv("capture_idea", { content: `${M}-随记填充${i}\n第二行\n第三行` }));
    for (let i = 1; i <= 12; i++) made.push(await inv("create_task", { title: `${M}-待办填充${i}`, dueOn: null, priority: null, topicId: null }));
    await reload();
    await clearBar();

    // ── R1-P 竖放随记 ──────────────────────────────────────────────────────────
    await mode("ideas");
    const yP = await scrollPage(700);
    if (step("R1-P 前置:随记列表真滚到了中段(否则这一格是空测)", yP > 400, { y: yP })) {
      const a = await save(`${M}-P 中段记下`);
      if (step("R1-P 前置:记下了一条", !!a)) {
        await sleep(350);
        const r = await after(a.id);
        step("R1-P 记下后页面回到了顶", r.y < 2, r);
        step("R1-P 新卡整张露在吸顶条之下", r.whole, r);
        step("R1-P 新卡闪一下(.flash)", a.flash, a);
        step("R1-P 回执「已记下」、不挂「去看看」", !r.barHidden && r.text.includes("已记下") && r.acts.length === 0, r);
        await snap("R1-P-saved-mid");
      }
    }
    await clearBar();
    await scrollPage(0);
    const b = await save(`${M}-P 顶上记下`);
    if (step("R1-P 对照前置:在顶上记下了一条", !!b)) {
      await sleep(350);
      const r = await after(b.id);
      step("R1-P 对照:在顶上记下 = 不滚、新卡闪、不出带钮的回执", r.y < 2 && b.flash && r.acts.length === 0, { ...r, ...b });
    }
    await clearBar();

    // ── R1-T 任务面不变 ────────────────────────────────────────────────────────
    await mode("tasks");
    const yT = await scrollPage("end");
    if (step("R1-T 前置:任务面真滚到了页底(否则这一格是空测)", yT > 300, { y: yT })) {
      const c = await save(`${M}-T 页底记下`);
      if (step("R1-T 前置:记下了一张待办", !!c)) {
        await sleep(350);
        const r = await after(c.id);
        step("R1-T 前置:新卡确实不在眼前", !r.shown, r);
        // 新卡插在上面那一节头上 ⇒ 引擎的滚动锚定可能把 scrollY 往下带一张卡的高(眼前那几张不动);要拦的只是「被拉上去」。
        step("R1-T 任务面不拉回顶(没往上走)", r.y > yT - 40, { yT, y: r.y });
        step("R1-T 回执「已记下」照旧带「去看看」", !r.barHidden && r.text.includes("已记下") && r.acts.join() === "去看看", r);
        await snap("R1-T-saved-bottom");
      }
    }
    await clearBar();
    await scrollPage(0);

    // ── R2 月历层(竖放任务面)──────────────────────────────────────────────────
    {
      const tid = await evalJs(`(()=>{const c=[...document.querySelectorAll("#timeline article.card[data-id]")].find(c=>c.querySelector(".content")?.textContent===${J(`${M}-待办填充12`)});return c?c.dataset.id:null})()`);
      const cardSel = `document.querySelector('#timeline article.card[data-id="${tid}"]')`;
      const dueOf = async () => (await inv("list_tasks")).find((x) => x.id === tid)?.due_on;
      const sheetOpen = () => evalJs(`document.getElementById("date-sheet").classList.contains("open")`);
      const pad = (n) => String(n).padStart(2, "0");
      const isoOf = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      const now = new Date();
      const today = isoOf(now);
      const next15 = isoOf(new Date(now.getFullYear(), now.getMonth() + 1, 15));
      const next20 = isoOf(new Date(now.getFullYear(), now.getMonth() + 1, 20));
      const titleOf = (dt) => `${dt.getFullYear()}年${dt.getMonth() + 1}月`;
      /** 开「截止」那一排(操作面没开就先点卡身),再点那枚钮开月历层。 */
      const openSheet = async () => {
        await clearBar();
        if (!(await evalJs(`!!${cardSel}.querySelector(".panel")`))) {
          await evalJs(`(()=>{const c=${cardSel};c.scrollIntoView({block:"center"});c.querySelector(".body").click();return 1})()`);
          await until(`!!${cardSel}.querySelector('.panel [data-pact="due"]')`, 3000);
        }
        if (!(await evalJs(`!!${cardSel}.querySelector('.panel [data-pact="due-pick"]')`))) {
          await evalJs(`(()=>{${cardSel}.querySelector('.panel [data-pact="due"]').click();return 1})()`);
          await until(`!!${cardSel}.querySelector('.panel [data-pact="due-pick"]')`, 3000);
        }
        await evalJs(`(()=>{${cardSel}.querySelector('.panel [data-pact="due-pick"]').click();return 1})()`);
        const ok = await until(`document.getElementById("date-sheet").classList.contains("open")`, 3000);
        await sleep(600); // 滑入过场 0.22 s + 遮罩那 450 ms 的漏点抑制
        return !!ok;
      };
      /** 真点(触摸管线)某个元素的中心;回点没点上(元素不在 / 被盖着 = false)。 */
      const tap = async (sel) => {
        const pt = await evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
          const h=document.elementFromPoint(x,y);return {x,y,hit:!!h&&(h===e||e.contains(h))}})()`);
        if (!pt || !pt.hit) return false;
        await touchSwipe(s, pt.x, pt.y, pt.x, pt.y, 1);
        await sleep(250);
        return true;
      };
      const titleNow = () => evalJs(`document.getElementById("dp-title").textContent`);
      /** 真点换月钮;触摸那记没落上(538)就退到合成 click。回打点命中没有。 */
      const nav = async (id) => {
        const t0 = await titleNow();
        const hit = await tap(`#${id}`);
        // 多等一会儿再判「没落上」:触摸那记的 click 会迟到(905 装机后头一趟撞过 —— 迟到的那记 + 兜底 click = 一下翻了两个月)。
        for (let i = 0; i < 8 && (await titleNow()) === t0; i++) await sleep(100);
        if ((await titleNow()) === t0) await click(`#${id}`);
        return hit;
      };
      /** 真点一天;触摸那记没落上(538)就退到合成 click。 */
      const pickDay = async (iso) => {
        const hit = await tap(`#dp-days [data-day="${iso}"]`);
        if (!(await evalJs(`!!document.querySelector('#dp-days [data-day="${iso}"].on')`))) await click(`#dp-days [data-day="${iso}"]`);
        return hit;
      };
      const view = () =>
        evalJs(`(()=>{const q=(s)=>document.querySelector(s);const days=[...document.querySelectorAll("#dp-days .dp-day")];const on=q("#dp-days .dp-day.on");
          const sheet=q("#date-sheet").getBoundingClientRect();const fab=document.getElementById("capture-fab");
          const probe=document.createElement("i");probe.style.cssText="position:fixed;left:-99px;background:var(--seal)";document.body.append(probe);const seal=getComputedStyle(probe).backgroundColor;probe.remove();
          return {title:q("#dp-title").textContent,week:[...document.querySelectorAll("#dp-week span")].map(x=>x.textContent).join(""),cells:q("#dp-days").children.length,
            first:days[0]?.dataset.day,n:days.length,today:q("#dp-days .dp-day.today")?.dataset.day??null,on:on?.dataset.day??null,onN:document.querySelectorAll("#dp-days .dp-day.on").length,
            onBg:on?getComputedStyle(on.querySelector("span")).backgroundColor:null,seal,fabBg:fab?getComputedStyle(fab).backgroundColor:null,
            okDisabled:q("#dp-ok").disabled,clearHidden:q("#dp-clear").hidden,minDayH:Math.min(...days.map(d=>d.getBoundingClientRect().height)),minDayW:Math.min(...days.map(d=>d.getBoundingClientRect().width)),
            nav:[q("#dp-prev"),q("#dp-next")].map(b=>{const r=b.getBoundingClientRect();return [r.width,r.height]}),sheetTop:sheet.top,sheetBottom:sheet.bottom,ih:innerHeight,gridH:q("#dp-days").getBoundingClientRect().height,
            actH:Math.min(...[...document.querySelectorAll("#date-sheet .compose-row button")].filter(b=>!b.hidden).map(b=>b.getBoundingClientRect().height)),
            scrimShown:!q("#date-scrim").hidden,acts:[...document.querySelectorAll("#date-sheet .compose-row button")].filter(b=>!b.hidden).map(b=>b.textContent).join("|")}})()`);

      if (step("R2 前置:任务面上找到了种子待办", !!tid) && step("R2 前置:它还没设截止", (await dueOf()) === null)) {
        await armKnife();
        const opened = await openSheet();
        const lane = await evalJs(`(()=>{const p=${cardSel}.querySelector(".panel");const b=p.querySelector('[data-pact="due-pick"]');return {dateInput:!!p.querySelector('input[type="date"]'),btn:b?b.textContent:null}})()`);
        step("R2 「截止」那一排没有日期框、是一枚写着「未设」的钮", !lane.dateInput && lane.btn === "未设", lane);
        if (step("R2 点那枚钮开了月历层", opened)) {
          const v = await view();
          step("R2 月历:标题是本月、周日起、恒六行(42 格)、今天有标记", v.title === titleOf(now) && v.week === "日一二三四五六" && v.cells === 42 && v.today === today && v.first === isoOf(new Date(now.getFullYear(), now.getMonth(), 1)), v);
          step("R2 没设过:什么都没选中、「确定」灰着、不出「清除」(钮 = 取消|确定)", v.on === null && v.okDisabled && v.clearHidden && v.acts === "取消|确定", v);
          step("R2 整层在屏内、遮罩盖着", v.sheetTop >= 0 && v.sheetBottom <= v.ih + 1 && v.scrimShown, v);
          step("R2 日格触区 ≥ 44×44、换月钮 ≥ 44×44、底下那排钮高 ≥ 44", v.minDayH >= 43.5 && v.minDayW >= 43.5 && v.nav.every(([w, h]) => w >= 43.5 && h >= 43.5) && v.actH >= 43.5, v);
          step("R2 月历恒六行高(本月只占五行也留着第六行,换月时顶上那排不挪)", v.gridH >= 6 * 43.5, v);
          await snap("R2-open-empty");
          // 换月
          const nx = await nav("dp-next");
          const v2 = await view();
          step("R2 真点「下个月」:打点命中、标题换成下个月、今天的标记不在这一页", nx && v2.title === titleOf(new Date(now.getFullYear(), now.getMonth() + 1, 1)) && v2.today === null, v2);
          await nav("dp-prev");
          await nav("dp-prev");
          const v3 = await view();
          step("R2 真点两下「上个月」:标题是上个月", v3.title === titleOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), v3);
          await nav("dp-next");
          await nav("dp-next");
          // 选日:只选中不写
          const hit = await pickDay(next15);
          const v4 = await view();
          step("R2 真点下个月 15 号:打点命中、只这一天选中、「确定」亮了", hit && v4.on === next15 && v4.onN === 1 && !v4.okDisabled, v4);
          step("R2 选中那天朱砂实心(底色 = --seal = 悬浮 ＋ 的底色)", !!v4.onBg && v4.onBg === v4.seal && v4.onBg === v4.fabBg, v4);
          step("R2 点某天只是选中:库里还没写", (await dueOf()) === null);
          await snap("R2-picked");
          // 确定
          await click("#dp-ok");
          const wrote = await until(`(async()=>(await window.__TAURI_INTERNALS__.invoke("list_tasks",{spaceId:"main"})).find(x=>x.id===${J(tid)})?.due_on===${J(next15)})()`, 4000);
          step("R2 「确定」后写进库(YYYY-MM-DD)", !!wrote, { due: await dueOf(), want: next15 });
          await sleep(500);
          const a5 = await evalJs(`(()=>{const e=document.getElementById("error");const c=${cardSel};return {open:document.getElementById("date-sheet").classList.contains("open"),scrim:!document.getElementById("date-scrim").hidden,
            bar:e.hidden?"":e.textContent,acts:e.hidden?[]:[...e.querySelectorAll(".bar-act")].map(b=>b.textContent),chip:!!c.querySelector(".chip.due"),main:!!c.querySelector('.panel [data-pact="due"]')&&!c.querySelector('.panel [data-pact="due-pick"]')}})()`);
          step("R2 确定后层收了、回执「已设截止 …」带撤销", !a5.open && !a5.scrim && /^已设截止 /.test(a5.bar) && a5.acts.join() === "撤销", a5);
          step("R2 确定后卡上出截止角标、操作面回主面", a5.chip && a5.main, a5);
          await snap("R2-confirmed");
          // 重开:落在那个月那天、出「清除」;另选一天点取消 = 不写
          if (step("R2 重开月历层", await openSheet())) {
            const v6 = await view();
            step("R2 重开:落在设的那个月、那天选中、出「清除」(钮 = 清除|取消|确定)", v6.on === next15 && v6.title === titleOf(new Date(now.getFullYear(), now.getMonth() + 1, 1)) && !v6.clearHidden && v6.acts === "清除|取消|确定", v6);
            await snap("R2-reopen");
            await pickDay(next20);
            await click("#dp-cancel");
            await sleep(700);
            step("R2 另选一天点「取消」:层收了、不写", !(await sheetOpen()) && (await dueOf()) === next15, { due: await dueOf() });
          }
          // 返回键
          if (step("R2 重开月历层(返回键那格)", await openSheet())) {
            await pickDay(next20);
            await shell("input", "keyevent", "4");
            await sleep(900);
            const b = await evalJs(`({open:document.getElementById("date-sheet").classList.contains("open"),vis:document.visibilityState,lane:!!${cardSel}?.querySelector('.panel [data-pact="due-pick"]')})`);
            step("R2 真按返回键:层收了、不写、app 还在前台、「截止」那一排还在", !b.open && b.vis === "visible" && b.lane && (await dueOf()) === next15, { ...b, due: await dueOf() });
          }
          // 点遮罩
          if (step("R2 重开月历层(点遮罩那格)", await openSheet())) {
            await pickDay(next20);
            const top = await evalJs(`document.getElementById("date-sheet").getBoundingClientRect().top`);
            await touchSwipe(s, 180, Math.max(8, top / 2), 180, Math.max(8, top / 2), 1);
            await sleep(700);
            if (await sheetOpen()) await click("#date-scrim"); // 触摸那记没落上(538)⇒ 合成 click
            await sleep(500);
            step("R2 点遮罩:层收了、不写", !(await sheetOpen()) && (await dueOf()) === next15, { due: await dueOf() });
          }
          // 清除
          if (step("R2 重开月历层(清除那格)", await openSheet())) {
            await click("#dp-clear");
            const cleared = await until(`(async()=>(await window.__TAURI_INTERNALS__.invoke("list_tasks",{spaceId:"main"})).find(x=>x.id===${J(tid)})?.due_on===null)()`, 4000);
            await sleep(400);
            const a9 = await evalJs(`(()=>{const e=document.getElementById("error");return {open:document.getElementById("date-sheet").classList.contains("open"),bar:e.hidden?"":e.textContent,chip:!!${cardSel}.querySelector(".chip.due")}})()`);
            step("R2 「清除」:库里清掉、层收了、回执「已清除截止」、角标没了", !!cleared && !a9.open && /^已清除截止/.test(a9.bar) && !a9.chip, a9);
          }
          // 账本没被打穿:层都收了之后再按返回 = 收操作面(不是退出 app,也不是按了没反应)
          await clearBar();
          await sleep(400);
          if (await evalJs(`!!${cardSel}.querySelector(".panel")`)) {
            const seen = [];
            for (let i = 0; i < 2; i++) {
              await shell("input", "keyevent", "4");
              await sleep(700);
              seen.push(await evalJs(`({vis:document.visibilityState,panel:!!document.querySelector("#timeline .panel")})`));
              if (!seen[i].panel) break;
            }
            const last = seen[seen.length - 1];
            step("R2 层收完之后至多按两下返回(子面 → 主面 → 收)= 收了操作面、app 还在前台", last.vis === "visible" && !last.panel, seen);
          }
        }
      }
      // 刀下之后别把层 / 操作面留给后面几格
      if (await sheetOpen()) await evalJs(`(()=>{document.getElementById("date-scrim").click();return 1})()`);
      await sleep(500);
      await evalJs(`(()=>{const p=document.querySelector("#timeline .panel");if(p)p.closest("article").querySelector(".body").click();return 1})()`);
    }
    await clearBar();
    await scrollPage(0);

    // ── R1-W 横放随记(多栏)────────────────────────────────────────────────────
    await mode("ideas");
    await shell("settings", "put", "system", "accelerometer_rotation", "0");
    await shell("settings", "put", "system", "user_rotation", "1");
    rotated = true;
    if (OHOS) (out.skipped ??= []).push("R1-W 横放随记:鸿蒙没有命令行转屏,这一段没跑");
    else if (step("R1-W 前置:真转成了横放", !!(await until(`innerWidth > innerHeight && innerWidth > 700`, 6000)))) {
      await sleep(1000);
      await scrollPage(0);
      // 真划一下(设备像素;横放后 input 吃的是转过来的坐标系):从屏下 3/4 推到 1/4,列表往下走、顶栏随之收起
      const g = await evalJs(`({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`);
      const x = Math.round(g.w * g.dpr * 0.4);
      for (let i = 0; i < 2; i++) {
        await shell("input", "swipe", String(x), String(Math.round(g.h * g.dpr * 0.75)), String(x), String(Math.round(g.h * g.dpr * 0.25)), "350");
        await sleep(700);
      }
      const pre = await evalJs(`({y:scrollY,chromeHidden:document.body.classList.contains("chrome-hidden"),wide:document.body.classList.contains("widescreen")})`);
      await snap("R1-W-before");
      if (step("R1-W 前置:横放随记真划下去了(否则这一格是空测;顶栏收没收只记不判)", pre.y > 48, pre)) {
        await armKnife();
        // ⭐ 装成「键盘还没落完」:那一刻哪张卡都量成「不在眼前」,滚回顶之后不能再被推下去
        // (首版就栽在这儿:scrollIntoView 又把页面推离了顶、回执挂回「去看看」)。
        const w = await save(`${M}-W 横放记下`, { shortViewport: true });
        if (step("R1-W 前置:横放记下了一条", !!w)) {
          await sleep(450);
          const r = await after(w.id);
          step("R1-W 前置:是多栏瀑布流", r.cols >= 2, r);
          step("R1-W 记下后页面回到了顶", r.y < 2, r);
          step("R1-W 顶栏露回来了、新卡在眼前", !r.chromeHidden && r.shown && r.top >= r.chrome - 1, r);
          step("R1-W 多栏新卡挂常亮描边(.flash-hold)", w.hold, w);
          step("R1-W 回执「已记下」、不挂「去看看」", !r.barHidden && r.text.includes("已记下") && r.acts.length === 0, r);
          await snap("R1-W-saved");
        }
      }
    }
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    try {
      if (rotated) {
        await shell("settings", "put", "system", "user_rotation", rot0.user === "null" ? "0" : rot0.user);
        await until(`innerWidth < innerHeight`, 6000);
        await shell("settings", "put", "system", "accelerometer_rotation", rot0.auto === "null" ? "0" : rot0.auto);
        await sleep(900);
      }
      await clearBar();
      await evalJs(`(()=>{localStorage.removeItem("zhujian.compose-draft");return 1})()`);
      const tl = await inv("list_timeline");
      const ids = new Set([...made, ...tl.filter((d) => String(d.content).includes(M)).map((d) => d.id)]);
      for (const id of ids) {
        for (const c of ["archive_task", "purge_task", "archive_note", "purge_note"]) await inv(c, { id }).catch(() => null);
      }
      const left = {
        timeline: (await inv("list_timeline")).filter((x) => String(x.content).includes(M)).length,
        trash: (await inv("list_trash")).filter((x) => String(x.content).includes(M)).length,
      };
      step("清场:时间轴 / 回收站都没有种子", left.timeline + left.trash === 0, left);
      if (startSpace && startSpace !== "main") await toSpace(startSpace);
      else {
        await evalJs(`(()=>{location.reload();return 1})()`).catch(() => 1);
        await sleep(2500);
      }
      step("收尾:回到起跑时的空间、竖屏", !!(await until(`innerWidth < innerHeight && document.getElementById("gate").hidden`, 10000)));
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
