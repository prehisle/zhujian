// 手机 T 组(907,907 观感巡检挑出、用户 2026-11-13 晚逐条拍板的十六条)的真机回归网。每条至少一格量几何 / 计算样式:
//   T1  五座屏底层收着时不带影(不漏回屏内压着底栏);开着时有影。
//   T2  收起态标签行只露整枚的钮(不许半截),「更多 N」的 N 对得上,过滤框照旧贴右。
//   T3  筛选条吸顶后药丸顶离顶栏底线仍有缝(静止 10、吸顶 6–10)。
//   T4  覆盖面 / 卡内输入框聚焦是应用自己的样子(没有引擎那圈框、边框朱砂)。
//   T5  带清单的卡:普通正文行与没清单的卡同一行距;清单行仍是 2.2、勾选触区不变小;方框与那一行字的中线对齐。
//   T6  英文档:选中的那一列整枚露在「列」那一排清楚的那一段里(不被挤出屏、不压在淡出里),「Column」也在。
//   T7  操作面第二排「列 / 截止 / 优先级」排进一行(字号 ≥ 12、触区没变小)。
//   T8  子面的「返回」是这一排最前面一枚画出来的小「‹」(读屏名「返回」、触区 44 × 44、不单占一行);真点 / 返回键都回主面。
//   T9  面板里的钮是全圆药丸;单字钮不是正圆小球。
//   T10 操作回执是深墨底(暗档翻面成浅底深字)、「撤销」可辨;出错的红条不变。
//   T11 各面顶上没有虚线;页标题 ≥ 17px 墨色加粗;设置首页节标题仍是小灰字。
//   T12 标签面:行右边只写总数 + 「›」(0 只留「›」),读屏名是完整说法;长名字一行省略。
//   T13 ① 空间 / 诊断两页有「‹ 设置」页头;② 搜索结果的标签带色点(同时间轴卡脚);③ 设置首页「说明」到入口列表的间距;
//       ④ 看大图层两钮等高、同中线;⑤ 关于页各行同一节奏。
// 驱动形(真点、真按返回键;CDP 摆前置、读状态、量几何)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-t.mjs                      # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-t.mjs --shots <目录>        # 关键几拍各截一张真屏(亮 / 暗 / 英)
//   node scripts/cdp-acceptance-picks-t.mjs --ohos               # 鸿蒙真机(返回键走 hdc、截图走 CDP)
//   node scripts/cdp-acceptance-picks-t.mjs --stand              # 宽屏截图台(ui-shots-wide --keep 的 :9245;WebView2,按 360×800 摆;
//                                                                #   返回键走页内入口、不问前台)—— 只为写这支时快跑,⛔ 不算真机结论
//   PICKST_KNIFE=all node scripts/cdp-acceptance-picks-t.mjs      # 阴性对照:页内注入一张把十六条逐条改回去的样式表
//     ⇒ 名字里带「〔刀〕」的格应当全红(「〔刀〕」= 这一格的判据吃得到那把刀;不带的是行为格 / 前置 / 自证)。
//       不带「〔刀〕」的里头有五格会被连带打红,是刀的后果、不是判据松:T10「撤销钮可辨」(bar 那把把条身换回绿)、
//       T13②「对照」(dots)、T13①「真点 ‹ 设置回首页 / 同步 → 空间 / 点它回同步」(sub 那把把钮藏了,点不着)。
//     也可以单下一把:PICKST_KNIFE=sheets|tags|sticky|focus|lines|props|back|shape|bar|head|topics|sub|dots|gap|viewer|about
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面。⚠ 从**刚拉起**的 app 上跑(905:真返回键那几格)。
// 会写库:只写**默认空间**(main)—— 10 枚标签、13 张待办、4 条随记(一条改过、一条进回收站),名字 / 正文都带 `PICKST` 记号;
//   收尾 archive → purge、标签 delete,并自证零残留。起跑时人在别的空间就切到 main 跑,跑完切回。
//   本机开关(标签行摊没摊开、明暗、语言)用前读、用后还。
// 诚实边界:
//  ① 刀都是页内注入的 CSS:证的是「判据真看几何 / 计算样式」,不是「删掉那几行源码会红」。T6(滚进视野是 JS)没有 CSS 刀,
//     那一格自带一趟反证:把那一排手动滚回开头 ⇒ 判据当场不成立,再重画 ⇒ 又成立。
//  ② T13④ 看大图层是把层临时摆出来量两枚钮(不真开一张图:播种不带图);层的开合手势不在本支(cdp-acceptance-android-viewer-close.js)。
//  ③ T4 判的是 `:focus` 那一刻的计算样式;暗档只换令牌、不换规则,没另跑一遍。
//  ④ T2 的「不许半截」按标签行歇在开头、没选着标签时判(选着某枚标签时这一行会横滚到它,那时不裁,见 main.ts syncTagsToggle)。
//  ⑤ T8「移动」子面要 ≥ 2 个空间、「挪到看板」要 ≥ 2 块看板才出得来:这台没有就记 SKIPPED(同形同一个 backBtn)。长文阅读页那两枚不在本支。
//  ⑥ 横放 / 平板的样子不在本支(board-wide / wide-engine 在截图台上守)。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const OHOS = process.argv.includes("--ohos");
const STAND = process.argv.includes("--stand");
const HDC = process.env.HDC ?? "G:/ohos-sdk/toolchains/hdc.exe";
const shell = async (...a) => {
  if (!OHOS) return (await adb(["shell", ...a])).stdout.trim();
  if (a.join(" ") === "input keyevent 4") return (await execFileAsync(HDC, ["shell", "uitest uiInput keyEvent Back"], { encoding: "utf8" })).stdout.trim();
  throw new Error(`--ohos 下没有这条设备命令:${a.join(" ")}`);
};
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.PICKST_KNIFE ?? null;
const M = "PICKST";
const TAGS_KEY = "zhujian.filter-tags-open";
const THEME_KEY = "zhujian.theme";
const LANG_KEY = "zhujian.lang";
const LONG = `${M}一个特别特别特别长的标签名字用来看标签页那一行会不会一行省略掉后面的字`;

// 每把刀 = 把那一条改回去的样式(页内注入)。
const KNIVES = {
  sheets: ".compose:not(.open),.cmsheet:not(.open){box-shadow:0 -8px 28px rgba(0,0,0,.18)!important}",
  tags: "#filter-topics{flex:1 1 0!important}",
  sticky: "#filterbar{margin-top:0!important;padding-top:0!important}",
  focus: "input:focus,textarea:focus{outline:2px solid #000!important;border-color:#888!important}",
  lines: ".content:has(.ckbox){line-height:2.2!important}.ckbox{margin-top:.25em!important}",
  props: ".panel button.prop{padding:8px 22px!important;gap:9px!important}",
  back: ".panel button.pback{flex:0 0 100%!important}.panel button.pback::before{content:none!important}",
  shape: ".row button,.tn-edit button,.tk-edit button{border-radius:8px!important;min-width:0!important}",
  bar: ".error.notice{background:var(--ok)!important;color:var(--on-seal)!important}",
  head: ".sync{border-top:1px dashed var(--line-strong)!important}.sync>h2:first-of-type,.phead>h2{font-size:13px!important;color:var(--ink-soft)!important}",
  topics: ".tname{white-space:normal!important;overflow-wrap:anywhere!important}.tcount::after{content:none!important}",
  sub: "[data-sub-back]{display:none!important}",
  dots: "#search-results .chip::before{content:none!important}",
  gap: "details.notes:not([open])+.set-list{margin-top:22px!important}",
  viewer: ".viewer-del,.viewer-close{display:inline-block!important;min-height:0!important;line-height:normal!important}.viewer-close{min-height:40px!important}",
  about: "#about>.k,#about>.v{min-height:0!important}",
};
const knifeCss = KNIFE === null ? "" : KNIFE === "all" ? Object.values(KNIVES).join("\n") : (KNIVES[KNIFE] ?? "");
if (KNIFE !== null && knifeCss === "") throw new Error(`不认识的刀:${KNIFE}(可选:all / ${Object.keys(KNIVES).join(" / ")})`);

const out = { pass: false, knife: KNIFE, steps: [] };
process.exitCode = 2; // 转发没建好时连接永不兑现、node 会一声不响地以 0 退出 ⇒ 先垫一个非零,跑完由末尾改写
const lum = (rgb) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb ?? "");
  if (!m) return null;
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
};
const ratio = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return x === null || y === null ? 0 : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.error(`${ok === "skip" ? "SKIP" : ok ? "ok  " : "RED "} ${name}`);
    return !!ok;
  };
  const connect = async () => {
    const x = await openSession((await pageTarget(STAND ? 9245 : 9222)).webSocketDebuggerUrl, { timeoutMs: 30000 });
    if (STAND) {
      await x.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
      await x.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await x.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // 隐藏窗口没有焦点 ⇒ :focus 不套;台上补上
    }
    return x;
  };
  let s = await connect();
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
        s = await connect();
      }
    }
  };
  const J = (v) => JSON.stringify(v);
  // 页内公用小件:R = 盒子、tok = 令牌算出来的色、vis = 在不在屏上排着
  const PRE = `const R=e=>{const b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}};
    const tok=v=>{const p=document.createElement("i");p.style.cssText="display:none;color:var("+v+")";document.body.append(p);const c=getComputedStyle(p).color;p.remove();return c};
    const vis=e=>!!e&&e.getClientRects().length>0;`;
  const P = (body) => evalJs(`(()=>{${PRE}${body}})()`);
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
    if (OHOS || STAND) {
      const r = await s.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
      return;
    }
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };
  /** 真点一下(`Input.dispatchTouchEvent`)。坐标连读两拍相同才取;`done` 没成立就重取坐标再点一次,还不成立退到合成 click(538)。 */
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
    if (!knifeCss) return;
    await evalJs(`(()=>{if(document.getElementById("pickst-knife"))return 1;const st=document.createElement("style");st.id="pickst-knife";st.textContent=${J(knifeCss)};document.head.append(st);return 1})()`);
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
  const closePane = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await click(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
      await sleep(250);
    }
  };
  const mode = async (m) => {
    await closePane();
    if (!(await evalJs(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`))) {
      await click(`#bottombar [data-mode="${m}"]`);
      await until(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`, 3000);
      await sleep(400);
    }
  };
  const openPaneBy = async (toggleSel, paneId) => {
    await closePane();
    await click(toggleSel);
    await until(`!document.getElementById(${J(paneId)}).hidden`, 3000);
    await sleep(500);
  };
  const foreground = async () => OHOS || STAND || /app\.zhujian\.notebook/.test(await shell("dumpsys", "window", "|", "grep", "mCurrentFocus"));
  const back = async () => {
    if (STAND) await evalJs(`window.__zhujianHandleBack()`);
    else await shell("input", "keyevent", "4");
    await sleep(700);
  };
  const card = (id) => `document.querySelector('#timeline article.card[data-id="${id}"]')`;
  const openPanel = async (id) => {
    await evalJs(`(()=>{${card(id)}.scrollIntoView({block:"center"});return 1})()`);
    await sleep(400);
    if (!(await evalJs(`${card(id)}.querySelector(".panel")!==null`))) await tap(`${card(id)}.querySelector(".content")`, `${card(id)}.querySelector(".panel")!==null`);
    return evalJs(`${card(id)}.querySelector(".panel")!==null`);
  };
  const mainPanel = `document.querySelector('#timeline .panel [data-pact="more"]')!==null`;

  const spaces = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
  const startSpace = spaces.find((x) => x.current)?.id;
  const keep = {
    tags: await evalJs(`localStorage.getItem(${J(TAGS_KEY)})`),
    theme: await evalJs(`localStorage.getItem(${J(THEME_KEY)})`),
    lang: await evalJs(`localStorage.getItem(${J(LANG_KEY)})`),
  };
  const made = [];
  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    if (!step("前置:竖屏", await evalJs(`innerWidth < innerHeight`))) return;
    if (startSpace !== "main") await toSpace("main");
    // ── 播种 ───────────────────────────────────────────────────────────────────
    const tids = [];
    for (let i = 1; i <= 8; i++) {
      const tid = await inv("create_topic", { title: `${M}签${i}` });
      tids.push(tid);
      made.push(await inv("create_task", { title: `${M}-挂签待办${i}`, dueOn: null, priority: null, topicId: tid }));
    }
    await inv("set_topic_color", { id: tids[0], color: "#3f7a99" });
    const longTid = await inv("create_topic", { title: LONG });
    await inv("create_topic", { title: `${M}空签` });
    const today = new Date();
    const propId = await inv("create_task", { title: `${M}-属性待办`, dueOn: ymd(new Date(today.getTime() + 40 * 864e5)), priority: 3, topicId: null });
    const ckId = await inv("create_task", { title: `${M}-清单卡\n第二行普通字\n- [ ] 没勾的\n- [x] 勾了的\n尾巴一行`, dueOn: null, priority: null, topicId: null });
    const lateId = await inv("create_task", { title: `${M}-逾期的`, dueOn: ymd(new Date(today.getTime() - 864e5)), priority: null, topicId: null });
    // 今天到期 + 两天后到期各一张:到期汇总钮写满三段(英文档「1 overdue · 1 today · 1 within 3d」),T6 那一排才放不下
    made.push(await inv("create_task", { title: `${M}-今天到期`, dueOn: ymd(today), priority: null, topicId: null }));
    made.push(await inv("create_task", { title: `${M}-后天到期`, dueOn: ymd(new Date(today.getTime() + 2 * 864e5)), priority: null, topicId: null }));
    const plainId = await inv("capture_idea", { content: `${M}-两行随记\n第二行` });
    const revId = await inv("capture_idea", { content: `${M}-改过的随记 初版` });
    await inv("edit_note", { id: revId, content: `${M}-改过的随记 改过` });
    const longNote = await inv("capture_idea", { content: `${M}-挂长名标签的随记` });
    await inv("file_note_to_topic", { id: longNote, topicId: longTid, newTitle: null });
    const binId = await inv("capture_idea", { content: `${M}-进回收站` });
    await inv("archive_note", { id: binId });
    made.push(propId, ckId, lateId, plainId, revId, longNote, binId);
    await reload({ [TAGS_KEY]: "0", [THEME_KEY]: "light" });
    await clearBar();

    // ── T1 屏底层收着时不带影 ───────────────────────────────────────────────────
    await sleep(450); // 影子的有无带 0.22s 过渡(刀刚注进去那一下也是)⇒ 等它走完再量
    {
      const SHEETS = `return ["compose-card","edit-sheet","date-sheet","more-sheet","comments-sheet"].map(id=>{const e=document.getElementById(id);const cs=getComputedStyle(e);const r=R(e);
        const m=/(-?[\\d.]+)px\\s+(-?[\\d.]+)px\\s+(-?[\\d.]+)px/.exec(cs.boxShadow);const reach=cs.boxShadow==="none"||!m?0:Math.max(0,parseFloat(m[3])-parseFloat(m[2]));
        return {id,open:e.classList.contains("open"),shadow:cs.boxShadow==="none"?"none":"有",top:r.t,leak:r.t-reach<innerHeight-0.5}})`;
      const a = await P(SHEETS);
      step("T1〔刀〕五座屏底层都收着、没有一座的影子探回屏内(影子上沿 ≥ 视口底)", a.length === 5 && a.every((x) => !x.open && !x.leak), a);
      await snap("T1-bottom-light");
    }

    // ── T2 标签行收起态只露整枚 ─────────────────────────────────────────────────
    await mode("tasks");
    {
      const ROW = `const tp=document.getElementById("filter-topics"),btn=document.getElementById("filter-expand"),ft=document.getElementById("filter-text"),fb=document.getElementById("filterbar");
        const kids=[...tp.children].filter(k=>k.offsetWidth>0);const pills=kids.filter(k=>k.classList.contains("fpill"));const tr=R(tp);const edge=tr.l+tp.clientWidth;
        const part=e=>{const r=R(e);return r.l<edge-1&&r.r>edge+1};const outside=e=>R(e).l>=edge-1;
        const keepFlex=tp.style.flex;tp.style.flex="1 1 0";const e0=tp.getBoundingClientRect().left+tp.clientWidth;const natural=kids.filter(k=>{const r=k.getBoundingClientRect();return r.left<e0-1&&r.right>e0+1}).length;tp.style.flex=keepFlex;
        return {sl:tp.scrollLeft,text:btn.textContent,hidden:btn.hidden,cutCls:fb.classList.contains("tags-cut"),open:fb.classList.contains("tags-open"),
          partial:kids.filter(part).map(k=>k.textContent),whole:pills.filter(k=>!part(k)&&!outside(k)).length,out:pills.filter(outside).length,pills:pills.length,
          seeded:pills.filter(p=>p.textContent.includes(${J(M)})).length,natural,btnGap:R(btn).l-tr.r,ftR:R(ft).r,mainR:R(ft.parentElement).r,
          fade:getComputedStyle(tp).webkitMaskImage||getComputedStyle(tp).maskImage}`;
      const a = await P(ROW);
      step("T2 前置:播种的 8 枚标签都在标签行里、收起态、钮在、行歇在开头", a.seeded === 8 && !a.open && !a.hidden && a.sl === 0, a);
      if (a.natural === 0 && a.partial.length === 0) step("T2 自证:不裁的话行尾正好有一枚半截的(这台上行宽恰好卡在缝里 ⇒ 下一格是空测)", "skip", a);
      else step("T2 自证:不裁的话行尾有半截的钮(这一格才不是空测)", a.natural >= 1 || a.partial.length >= 1, { natural: a.natural, partial: a.partial });
      step("T2〔刀〕收起态标签行里没有半截的钮(每一枚要么整枚露着、要么整枚不露)", a.partial.length === 0 && a.whole >= 1, a);
      const m = /^更多 (\d+)▾$/.exec(a.text ?? "");
      step("T2 「更多 N」的 N = 没露出来的枚数(另量一遍,≥ 1)", !!m && Number(m[1]) === a.out + a.partial.length && Number(m[1]) >= 1, { text: a.text, out: a.out, partial: a.partial.length });
      step("T2 「更多 N」紧跟在标签行后面(缝 ≤ 12),过滤框贴主行右端", a.btnGap >= 0 && a.btnGap <= 12 && Math.abs(a.ftR - a.mainR) <= 1.5, a);
      await snap("T2-tags-collapsed");
      // 选着一枚标签时不裁:选中那枚整枚在行里(摊开 → 点第 7 枚 → 收回单行)
      await tap(`document.getElementById("filter-expand")`, `document.getElementById("filterbar").classList.contains("tags-open")`);
      await sleep(300);
      await tap(`[...document.querySelectorAll("#filter-topics .fpill")].find(p=>p.textContent.includes(${J(`${M}签7`)}))`, `!document.getElementById("filterbar").classList.contains("tags-open")`);
      await sleep(400);
      const b = await P(`const tp=document.getElementById("filter-topics");const a=tp.querySelector(".fpill.active[data-topic-id]");if(!a)return null;const r=R(a),tr=R(tp);return {text:a.textContent,inRow:r.l>=tr.l-1&&r.r<=tr.l+tp.clientWidth+1,cut:document.getElementById("filterbar").classList.contains("tags-cut")}`);
      step("T2 选着一枚标签时:选中那枚整枚在这一行里(这一态不裁)", !!b && b.text.includes(`${M}签7`) && b.inRow && !b.cut, b);
      await evalJs(`(()=>{[...document.querySelectorAll("#filter-topics .fpill")].find(p=>!p.dataset.topicId).click();return 1})()`);
      await sleep(300);
      await evalJs(`(()=>{localStorage.setItem(${J(TAGS_KEY)},"0");return 1})()`);
      await reload({ [TAGS_KEY]: "0" });
      await mode("tasks");
    }

    // ── T3 吸顶后药丸离顶栏线有缝 ───────────────────────────────────────────────
    {
      const GAP = `const h=R(document.querySelector("body>header"));const fb=document.getElementById("filterbar");const p=[...fb.querySelectorAll(".fpill")].find(vis);
        return {gap:R(p).t-h.b,barTop:R(fb).t-h.b,y:scrollY,max:document.scrollingElement.scrollHeight-innerHeight}`;
      await evalJs(`(window.scrollTo(0,0),1)`);
      await sleep(300);
      const a = await P(GAP);
      step("T3 静止态:第一排药丸顶离顶栏底线 10(±1)", Math.abs(a.gap - 10) <= 1, a);
      if (a.max < 120) step("T3 吸顶态(这台上任务页一屏放得下、滚不动 ⇒ 没得验)", "skip", a);
      else {
        await evalJs(`(window.scrollTo(0,Math.min(400,document.scrollingElement.scrollHeight-innerHeight)),1)`);
        await sleep(400);
        const b = await P(GAP);
        step("T3 自证:滚下去之后筛选条吸在顶栏下沿(条顶贴线)", b.y > 60 && Math.abs(b.barTop) <= 1, b);
        step("T3〔刀〕吸顶态:药丸顶离顶栏底线 6–10", b.gap >= 6 - 0.5 && b.gap <= 10 + 0.5, b);
        await snap("T3-sticky");
        await evalJs(`(window.scrollTo(0,0),1)`);
        await sleep(300);
      }
    }

    // ── T5 清单卡的行距 ─────────────────────────────────────────────────────────
    {
      // 一段正文里第 a 行与第 b 行(都是普通字)的行首字顶之差 = 行距;取含那几个字的文本节点量
      const PITCH = (id, first, second) => `const c=${card(id)}.querySelector(".content");const tw=document.createTreeWalker(c,NodeFilter.SHOW_TEXT);const top=s=>{tw.currentNode=c;for(let n=tw.nextNode();n;n=tw.nextNode()){const i=n.data.indexOf(s);if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);return r.getBoundingClientRect().top}}return null};
        const cs=getComputedStyle(c);return {pitch:top(${J(second)})-top(${J(first)}),fs:parseFloat(cs.fontSize),lh:parseFloat(cs.lineHeight)}`;
      await mode("ideas");
      const plain = await P(PITCH(plainId, `${M}-两行随记`, "第二行"));
      await mode("tasks");
      await evalJs(`(()=>{${card(ckId)}.scrollIntoView({block:"center"});return 1})()`);
      await sleep(350);
      const ck = await P(PITCH(ckId, `${M}-清单卡`, "第二行普通字"));
      step("T5〔刀〕带清单的卡:普通正文行的行距 = 没清单的卡(差 ≤ 0.5px;约 1.6 倍字号)", plain.pitch > 0 && Math.abs(ck.pitch - plain.pitch) <= 0.5 && ck.pitch < plain.fs * 1.9, { plain, ck });
      const L = await P(`const c=${card(ckId)};const ln=[...c.querySelectorAll(".ckline")];const b=ln[0].querySelector(".ckbox");const hb=getComputedStyle(b,"::before");const fs=parseFloat(getComputedStyle(ln[0]).fontSize);
        const hit=(x,y)=>document.elementFromPoint(x,y)===b;const rb=R(b),rl=R(ln[0]);
        return {n:ln.length,lineH:rl.h,fs,zoneH:parseFloat(hb.height),zoneW:parseFloat(hb.width),boxMid:(rb.t+rb.b)/2,lineMid:(rl.t+rl.b)/2,
          hits:[hit((rb.l+rb.r)/2,(rb.t+rb.b)/2),hit((rb.l+rb.r)/2,(rb.t+rb.b)/2-15),hit((rb.l+rb.r)/2,(rb.t+rb.b)/2+15),hit((rb.l+rb.r)/2+18,(rb.t+rb.b)/2)],
          pitch:R(ln[1]).t-rl.t}`);
      step("T5 清单行仍是 2.2 倍行距(行高 ≥ 触区 32),两项清单之间的行距也是它", L.n === 2 && L.lineH >= 32 && Math.abs(L.lineH - L.fs * 2.2) <= 1 && Math.abs(L.pitch - L.lineH) <= 1, L);
      step("T5 勾选触区没变小:40 × 32,上下左右打点都命中方框", L.zoneH >= 32 && L.zoneW >= 40 && L.hits.every(Boolean), L);
      step("T5〔刀〕方框与这一行字同一条中线(差 ≤ 1.5px)", Math.abs(L.boxMid - L.lineMid) <= 1.5, { boxMid: L.boxMid, lineMid: L.lineMid });
      await snap("T5-checklist-card");
    }

    // ── T7 属性那一排 ───────────────────────────────────────────────────────────
    step("T7 前置:带截止 + 优先级的待办的操作面开了", await openPanel(propId));
    {
      const a = await P(`const p=${card(propId)}.querySelector(".panel");const bs=[...p.querySelectorAll(".props button.prop")];const ac=p.querySelector(".acts button");
        const zone=b=>{const h=getComputedStyle(b,"::before");return b.clientHeight-parseFloat(h.top)-parseFloat(h.bottom)};
        return {keys:bs.map(b=>b.dataset.pact),rows:new Set(bs.map(b=>Math.round(R(b).t))).size,minFs:Math.min(...bs.flatMap(b=>[...b.querySelectorAll("span")].map(x=>parseFloat(getComputedStyle(x).fontSize)))),
          zone:Math.min(...bs.map(zone)),actZone:zone(ac),h:Math.min(...bs.map(b=>R(b).h)),fits:bs.every(b=>R(b).r<=R(p).r+1),sum:bs.reduce((w,b)=>w+R(b).w,0),room:R(p).w,
          clip:bs.some(b=>b.scrollWidth>b.clientWidth+1),texts:bs.map(b=>b.textContent)}`);
      step("T7〔刀〕「列 / 截止 / 优先级」三枚排在一行、都在面里", J(a.keys) === J(["status", "due", "prio"]) && a.rows === 1 && a.fits, a);
      step("T7 字号 ≥ 12、不截字,触区与上一排动作钮一样高(内盒 + 上下 halo;> 40)", a.minFs >= 12 && !a.clip && a.zone > 40 && a.zone >= a.actZone - 0.5, a);
      await snap("T7-props-row");
    }

    // ── T8 子面排头的「‹」──────────────────────────────────────────────────────
    {
      const BACK = `const p=document.querySelector("#timeline .panel");if(!p)return null;const b=p.querySelector('[data-pact="back"]');if(!b)return {none:true,btns:[...p.querySelectorAll("button")].map(x=>x.textContent)};
        const rb=R(b);const sib=b.nextElementSibling;const next=sib&&sib.classList.contains("pillrow")&&sib.firstElementChild?sib.firstElementChild:sib;const rn=next?R(next):null;const hb=getComputedStyle(b,"::before");const ha=getComputedStyle(b,"::after");
        const hit=(x,y)=>document.elementFromPoint(x,y)===b;const mx=(rb.l+rb.r)/2,my=(rb.t+rb.b)/2;
        const zw=hb.content==="none"?rb.w:rb.w-parseFloat(hb.left)-parseFloat(hb.right),zh=hb.content==="none"?rb.h:rb.h-parseFloat(hb.top)-parseFloat(hb.bottom);
        return {first:b.parentElement.firstElementChild===b,parent:b.parentElement.className,isFirstRow:b.parentElement===p.querySelector(".lane, .acts"),text:b.textContent,aria:b.getAttribute("aria-label"),
          w:rb.w,h:rb.h,icon:parseFloat(ha.width),mask:(ha.webkitMaskImage||ha.maskImage||"").includes("svg"),sameRow:!!rn&&Math.abs((rn.t+rn.b)/2-my)<=4&&rn.l>=rb.r-1,
          zw,zh,hits:[hit(mx,my),hit(rb.l-14,my),hit(rb.r+4,my),hit(mx,rb.t-16),hit(mx,rb.b+1)],
          worded:[...p.querySelectorAll("button")].filter(x=>x.textContent.trim()==="返回").length,fs:parseFloat(getComputedStyle(b).fontSize)}`;
      const judge = (name, a) => {
        step(`T8〔刀〕${name}:「返回」是这一排最前面一枚小「‹」—— 不单占一行(与后一枚同一行)、屏上没有「返回」两个字、读屏名「返回」`, !!a && !a.none && a.first && a.isFirstRow && a.sameRow && a.text === "" && a.worded === 0 && a.aria === "返回" && a.mask && a.icon <= 20 && a.w <= 28 && a.h <= 28, a);
        step(`T8〔刀〕${name}:「‹」的触区 ≥ 44 × 44,中心与四个方向探出去的点都命中它`, !!a && !a.none && a.zw >= 44 && a.zh >= 44 && a.hits.every(Boolean), a && { zw: a.zw, zh: a.zh, hits: a.hits });
      };
      const sub = async (pact, name, shot) => {
        if (!(await evalJs(mainPanel))) await openPanel(propId);
        await tap(`document.querySelector('#timeline .panel [data-pact="${pact}"]')`, `document.querySelector('#timeline .panel [data-pact="back"]')!==null`);
        await sleep(350);
        const a = await P(BACK);
        judge(name, a);
        if (shot) await snap(shot);
        return a;
      };
      await sub("status", "「列」子面", "T8-sub-status");
      const n1 = await tap(`document.querySelector('#timeline .panel [data-pact="back"]')`, mainPanel);
      step("T8 真点「‹」⇒ 回到两行主面", n1 > 0 && (await evalJs(mainPanel)), { tapTry: n1 });
      await sub("due", "「截止」子面", null);
      await back();
      step("T8 子面里真按返回键 ⇒ 回到两行主面(操作面还开着),app 还在前台", (await evalJs(mainPanel)) && (await foreground()));
      await sub("prio", "「优先级」子面", null);
      await click(`#timeline .panel [data-pact="back"]`);
      await sleep(250);
      await sub("tags", "「标签」子面", "T8-sub-tags");
      // T4 顺路:卡内「新标签名」框聚焦
      const tg = await P(`const i=document.querySelector("#timeline .panel input.tagnew");if(!i)return null;i.focus();const cs=getComputedStyle(i);const r={focused:document.activeElement===i,outline:cs.outlineStyle,ow:parseFloat(cs.outlineWidth),border:cs.borderTopColor,seal:tok("--seal")};i.blur();return r`);
      step("T4〔刀〕卡内「新标签名」框聚焦:没有引擎那圈框、边框朱砂", !!tg && tg.focused && (tg.outline === "none" || tg.ow === 0) && tg.border === tg.seal, tg);
      await sleep(400);
      await click(`#timeline .panel [data-pact="back"]`);
      await sleep(250);
      step("T8 标签子面点「‹」⇒ 回主面", await evalJs(mainPanel));

      // ── T10 回执条(顺着这张卡点「完成」)──────────────────────────────────────
      await clearBar();
      await tap(`${card(propId)}.querySelector('.panel [data-pact="complete"]')`, `${card(propId)}?.classList.contains("done")`);
      const BAR = `const e=document.getElementById("error");if(e.hidden)return null;const cs=getComputedStyle(e);const a=e.querySelector(".bar-act");const ca=a?getComputedStyle(a):null;
        const d=document.createElement("div");d.className="error";d.style.cssText="position:absolute;left:-9999px;top:-9999px";d.textContent="x";document.body.append(d);const red=getComputedStyle(d).backgroundColor;d.remove();
        return {cls:e.className,text:e.textContent,bg:cs.backgroundColor,fg:cs.color,act:ca?ca.color:null,actBorder:ca?ca.borderTopColor:null,actW:ca?parseFloat(ca.borderTopWidth):0,
          ink:tok("--ink"),paper:tok("--paper"),ok:tok("--ok"),seal:tok("--seal"),page:getComputedStyle(document.body).backgroundColor,red}`;
      const bar = await until(`(()=>{const e=document.getElementById("error");return !e.hidden&&e.textContent.includes("已完成")})()`, 4000);
      const a = bar ? await P(BAR) : null;
      step("T10 前置:点「完成」出了回执(notice 形、带「撤销」)", !!a && /notice/.test(a.cls) && a.text.includes("撤销"), a);
      step("T10〔刀〕亮档回执:深墨底(= --ink,不是绿)、纸色字,字压底 ≥ 7:1,条与页面底色分得开(≥ 3:1)", !!a && a.bg === a.ink && a.bg !== a.ok && a.fg === a.paper && ratio(a.fg, a.bg) >= 7 && ratio(a.bg, a.page) >= 3, a && { bg: a.bg, fg: a.fg, text: ratio(a.fg, a.bg), vsPage: ratio(a.bg, a.page) });
      step("T10 「撤销」钮可辨:描边 ≥ 1px、描边与字压条身 ≥ 7:1", !!a && a.actW >= 0.9 && ratio(a.act, a.bg) >= 7 && ratio(a.actBorder, a.bg) >= 7, a && { act: a.act, border: a.actBorder });
      step("T10 出错的红条没变(裸 .error 仍是朱砂底)", !!a && a.red === a.seal, a && { red: a.red, seal: a.seal });
      await snap("T10-receipt-light");
      await evalJs(`(document.documentElement.dataset.theme="dark",1)`);
      await sleep(250);
      const d = await P(BAR);
      step("T10〔刀〕暗档回执:浅底深字(同一对令牌翻面),字压底 ≥ 7:1,条与页面底色分得开(≥ 3:1)", !!d && d.bg === d.ink && d.fg === d.paper && lum(d.bg) > lum(d.fg) && ratio(d.fg, d.bg) >= 7 && ratio(d.bg, d.page) >= 3, d && { bg: d.bg, fg: d.fg, text: ratio(d.fg, d.bg), vsPage: ratio(d.bg, d.page) });
      await snap("T10-receipt-dark");
      await evalJs(`(document.documentElement.dataset.theme="light",1)`);
      const undo = await evalJs(`(()=>{const b=[...document.querySelectorAll("#error .bar-act")].find(b=>b.textContent==="撤销");if(!b)return false;b.click();return true})()`);
      step("T10 点「撤销」⇒ 那张回到没完成", undo && !!(await until(`!${card(propId)}?.classList.contains("done")&&${card(propId)}!==null`, 5000)));
      await clearBar();
      if (await evalJs(`document.querySelector("#timeline .panel")!==null`)) await back();

      // 历史 / 移动 / 挪到看板(走「更多…」菜单进)
      await mode("ideas");
      const viaMore = async (id, label, name, shot) => {
        if (!(await openPanel(id))) return step(`T8 ${name}(操作面没开成)`, false);
        await tap(`document.querySelector('#timeline .panel [data-pact="more"]')`, `document.getElementById("more-sheet").classList.contains("open")`);
        await sleep(500);
        const has = await evalJs(`[...document.querySelectorAll("#more-list .ms-item")].some(b=>b.textContent===${J(label)})`);
        if (!has) {
          await back();
          return step(`T8 ${name}(这台上菜单里没有「${label}」⇒ 没得验;同一个 backBtn)`, "skip");
        }
        await tap(`[...document.querySelectorAll("#more-list .ms-item")].find(b=>b.textContent===${J(label)})`, `document.querySelector('#timeline .panel [data-pact="back"]')!==null`);
        await sleep(600);
        judge(name, await P(BACK));
        if (shot) await snap(shot);
        await click(`#timeline .panel [data-pact="back"]`);
        await sleep(300);
        return step(`T8 ${name}点「‹」⇒ 回主面`, await evalJs(mainPanel));
      };
      await viaMore(revId, "历史", "「历史」子面", "T8-sub-history");
      await viaMore(revId, "移动", "「移动」子面", null);
      await viaMore(revId, "放进看板", "「放进看板」子面", null);
      if (await evalJs(`document.querySelector("#timeline .panel")!==null`)) await back();
    }

    // ── T1 续:开着的层有影(「更多…」那座,不带键盘)────────────────────────────
    {
      await openPanel(revId);
      await tap(`document.querySelector('#timeline .panel [data-pact="more"]')`, `document.getElementById("more-sheet").classList.contains("open")`);
      await sleep(500);
      const o = await P(`const e=document.getElementById("more-sheet");return {open:e.classList.contains("open"),shadow:getComputedStyle(e).boxShadow,bottom:R(e).b,vh:innerHeight}`);
      step("T1 开着的层带影、贴着屏底", o.open && o.shadow !== "none" && Math.abs(o.bottom - o.vh) <= 1.5, o);
      await snap("T1-sheet-open");
      await back();
      await sleep(400);
      const c = await P(`const e=document.getElementById("more-sheet");return {open:e.classList.contains("open"),shadow:getComputedStyle(e).boxShadow}`);
      step("T1〔刀〕收回去之后那座又不带影了", !c.open && c.shadow === "none", c);
      if (await evalJs(`document.querySelector("#timeline .panel")!==null`)) await back();
    }

    // ── T11 页头 / T9 形状 / T4 聚焦 / T12 标签面 / T13 ─────────────────────────
    const HEAD = (paneId) => `const s=document.getElementById(${J(paneId)});const h=s.querySelector(":scope > h2, :scope > .phead > h2");const cs=getComputedStyle(s),ch=getComputedStyle(h);
      return {pane:${J(paneId)},shown:vis(s),line:cs.borderTopStyle==="none"?0:parseFloat(cs.borderTopWidth),title:h.textContent,fs:parseFloat(ch.fontSize),color:ch.color,ink:tok("--ink"),weight:Number(ch.fontWeight),top:R(h).t-R(document.querySelector("body>header")).b}`;
    const headOk = (a) => a.shown && a.line === 0 && a.fs >= 17 && a.color === a.ink && a.weight >= 600 && a.top >= 0 && a.top < 40;
    const SHAPE = (expr) => `const b=${expr};if(!vis(b))return null;const r=R(b);const cs=getComputedStyle(b);return {text:b.textContent.trim(),w:r.w,h:r.h,radius:parseFloat(cs.borderTopLeftRadius)}`;
    const pill = (a) => !!a && a.radius >= a.h / 2 - 0.5;
    const FOCUS = (expr) => `const i=${expr};if(!vis(i))return null;i.focus();const cs=getComputedStyle(i);const r={focused:document.activeElement===i,outline:cs.outlineStyle,ow:parseFloat(cs.outlineWidth),border:cs.borderTopColor,seal:tok("--seal")};i.blur();return r`;
    const focusOk = (a) => !!a && a.focused && (a.outline === "none" || a.ow === 0) && a.border === a.seal;
    {
      // 标签面
      await openPaneBy("#topics-toggle", "topics-pane");
      await until(`document.querySelectorAll("#topics-list .trow").length>=10`, 4000);
      const hd = await P(HEAD("topics-pane"));
      step("T11〔刀〕标签面:顶上没有虚线,页标题「标签」≥ 17px、墨色、加粗", headOk(hd) && hd.title === "标签", hd);
      const tree = await inv("list_topics_full");
      const tasks = await inv("list_tasks");
      const total = (tp) => tp.notes.length + tp.docs.length + tasks.filter((x) => x.topics.some((y) => y.id === tp.id)).length;
      const ROWS = `return [...document.querySelectorAll("#topics-list .trow[data-topic]")].map(r=>{const n=r.querySelector(".tname"),c=r.querySelector(".tcount");if(!n||!c)return null;const ca=getComputedStyle(c,"::after");
        return {id:r.dataset.topic,name:n.textContent,rowH:R(r).h,nameH:R(n).h,nameW:R(n).w,cut:n.scrollWidth>n.clientWidth+1,ws:getComputedStyle(n).whiteSpace,to:getComputedStyle(n).textOverflow,
          count:c.textContent.trim(),aria:c.getAttribute("aria-label"),arrow:ca.content,cw:R(c).w,ch:R(c).h,rowW:R(r).w}}).filter(Boolean)`;
      const rows = await P(ROWS);
      const mine = rows.filter((r) => r.name.includes(M));
      const want = Object.fromEntries(tree.filter((x) => x.title.includes(M)).map((x) => [x.id, total(x)]));
      const lr = mine.find((r) => r.name === LONG);
      const zero = mine.find((r) => r.name === `${M}空签`);
      const one = mine.find((r) => r.name === `${M}签1`);
      step("T12 行右边只写总数(与库对得上:随记 + 长文 + 卡片),0 的不写数", mine.length === 10 && mine.every((r) => r.count === (want[r.id] > 0 ? String(want[r.id]) : "")) && !!zero && zero.count === "" && !!one && one.count === "1", mine.map((r) => [r.name.slice(0, 12), r.count, want[r.id]]));
      step("T12〔刀〕每行都有那枚「›」,条数列很窄(≤ 44),触区高 ≥ 44", mine.every((r) => /›/.test(r.arrow) && r.cw <= 44 && r.ch >= 44), mine.map((r) => [r.arrow, r.cw, r.ch]));
      step("T12 读屏名是完整说法(「N 条随记 · M 张卡片」)", !!one && (one.aria ?? "").replace(/\s/g, "") === "0条随记·1张卡片" && !!lr && (lr.aria ?? "").replace(/\s/g, "") === "1条随记·0张卡片", { one: one?.aria, long: lr?.aria });
      step("T12〔刀〕长名字一行省略:名字盒高 = 44(没折行)、被截着、行高 < 60;名字占到行宽的一半以上", !!lr && lr.cut && lr.ws === "nowrap" && lr.to === "ellipsis" && Math.abs(lr.nameH - 44) <= 1.5 && lr.rowH < 60 && lr.nameW > lr.rowW * 0.5, lr);
      await snap("T12-topics");
      // 0 的那一行点「›」照样展开
      await tap(`document.querySelector('#topics-list .trow[data-topic="${zero?.id}"] .tcount')`, `document.querySelector('#topics-list .tcount[data-expand="${zero?.id}"]')?.getAttribute("aria-expanded")==="true"`);
      step("T12 总数为 0 的那一行真点「›」照样展开", await evalJs(`document.querySelector('#topics-list .tcount[data-expand="${zero?.id}"]')?.getAttribute("aria-expanded")==="true"`));
      await click(`#topics-list .tcount[data-expand="${zero?.id}"]`);
      // 点进有内容的那一层:照旧分段写随记 / 卡片
      await click(`#topics-list .tcount[data-expand="${one?.id}"]`);
      const body = await until(`(()=>{const b=document.querySelector("#topics-list .tbody");return b?b.textContent:false})()`, 2500);
      step("T12 点进去的那一层照旧分段列着(有段头、有那张卡)", typeof body === "string" && body.includes(`${M}-挂签待办1`), { body: String(body).slice(0, 80) });
      await click(`#topics-list .tcount[data-expand="${one?.id}"]`);
      // 新建框:聚焦 + 「建」的形状
      await click("#topics-new");
      await until(`document.querySelector("#topics-list .tn-input")!==null`, 2000);
      const nf = await P(FOCUS(`document.querySelector("#topics-list .tn-input")`));
      step("T4〔刀〕新建标签框聚焦:没有引擎那圈框、边框朱砂", focusOk(nf), nf);
      const jian = await P(SHAPE(`document.querySelector("#topics-list .tn-edit .tn-save")`));
      const quxiao = await P(SHAPE(`document.querySelector("#topics-list .tn-edit button.ghost")`));
      step("T9〔刀〕标签面「建」「取消」是全圆药丸;单字的「建」不是正圆(宽 ≥ 1.4 × 高)", pill(jian) && pill(quxiao) && jian.w >= jian.h * 1.4, { jian, quxiao });
      await snap("T9-topics-new");
      await evalJs(`(()=>{const b=document.querySelector("#topics-list .tn-edit button.ghost");if(b)b.click();return 1})()`);
      // 改名框
      await click(`#topics-list .trow[data-topic="${one?.id}"] .tname`);
      await until(`document.querySelector("#topics-list .tn-input")!==null`, 2000);
      const rf = await P(FOCUS(`document.querySelector("#topics-list .tn-input")`));
      step("T4〔刀〕标签改名框聚焦:同上", focusOk(rf), rf);
      const rbs = await P(`return [...document.querySelectorAll("#topics-list .tn-edit button")].filter(vis).map(b=>({text:b.textContent.trim(),h:R(b).h,w:R(b).w,radius:parseFloat(getComputedStyle(b).borderTopLeftRadius)}))`);
      step("T9〔刀〕改名那排的钮都是全圆药丸", rbs.length >= 3 && rbs.every(pill), rbs);
      await evalJs(`(()=>{const b=[...document.querySelectorAll("#topics-list .tn-edit button")].find(b=>b.textContent.trim()==="取消");if(b)b.click();return 1})()`);

      // 搜索面
      await openPaneBy("#search-toggle", "search-pane");
      const hs = await P(HEAD("search-pane"));
      step("T11〔刀〕搜索面:没有虚线,页标题达标", headOk(hs) && hs.title === "搜索", hs);
      const sf = await P(FOCUS(`document.getElementById("search-input")`));
      step("T4〔刀〕搜索框聚焦:没有引擎那圈框、边框朱砂", focusOk(sf), sf);
      const sou = await P(SHAPE(`document.getElementById("search-btn")`));
      step("T9〔刀〕「搜」是全圆药丸、不是正圆小球(宽 ≥ 1.4 × 高)、高 ≥ 44", pill(sou) && sou.w >= sou.h * 1.4 && sou.h >= 44, sou);
      await evalJs(`(()=>{const i=document.getElementById("search-input");i.value=${J(`${M}-挂签待办`)};i.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("search-btn").click();return 1})()`);
      await until(`document.querySelectorAll("#search-results .card").length>=8`, 5000);
      const dots = await P(`const pick=t=>[...document.querySelectorAll("#search-results .card")].find(c=>c.textContent.includes(t));const chip=c=>c?c.querySelector("footer .chip.topic"):null;
        const d=e=>{if(!e)return null;const b=getComputedStyle(e,"::before");return {text:e.textContent,content:b.content,color:b.color,tinted:e.classList.contains("tinted")}};
        const p=document.createElement("i");p.style.cssText="display:none;color:#3f7a99";document.body.append(p);const want=getComputedStyle(p).color;p.remove();
        return {a:d(chip(pick(${J(`${M}-挂签待办1`)}))),b:d(chip(pick(${J(`${M}-挂签待办2`)}))),want}`);
      step("T13②〔刀〕搜索结果里有颜色的标签带实心色点(色 = 标签色)", !!dots.a && dots.a.tinted && /●/.test(dots.a.content) && dots.a.color === dots.want, dots);
      step("T13②〔刀〕没颜色的标签画空心圈(与时间轴卡脚同形)", !!dots.b && !dots.b.tinted && /○/.test(dots.b.content), dots.b);
      await snap("T13-search-dots");
      await closePane();
      await mode("tasks");
      const tl = await P(`const c=${card(made[0])};const e=c?c.querySelector("footer .chip.topic"):null;if(!e)return null;const b=getComputedStyle(e,"::before");return {content:b.content,color:b.color}`);
      step("T13② 对照:时间轴上同一枚标签的色点是同一个字、同一个色", !!tl && !!dots.a && tl.content === dots.a.content && tl.color === dots.a.color, { timeline: tl, search: dots.a });

      // 同步面
      await openPaneBy("#sync-toggle", "sync");
      const hy = await P(HEAD("sync"));
      step("T11〔刀〕同步面:没有虚线,页标题达标", headOk(hy), hy);
      const syncBtns = await P(`return [...document.querySelectorAll("#sync .row button")].filter(vis).map(b=>({text:b.textContent.trim().slice(0,14),h:R(b).h,w:R(b).w,radius:parseFloat(getComputedStyle(b).borderTopLeftRadius)}))`);
      step("T9〔刀〕同步面上看得见的钮都是全圆药丸(高 ≥ 44)", syncBtns.length >= 1 && syncBtns.every((b) => pill(b) && b.h >= 44), syncBtns);
      await snap("T9-sync");

      // 回收站 / 归档
      await closePane();
      await click(`#bottombar [data-pane="trash"]`);
      await until(`!document.getElementById("trash-pane").hidden&&document.querySelector("#trash-list .trash-foot button")!==null`, 4000);
      await sleep(300);
      const ht = await P(HEAD("trash-pane"));
      step("T11〔刀〕回收站:没有虚线,页标题达标", headOk(ht) && ht.title === "回收站", ht);
      const tf = await P(SHAPE(`document.querySelector("#trash-list .trash-foot button")`));
      step("T9〔刀〕「清空…」是全圆药丸(高 ≥ 44)", pill(tf) && tf.h >= 44, tf);
      await snap("T11-trash");
      await click(`#bottombar [data-pane="sealed"]`);
      await until(`!document.getElementById("sealed-pane").hidden`, 3000);
      await sleep(300);
      const hz = await P(HEAD("sealed-pane"));
      step("T11〔刀〕归档:没有虚线,页标题达标", headOk(hz) && hz.title === "归档", hz);

      // 设置首页
      await openPaneBy("#settings-toggle", "settings-pane");
      await sleep(600);
      const hh = await P(HEAD("settings-pane"));
      step("T11〔刀〕设置首页:没有虚线,页标题「设置」达标", headOk(hh) && hh.title === "设置", hh);
      const sec = await P(`const hs=[...document.querySelectorAll("#settings-pane > h2")].filter(vis);const t=getComputedStyle(hs[0]),n=getComputedStyle(hs[1]);
        return {title:hs[0].textContent,sec:hs[1].textContent,tfs:parseFloat(t.fontSize),sfs:parseFloat(n.fontSize),tc:t.color,sc:n.color,soft:tok("--ink-soft"),ink:tok("--ink"),gap:R(hs[1]).t-R(hs[0]).b}`);
      step("T11〔刀〕「设置」与「外观」分出主次:节标题仍是小灰字(≤ 13px、--ink-soft),页标题比它大 ≥ 4px", sec.sec === "外观" && sec.sfs <= 13.5 && sec.sc === sec.soft && sec.tfs - sec.sfs >= 4 && sec.tc === sec.ink, sec);
      const g = await P(`const d=document.querySelector("#settings-pane details.notes");const l=document.getElementById("settings-entries");const s=d.querySelector("summary");
        return {open:d.open,gap:R(l).t-R(d).b,sumH:R(s).h,secGap:parseFloat(getComputedStyle(document.querySelectorAll("#settings-pane > h2")[1]).marginTop)}`);
      step("T13③〔刀〕收着的「说明」到入口列表的缝 ≤ 12(钮自己那 44 的行高里字下面还空着十来像素,合起来 ≈ 别处的节距 22)", !g.open && g.gap <= 12 && g.gap >= 4 && g.sumH >= 44, g);
      await snap("T11-settings-home");
      const fc = await P(SHAPE(`document.getElementById("feedback-copy")`));
      step("T9〔刀〕设置首页「复制」是全圆药丸", pill(fc), fc);

      // 设置 → 空间
      const SUB = (paneId) => `const b=document.querySelector("#${paneId} [data-sub-back]");const s=document.getElementById(${J(paneId)});const h=s.querySelector(":scope > h2");
        return {shown:vis(b),text:b.textContent.trim(),aria:b.getAttribute("aria-label"),h:vis(b)?R(b).h:0,first:s.firstElementChild===b,title:h.textContent,titleBelow:vis(b)&&R(h).t>=R(b).b-8,chev:vis(b)?parseFloat(getComputedStyle(b,"::before").width):0}`;
      const subOk = (a, text) => a.shown && a.text === text && a.h >= 44 && a.first && a.titleBelow && a.chev >= 12;
      await tap(`document.getElementById("settings-spaces-btn")`, `!document.getElementById("spaces").hidden`);
      await sleep(400);
      const sp = await P(SUB("spaces"));
      step("T13①〔刀〕设置 → 空间:页头有「‹ 设置」(高 ≥ 44、读屏名「返回设置」),下面是页标题「空间」", subOk(sp, "设置") && sp.aria === "返回设置" && sp.title === "空间", sp);
      const hp = await P(HEAD("spaces"));
      step("T11〔刀〕空间页:没有虚线,页标题达标", hp.line === 0 && hp.fs >= 17 && hp.color === hp.ink && hp.weight >= 600, hp);
      const sc = await P(SHAPE(`document.getElementById("space-create")`));
      step("T9〔刀〕空间页「新建」是全圆药丸", pill(sc), sc);
      await snap("T13-spaces-from-settings");
      const bn = await tap(`document.querySelector("#spaces [data-sub-back]")`, `!document.getElementById("settings-pane").hidden`);
      step("T13① 真点空间页的「‹ 设置」⇒ 回设置首页", bn > 0 && (await evalJs(`!document.getElementById("settings-pane").hidden&&document.getElementById("spaces").hidden`)), { tapTry: bn });
      // 设置 → 诊断
      await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=se.scrollHeight;return 1})()`);
      await sleep(300);
      await tap(`document.getElementById("settings-diag-btn")`, `!document.getElementById("diag").hidden`);
      await sleep(600);
      const dg = await P(SUB("diag"));
      step("T13①〔刀〕设置 → 诊断:页头有「‹ 设置」,下面是页标题「诊断」", subOk(dg, "设置") && dg.aria === "返回设置" && dg.title === "诊断", dg);
      const hd2 = await P(`const s=document.getElementById("diag");const hs=[...s.querySelectorAll(":scope > h2")];const cs=getComputedStyle(s),t=getComputedStyle(hs[0]),n=getComputedStyle(hs[1]);
        return {line:cs.borderTopStyle==="none"?0:parseFloat(cs.borderTopWidth),tfs:parseFloat(t.fontSize),tc:t.color,ink:tok("--ink"),sec:hs.map(h=>h.textContent),sfs:parseFloat(n.fontSize)}`);
      step("T11 诊断页:没有虚线,页标题 ≥ 17px 墨色;两节的节标题(本机库 / 网络自检)照旧在、仍是小字", hd2.line === 0 && hd2.tfs >= 17 && hd2.tc === hd2.ink && hd2.sec.length === 3 && hd2.sec[2] === "网络自检" && hd2.sfs <= 13.5, hd2);
      await snap("T13-diag-from-settings");
      await back();
      step("T13① 诊断页真按返回键 ⇒ 回设置首页,app 还在前台", (await evalJs(`!document.getElementById("settings-pane").hidden`)) && (await foreground()));
      // 关于
      await tap(`document.querySelector('#settings-pane [data-set-page="set-about"]')`, `!document.getElementById("set-about").hidden`);
      await until(`document.querySelectorAll("#about > .k").length>=3`, 4000);
      await sleep(300);
      const ab = await P(`const ks=[...document.querySelectorAll("#about > .k")];const rows=ks.map(k=>{const v=k.nextElementSibling;const lh=parseFloat(getComputedStyle(v).lineHeight)||20;return {k:k.textContent,h:R(k).h,vh:R(v).h,top:R(k).t,link:v.classList.contains("about-link"),kMid:(R(k).t+R(k).b)/2,
          textMid:(()=>{const r=document.createRange();r.selectNodeContents(k);const b=r.getBoundingClientRect();return (b.top+b.bottom)/2})()}});
        const s=document.getElementById("set-about");const h=s.querySelector(":scope > h2");const bk=s.querySelector(".set-back");
        return {rows,pitch:rows.slice(1).map((r,i)=>r.top-rows[i].top),titleFs:parseFloat(getComputedStyle(h).fontSize),titleColor:getComputedStyle(h).color,ink:tok("--ink"),back:vis(bk)&&R(bk).h>=44,line:getComputedStyle(s).borderTopStyle}`);
      const single = ab.rows.filter((r) => r.h <= 46);
      step("T13⑤〔刀〕关于页:每行键格都 ≥ 44 高(触区),单行的那几行同一个高(差 ≤ 1)", ab.rows.length >= 4 && ab.rows.every((r) => r.h >= 43.5) && single.length >= 3 && Math.max(...single.map((r) => r.h)) - Math.min(...single.map((r) => r.h)) <= 1, ab.rows.map((r) => [r.k, r.h]));
      step("T13⑤ 键名在各自那一格里竖向居中(差 ≤ 2)", ab.rows.every((r) => Math.abs(r.kMid - r.textMid) <= 2), ab.rows.map((r) => [r.k, r.kMid - r.textMid]));
      step("T11〔刀〕二级页(关于):「‹ 设置」在、没有虚线、页标题 ≥ 17px 墨色", ab.back && ab.line === "none" && ab.titleFs >= 17 && ab.titleColor === ab.ink, { back: ab.back, line: ab.line, fs: ab.titleFs });
      const cu = await P(SHAPE(`document.getElementById("update-check")`));
      if (!cu) step("T9 「检查更新」(这个渠道没有这枚钮 ⇒ 不判)", "skip");
      else step("T9〔刀〕「检查更新」是全圆药丸", pill(cu), cu);
      await snap("T13-about");
      await closePane();

      // 从同步面进空间:页头写的是「同步」;从顶栏徽章直接开:没有那枚钮
      await openPaneBy("#sync-toggle", "sync");
      if (!(await evalJs(`(()=>{const b=document.getElementById("sync-spaces-btn");return !!b&&b.getClientRects().length>0})()`))) step("T13① 同步 → 空间(这台同步面上没有「空间…」那枚 ⇒ 不判)", "skip");
      else {
        await evalJs(`(()=>{document.getElementById("sync-spaces-btn").scrollIntoView({block:"center"});return 1})()`);
        await sleep(300);
        await tap(`document.getElementById("sync-spaces-btn")`, `!document.getElementById("spaces").hidden`);
        await sleep(400);
        const a = await P(SUB("spaces"));
        step("T13① 同步 → 空间:页头那枚写的是上一层的名字「同步」,点它回同步", a.shown && a.text.startsWith("同步") && a.aria === "返回", a);
        await tap(`document.querySelector("#spaces [data-sub-back]")`, `!document.getElementById("sync").hidden`);
        step("T13① …点它回到同步面", await evalJs(`!document.getElementById("sync").hidden`));
      }
      await closePane();
      if (!(await evalJs(`(()=>{const c=document.getElementById("space-chip");return !c.hidden&&c.getClientRects().length>0})()`))) step("T13① 顶栏徽章直接开空间页(这台只有一个空间、没有徽章 ⇒ 不判)", "skip");
      else {
        await click("#space-chip");
        await until(`!document.getElementById("spaces").hidden`, 3000);
        await sleep(300);
        const a = await P(SUB("spaces"));
        step("T13① 从顶栏徽章直接开空间页:没有上一层 ⇒ 那枚钮不出", !a.shown, a);
        await closePane();
      }
    }

    // ── T13④ 看大图层两钮 ───────────────────────────────────────────────────────
    {
      const v = await P(`const w=document.getElementById("viewer");const was=w.hidden;const ro=w.classList.contains("readonly");w.hidden=false;w.classList.remove("readonly");
        const d=R(document.getElementById("viewer-del")),c=R(document.getElementById("viewer-close"));w.hidden=was;if(ro)w.classList.add("readonly");
        return {del:d,close:c}`);
      step("T13④〔刀〕看大图层「✕」与「删除」等高(差 ≤ 0.5)、同一条中线(差 ≤ 0.5)、高 ≥ 40", Math.abs(v.del.h - v.close.h) <= 0.5 && Math.abs((v.del.t + v.del.b) / 2 - (v.close.t + v.close.b) / 2) <= 0.5 && v.del.h >= 40 && v.close.w >= 44, v);
    }

    // ── T6 英文档:选中的那一列露在清楚的那一段里 ──────────────────────────────
    {
      await reload({ [LANG_KEY]: "en" });
      await mode("tasks");
      await sleep(600);
      const ROW = `const row=document.getElementById("filter-stages");const a=row.querySelector(".fpill.active[data-stage]");const ax=row.querySelector(".faxis");const due=row.querySelector(".fdue");if(!a)return null;
        const r=R(row),p=R(a),x=R(ax);const more=!!a.nextElementSibling;
        return {lang:document.documentElement.lang,active:a.textContent,sl:row.scrollLeft,max:row.scrollWidth-row.clientWidth,clear:p.l>=r.l-1&&p.r<=r.r-(more?32:0)+1,inScreen:p.r<=innerWidth&&p.l>=0,
          axis:ax.textContent,axisIn:x.l>=r.l-1&&x.r<=r.r+1,due:due?due.textContent:null,dueW:due?R(due).w:0,rowW:r.w,p,r}`;
      const a = await P(ROW);
      step("T6 前置:英文档、看板页、选中的是「All」、到期汇总钮在", !!a && a.lang === "en" && a.active === "All" && !!a.due, a);
      if (a && a.sl === 0) step("T6 自证:这台上那一排不滚也放得下(到期钮不够长)⇒ 下一格不是在验「滚进来」", "skip", { dueW: a.dueW, rowW: a.rowW });
      else step("T6 自证:那一排放不下、确实滚过(scrollLeft > 0)", !!a && a.sl > 0, a && { sl: a.sl, dueW: a.dueW, rowW: a.rowW });
      step("T6 选中的「All」整枚在屏内、且在淡出那一截之外;「Column」也在这一排里", !!a && a.clear && a.inScreen && a.axisIn && a.axis === "Column", a);
      await snap("T6-en-board");
      if (a && a.sl > 0) {
        // 反证:手动滚回开头 ⇒ 判据不成立;重画(点一下别的列再点回 All)⇒ 又成立
        await evalJs(`(()=>{document.getElementById("filter-stages").scrollLeft=0;return 1})()`);
        await sleep(200);
        const b = await P(ROW);
        step("T6 反证:把那一排手动滚回开头 ⇒ 「All」不在清楚的那一段里(判据吃得到)", !!b && !b.clear, b && { sl: b.sl, clear: b.clear });
        await evalJs(`(()=>{const row=document.getElementById("filter-stages");const o=[...row.querySelectorAll(".fpill[data-stage]")].find(p=>p.dataset.stage!=="all");o.click();return 1})()`);
        await sleep(400);
        const c1 = await P(ROW);
        step("T6 选另一列 ⇒ 那一枚也整枚露在清楚的那一段里", !!c1 && c1.active !== "All" && c1.clear && c1.inScreen, c1);
        await evalJs(`(()=>{document.querySelector('#filter-stages .fpill[data-stage="all"]').click();return 1})()`);
        await sleep(400);
        const c2 = await P(ROW);
        step("T6 选回「All」⇒ 重画后又露出来了", !!c2 && c2.active === "All" && c2.clear, c2);
      }
      // 英文档的属性排:放不下时整枚换行、不截字
      if (await openPanel(propId)) {
        const e = await P(`const p=${card(propId)}.querySelector(".panel");const bs=[...p.querySelectorAll(".props button.prop")];
          return {rows:new Set(bs.map(b=>Math.round(R(b).t))).size,fits:bs.every(b=>R(b).r<=R(p).r+1&&R(b).l>=R(p).l-1),clip:bs.some(b=>b.scrollWidth>b.clientWidth+1),oneLine:bs.every(b=>R(b).h<46),texts:bs.map(b=>b.textContent)}`);
        step("T7 英文档:三枚各自一行字、不截字、都在面里(放不下就整枚换行)", e.fits && !e.clip && e.oneLine, e);
        await snap("T7-en-props");
        await back();
      }
      await reload({ [LANG_KEY]: keep.lang });
    }
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    try {
      await clearBar();
      await evalJs(`(()=>{const c=document.getElementById("confirmbar");if(!c.hidden)document.getElementById("confirmbar-no").click();return 1})()`).catch(() => 0);
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
      const restore = { [TAGS_KEY]: keep.tags, [THEME_KEY]: keep.theme, [LANG_KEY]: keep.lang };
      if (startSpace && startSpace !== "main") {
        await evalJs(`(()=>{const o=${J(restore)};for(const k in o){if(o[k]===null)localStorage.removeItem(k);else localStorage.setItem(k,o[k])}return 1})()`);
        await toSpace(startSpace);
      } else await reload(restore);
      const now = await evalJs(`({tags:localStorage.getItem(${J(TAGS_KEY)}),theme:localStorage.getItem(${J(THEME_KEY)}),lang:localStorage.getItem(${J(LANG_KEY)}),gate:document.getElementById("gate").hidden})`);
      step("收尾:回到起跑时的空间、本机开关(标签行 / 明暗 / 语言)还原", now.gate && now.tags === keep.tags && now.theme === keep.theme && now.lang === keep.lang, { now, keep });
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
