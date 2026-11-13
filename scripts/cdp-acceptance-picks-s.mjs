// 手机 S 组(906,用户 2026-11-13 下午在日常手机上当面拍的三条)的真机回归网:
//   S1 标签行那枚钮写字(收起态「更多 N ▾」/ 摊开态「收起 ▴」排在标签块最后一枚,过滤框回到「标签 所有 无标签」那一行右端);
//   S2 卡片「更多…」改成屏底菜单(一行一项、删除单独一段、没有「返回」钮);
//   S3 设置首页只留短的(外观 / 界面字号 / 语言 + 意见反馈),其余各收成一行入口、点进去是单独一页;
//   S4 任务卡左边那枚勾完成的圆圈撤了:正文左缘与随记卡同线,「完成」是操作面最前面那一枚(主色实底),已完成的卡正文前带朱砂 ✓。
// 驱动形(要真点、要真按返回键;CDP 摆前置、读状态、量几何)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-s.mjs                      # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-s.mjs --shots <目录>        # 关键几拍各截一张真屏
//   node scripts/cdp-acceptance-picks-s.mjs --ohos               # 鸿蒙真机(返回键走 hdc、截图走 CDP;没有通知 / 字号桥的那几行按「不在」判)
//   PICKSS_KNIFE=tags node scripts/cdp-acceptance-picks-s.mjs     # 阴性对照(S1):页内注入 —— 垫片抹掉、过滤框退回流内、钮上的字抹成空
//     ⇒ 应当红:「钮上写着更多 N」「数对得上」「过滤框与『所有』同一行」「摊开态钮写收起」「再点收起回到更多 N」;其余照绿。
//   PICKSS_KNIFE=more node scripts/cdp-acceptance-picks-s.mjs     # 阴性对照(S2):行高压到 30、删除那一段的间隔抹掉、菜单上的点击吞掉
//     ⇒ 应当红:「行高 ≥ 48」「删除单独一段」「选复制 = 收层 + 回执」「选历史进历史面」「删除一点即删」「撤回出确认条」;S1 / S3 照绿。
//   PICKSS_KNIFE=settings node scripts/cdp-acceptance-picks-s.mjs # 阴性对照(S3):入口行压到 30 高、意见反馈那一节藏掉、摘要抹掉、二级页的返回钮吞掉
//     ⇒ 应当红:「首页只剩这几节」「入口行高 ≥ 48」「意见反馈在首页看得见」「摘要…」那几格、「页头返回回首页」
//       (连带它后面的「摘要跟着变」「备份那一页进得去」—— 刀把人留在了压缩大图那一页);其余照绿。
//
//   PICKSS_KNIFE=done node scripts/cdp-acceptance-picks-s.mjs     # 阴性对照(S4):「完成」钮藏掉、已完成卡的 ✓ 抹掉、卡片正文左边垫回 48
//     ⇒ 应当红:「正文左缘与随记卡同线」「操作面最前面是完成」「点完成写库」(连带回执 / 撤销)「已完成卡带 ✓」;S1–S3 照绿。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面。
// ⚠ 从**刚拉起**的 app 上跑(`am force-stop` → monkey 拉起 → forward):前面别的资产若在开着面 / 层时重载过页面,那几枚守门条目就成了
//   「上一个文档」的会话历史,WebView 从此自己接返回键去后退(161 / W4 A13 那一形)⇒ 「再按一次 ⇒ 收操作面」那格假红(906 实撞:
//   连跑几支之后红、重新拉起就绿;页内插桩看得到两记返回都只有 popstate、原生入口一次没被问到)。
// 会写库:只写**默认空间**(main)—— 8 枚标签(各挂一张待办)+ 一张待办 + 两条随记(一条改过一次),名字 / 正文都带 `PICKSS` 记号;
//   收尾 archive → purge、标签 delete,并自证零残留。起跑时人在别的空间就切到 main 跑,跑完切回。
//   本机开关(标签行摊没摊开 `zhujian.filter-tags-open`、压缩大图)用前读、用后还。
// 诚实边界:
//  ① 刀都是页内注入(CSS / 吞事件):证的是「判据真看几何与行为」,不是「删掉那几行源码会红」;后者 = 在 905 的包上跑这支(三段都红)。
//  ② S1 的「N」按「标签行歇在开头时没露全的枚数」判(与产品同一个口径,另写一份量法);横划之后 N 不跟着变是产品的取舍,本支不判。
//  ③ S2「换卡 / 切空间 / 刷新清态 / 滚走 / 转屏时菜单跟着收」只靠代码构造(都走 cardpanel 的 setState → syncShell):层开着时遮罩压着
//     时间轴,真手点不出这几种,本支只验了「返回键」「点遮罩」「选一项」三条收层路。
//  ④ S3 的备份页只验到「进得去、那一节画出来了、摘要与状态对得上」;列表行(文件名收起)要挑过文件夹才有,这台没挑就记 SKIPPED。
//  ⑥ S4「纯分类看板 / 收容区里的卡不出『完成』」:手机端造不出看板(只做读侧),这台的默认空间里恰好有那样的卡才判,没有记 SKIPPED;
//     那半由 cdp-acceptance-multiboard.mjs ③ / ⑦ 守(要桌面先摆好看板)。
//  ⑤ 横放 / 平板 / 暗档 / 英文档的样子不在本支(截图在 .zjshots/906-fix/mob-s/;宽屏排法由 board-wide ⑥ 守)。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
// --ohos:鸿蒙真机上跑(9222 那条转发照 skill `zhujian-ohos-verify` 自己建)。设备侧只有两样要换:返回键走 hdc、截图走 CDP。
const OHOS = process.argv.includes("--ohos");
const HDC = process.env.HDC ?? "G:/ohos-sdk/toolchains/hdc.exe";
const shell = async (...a) => {
  if (!OHOS) return (await adb(["shell", ...a])).stdout.trim();
  if (a.join(" ") === "input keyevent 4") return (await execFileAsync(HDC, ["shell", "uitest uiInput keyEvent Back"], { encoding: "utf8" })).stdout.trim();
  throw new Error(`--ohos 下没有这条设备命令:${a.join(" ")}`);
};
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.PICKSS_KNIFE ?? null;
const M = "PICKSS";
const TAGS_KEY = "zhujian.filter-tags-open";

const out = { pass: false, knife: KNIFE, steps: [] };
process.exitCode = 2; // 转发没建好时连接永不兑现、node 会一声不响地以 0 退出 ⇒ 先垫一个非零,跑完由末尾改写
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
  /** 真点一下(`Input.dispatchTouchEvent`,走原生输入管线)。`expr` = 页内取元素的表达式。坐标连读两拍相同才取(滚动 / 过场没停时量到的是半路)。
   *  `done` = 点完该成立的页内表达式:没成立就重取坐标再点一次,还不成立退到合成 click(538 那记偶发不落;落在第几次记在返回值里)。 */
  const tap = async (expr, done = null) => {
    const rect = `(()=>{const e=${expr};if(!e||e.getClientRects().length===0)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`;
    for (let n = 1; n <= 3; n++) {
      let p = await evalJs(rect);
      for (let i = 0; i < 6 && p; i++) {
        await sleep(90);
        const q = await evalJs(rect);
        if (q && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5) break;
        p = q;
      }
      if (!p) return 0;
      if (n < 3) {
        await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
        await sleep(40);
        await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else await evalJs(`(()=>{${expr}.click();return 1})()`);
      if (!done) return n;
      if (await until(done, 1500)) return n;
    }
    return 0;
  };
  const armKnife = async () => {
    if (!KNIFE) return;
    await evalJs(`(()=>{if(document.getElementById("pickss-knife"))return 1;const st=document.createElement("style");st.id="pickss-knife";const k=${J(KNIFE)};
      st.textContent=k==="tags"?".fspacer{display:none!important}body:not(.board) #filterbar.tags-open .ftext{position:static!important}#filter-expand{font-size:0!important;color:transparent!important}#filter-expand>*{display:none!important}"
        :k==="more"?".ms-item{min-height:30px!important}.ms-tail{margin-top:0!important}"
        :k==="done"?'#timeline .panel [data-pact="complete"]{display:none!important}.card.done .content::before{content:none!important}body[data-view="tasks"] #timeline .card .body{margin-left:48px!important}'
        :k==="settings"?".set-row{min-height:30px!important}#feedback-title,#feedback-title~*{display:none!important}.set-sum{display:none!important}":"";
      document.head.append(st);
      if(k==="tags"){const b=document.getElementById("filter-expand");new MutationObserver(()=>{if(b.textContent!=="")b.textContent=""}).observe(b,{childList:true,subtree:true,characterData:true});b.textContent=""}
      if(k==="more")document.getElementById("more-list").addEventListener("click",e=>e.stopImmediatePropagation(),true);
      if(k==="settings")document.addEventListener("click",e=>{if(e.target.closest&&e.target.closest("[data-set-back]"))e.stopImmediatePropagation()},true);
      return 1})()`);
  };
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o){if(o[k]===null)localStorage.removeItem(k);else localStorage.setItem(k,o[k])}location.reload();return 1})()`).catch(() => 1);
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
  const foreground = async () => OHOS || /app\.zhujian\.notebook/.test(await shell("dumpsys", "window", "|", "grep", "mCurrentFocus"));
  const back = async () => {
    await shell("input", "keyevent", "4");
    await sleep(700);
  };

  const spaces = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
  const startSpace = spaces.find((x) => x.current)?.id;
  const tags0 = await evalJs(`localStorage.getItem(${J(TAGS_KEY)})`);
  const made = [];
  const topics = [];
  let compress0 = null;
  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    if (!step("前置:竖屏", await evalJs(`innerWidth < innerHeight`))) return;
    if (startSpace !== "main") await toSpace("main");
    // 播种(页内直调写库后时间轴是旧快照 ⇒ 重载):8 枚标签各挂一张待办(撑出一行放不下的标签行)、一张没改过的待办、一条改过一次的随记。
    for (let i = 1; i <= 8; i++) {
      const tid = await inv("create_topic", { title: `${M}签${i}` });
      topics.push(tid);
      made.push(await inv("create_task", { title: `${M}-挂签待办${i}`, dueOn: null, priority: null, topicId: tid }));
    }
    const taskId = await inv("create_task", { title: `${M}-菜单待办`, dueOn: null, priority: null, topicId: null });
    const noteId = await inv("capture_idea", { content: `${M}-菜单随记 初版` });
    await inv("edit_note", { id: noteId, content: `${M}-菜单随记 改过` });
    const delId = await inv("capture_idea", { content: `${M}-删我` });
    made.push(taskId, noteId, delId);
    await reload({ [TAGS_KEY]: "0" });
    await clearBar();

    // ── S1 标签行 ──────────────────────────────────────────────────────────────
    await mode("tasks");
    const BAR = `(()=>{const R=e=>{const b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}};
      const tp=document.getElementById("filter-topics"),btn=document.getElementById("filter-expand"),ft=document.getElementById("filter-text"),fb=document.getElementById("filterbar");
      const pills=[...tp.querySelectorAll(":scope > .fpill")].filter(p=>p.offsetWidth>0);const tr=R(tp);const edge=tr.l+tp.clientWidth;
      const all=pills.find(p=>!p.dataset.topicId);const mid=r=>(r.t+r.b)/2;const br=btn&&btn.getClientRects().length?R(btn):null;
      const hit=(x,y)=>{const e=document.elementFromPoint(x,y);return !!e&&(e===btn||btn.contains(e))};
      return {open:fb.classList.contains("tags-open"),fit:fb.classList.contains("tags-fit"),text:btn?btn.textContent:null,hidden:!btn||btn.hidden,inTopics:!!btn&&btn.parentElement===tp,last:tp.lastElementChild===btn,
        aria:btn?btn.getAttribute("aria-label"):null,expanded:btn?btn.getAttribute("aria-expanded"):null,btn:br,ft:R(ft),topics:tr,fmainR:R(ft.parentElement).r,
        cut:pills.filter(p=>p.getBoundingClientRect().right+tp.scrollLeft>edge+1).length,pills:pills.length,seeded:pills.filter(p=>p.textContent.includes(${J(M)})).length,
        seededShown:pills.filter(p=>p.textContent.includes(${J(M)})).every(p=>{const r=R(p);return r.l>=tr.l-1&&r.r<=tr.r+1&&r.r<=innerWidth}),
        allMid:all?mid(R(all)):null,ftMid:mid(R(ft)),overlap:pills.some(p=>{const r=R(p),f=R(ft);return r.l<f.r-1&&r.r>f.l+1&&r.t<f.b-1&&r.b>f.t+1}),
        hits:br?[hit(br.l+br.w/2,br.t+br.h/2),hit(br.l+3,br.t+3),hit(br.r-3,br.b-3),hit(br.l+br.w/2,br.t-2),hit(br.l+br.w/2,br.b+2)]:[],
        active:(()=>{const a=tp.querySelector(".fpill.active[data-topic-id]");if(!a)return null;const r=R(a);return {text:a.textContent,inRow:r.l>=tr.l-1&&r.r<=tr.l+tp.clientWidth+1}})(),
        pref:localStorage.getItem(${J(TAGS_KEY)})}})()`;
    {
      const a = await evalJs(BAR);
      step("S1 前置:播种的 8 枚标签都在标签行里、一行放不下(收起态、钮在)", a.seeded === 8 && !a.open && !a.hidden, a);
      const m = /^更多 (\d+)▾$/.exec(a.text ?? "");
      step("S1 收起态:钮上写着「更多 N ▾」", !!m, { text: a.text });
      step("S1 收起态:N = 这一行没露全的标签枚数(另量一遍,且 ≥ 1)", !!m && Number(m[1]) === a.cut && a.cut >= 1, { text: a.text, cut: a.cut, pills: a.pills });
      step("S1 收起态:钮在标签行外(过滤框左边)、读屏名「摊开全部标签」、aria-expanded=false", !a.inTopics && a.aria === "摊开全部标签" && a.expanded === "false", a);
      step("S1 钮的触区:宽 ≥ 44、高 ≥ 30 且上下那层 halo 打点命中(五点)", !!a.btn && a.btn.w >= 44 && a.btn.h >= 30 && a.hits.every(Boolean), { btn: a.btn, hits: a.hits });
      await snap("S1-collapsed");
      const n = await tap(`document.getElementById("filter-expand")`, `document.getElementById("filterbar").classList.contains("tags-open")`);
      step("S1 真点那枚钮 ⇒ 摊开", n > 0, { tapTry: n });
      await sleep(350);
      const b = await evalJs(BAR);
      step("S1 摊开态:钮写「收起 ▴」、是标签块的最后一枚、读屏名「收起标签行」", b.text === "收起▴" && b.inTopics && b.last && b.aria === "收起标签行" && b.expanded === "true", b);
      step("S1 摊开态:播种的 8 枚标签全露在屏内", b.seeded === 8 && b.seededShown, b);
      step("S1 摊开态:过滤框与「所有」同一行、贴主行右端、不压着任何一枚标签", b.allMid !== null && Math.abs(b.ftMid - b.allMid) <= 3 && Math.abs(b.ft.r - b.fmainR) <= 1.5 && !b.overlap, b);
      step("S1 摊没摊开记进本机开关", b.pref === "1", { pref: b.pref });
      await snap("S1-open");
      // 既有规矩(157 G3):摊开态点一枚标签 = 收回单行、选中那枚在这一行里看得见、存着的偏好不变。
      await tap(`[...document.querySelectorAll("#filter-topics .fpill")].find(p=>p.textContent.includes(${J(`${M}签7`)}))`, `!document.getElementById("filterbar").classList.contains("tags-open")`);
      await sleep(350);
      const c = await evalJs(BAR);
      step("S1 摊开态点一枚标签 ⇒ 收回单行,选中那枚仍在这一行里看得见,偏好不变", !c.open && !!c.active && c.active.text.includes(`${M}签7`) && c.active.inRow && c.pref === "1", c);
      await evalJs(`(()=>{[...document.querySelectorAll("#filter-topics .fpill")].find(p=>!p.dataset.topicId).click();return 1})()`);
      await sleep(300);
      await click("#filter-expand"); // 摊开(内存态)→ 再点收起,偏好落回 0
      await sleep(250);
      await click("#filter-expand");
      await sleep(250);
      const d = await evalJs(BAR);
      step("S1 再点「收起 ▴」⇒ 回到单行、钮回到「更多 N ▾」、偏好记成收起", !d.open && /^更多 \d+▾$/.test(d.text ?? "") && !d.inTopics && d.pref === "0", d);
    }

    // ── S2 「更多…」屏底菜单 ───────────────────────────────────────────────────
    const SHEET = `(()=>{const R=e=>{const b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}};
      const sh=document.getElementById("more-sheet"),items=[...document.querySelectorAll("#more-list .ms-item")];const p=document.querySelector("#timeline .panel");
      const probe=document.createElement("span");probe.style.color="var(--seal-ink)";document.body.append(probe);const seal=getComputedStyle(probe).color;probe.remove();
      const tail=document.querySelector("#more-list .ms-tail");const lastMain=[...document.querySelectorAll("#more-list .ms-group:not(.ms-tail) .ms-item")].pop();
      return {open:sh.classList.contains("open"),scrim:!document.getElementById("more-scrim").hidden,labels:items.map(b=>b.textContent),
        minH:items.length?Math.min(...items.map(b=>R(b).h)):0,lefts:[...new Set(items.map(b=>Math.round(R(b).l)))],align:[...new Set(items.map(b=>getComputedStyle(b).textAlign))],
        lines:items.filter(b=>b.previousElementSibling).every(b=>parseFloat(getComputedStyle(b).borderTopWidth)>=0.5),
        tailLabels:tail?[...tail.querySelectorAll(".ms-item")].map(b=>b.textContent):[],tailGap:tail&&lastMain?R(tail.querySelector(".ms-item")).t-R(lastMain).b:0,
        warn:items.filter(b=>getComputedStyle(b).color===seal).map(b=>b.textContent),plain:items.filter(b=>getComputedStyle(b).color!==seal).length,
        sheet:R(sh),vh:innerHeight,panel:p?[...p.querySelectorAll("[data-pact]")].map(b=>b.dataset.pact):null,panelCard:p?p.closest("article.card").dataset.id:null}})()`;
    const openPanel = async (id) => {
      await evalJs(`(()=>{document.querySelector('#timeline article.card[data-id="${id}"]').scrollIntoView({block:"center"});return 1})()`);
      await sleep(400);
      if (!(await evalJs(`document.querySelector('#timeline article.card[data-id="${id}"] .panel')!==null`)))
        await tap(`document.querySelector('#timeline article.card[data-id="${id}"] .content')`, `document.querySelector('#timeline article.card[data-id="${id}"] .panel')!==null`);
      return evalJs(`document.querySelector('#timeline article.card[data-id="${id}"] .panel')!==null`);
    };
    const openMore = async () => {
      const n = await tap(`document.querySelector('#timeline .panel [data-pact="more"]')`, `document.getElementById("more-sheet").classList.contains("open")`);
      await sleep(500); // 过场 0.22 s + 遮罩那记漏点的抑制窗 450 ms
      return n;
    };
    const closed = `!document.getElementById("more-sheet").classList.contains("open")&&document.getElementById("more-scrim").hidden`;
    const spaceN = spaces.length;
    {
      await mode("ideas");
      step("S2 前置:随记卡的操作面开了", await openPanel(noteId));
      const n = await openMore();
      const a = await evalJs(SHEET);
      step("S2 真点「更多…」⇒ 屏底升起菜单层、遮罩在", n > 0 && a.open && a.scrim, { tapTry: n, open: a.open });
      step("S2 卡片里的操作面原样是第一层(没有「返回」、没有删除)", !!a.panel && a.panel.join() === "edit,tags,promote,more" && a.panelCard === noteId, a.panel);
      const want = ["留言", "转成长文", "复制", "复制链接", "历史", ...(spaceN >= 2 ? ["移动"] : []), "删除"];
      const got = a.labels.filter((l) => l !== "放进看板"); // 看板那一枚按库里有几块放得进卡的看板出,不在本支的播种里
      step("S2 随记(改过)的菜单:项目与次序同原来那一面,没有「返回」", J(got) === J(want), { got: a.labels, want });
      step("S2 一行一项、左对齐、行高 ≥ 48、行间有细线", a.minH >= 48 && a.lefts.length === 1 && a.align.join() === "left" && a.lines, a);
      step("S2 「删除」在最底下单独一段(与上一项隔开 ≥ 8)、朱砂字;其余是墨色", J(a.tailLabels) === J(["删除"]) && a.tailGap >= 8 && a.warn.join() === "删除" && a.plain === a.labels.length - 1, a);
      step("S2 层贴着屏底、没顶出屏", Math.abs(a.sheet.b - a.vh) <= 1.5 && a.sheet.t >= 0, a.sheet);
      await snap("S2-sheet-note");
      // 返回键 = 收层,操作面还在;再按 = 收操作面;app 还在前台
      await back();
      step("S2 真按返回键 ⇒ 只收菜单层,操作面还开着,app 还在前台", (await evalJs(closed)) && (await evalJs(`document.querySelector("#timeline .panel")!==null`)) && (await foreground()));
      await back();
      step("S2 再按一次 ⇒ 收操作面,app 还在前台", (await evalJs(`document.querySelector("#timeline .panel")===null`)) && (await foreground()));
      // 点遮罩 = 收层、什么都不做
      await openPanel(noteId);
      await openMore();
      const sn = await tap(`document.getElementById("more-scrim")`, closed);
      step("S2 真点遮罩 ⇒ 收层,操作面还在,那条随记原样", sn > 0 && (await evalJs(`document.querySelector("#timeline .panel")!==null`)) && !!(await inv("list_timeline")).find((x) => x.id === noteId), { tapTry: sn });
      // 选「复制」= 先收层、再走原来那条路(回执)
      await clearBar();
      await openMore();
      await tap(`[...document.querySelectorAll("#more-list .ms-item")].find(b=>b.textContent==="复制")`, closed);
      const copied = await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&e.textContent.includes("已复制这张卡的文字")})()`, 3000);
      step("S2 选「复制」⇒ 层收了、出回执「已复制这张卡的文字」、操作面原样留着", (await evalJs(closed)) && !!copied && (await evalJs(`document.querySelector('#timeline .panel [data-pact="more"]')!==null`)));
      await clearBar();
      // 选「历史」= 收层,历史在卡片里展开
      await openMore();
      await tap(`[...document.querySelectorAll("#more-list .ms-item")].find(b=>b.textContent==="历史")`, closed);
      const hist = await until(`document.querySelector("#timeline .panel [data-rev]")!==null&&document.querySelector('#timeline .panel [data-pact="back"]')!==null`, 4000);
      step("S2 选「历史」⇒ 层收了,历史照旧在卡片里展开(有版本行、有「返回」)", (await evalJs(closed)) && !!hist);
      await click(`#timeline .panel [data-pact="back"]`);
      await sleep(300);
      step("S2 历史面点「返回」⇒ 回到第一层", await evalJs(`document.querySelector('#timeline .panel [data-pact="more"]')!==null`));
      await back(); // 收操作面
      // 删除:单拍 + 撤销
      step("S2 前置:待删那条随记的操作面开了", await openPanel(delId));
      await openMore();
      await tap(`document.querySelector("#more-list .ms-tail .ms-item")`, closed);
      const gone = await until(`document.querySelector('#timeline article.card[data-id="${delId}"]')===null`, 4000);
      const bar = await evalJs(`(()=>{const e=document.getElementById("error");return {hidden:e.hidden,text:e.textContent,acts:[...e.querySelectorAll(".bar-act")].map(b=>b.textContent)}})()`);
      step("S2 选「删除」⇒ 一点即删(不再问)、回执「已移入回收站」带「撤销」", !!gone && !bar.hidden && bar.text.includes("已移入回收站") && bar.acts.includes("撤销"), bar);
      await evalJs(`(()=>{[...document.querySelectorAll("#error .bar-act")].find(b=>b.textContent==="撤销").click();return 1})()`).catch(() => 0);
      step("S2 点「撤销」⇒ 那条回来了", !!(await until(`document.querySelector('#timeline article.card[data-id="${delId}"]')!==null`, 5000)));
      await clearBar();
      // 任务卡:没改过 ⇒ 没有「历史」;落点列 ⇒ 有「撤回为随记」(朱砂),选它出确认条(两拍照旧)
      await mode("tasks");
      step("S2 前置:待办卡的操作面开了", await openPanel(taskId));
      await openMore();
      const t = await evalJs(SHEET);
      // S4:有「完成」那一枚的待办,「留言」让进这张菜单的最上面(第一层四枚封顶)
      const wantT = ["留言", "复制", "复制链接", ...(spaceN >= 2 ? ["移动"] : []), "撤回为随记", "删除"];
      step("S2 待办(没改过、在落点列)的菜单:「留言」在最上面,没有「转成长文 / 历史 / 归档」,有「撤回为随记」", J(t.labels.filter((l) => l !== "挪到看板")) === J(wantT), { got: t.labels, want: wantT });
      step("S2 「撤回为随记」「删除」是朱砂字", J(t.warn) === J(["撤回为随记", "删除"]), t.warn);
      await snap("S2-sheet-task");
      await tap(`[...document.querySelectorAll("#more-list .ms-item")].find(b=>b.textContent==="撤回为随记")`, closed);
      const q = await until(`(()=>{const c=document.getElementById("confirmbar");return !c.hidden&&document.getElementById("confirmbar-q").textContent})()`, 3000);
      step("S2 选「撤回为随记」⇒ 层收了、出确认条(两拍照旧)", (await evalJs(closed)) && typeof q === "string" && q.includes("撤回为随记"), { q });
      await click("#confirmbar-no");
      await sleep(300);
      const still = (await inv("list_tasks")).some((x) => x.id === taskId);
      step("S2 确认条点「取消」⇒ 那张还是待办", still);
      await back(); // 收操作面
    }

    // ── S4 圆圈撤了、「完成」在操作面 ───────────────────────────────────────────
    {
      const LEFT = (id) => `(()=>{const c=document.querySelector('#timeline article.card[data-id="${id}"]');if(!c)return null;return {l:c.querySelector(".content").getBoundingClientRect().left-c.getBoundingClientRect().left,ticks:document.querySelectorAll("#timeline .tick").length}})()`;
      await mode("ideas");
      const nl = await evalJs(LEFT(noteId));
      await mode("tasks");
      const tl = await evalJs(LEFT(taskId));
      step("S4 任务卡上没有圆圈(.tick 一枚都没有)", !!tl && tl.ticks === 0, tl);
      step("S4 任务卡正文左缘与随记卡同一条线(离卡左边同样远)", !!nl && !!tl && Math.abs(nl.l - tl.l) <= 1, { note: nl, task: tl });
      step("S4 前置:待办卡的操作面开了", await openPanel(taskId));
      const P = `(()=>{const p=document.querySelector('#timeline article.card[data-id="${taskId}"] .panel');if(!p)return null;const bs=[...p.querySelectorAll(".acts button")];
        const probe=document.createElement("span");probe.style.cssText="color:var(--seal);background:var(--on-seal)";document.body.append(probe);const seal=getComputedStyle(probe).color,on=getComputedStyle(probe).backgroundColor;probe.remove();
        const c=bs[0]?getComputedStyle(bs[0]):null;const rb=bs[0]?bs[0].getBoundingClientRect():null;const hb=bs[0]?getComputedStyle(bs[0],"::before"):null;
        return {acts:bs.map(b=>b.dataset.pact),first:bs[0]?bs[0].textContent:null,filled:!!c&&c.backgroundColor===seal&&c.color===on,
          rows:new Set(bs.map(b=>Math.round(b.getBoundingClientRect().top))).size,zone:rb&&hb?bs[0].clientHeight-parseFloat(hb.top)-parseFloat(hb.bottom):0,
          zoneNext:bs[1]?bs[1].clientHeight-parseFloat(getComputedStyle(bs[1],"::before").top)-parseFloat(getComputedStyle(bs[1],"::before").bottom):0,
          shown:!!bs[0]&&bs[0].getClientRects().length>0,fits:bs.every(b=>b.getBoundingClientRect().right<=p.getBoundingClientRect().right+1)}})()`;
      const a = await evalJs(P);
      step("S4 操作面第一层最前面是「完成」(主色实底),整排:完成 / 编辑 / 标签 / 更多…,一排放得下", !!a && a.shown && a.first === "完成" && a.filled && J(a.acts) === J(["complete", "edit", "tags", "more"]) && a.rows === 1 && a.fits, a);
      // 这一排的触区 = 钮的内盒 + 上下各 5 的 halo(index.html `.panel .acts button::before`);这台标准字号下量到 43.3(整排如此,906 之前就是)
      // ⇒ 这里判的是「完成」与同排别的钮同一身触区、没被做小,不另立一个它够不着的数。
      step("S4 「完成」钮的触区与同排别的钮一样高(内盒 + 上下 halo;> 40)", !!a && a.zone > 40 && Math.abs(a.zone - a.zoneNext) < 0.5, a);
      await snap("S4-panel");
      const st0 = (await inv("list_tasks")).find((x) => x.id === taskId)?.status;
      await clearBar();
      const n = await tap(`document.querySelector('#timeline article.card[data-id="${taskId}"] .panel [data-pact="complete"]')`, `document.querySelector('#timeline article.card[data-id="${taskId}"]')?.classList.contains("done")`);
      const row = (await inv("list_timeline")).find((x) => x.id === taskId);
      step("S4 真点「完成」⇒ 写进库(换到完成列、盖了完成时刻)", n > 0 && !!row && row.stage !== st0 && row.done_at !== null, { tapTry: n, st0, stage: row?.stage, done_at: row?.done_at });
      const bar = await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&e.textContent.includes("已完成")?{acts:[...e.querySelectorAll(".bar-act")].map(b=>b.textContent)}:false})()`, 4000);
      step("S4 回执「已完成」带「撤销」,操作面跟着收了", !!bar && bar.acts.includes("撤销") && (await evalJs(`document.querySelector("#timeline .panel")===null`)), bar);
      const DONE = `(()=>{const c=document.querySelector('#timeline article.card[data-id="${taskId}"]');if(!c)return null;const cs=getComputedStyle(c.querySelector(".content"),"::before");
        const probe=document.createElement("span");probe.style.color="var(--seal)";document.body.append(probe);const seal=getComputedStyle(probe).color;probe.remove();
        return {done:c.classList.contains("done"),mark:cs.content,sealInk:cs.color===seal,tick:!!c.querySelector(".tick")}})()`;
      const dn = await evalJs(DONE);
      step("S4 已完成的卡:正文前带朱砂 ✓、没有圆圈", !!dn && dn.done && /✓/.test(dn.mark) && dn.sealInk && !dn.tick, dn);
      await snap("S4-done");
      const undo = await evalJs(`(()=>{const b=[...document.querySelectorAll("#error .bar-act")].find(b=>b.textContent==="撤销");if(!b)return false;b.click();return true})()`);
      const backTo = await until(`window.__TAURI_INTERNALS__.invoke("list_tasks",{spaceId:"main"}).then(l=>(l.find(x=>x.id===${J(taskId)})||{}).status===${J(st0)})`, 5000);
      step("S4 点「撤销」⇒ 回到原来那一列", undo && !!backTo, { undo, st0 });
      await clearBar();
      // 已完成的卡的操作面(回执那 6 秒不等人 ⇒ 这一张直调命令再完成一次、重载后看)
      await inv("complete_task", { id: taskId });
      await reload();
      await mode("tasks");
      step("S4 前置:已完成那张的操作面开了", await openPanel(taskId));
      const d = await evalJs(P);
      step("S4 已完成的卡不出「完成」;留言回到第三枚;「列」那枚在(挪回去走它)", !!d && J(d.acts) === J(["edit", "tags", "comment", "more"]) && (await evalJs(`document.querySelector('#timeline article.card[data-id="${taskId}"] .panel [data-pact="status"]')!==null`)), d);
      await back(); // 收操作面
      // 纯分类看板(没有完成列)/ 收容区里的卡不出「完成」:这台的默认空间里有那样的卡才判
      const boards = await inv("list_boards").catch(() => []);
      const cols = await inv("list_board_columns").catch(() => []);
      const noDone = new Set(boards.filter((b) => b.done === null || b.done === undefined).map((b) => b.id));
      const plainCols = new Set(cols.filter((c) => noDone.has(c.board_id ?? c.boardId)).map((c) => c.id));
      const plain = (await inv("list_tasks")).find((x) => plainCols.has(x.status));
      if (!plain) step("S4 纯分类看板的卡不出「完成」(这台默认空间里没有没有完成列的看板上的卡 ⇒ 没得验;multiboard ③ 守)", "skip", { boards: boards.length, noDone: noDone.size });
      else {
        await evalJs(`(()=>{const b=document.querySelector('#filter-boards [data-board="${plain.board_id ?? ""}"]');if(b)b.click();return 1})()`);
        await sleep(500);
        if (await openPanel(plain.id)) step("S4 纯分类看板的卡不出「完成」", await evalJs(`document.querySelector('#timeline .panel [data-pact="complete"]')===null`));
        else step("S4 纯分类看板的卡不出「完成」(那张卡这会儿不在屏上,没验)", "skip");
        await back();
      }
    }

    // ── S3 设置首页瘦身 ────────────────────────────────────────────────────────
    {
      const HOME = `(()=>{const vis=e=>!!e&&e.getClientRects().length>0;const home=document.getElementById("settings-pane");
        const R=e=>{const b=e.getBoundingClientRect();return {t:b.top,b:b.bottom,h:b.height}};
        const rows=[...home.querySelectorAll(".set-row")].filter(vis);
        return {home:vis(home),y:Math.round(scrollY),h2:[...home.querySelectorAll("h2")].filter(vis).map(h=>h.textContent),
          rows:rows.map(r=>r.querySelector(".set-name").textContent),rowH:rows.length?Math.min(...rows.map(r=>R(r).h)):0,
          sums:Object.fromEntries(rows.map(r=>[r.querySelector(".set-name").textContent,(()=>{const x=r.querySelector(".set-sum");return x&&vis(x)?x.textContent:null})()])),
          feedback:vis(document.getElementById("feedback-mail"))&&home.contains(document.getElementById("feedback-mail"))&&vis(document.getElementById("feedback-copy")),
          heavy:["compress-seg","remind-seg","alias-input","backup-body","about","update-check"].filter(id=>vis(document.getElementById(id))),
          pages:[...document.querySelectorAll(".set-page")].filter(vis).map(p=>p.id),max:document.scrollingElement.scrollHeight-innerHeight}})()`;
      const openSettings = async () => {
        if (await evalJs(`document.body.classList.contains("pane-open")`)) {
          await click(`#bottombar [data-mode="ideas"]`);
          await until(`!document.body.classList.contains("pane-open")`, 3000);
        }
        await click("#settings-toggle");
        await until(`!document.getElementById("settings-pane").hidden`, 3000);
        await sleep(900); // 摘要里异步那几样(别名 / 备份 / 版本)
      };
      const enter = async (page, name) => {
        const n = await tap(`[...document.querySelectorAll("#settings-pane .set-row")].find(r=>r.querySelector(".set-name").textContent===${J(name)})`, `!document.getElementById(${J(page)}).hidden`);
        await sleep(500);
        return n;
      };
      await openSettings();
      const h = await evalJs(HOME);
      const wantH2 = OHOS ? ["设置", "外观", "语言", "意见反馈"] : ["设置", "外观", "界面字号", "语言", "意见反馈"];
      const wantRows = OHOS ? ["空间", "压缩大图", "本机别名", "备份", "关于", "诊断"] : ["空间", "压缩大图", "截止提醒", "本机别名", "备份", "关于", "诊断"];
      step("S3 首页只剩这几节:设置 / 外观 / 界面字号 / 语言 / 意见反馈", J(h.h2) === J(wantH2), h.h2);
      step("S3 其余各收成一行入口,次序:空间 / 压缩大图 / 截止提醒 / 本机别名 / 备份 / 关于 / 诊断", J(h.rows) === J(wantRows), h.rows);
      step("S3 入口行高 ≥ 48", h.rowH >= 48, { rowH: h.rowH });
      step("S3 意见反馈留在首页看得见(地址框 + 复制钮)", h.feedback, h);
      step("S3 重的那几节不在首页上(压缩 / 提醒 / 别名 / 备份 / 关于 / 检查更新)", h.heavy.length === 0 && h.pages.length === 0, h);
      const ver = await evalJs(`window.__TAURI__.app.getVersion()`);
      const bst = await evalJs(`window.__TAURI_INTERNALS__.invoke("backup_status").catch(()=>null)`);
      step("S3 摘要:空间写个数、关于写版本号", h.sums["空间"] === `${spaceN} 个` && h.sums["关于"] === `v${ver}`, h.sums);
      step("S3 摘要:压缩大图是「开 / 关」", ["开", "关"].includes(h.sums["压缩大图"]), h.sums);
      if (!OHOS) step("S3 摘要:截止提醒是「每天 HH:MM」或「关着」", /^每天 \d\d:\d\d$/.test(h.sums["截止提醒"] ?? "") || h.sums["截止提醒"] === "关着", h.sums);
      step(
        "S3 摘要:备份没设置过写「还没设置」;设置过写「上次 MM-DD HH:MM」或不写(⛔ 不编)",
        bst && bst.configured === false && !bst.problem && !bst.blocked && !OHOS ? h.sums["备份"] === "还没设置" : h.sums["备份"] === "" || /^上次 \d\d-\d\d \d\d:\d\d$/.test(h.sums["备份"] ?? ""),
        { sum: h.sums["备份"], bst },
      );
      await snap("S3-home");
      // 压缩大图:进二级页拨一下,回首页摘要跟着变;页头那枚「设置」回首页
      compress0 = h.sums["压缩大图"];
      step("S3 真点「压缩大图」⇒ 进它那一页(首页收起、从页顶开始)", (await enter("set-compress", "压缩大图")) > 0 && (await evalJs(`document.getElementById("settings-pane").hidden&&scrollY===0&&document.getElementById("compress-seg").getClientRects().length>0`)));
      const flip = compress0 === "开" ? "off" : "on";
      await click(`#compress-seg [data-compress="${flip}"]`);
      await snap("S3-compress");
      const bn = await tap(`document.querySelector("#set-compress [data-set-back]")`, `!document.getElementById("settings-pane").hidden`);
      await sleep(500);
      const h2 = await evalJs(HOME);
      step("S3 页头那枚「设置」⇒ 回首页", bn > 0 && h2.home && h2.pages.length === 0, { tapTry: bn, pages: h2.pages });
      step("S3 回首页后压缩大图的摘要跟着刚才那一拨变了", h2.sums["压缩大图"] === (flip === "on" ? "开" : "关"), h2.sums);
      await evalJs(`(()=>{document.querySelector('#compress-seg [data-compress="${compress0 === "开" ? "on" : "off"}"]').click();return 1})()`);
      compress0 = null;
      // 滚到底 → 进「关于」→ 返回键回首页、回到进去前的位置
      await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=se.scrollHeight;return 1})()`);
      await sleep(400);
      const y0 = await evalJs(`Math.round(scrollY)`);
      if (y0 <= 20) step("S3 「回到进去前的滚动位置」:这台上设置首页一屏放得下、滚不动(空测,不判)", "skip", { y0, max: h.max });
      else {
        await enter("set-about", "关于");
        const ab = await evalJs(`({top:scrollY===0,kv:document.getElementById("about").textContent,home:!document.getElementById("settings-pane").hidden})`);
        step("S3 「关于」那一页:从页顶开始、版本号在", ab.top && ab.kv.includes(`v${ver}`) && !ab.home, ab);
        await snap("S3-about");
        await back();
        const r = await evalJs(HOME);
        step("S3 真按返回键 ⇒ 回设置首页、回到进去前的滚动位置,app 还在前台", r.home && Math.abs(r.y - y0) <= 2 && r.pages.length === 0 && (await foreground()), { y0, y: r.y });
        // 「关于」里那枚「意见反馈」链接:回首页并把那一节摆进屏内
        await enter("set-about", "关于");
        await click("#about-feedback-link");
        await sleep(500);
        const fb = await evalJs(`(()=>{const t=document.getElementById("feedback-title").getBoundingClientRect();return {home:!document.getElementById("settings-pane").hidden,inView:t.top>=0&&t.top<innerHeight}})()`);
        step("S3 「关于」里点「意见反馈」⇒ 回首页、那一节在屏内", fb.home && fb.inView, fb);
      }
      // 备份页进得去、那一节画出来了
      await enter("set-backup", "备份");
      const bk = await until(`(()=>{const b=document.getElementById("backup-body");return b.getClientRects().length>0&&b.textContent.trim()!==""&&!b.textContent.includes("读取中")?b.textContent.slice(0,40):false})()`, 6000);
      step("S3 「备份」那一页进得去、那一节画出来了", !!bk, { bk });
      const rows = await evalJs(`[...document.querySelectorAll("#backup-list .bkup-item")].map(r=>({file:r.querySelector(".bkup-item-file"),n:r.querySelector(".bkup-item-name").textContent})).map(x=>({n:x.n,fileShown:!!x.file&&!x.file.hidden}))`);
      if (rows.length === 0) step("S3 备份列表行:文件名平时收着(这台没挑文件夹 / 没有备份 ⇒ 没有行可验)", "skip");
      else step("S3 备份列表行:文件名平时收着", rows.every((x) => !x.fileShown), rows);
      await snap("S3-backup");
      await back();
      step("S3 备份页按返回键 ⇒ 回设置首页", await evalJs(`!document.getElementById("settings-pane").hidden`));
      // 903:设置再打开从最上面开始
      await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=se.scrollHeight;return 1})()`);
      await sleep(300);
      await click("#settings-toggle"); // 收
      await sleep(400);
      await click("#settings-toggle"); // 再开
      await sleep(600);
      step("S3 设置收了再打开 ⇒ 从最上面开始(903 那条照旧)", await evalJs(`!document.getElementById("settings-pane").hidden&&scrollY===0`));
      await click("#settings-toggle");
      await sleep(400);
    }
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    try {
      await clearBar();
      await evalJs(`(()=>{const c=document.getElementById("confirmbar");if(!c.hidden)document.getElementById("confirmbar-no").click();return 1})()`).catch(() => 0);
      if (compress0 !== null) await evalJs(`(()=>{document.querySelector('#compress-seg [data-compress="${compress0 === "开" ? "on" : "off"}"]').click();return 1})()`).catch(() => 0);
      const tl = await inv("list_timeline");
      const ids = new Set([...made, ...tl.filter((d) => String(d.content).includes(M)).map((d) => d.id)]);
      for (const id of ids) {
        for (const c of ["archive_task", "purge_task", "archive_note", "purge_note"]) await inv(c, { id }).catch(() => null);
      }
      const all = await inv("list_topics_full").catch(() => []);
      for (const tp of all.filter((x) => String(x.title).includes(M))) await inv("delete_topic", { id: tp.id }).catch(() => null);
      const left = {
        timeline: (await inv("list_timeline")).filter((x) => String(x.content).includes(M)).length,
        trash: (await inv("list_trash")).filter((x) => String(x.content).includes(M)).length,
        topics: (await inv("list_topics_full")).filter((x) => String(x.title).includes(M)).length,
      };
      step("清场:时间轴 / 回收站 / 标签都没有种子", left.timeline + left.trash + left.topics === 0, left);
      await evalJs(`(()=>{const v=${J(tags0)};if(v===null)localStorage.removeItem(${J(TAGS_KEY)});else localStorage.setItem(${J(TAGS_KEY)},v);return 1})()`);
      if (startSpace && startSpace !== "main") await toSpace(startSpace);
      else {
        await evalJs(`(()=>{location.reload();return 1})()`).catch(() => 1);
        await sleep(2500);
      }
      step("收尾:回到起跑时的空间、本机开关还原", !!(await until(`document.getElementById("gate").hidden`, 10000)) && (await evalJs(`localStorage.getItem(${J(TAGS_KEY)})`)) === tags0);
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
