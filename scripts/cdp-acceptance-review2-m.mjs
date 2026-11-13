// 应用评审二轮(900)手机 M 组 —— 评审员在真机上摆出来的那批确凿毛病 —— 的真机回归网。
// 驱动形(要重载页面、要真点 ＋ 把软键盘叫起来;CDP 摆前置、读状态、量几何)。⚠ 只在有软键盘的真机上有意义(MuMu 没有)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-review2-m.mjs                    # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-review2-m.mjs --shots <目录>      # 关键几拍各截一张真屏
//   REVIEW2_KNIFE=css node scripts/cdp-acceptance-review2-m.mjs  # 阴性对照:页内把六处 CSS 修法改回坏的样子,对应那几格应当红
//     (M2 主钮底色 / M3 徽章触区被 overflow:hidden 裁掉 / M5 键盘起着页头不吸 / M10 触区缩回 / M6① 顶栏内边距 / M6② 第一行靠右)
//
// 逐条(编号同 .zjshots/900-fix/mob-m.md):
//  M1  随记列表滚到「新卡压在吸顶条底下」的位置记下:新卡算不在眼前(900 的尺子)⇒ 自己滚回顶、新卡整张露在吸顶条之下、
//      回执「已记下」不挂钮(用户 2026-11-13 改拍:此前 = 不拉回顶 + 回执带「去看看」;横放 / 任务面那几半在 `picks-r`);
//      在顶上记下:新卡闪一下、回执不挂钮(这一半是「别把在屏上的也判成不在」的对照)。
//  M2  标签面改名那一行的主钮:字是「保存」、底色 = 「记下」那枚主钮的底色(不是引擎的原生灰钮)。
//  M3  顶栏空间徽章的可点高度 ≥ 44(逐点探,0.5px 步长;halo 被 overflow 裁掉时只有 20)。
//  M5  记一笔 →「长文」写到四十行、键盘起着:页头两排吸在顶栏下面、「保存」在屏上(此前滚出屏)。
//  M7  人在非默认空间时重载页面(设置里换语言走的就是这条路;冷启动同形):不出「已切到 …」。
//  M10 「全部归档」的可点高度 ≥ 44,且下一张卡上沿往里 1.5px 那一点不归它(没压进卡里)。
//  M11 设置「关于」第四行是「用户指南」,地址 = 官网那一行的地址 + /docs/。
//  M6  英文档:①顶栏空间徽章比修之前宽(≥ 70,此前 56–58);②记一笔那排折行时第一枚小钮贴左;③字号档四枚都只占一行。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面;设备上有第二个空间(M3 / M7 要徽章在、要一个非默认空间)。
// 会写库:只写**默认空间**(main)—— 两条随记 + 一篇长文,正文带 `REVIEW2M` 记号,收尾 archive_note → purge_note 清掉并自证零残留。
//   ⚠ 另一个空间只「切过去再切回来」,一个字不写。跑完停在默认空间、中文档。
// 诚实边界:
//  ① M1 / M7 是 JS 行为,页内下不了刀 ⇒ 它们的阴性对照 = 在**修之前的包**上跑这支(那两格红),见 progress-log 同号条目;
//  ② M5 只判「页头吸着、保存在屏上」,光标那一行有没有被页头盖住靠截图(textarea 里量不到光标);横放那一形归 `walk165-m2` 的 A26;
//  ③ M3 的 `overflow: clip` + `overflow-clip-margin` 只在本机这只 WebView(155)上量过,老引擎(MuMu / Chrome 110)没量;
//  ④ M11 只核地址拼得对,不真开浏览器(那一半归 `walk165-o1` 的 S2 / S4 那一形)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.REVIEW2_KNIFE === "css";
const M = "REVIEW2M";
const KNIFE_CSS = [
  ".tk-edit button.tn-save,.tn-edit button.tn-save{background:revert !important;color:revert !important;border:revert !important}",
  ".space-chip{overflow:hidden !important}",
  "html.kb-up .doc-head{position:static !important}",
  ".tl-act::before{top:-12px !important;bottom:-4px !important}",
  ":root:lang(en) .head-acts .ghost{padding-inline:6px !important}",
  ".compose-row{justify-content:flex-end !important}",
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
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, Object.assign({spaceId: "main"}, ${J(args)}))`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.click();return true})()`);
  const kb = () => evalJs(`document.documentElement.classList.contains("kb-up")`);
  const dropIme = async () => {
    if (await kb()) {
      await adb(["shell", "input", "keyevent", "111"]); // ESCAPE:只收键盘,不走返回键那条「退一层」
      await until(`!document.documentElement.classList.contains("kb-up")`, 3000);
    }
  };
  const closePanes = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await click(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
  };
  const mode = async (m) => {
    await closePanes();
    if (!(await evalJs(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`))) {
      await click(`#bottombar [data-mode="${m}"]`);
      await until(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`, 3000);
    }
  };
  const dpr = await evalJs(`devicePixelRatio`);
  const tapEl = async (sel) => {
    const r = await evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!r) return false;
    await adb(["shell", "input", "tap", String(Math.round(r.x * dpr)), String(Math.round(r.y * dpr))]);
    return true;
  };
  const snap = async (name) => {
    if (!SHOTS) return;
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };
  /** 重载并等时间轴画出来;`set` = 重载前写进 localStorage 的几项。重载后把刀补回去(页内注入的样式一载就没)。 */
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o)localStorage.setItem(k,o[k]);location.reload();return 1})()`).catch(() => 1);
    await sleep(1500);
    await until(`document.readyState==="complete"&&!!document.getElementById("gate")&&document.getElementById("gate").hidden`, 15000);
    await sleep(1200);
    if (KNIFE) await evalJs(`(()=>{const st=document.createElement("style");st.id="review2-knife";st.textContent=${J(KNIFE_CSS)};document.head.append(st);return 1})()`);
  };
  const toSpace = async (id) => {
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(id)}}).then(()=>1)`);
    await reload({ "zhujian.last-space": id });
  };
  /** 某个元素在 x 这一列上的可点高度(逐点探,0.5 步长;halo 不进宿主 rect,只能这么量)。 */
  const hitSpan = (sel) =>
    evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();const x=r.left+r.width/2;let lo=null,hi=null;
      for(let y=r.top-40;y<=r.bottom+40;y+=0.5){if(document.elementFromPoint(x,y)===e){if(lo===null)lo=y;hi=y}}
      return lo===null?{span:0}:{span:hi-lo+0.5,lo,hi,top:r.top,bottom:r.bottom,x}})()`);

  const made = [];
  const spaces = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
  const other = spaces.find((x) => x.id !== "main");
  const startSpace = spaces.find((x) => x.current)?.id;
  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    if (!step("前置:设备上有第二个空间", !!other, spaces.map((x) => x.id))) return;
    if (startSpace !== "main") await toSpace("main");
    else if (KNIFE) await reload();
    await clearBar();

    // ── M3 徽章触区 ────────────────────────────────────────────────────────────
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    const m3 = await hitSpan("#space-chip");
    step("M3 空间徽章可点高度 ≥ 44", !!m3 && m3.span >= 43.5, m3);

    // ── M1 记下之后的信号 ──────────────────────────────────────────────────────
    const save = async (text) => {
      await click("#capture-fab");
      await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
      await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(text)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await click("#save");
      const id = await until(`window.__TAURI_INTERNALS__.invoke("list_timeline",{spaceId:"main"}).then(l=>(l.find(x=>x.content===${J(text)})||{}).id||false)`, 5000);
      if (id) made.push(id);
      await until(`!!document.querySelector('#timeline [data-id="${id}"]')`, 4000);
      return id;
    };
    // 新卡落在列表最上面(约 190–260);滚 150 ⇒ 它整张在吸顶条(顶栏 + 筛选条,约 164)底下
    await evalJs(`(()=>{window.scrollTo(0,150);return 1})()`);
    await sleep(300);
    const y0 = await evalJs(`scrollY`);
    const idA = await save(`${M}-A 列表没在顶时记下`);
    await sleep(500);
    const a = await evalJs(`(()=>{const e=document.getElementById("error");const c=document.querySelector('#timeline [data-id="${idA}"]');const r=c&&c.getBoundingClientRect();
      const cs=getComputedStyle(document.documentElement);const chrome=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0);
      return {y:scrollY,hidden:e.hidden,text:e.textContent,acts:[...e.querySelectorAll(".bar-act")].map(b=>b.textContent),cardBottom:r&&r.bottom,chrome}})()`);
    // 「新卡真的压在吸顶条底下」这格前置从这儿撤了:滚回顶之后量不到「滚之前它在哪儿」;滚的那 150 就是照它量的(见上面那行)。
    step("M1 前置:记下之前列表不在顶(滚了 150,否则这一格是空测)", !!idA && y0 > 100, { y0 });
    step("M1 新卡被吸顶条盖着 ⇒ 自己滚回顶", a.y < 2, { y0, y: a.y });
    step("M1 回执「已记下」、不挂「去看看」", !a.hidden && a.text.includes("已记下") && a.acts.length === 0, a);
    await snap("M1-saved-under-chrome");
    const a2 = await evalJs(`(()=>{const c=document.querySelector('#timeline [data-id="${idA}"]');const r=c.getBoundingClientRect();const cs=getComputedStyle(document.documentElement);
      const chrome=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0);return {top:r.top,bottom:r.bottom,chrome,ih:innerHeight}})()`);
    step("M1 新卡整张露在吸顶条之下", a2.top >= a2.chrome - 1 && a2.bottom <= a2.ih, a2);
    await clearBar();
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(300);
    const idB = await save(`${M}-B 在顶上记下`);
    const flashed = await until(`!!document.querySelector('#timeline [data-id="${idB}"].flash, #timeline [data-id="${idB}"].flash-hold')`, 1500);
    const b = await evalJs(`(()=>{const e=document.getElementById("error");return {hidden:e.hidden,acts:e.querySelectorAll(".bar-act").length,text:e.textContent}})()`);
    step("M1 对照:在顶上记下 = 新卡闪一下、不挂「去看看」", !!flashed && (b.hidden || b.acts === 0), b);
    await clearBar();

    // ── M10 全部归档的触区 ─────────────────────────────────────────────────────
    await mode("tasks");
    if (await evalJs(`!!document.querySelector("#timeline .tl-act")`)) {
      await evalJs(`(()=>{document.querySelector("#timeline .tl-act").scrollIntoView({block:"center"});return 1})()`);
      // 滚完连读两拍,相同了才量(696:量到中途那一帧就是陈坐标)
      let t0 = null;
      for (let i = 0; i < 20; i++) {
        const t = await evalJs(`document.querySelector("#timeline .tl-act").getBoundingClientRect().top`);
        if (t === t0) break;
        t0 = t;
        await sleep(150);
      }
      const m10 = await hitSpan("#timeline .tl-act");
      const below = await evalJs(`(()=>{const a=document.querySelector("#timeline .tl-act");const c=a.closest(".tl-group").querySelector(".card");if(!c)return null;
        const x=a.getBoundingClientRect().left+a.getBoundingClientRect().width/2;const y=c.getBoundingClientRect().top+1.5;return {y,hitsAct:document.elementFromPoint(x,y)===a}})()`);
      step("M10「全部归档」可点高度 ≥ 44", !!m10 && m10.span >= 43.5, m10);
      step("M10 触区没压进下一张卡", !!below && !below.hitsAct, below);
      await snap("M10-archive-all");
    } else step("M10(这块看板没有已完成的卡,节头上没有「全部归档」)", "skip");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);

    // ── M2 标签改名行的主钮 ────────────────────────────────────────────────────
    await mode("ideas");
    await click("#topics-toggle");
    if (await until(`!!document.querySelector("#topics-list .tname")`, 4000)) {
      await click("#topics-list .tname");
      await until(`!!document.querySelector("#topics-list [data-rename-save]")`, 3000);
      const m2 = await evalJs(`(()=>{const b=document.querySelector("#topics-list [data-rename-save]");const c=getComputedStyle(b);const p=getComputedStyle(document.getElementById("save"));
        return {text:b.textContent,bg:c.backgroundColor,want:p.backgroundColor,color:c.color,wantColor:p.color,border:c.borderTopStyle+" "+c.borderTopWidth}})()`);
      step("M2 改名行主钮的字是「保存」", m2.text === "保存", m2);
      step("M2 改名行主钮是朱砂实底(与「记下」同底同字色,不是原生灰钮)", m2.bg === m2.want && m2.color === m2.wantColor && m2.border.startsWith("solid"), m2);
      await snap("M2-rename-row");
      await click("#topics-list [data-rename-cancel]");
    } else step("M2(默认空间一枚标签都没有,进不了改名态)", "skip");
    await closePanes();

    // ── M11 关于里的用户指南 ───────────────────────────────────────────────────
    await click("#settings-toggle");
    await until(`document.querySelectorAll("#about .k").length>=3`, 5000);
    const m11 = await evalJs(`(()=>{const ks=[...document.querySelectorAll("#about .k")].map(k=>k.textContent);const as=[...document.querySelectorAll("#about a.about-link")].map(a=>a.getAttribute("href"));return {ks,as}})()`);
    step("M11「关于」第四行链接是「用户指南」、地址 = 官网 + /docs/", m11.as.length === 4 && m11.as[3] === `${m11.as[0]}/docs/` && m11.ks[m11.ks.length - 1] === "用户指南", m11);
    await evalJs(`(()=>{document.scrollingElement.scrollTop=document.scrollingElement.scrollHeight;return 1})()`);
    await sleep(300);
    await snap("M11-about");
    await closePanes();

    // ── M5 长文编辑器:键盘起着页头吸着 ────────────────────────────────────────
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(300);
    await tapEl("#capture-fab"); // 真点:软键盘要用户手势才起
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await until(`document.documentElement.classList.contains("kb-up")`, 4000);
    const body = `# ${M} 长文\n${Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n")}`;
    await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(body)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    await click("#compose-doc");
    if (step("M5 前置:记一笔 →「长文」进了编辑器", !!(await until(`!!document.querySelector("#docs-pane .doc-area")`, 4000)))) {
      await sleep(1200);
      const m5 = await evalJs(`(()=>{const h=document.querySelector("#docs-pane .doc-head");const hr=h.getBoundingClientRect();const b=[...h.querySelectorAll("button")].find(x=>x.textContent==="保存").getBoundingClientRect();
        const head=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--head-h"));const a=document.querySelector("#docs-pane .doc-area");
        return {kb:document.documentElement.classList.contains("kb-up"),sy:scrollY,pos:getComputedStyle(h).position,headTop:hr.top,headBottom:hr.bottom,head,saveTop:b.top,saveBottom:b.bottom,ih:innerHeight,caretAtEnd:a.selectionStart===a.value.length}})()`);
      step("M5 前置:键盘起着、光标在文末、页面真滚下去了(否则这一格是空测)", m5.kb && m5.caretAtEnd && m5.sy > 100, m5);
      step("M5 键盘起着写到四十行:页头吸在顶栏下面", m5.pos === "sticky" && Math.abs(m5.headTop - m5.head) < 1.5, m5);
      step("M5「保存」在屏上(顶栏之下、键盘之上)", m5.saveTop >= m5.head - 1 && m5.saveBottom <= m5.ih, m5);
      await snap("M5-doc-kb-up");
      await dropIme();
      await sleep(600);
      await snap("M5-doc-kb-down");
      // 落成一篇(「← 回到正文」= 存了再回阅读页),随后清掉
      await evalJs(`(()=>{const b=document.querySelector("#docs-pane .doc-head button");b.click();return 1})()`);
      await sleep(1200);
    }
    await dropIme();
    await closePanes();
    await clearBar();

    // ── M7 重载不报「已切换到」 ────────────────────────────────────────────────
    // ⚠ 那句回执只亮两三秒 ⇒ 重载之后**立刻**开始盯,每 150ms 读一拍、盯满 5 s(等页面画完再读就已经收了:修之前的包上第一版正是这么假绿的)。
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(other.id)}}).then(()=>1)`);
    await evalJs(`(()=>{localStorage.setItem("zhujian.last-space",${J(other.id)});location.reload();return 1})()`).catch(() => 1);
    const seen = [];
    for (let t0 = Date.now(); Date.now() - t0 < 5000; ) {
      const v = await evalJs(`(()=>{const e=document.getElementById("error");return e&&!e.hidden?e.textContent:""})()`).catch(() => "");
      if (v && !seen.includes(v)) seen.push(v);
      await sleep(150);
    }
    if (KNIFE) await evalJs(`(()=>{const st=document.createElement("style");st.id="review2-knife";st.textContent=${J(KNIFE_CSS)};document.head.append(st);return 1})()`);
    const m7 = await evalJs(`(async()=>{const sp=await window.__TAURI_INTERNALS__.invoke("list_spaces");return {cur:(sp.find(x=>x.current)||{}).id,chip:document.getElementById("space-chip").textContent}})()`);
    step("M7 前置:重载后人确实回到了那个非默认空间", m7.cur === other.id, m7);
    step("M7 重载回到原空间:不出「已切到 …」", !seen.some((x) => /已切到|Switched to/.test(x)), seen);
    await snap("M7-after-reload");
    await toSpace("main");

    // ── M6 英文档 ──────────────────────────────────────────────────────────────
    await reload({ "zhujian.lang": "en" });
    const m6a = await evalJs(`(()=>{const c=document.getElementById("space-chip");const acts=document.querySelector(".head-acts").getBoundingClientRect();return {lang:document.documentElement.lang,chipW:c.clientWidth,actsW:acts.width,vw:innerWidth}})()`);
    step("M6 前置:切到了英文档、视口 360 宽(判据的数是照它量的)", m6a.lang === "en" && m6a.vw === 360, m6a);
    step("M6 ① 英文档顶栏空间徽章 ≥ 70 宽(此前 56)", m6a.chipW >= 70, m6a);
    await snap("M6-en-header");
    await click("#capture-fab");
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await sleep(500);
    const m6b = await evalJs(`(()=>{const row=document.querySelector("#compose-card .compose-row");const rr=row.getBoundingClientRect();const bs=[...row.children].map(b=>{const r=b.getBoundingClientRect();return {l:r.left,t:Math.round(r.top)}});
      return {rowLeft:rr.left,first:bs[0],wrapped:new Set(bs.map(b=>b.t)).size>1}})()`);
    step("M6 前置:英文档记一笔那排折成了两行(否则这一格是空测)", m6b.wrapped, m6b);
    step("M6 ② 折行时第一枚小钮贴左", Math.abs(m6b.first.l - m6b.rowLeft) < 1.5, m6b);
    await snap("M6-en-compose");
    await adb(["shell", "input", "keyevent", "4"]); // 返回 = 收记一笔层(层开着才按,见上面那句 until)
    await until(`!document.getElementById("compose-card").classList.contains("open")`, 3000);
    await dropIme();
    await click("#settings-toggle");
    await until(`!!document.querySelector("#textsize-seg button")`, 4000);
    const m6c = await evalJs(`(()=>[...document.querySelectorAll("#textsize-seg button")].map(b=>{const r=document.createRange();r.selectNodeContents(b);return {text:b.textContent,lines:new Set([...r.getClientRects()].map(q=>Math.round(q.top))).size}}))()`);
    step("M6 ③ 字号档四枚都只占一行", m6c.length === 4 && m6c.every((x) => x.lines === 1), m6c);
    await evalJs(`(()=>{document.getElementById("textsize-seg").scrollIntoView({block:"center"});return 1})()`);
    await sleep(300);
    await snap("M6-en-textsize");
    await closePanes();
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    // 收尾:回中文、回默认空间、清种子(随记与长文都是 archive_note → purge_note)
    try {
      const sp = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
      if (sp.find((x) => x.current)?.id !== "main") await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:"main"}).then(()=>1)`);
      await evalJs(`(()=>{localStorage.setItem("zhujian.lang","zh");localStorage.setItem("zhujian.last-space","main");localStorage.removeItem("zhujian.compose-draft");return 1})()`);
      const docs = await inv("list_docs");
      const tl = await inv("list_timeline");
      const ids = new Set([...made, ...docs.filter((d) => String(d.content).includes(M)).map((d) => d.id), ...tl.filter((d) => String(d.content).includes(M)).map((d) => d.id)]);
      for (const id of ids) {
        for (const c of ["archive_note", "purge_note"]) await inv(c, { id }).catch(() => null);
      }
      const left = {
        timeline: (await inv("list_timeline")).filter((x) => String(x.content).includes(M)).length,
        docs: (await inv("list_docs")).filter((x) => String(x.content).includes(M)).length,
        trash: (await inv("list_trash")).filter((x) => String(x.content).includes(M)).length,
      };
      step("清场:时间轴 / 长文 / 回收站都没有种子", left.timeline + left.docs + left.trash === 0, left);
      await evalJs(`(()=>{location.reload();return 1})()`).catch(() => 1);
      await sleep(2500);
      step("收尾:停在默认空间、中文档", await until(`document.documentElement.lang==="zh"&&document.getElementById("gate").hidden`, 10000));
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
