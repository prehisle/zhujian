// 165(W5「横切」走查,用户 2026-11-06 全取推荐)手机那组 M2 —— 手机横放与平板排法 —— 的真机回归网。
// 驱动形(要真转屏 `settings put system user_rotation`、真弹键盘、真按返回;CDP 摆前置、发触摸、读状态、量几何)。
// ⚠ 只在 vivo V1986A 这类有软键盘的真机上有意义(MuMu 恒横屏、没有软键盘)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-walk165-m2.mjs                 # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-walk165-m2.mjs --shots <目录>   # 关键几拍各截一张真屏
//   W165_KNIFE=css node scripts/cdp-acceptance-walk165-m2.mjs  # 阴性对照:页内把几处修法改回坏的样子,对应那几格应当红
//     (七把 CSS 刀:A47 / A48 两格 / A36 / A30 / A21 / Q15 ＋;一把页内 JS 刀:A5 取图 input 上的 cancel 监听挂不上)
//
// 逐条(编号同 .zjshots/W5-walk/清单.md):
//  A47  任务页「列」那行被右缘裁着时右头淡出(`.fade-r` 且遮罩真在);划到头换成左头淡出。
//  A27  随记 / 任务各记各的滚动位置:随记划到中段点「任务」落在顶上,再点「随记」回到刚才那儿。
//  Q15  操作面开着时悬浮 ＋ 留在原位,面上的钮一枚都不在它底下(开在屏下半截的卡上)。
//  A48  ①竖着点「过滤…」键盘起来时 ＋ 让位;②横放随记 / 看板给 ＋ 让一条右边距,露着的卡没有一张伸到它底下,栏数不变。
//  A5   取图(拦截选择器,本页从没被盖住)后发一记 `cancel`(ArkWeb 取消时只发这一记)⇒「记下」不再灰、再点【＋ 加图】选择器照样起来。
//  A24  记一笔 → 长文:「← 回到正文 / 保存」那排在屏上(scrollY 0);写三段、收键盘,三段都在页头那排下面露着。
//  A25  长文写到一半(键盘起着)转横再转回:`kb-up` 还在、页头照旧吸着(应用评审二轮 M5 起竖放键盘起着也吸;此前这一格判「不吸」)、
//       底栏没浮到键盘上沿,三段照旧露着。
//  A26  ①横放打长文:顶栏不吸、只留「← 回到正文 / 保存」那排吸在屏顶,保存钮在屏上;②横放开记一笔(键盘起):层顶不进状态栏;
//       ③设置「本机别名」打着字转横:那一行(框 + 保存)整个在可见区。
//  A28  随记转横再转回:转之前最上面露着的那张,转过去、转回来都在原来那个偏移(±6)。
//  A29  竖着开着任务操作面转横:面上的钮在屏上(页面跟过去了)。
//  A36  看板(横放任务页)点「设置」:整页换(时间轴 display:none,设置标题在顶栏下)。
//  A30  横放看大图:图顶在状态栏之下、「图N · n/9」那行在视口里。
//  A49  横放 2×2 看板:「进行中」往右划进下一排的「待确认」(链上的下一列)、撤销;「已完成」往右划:卡不动、说「已是最后一列」。
//  A37  看板上长按拿卡(按住 700ms 再拖)拖进另一列 ⇒ 写库 + 回执「已移到「…」」;拖回原处。
//  Q15  多栏(横放随记)上新记一条:新卡挂 `.flash-hold`(描边常亮约 3 s),2.5 s 后还亮着。
//  A21  (879 翻案:用户拍「不占位」)一枚标签都没有时标签行**不**另占一行:临时空间里两条随记 → 标签行不在过滤框下面;
//       挂第一个标签 → 标签行长出来(卡往下,代价照收);转待办摘走 → 卡回到第一拍的位置(±0.5)。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏手机宽、没开任何面;主空间里有种子库那样的数据
//   (随记两屏以上、任务四列都有卡、一张九图的随记)—— `walk-seed.mjs --android` 播的那份。
//   本资产会写库:建几条带标记「W165M2-<时刻>」的随记 / 长文,一个临时空间「W165M2」;收尾全部彻底删掉、临时空间 reset 掉,
//   最后一格核「零残留」。拖动 / 横滑的那几张种子卡都放回原列原位(撤销 / 拖回)。转屏设置收尾还原成开工时的值。
//   ⛔ 别在用户日常那台上跑。
//
// 诚实边界:
//  ① 转屏是 `user_rotation` 拨的,不是真转手机;键盘高度是搜狗的(横放可见区约 130)—— 用户日常那台(Android 16、115% 字号)要手上看一眼。
//  ② 平板(高屏)的几格 —— A53 浮窗随键盘跳、A35 设置转屏、A37 长按在 ArkWeb 上、A5 三种取消 —— 在鸿蒙平板模拟器上手走(回报截图),
//     本资产只在手机横放(宽屏、不是高屏)上跑看板那几格。
//  ③ A5 这一格验的是前端那半(收到 `cancel` 就放手);ArkWeb 真发不发 `cancel` 归模拟器那趟(O1 的记录器)。安卓真机上取消走
//     `visibilitychange` 那条(604),拦截模式下本页从没被盖住过,那条这里验不到。
//  ④ A49 / A37 的触摸走 CDP `Input.dispatchTouchEvent`(原生输入管线,touch-action / pointer capture 都真生效),不是 adb 的真手指。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const PKG = "app.zhujian.notebook";
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const shell = async (...a) => (await adb(["shell", ...a])).stdout.trim();

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
    await sleep(800);
  }
}

const out = { pass: false, steps: [] };

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.error(`${ok === "skip" ? "SKIP" : ok ? "ok  " : "RED "} ${name}`); // 逐格先印到 stderr:中途卡住也看得出走到哪了
    return !!ok;
  };
  let s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
  /** 页面重载 / 转屏后那条连接可能换了:失败一次就重连再来。 */
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
  const send = (m, p) => s.send(m, p);
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
  // 空间 id 记在驱动这边(⚠ 别放 window 上:A21 那段要重载页面,window 上的东西一载就没了)
  let curSp = null;
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI__.core.invoke(${J(cmd)}, Object.assign({spaceId: ${J(curSp)}}, ${J(args)}))`);
  const MSG = `(()=>{const e=document.getElementById("error");const s=e.querySelector(":scope > span");return s?s.textContent:e.textContent})()`;
  const barText = () => evalJs(`(()=>{const e=document.getElementById("error");return e.hidden?"":${MSG}})()`);
  const barIs = (re, ms = 5000) => until(`(()=>{const e=document.getElementById("error");return !e.hidden&&${re}.test(${MSG})})()`, ms);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  /** 只在那一层真开着时按返回(⚠ 没有层时返回 = app 退到后台,手机端 runtime 一停,后面每一发 CDP 都挂住)。 */
  const backIf = async (expr) => {
    if (await evalJs(expr)) {
      await back();
      await sleep(700);
    }
  };
  const clickBarAct = (label) => evalJs(`(()=>{const b=[...document.querySelectorAll("#error .bar-act")].find(x=>x.textContent===${J(label)});if(!b)return false;b.click();return true})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.click();return true})()`);
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
  const rect = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {t:r.top,b:r.bottom,l:r.left,r:r.right,w:r.width,h:r.height}})()`);
  /** 真机点一下(CSS 坐标 × dpr = 设备像素;adb input tap 吃设备像素)。 */
  const dpr = await evalJs(`devicePixelRatio`);
  const tap = (x, y) => adb(["shell", "input", "tap", String(Math.round(x * dpr)), String(Math.round(y * dpr))]);
  const tapEl = async (sel) => {
    const r = await rect(sel);
    if (!r) return false;
    await tap(r.l + r.w / 2, r.t + r.h / 2);
    return true;
  };
  /** CDP 原生触摸:按下(可按住 hold 毫秒)→ 分 steps 步挪 → 抬起。CSS 坐标。 */
  const touch = async (x1, y1, x2, y2, steps = 12, hold = 0) => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
    if (hold) await sleep(hold);
    for (let i = 1; i <= steps; i++) {
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }] });
      await sleep(24);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const rotate = async (land) => {
    await shell("settings", "put", "system", "user_rotation", land ? "1" : "0");
    await until(`(innerWidth > innerHeight) === ${land} && innerWidth ${land ? ">" : "<"} 700`, 6000);
    await sleep(900); // 等转屏后那几次 resize 停下、锚摆完(main.ts 那段 120ms)
  };
  const SHOTS = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
  const snap = async (name) => {
    if (!SHOTS) return;
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };

  // 阴性对照(页内 CSS 刀):把几处修法改回坏的样子,对应那几格应当红。行为类的刀落不进页内(打包后的逻辑改不了),见回报。
  const KNIFE_CSS = [
    ".fade-r,.fade-l{-webkit-mask-image:none !important;mask-image:none !important}", // A47 暗示没了
    "body.fab-gutter #timeline{padding-right:0 !important}", // A48 右边距没了
    "html.kb-up #capture-fab{visibility:visible !important}", // A48 键盘起着 ＋ 不让
    "body.board.pane-open #timeline{display:grid !important}", // A36 看板压过收起
    "#viewer img{max-height:88vh !important}", // A30 回到旧封顶
    "#filterbar .fmain{flex-wrap:wrap !important}#filter-topics:empty{order:1;flex:0 0 100% !important;min-height:41px}", // A21 占位加回来
    "body.panel-open #capture-fab{display:none !important}", // Q15 ＋ 又藏
  ].join("\n");
  const knife = process.env.W165_KNIFE === "css";
  const armKnife = () =>
    knife
      ? evalJs(`(()=>{let k=document.getElementById("w165m2-knife");if(!k){k=document.createElement("style");k.id="w165m2-knife";document.head.appendChild(k)}k.textContent=${J(KNIFE_CSS)};return 1})()`)
      : null;
  await armKnife();

  // ── 前置 ────────────────────────────────────────────────────────────────────
  if (!step("前置-app 在前台", (await focusedPkg()) === PKG, await focusedPkg())) return out;
  if (!step("前置-界面语言中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return out;
  if (!step("前置-首启告知已同意", (await evalJs(`document.documentElement.dataset.privacy`)) === "ok")) return out;
  const rot0 = { acc: await shell("settings", "get", "system", "accelerometer_rotation"), user: await shell("settings", "get", "system", "user_rotation") };
  await shell("settings", "put", "system", "accelerometer_rotation", "0");
  await rotate(false);
  if (!step("前置-竖屏手机宽", !(await evalJs(`document.body.classList.contains("widescreen")`)))) return out;
  const mainSp = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_spaces")).find(x=>x.current).id)()`);
  curSp = mainSp;
  await dropIme();
  await closePanes();
  await clearBar();
  const M = `W165M2-${Date.now().toString(36)}`;
  let tempSp = null;

  try {
    // ── A47:「列」那行的「后面还有」──────────────────────────────────────────
    await mode("tasks");
    await evalJs(`(()=>{window.scrollTo(0,0);document.getElementById("filter-stages").scrollLeft=0;return 1})()`);
    await sleep(300);
    const fade = () => evalJs(`(()=>{const r=document.getElementById("filter-stages");const m=getComputedStyle(r).webkitMaskImage;return {cls:r.className,over:r.scrollWidth-r.clientWidth,mask:m}})()`);
    const f0 = await fade();
    step("A47 前置:「列」那行确实被裁着(放不下)", f0.over > 1, f0);
    step("A47 被裁着那头淡出(.fade-r,遮罩真在)", /fade-r/.test(f0.cls) && !/fade-l/.test(f0.cls) && /gradient/.test(f0.mask), f0);
    await snap("A47-fade-right");
    await evalJs(`(()=>{const r=document.getElementById("filter-stages");r.scrollLeft=r.scrollWidth;return 1})()`);
    await sleep(300);
    const f1 = await fade();
    step("A47 划到头:换成左头淡出", /fade-l/.test(f1.cls) && !/fade-r/.test(f1.cls) && /gradient/.test(f1.mask), f1);
    await evalJs(`(()=>{document.getElementById("filter-stages").scrollLeft=0;return 1})()`);

    // ── A27:两个主视图各记各的滚动位置 ──────────────────────────────────────
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,900);return 1})()`);
    await sleep(400);
    const y0 = await evalJs(`scrollY`);
    await tapEl(`#bottombar [data-mode="tasks"]`);
    await until(`document.body.dataset.view==="tasks"`, 3000);
    await sleep(300);
    step("A27 随记划到中段点「任务」:看板落在顶上", (await evalJs(`scrollY`)) < 2, { ideas: y0, tasks: await evalJs(`scrollY`) });
    await tapEl(`#bottombar [data-mode="ideas"]`);
    await until(`document.body.dataset.view==="ideas"`, 3000);
    await sleep(300);
    step("A27 再点「随记」:回到刚才那儿", Math.abs((await evalJs(`scrollY`)) - y0) < 2, { was: y0, now: await evalJs(`scrollY`) });

    // ── Q15:操作面开着 ＋ 留在原位、面上的钮不在它底下 ────────────────────────
    await mode("tasks");
    await evalJs(`(()=>{window.scrollTo(0,1400);return 1})()`);
    await sleep(500);
    // 屏下半截那张(开面后 revealPanel 要把面摆到 ＋ 上沿之上)
    const low = await evalJs(`(()=>{const c=[...document.querySelectorAll("#timeline article.card[data-id]")].find(c=>{const r=c.getBoundingClientRect();return r.top>innerHeight*0.55&&r.bottom<innerHeight-90&&!c.querySelector(".ckbox,.thumb")});if(!c)return null;const r=c.querySelector(".content").getBoundingClientRect();return {id:c.dataset.id,x:r.left+20,y:r.top+r.height/2}})()`);
    if (step("Q15 前置:屏下半截有一张普通任务卡", !!low)) {
      await tap(low.x, low.y);
      await until(`!!document.querySelector('#timeline [data-id="${low.id}"] .panel')`, 3000);
      await sleep(500);
      const q = await evalJs(`(()=>{const f=document.getElementById("capture-fab");const fr=f.getBoundingClientRect();const bs=[...document.querySelectorAll("#timeline .panel button")].map(b=>b.getBoundingClientRect()).filter(r=>r.width>0);return {disp:getComputedStyle(f).display,vis:getComputedStyle(f).visibility,n:bs.length,under:bs.filter(r=>r.right>fr.left&&r.left<fr.right&&r.bottom>fr.top&&r.top<fr.bottom).length}})()`);
      step("Q15 操作面开着:＋ 在原位(看得见)", q.disp !== "none" && q.vis === "visible", q);
      step("Q15 面上的钮没有一枚在 ＋ 底下", q.n > 0 && q.under === 0, q);
      await snap("Q15-fab-with-panel");
      // A29 顺着用这一张:开着转横
      await rotate(true);
      const a29 = await evalJs(`(()=>{const p=document.querySelector('#timeline [data-id="${low.id}"] .panel');if(!p)return null;const bs=[...p.querySelectorAll("button")].map(b=>b.getBoundingClientRect()).filter(r=>r.width>0);return {ih:innerHeight,top:Math.min(...bs.map(r=>r.top)),bottom:Math.max(...bs.map(r=>r.bottom))}})()`);
      step("A29 竖着开着的操作面转横:面上那排钮在屏上", !!a29 && a29.top >= 0 && a29.bottom <= a29.ih, a29);
      await snap("A29-panel-landscape");
      await rotate(false);
      await backIf(`!!document.querySelector("#timeline .panel")`); // 收面
    }

    // ── A48 ①:竖着点「过滤…」键盘起来,＋ 让位 ──────────────────────────────
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(300);
    await tapEl("#filter-text");
    const kbUp = await until(`document.documentElement.classList.contains("kb-up")`, 4000);
    if (step("A48 前置:点「过滤…」键盘起来了(kb-up)", !!kbUp)) {
      step("A48 键盘起着 ＋ 让位(不浮到键盘上沿压列表)", (await evalJs(`getComputedStyle(document.getElementById("capture-fab")).visibility`)) === "hidden");
    }
    await dropIme();
    await evalJs(`(()=>{document.getElementById("filter-text").blur();return 1})()`);
    step("A48 收键盘 ＋ 回来", await until(`getComputedStyle(document.getElementById("capture-fab")).visibility==="visible"`, 3000));

    // ── A5:取图被取消(只来一记 cancel)⇒ 不卡 ─────────────────────────────────
    await mode("ideas");
    // A5 的页内 JS 刀:文件框上那记 cancel 监听挂不上(= 还原成修之前只等 visibilitychange 的样子)
    if (knife) await evalJs(`(()=>{if(window.__w165k5)return 1;window.__w165k5=1;const o=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,...a){if(t==="cancel"&&this instanceof HTMLInputElement&&this.type==="file")return;return o.call(this,t,...a)};return 1})()`);
    await send("Page.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const pick = () => send("Runtime.evaluate", { expression: `document.getElementById("compose-addimg").click()`, userGesture: true, returnByValue: true });
      await pick();
      const hasInput = await until(`!!document.querySelector('body > input[type="file"]')`, 2000);
      step("A5 前置:点【＋ 加图】选择器起了(拦下)、「记下」灰着", !!hasInput && (await evalJs(`document.getElementById("save").disabled`)));
      await evalJs(`(()=>{document.querySelector('body > input[type="file"]').dispatchEvent(new Event("cancel"));return 1})()`);
      step("A5 收到 cancel:「记下」不再灰", await until(`!document.getElementById("save").disabled`, 2500));
      step("A5 收到 cancel:那只 input 收掉了", await until(`!document.querySelector('body > input[type="file"]')`, 1500));
      await evalJs(`(()=>{document.querySelectorAll('body > input[type="file"]').forEach(i=>i.dataset.w165old="1");return 1})()`); // 刀下旧那只没收掉,别把它认成新弹的
      await pick();
      step("A5 再点【＋ 加图】选择器照样起来", await until(`!!document.querySelector('body > input[type="file"]:not([data-w165old])')`, 2000));
      await evalJs(`(()=>{document.querySelector('body > input[type="file"]')?.dispatchEvent(new Event("cancel"));return 1})()`);
      await until(`!document.getElementById("save").disabled`, 2500);
    } finally {
      await send("Page.setInterceptFileChooserDialog", { enabled: false });
    }
    await dropIme();
    await backIf(`document.getElementById("compose-card").classList.contains("open")`); // 收记一笔层(取图回来会聚焦写字框开层)
    if (knife) {
      // 刀下 picking 卡死了(「记下」灰、「长文」钮也早退)⇒ 重载一次把它放掉,别让后面几段被这一刀连坐
      await evalJs(`(()=>{location.reload();return 1})()`);
      await sleep(3500);
      await armKnife();
    }
    await evalJs(`(()=>{const t=document.getElementById("text");t.value="";t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);

    // ── A24 / A25 / A26①:长文编辑器 ───────────────────────────────────────────
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(300);
    await tapEl("#capture-fab");
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await until(`document.documentElement.classList.contains("kb-up")`, 4000);
    await evalJs(`(()=>{const t=document.getElementById("text");t.value="";t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    await tapEl("#compose-doc");
    const inEd = await until(`!!document.querySelector("#docs-pane .doc-area")`, 4000);
    if (step("A24 前置:记一笔 →「长文」进了编辑器", !!inEd)) {
      await sleep(800);
      const saveBtn = `[...document.querySelectorAll("#docs-pane .doc-head button")].find(b=>b.textContent==="保存")`;
      const g = await evalJs(`(()=>{const b=${saveBtn}.getBoundingClientRect();const head=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--head-h"));return {sy:scrollY,kb:document.documentElement.classList.contains("kb-up"),saveTop:b.top,saveBottom:b.bottom,head,ih:innerHeight}})()`);
      step("A24 一进来「保存」那排在屏上(顶栏之下、视口之内)", g.sy < 1 && g.saveTop >= g.head - 1 && g.saveBottom <= g.ih, g);
      await snap("A24-open");
      await send("Input.insertText", { text: `${M}-111` });
      for (const line of ["", "222", "", "333"]) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        if (line) await send("Input.insertText", { text: line });
      }
      await sleep(400);
      // 三段都露着:编辑框的上沿在页头那排下沿之下(页头吸顶时它盖着的就是框的上沿)
      const shown = () =>
        evalJs(`(()=>{const h=document.querySelector("#docs-pane .doc-head").getBoundingClientRect();const a=document.querySelector("#docs-pane .doc-area").getBoundingClientRect();const nav=document.getElementById("bottombar");return {sy:scrollY,headBottom:h.bottom,areaTop:a.top,pos:getComputedStyle(document.querySelector("#docs-pane .doc-head")).position,kb:document.documentElement.classList.contains("kb-up"),navVis:getComputedStyle(nav).visibility,ih:innerHeight}})()`);
      await dropIme(); // 收键盘(焦点留在框里)
      await until(`!document.documentElement.classList.contains("kb-up")`, 3000);
      await sleep(600);
      const k0 = await shown();
      step("A24 收键盘:页头那排没盖住前几段(框上沿在它下面)", k0.areaTop >= k0.headBottom - 1, k0);
      await snap("A24-kb-down");
      // A25:再点进框(键盘起)→ 转横 → 转回
      const ar = await rect("#docs-pane .doc-area");
      await tap(ar.l + ar.w / 2, Math.min(ar.t + 60, k0.ih - 40));
      await until(`document.documentElement.classList.contains("kb-up")`, 4000);
      await sleep(500);
      await rotate(true);
      await until(`document.documentElement.classList.contains("kb-up")`, 3000);
      await sleep(400);
      const l = await evalJs(`(()=>{const hd=document.querySelector("body > header");const b=${saveBtn}.getBoundingClientRect();return {kb:document.documentElement.classList.contains("kb-up"),ih:innerHeight,header:getComputedStyle(hd).position,saveTop:b.top,saveBottom:b.bottom,tools:getComputedStyle(document.querySelector("#docs-pane .doc-tools")).display}})()`);
      step("A25 打着字转横:kb-up 没掉", l.kb, l);
      step("A26 横放打长文:顶栏不吸、「保存」那排在屏上", l.header === "static" && l.saveTop >= -1 && l.saveBottom <= l.ih + 1 && l.tools === "none", l);
      await snap("A26-doc-landscape");
      await rotate(false);
      await until(`document.documentElement.classList.contains("kb-up")`, 3000);
      await sleep(500);
      const k1 = await shown();
      step("A25 转回竖:kb-up 还在、页头吸着(M5)、底栏没浮到键盘上沿", k1.kb && k1.pos === "sticky" && k1.navVis === "hidden", k1);
      step("A25 转回竖:前几段没滚到页头底下(回得了页顶就回页顶)", k1.sy < 1 && k1.areaTop >= k1.headBottom - 1, k1);
      await snap("A25-back-portrait");
      await dropIme();
      await backIf(`!!document.querySelector("#docs-pane .doc-area")`); // 离开编辑器(落一篇,收尾删)
      await until(`!document.querySelector("#docs-pane .doc-area")`, 4000);
      await sleep(500);
    }
    await closePanes();

    // ── 横放那一组 ────────────────────────────────────────────────────────────
    // A28:随记转横再转回,最上面那张留在原偏移
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,1100);return 1})()`);
    await sleep(700); // 等锚记下(滚动停 100ms 后记)
    const TOP = `(()=>{const cs=getComputedStyle(document.documentElement);const top=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0);let best=null;for(const c of document.querySelectorAll("#timeline article.card[data-id]")){const r=c.getBoundingClientRect();if(r.height===0||r.bottom<=top+1||r.top>=innerHeight)continue;if(!best||r.top<best.t-0.5||(Math.abs(r.top-best.t)<=0.5&&r.left<best.l))best={id:c.dataset.id,t:r.top,l:r.left,off:Math.round(r.top-top)}}return best})()`;
    const OFF = (id) => `(()=>{const cs=getComputedStyle(document.documentElement);const top=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0);const c=document.querySelector('#timeline [data-id="${id}"]');return c?Math.round(c.getBoundingClientRect().top-top):null})()`;
    const a0 = await evalJs(TOP);
    await rotate(true);
    await armKnife();
    const a1 = await evalJs(OFF(a0.id));
    step("A28 随记转横:刚才最上面那张还在原偏移(±6)", a1 !== null && Math.abs(a1 - a0.off) <= 6, { before: a0, after: a1 });
    await snap("A28-landscape");

    // A48 ②:横放给 ＋ 让一条右边距
    const g48 = await evalJs(`(()=>{const f=document.getElementById("capture-fab").getBoundingClientRect();let maxR=0,n=0;for(const c of document.querySelectorAll("#timeline article.card")){const r=c.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight){maxR=Math.max(maxR,r.right);n++}}return {gutter:document.body.classList.contains("fab-gutter"),fabL:f.left,maxR,n,cols:document.querySelectorAll("#timeline .tl-col").length?Math.max(...[...document.querySelectorAll("#timeline .tl-cols, #timeline .tl-flow")].map(x=>x.children.length)):1}})()`);
    step("A48 横放随记:露着的卡没有一张伸到 ＋ 底下、仍是两栏", g48.n > 0 && g48.maxR <= g48.fabL && g48.cols >= 2, g48);
    await rotate(false);
    const a2 = await evalJs(OFF(a0.id));
    step("A28 再转回竖:还是那一张、原偏移(±6)", a2 !== null && Math.abs(a2 - a0.off) <= 6, { before: a0, back: a2 });
    await rotate(true);
    await armKnife();

    // Q15 多栏新卡描边常亮(新卡要在眼前 —— 不在眼前出的是「已记下 [去看看]」那条,不闪;先回到页顶)
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(500);
    await tapEl("#capture-fab");
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await sleep(800);
    // A26②:横放开记一笔、键盘起着:层顶不进状态栏
    const c26 = await evalJs(`(()=>{const r=document.getElementById("compose-card").getBoundingClientRect();return {top:r.top,sat:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat"))||0,kb:document.documentElement.classList.contains("kb-up"),ih:innerHeight}})()`);
    step("A26 横放开记一笔(键盘起):层顶在状态栏之下", c26.kb && c26.top >= c26.sat - 1, c26);
    await snap("A26-compose-landscape");
    const NOTE = `${M} 多栏新卡`;
    await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(NOTE)};t.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("save").click();return 1})()`);
    const nid = await until(`(()=>{const c=[...document.querySelectorAll("#timeline [data-id]")].find(c=>c.querySelector(".content")?.textContent===${J(NOTE)});return c?c.dataset.id:""})()`, 6000);
    if (step("Q15 前置:横放随记记下一条", !!nid)) {
      const t0 = Date.now();
      const hold = await until(`document.querySelector('#timeline [data-id="${nid}"]')?.classList.contains("flash-hold")`, 1500);
      step("Q15 多栏新卡挂的是常亮那一种(.flash-hold)", !!hold);
      await sleep(Math.max(0, 2500 - (Date.now() - t0)));
      step("Q15 2.5 s 后描边还亮着", await evalJs(`!!document.querySelector('#timeline [data-id="${nid}"]')?.classList.contains("flash-hold")`));
    }
    await dropIme();

    // A49 / A37 / A36:横放看板
    await mode("tasks");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    await sleep(500);
    const plain = (col) =>
      evalJs(`(()=>{const c=[...document.querySelectorAll('#timeline > .tl-group[data-col="${col}"] > article.card[data-id]')].find(c=>!c.querySelector(".ckbox,.thumb"));if(!c)return null;c.scrollIntoView({block:"center"});return c.dataset.id})()`);
    const centerOf = async (id) => {
      await sleep(500);
      return evalJs(`(()=>{const r=document.querySelector('#timeline [data-id="${id}"]').getBoundingClientRect();return {x:r.left+r.width*0.5,y:r.top+Math.min(28,r.height/2),w:r.width}})()`);
    };
    const colOf = (id) => evalJs(`document.querySelector('#timeline [data-id="${id}"]')?.closest(".tl-group")?.dataset.col??null`);
    // 889 起看板一排横滚(此前 2×2 折排):手机横放上「待确认」在屏外,A49 往右划照样按链进它(不按屏上左右)。
    step("前置-横放任务页是一排横滚的看板", (await evalJs(`(()=>{const tl=document.getElementById("timeline");return document.body.classList.contains("board")&&getComputedStyle(tl).overflowX==="auto"&&tl.scrollWidth>tl.clientWidth})()`)));
    // A49 ①「进行中」往右 = 链上的下一列「待确认」(在屏外那一列)
    const doing = await plain("doing");
    if (step("A49 前置:「进行中」里有一张普通卡", !!doing)) {
      const p = await centerOf(doing);
      await clearBar();
      await touch(p.x - p.w * 0.3, p.y, p.x + p.w * 0.35, p.y);
      step("A49「进行中」往右划进屏外那一列「待确认」", (await until(`document.querySelector('#timeline [data-id="${doing}"]')?.closest(".tl-group")?.dataset.col==="confirming"`, 4000)) && (await barIs(/^已移到「待确认」$/.toString(), 3000)), await barText());
      await clickBarAct("撤销");
      step("A49 撤销:回到「进行中」", await until(`document.querySelector('#timeline [data-id="${doing}"]')?.closest(".tl-group")?.dataset.col==="doing"`, 4000));
    }
    // A49 ②「已完成」往右:没有列了 ⇒ 不动、说一句
    const done = await plain("done");
    if (step("A49 前置:「已完成」里有一张普通卡", !!done)) {
      const p = await centerOf(done);
      await clearBar();
      await touch(p.x - p.w * 0.3, p.y, p.x + p.w * 0.35, p.y);
      step("A49「已完成」往右划:卡不动、说「已是最后一列」", (await barIs(/^「已完成」已是最后一列$/.toString(), 3000)) && (await colOf(done)) === "done", await barText());
      await snap("A49-end-hint");
    }
    // A37 长按拿卡(按住 700ms)从「待办」拖进「进行中」,再拖回原位
    const todo = await plain("todo");
    if (step("A37 前置:「待办」里有一张普通卡", !!todo)) {
      const idx0 = await evalJs(`[...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > article.card[data-id]')].findIndex(c=>c.dataset.id===${J(todo)})`);
      const p = await centerOf(todo);
      const dcol = await rect(`#timeline > .tl-group[data-col="doing"] > .tl-sec`);
      await clearBar();
      await touch(p.x, p.y, dcol.l + dcol.w / 2, dcol.b + 24, 16, 700);
      step("A37 看板上长按拖进隔壁那一列:写进了「进行中」", !!(await until(`document.querySelector('#timeline [data-id="${todo}"]')?.closest(".tl-group")?.dataset.col==="doing"`, 4000)), await colOf(todo));
      step("A37 回执「已移到「进行中」」", !!(await barIs(/^已移到「进行中」$/.toString(), 3000)), await barText());
      await clickBarAct("撤销");
      step("A37 撤销:回到「待办」原位", !!(await until(`[...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > article.card[data-id]')].findIndex(c=>c.dataset.id===${J(todo)})===${idx0}`, 4000)), { idx0 });
      // ⚠ 上面那一下拖进的是**隔壁**那一列 —— 长按没接上的话,同样的手势会被横滑接走、结果一模一样(JS 刀实跑撞到的空测)。
      // ⇒ 再在同一列里往下拖过下一张的中线:横滑做不到列内换序,竖着挪又是滚页面,只有长按拿起来才挪得动。
      const p2 = await centerOf(todo);
      const below = await evalJs(`(()=>{const cs=[...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > article.card[data-id]')];const i=cs.findIndex(c=>c.dataset.id===${J(todo)});const t=cs[i+1];const r=t.getBoundingClientRect();return {y:Math.min(r.top+r.height*0.75,innerHeight-24),mid:r.top+r.height/2,n:cs.length}})()`);
      if (step("A37 前置:「待办」里至少两张、下一张的中线在屏上", below.n >= 2 && below.y > below.mid + 4, below)) {
        await clearBar();
        await touch(p2.x, p2.y, p2.x, below.y, 16, 700);
        const idx1 = await until(`(()=>{const i=[...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > article.card[data-id]')].findIndex(c=>c.dataset.id===${J(todo)});return i!==${idx0}?i:0})()`, 4000);
        step("A37 看板上长按在同一列里往下拖:换了位置、回执「已挪到这里」", idx1 > idx0 && !!(await barIs(/^已挪到这里$/.toString(), 3000)), { idx0, idx1, bar: await barText() });
        await clickBarAct("撤销");
        step("A37 撤销:回到原位", !!(await until(`[...document.querySelectorAll('#timeline > .tl-group[data-col="todo"] > article.card[data-id]')].findIndex(c=>c.dataset.id===${J(todo)})===${idx0}`, 4000)), { idx0 });
      }
    }
    // A36 看板上点「设置」:整页换
    await click("#settings-toggle");
    await until(`!document.getElementById("settings-pane").hidden`, 3000);
    await sleep(400);
    const s36 = await evalJs(`(()=>{const h=document.querySelector("#settings-pane h2").getBoundingClientRect();return {board:document.body.classList.contains("board"),tl:getComputedStyle(document.getElementById("timeline")).display,h2:h.top,head:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--head-h"))}})()`);
    step("A36 看板上点「设置」:整页换(时间轴收起、设置标题在顶栏下)", s36.tl === "none" && s36.h2 >= s36.head && s36.h2 < s36.head + 60, s36);
    await snap("A36-settings-from-board");
    await closePanes();

    // A30 横放看大图
    await mode("ideas");
    const nine = await evalJs(`(()=>{const c=[...document.querySelectorAll("#timeline article.card[data-id]")].find(c=>c.querySelectorAll(".thumb[data-img]").length>=5);if(!c)return null;c.scrollIntoView({block:"center"});return c.dataset.id})()`);
    if (step("A30 前置:有一张多图随记", !!nine)) {
      await sleep(800);
      // 点一张**露在吸顶区之下**的缩略图(屏外那几张字节还没取,点了不开;压在吸顶筛选条底下的那几张点到的是筛选条):先把第五张摆到屏中
      await dropIme();
      await evalJs(`(()=>{const ts=[...document.querySelectorAll('#timeline [data-id="${nine}"] .thumb[data-img]')];ts[Math.min(4,ts.length-1)].scrollIntoView({block:"center"});return 1})()`);
      await sleep(800);
      // ⚠ 真点(adb tap),别用页内 click():前面 A37 长按拖过一次,carddrag 留着「吞掉抬手后那一记 click」的标记,要等下一记 pointerdown
      // 才清 —— 真手指点下去先有 pointerdown,页内 click() 没有,会被它当成拖完那一记吞掉。
      const th = await evalJs(`(()=>{const cs=getComputedStyle(document.documentElement);const band=(parseFloat(cs.getPropertyValue("--head-h"))||0)+(parseFloat(cs.getPropertyValue("--fbar-h"))||0)+28;const t=[...document.querySelectorAll('#timeline [data-id="${nine}"] .thumb[data-img]')].find(b=>{const r=b.getBoundingClientRect();return r.top>band&&r.bottom<innerHeight-8});if(!t)return null;const r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      if (th) await tap(th.x, th.y);
      await until(`!document.getElementById("viewer").hidden`, 3000);
      await sleep(900);
      const v = await evalJs(`(()=>{const i=document.getElementById("viewer-img").getBoundingClientRect();const c=document.getElementById("viewer-cap").getBoundingClientRect();return {ih:innerHeight,sat:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat"))||0,imgTop:i.top,imgH:i.height,capBottom:c.bottom}})()`);
      step("A30 横放看大图:图顶在状态栏之下、「图N · n/9」那行在视口里", v.imgH > 50 && v.imgTop >= v.sat - 1 && v.capBottom <= v.ih, v);
      await snap("A30-viewer-landscape");
      await backIf(`!document.getElementById("viewer").hidden`);
      await until(`document.getElementById("viewer").hidden`, 3000);
    }
    await rotate(false);

    // A26③:设置「本机别名」打着字转横
    await closePanes();
    await click("#settings-toggle");
    await until(`!document.getElementById("settings-pane").hidden`, 3000);
    await evalJs(`(()=>{document.getElementById("alias-input").scrollIntoView({block:"center"});return 1})()`);
    await sleep(600);
    if (await evalJs(`!document.getElementById("alias-input").disabled`)) {
      await tapEl("#alias-input");
      await until(`document.documentElement.classList.contains("kb-up")`, 4000);
      await rotate(true);
      await sleep(500);
      const a26 = await evalJs(`(()=>{const r=document.getElementById("alias-input").closest(".row").getBoundingClientRect();const head=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--head-h"));return {top:r.top,bottom:r.bottom,head,ih:innerHeight,kb:document.documentElement.classList.contains("kb-up"),focus:document.activeElement.id}})()`);
      step("A26「本机别名」打着字转横:框和「保存」那一行整个在可见区", a26.kb && a26.focus === "alias-input" && a26.top >= a26.head - 1 && a26.bottom <= a26.ih + 1, a26);
      await snap("A26-alias-landscape");
      await dropIme();
      await rotate(false);
    } else step("A26 别名框(没读到本机设备,框是灰的)", "skip");
    await closePanes();

    // ── A21:空着时标签行不占位(临时空间;879 翻案)──────────────────────────────
    await mode("ideas");
    tempSp = await inv("create_space", { name: "W165M2" });
    await inv("activate_space", { spaceId: tempSp });
    await evalJs(`(()=>{localStorage.setItem("zhujian.last-space",${J(tempSp)});location.reload();return 1})()`);
    await sleep(3500);
    await armKnife();
    curSp = tempSp;
    const ra = await inv("capture_idea", { content: `${M} 甲` });
    await inv("capture_idea", { content: `${M} 乙` });
    const reloadIdeas = async () => {
      await evalJs(`(()=>{location.reload();return 1})()`);
      await sleep(3500);
      await armKnife();
      await until(`document.querySelectorAll("#timeline article.card[data-id]").length>0`, 5000);
      await sleep(400);
    };
    const FIRST = `(()=>{const c=document.querySelector("#timeline article.card[data-id]");const fb=document.getElementById("filterbar");const tp=document.getElementById("filter-topics").getBoundingClientRect(),ft=document.getElementById("filter-text").getBoundingClientRect();return {top:c.getBoundingClientRect().top,fb:fb.getBoundingClientRect().height,cls:fb.className,tags:document.getElementById("filter-topics").childElementCount,topicsBelow:tp.height>1&&tp.top>=ft.bottom-1}})()`;
    await reloadIdeas();
    const r0 = await evalJs(FIRST);
    step("A21 一枚标签都没有:标签行不在过滤框下面另占一行(879 用户拍不占位)", r0.tags === 0 && r0.topicsBelow === false, r0);
    await snap("A21-no-reserve");
    await inv("file_note_to_topic", { id: ra, topicId: null, newTitle: "9" });
    await reloadIdeas();
    const r1 = await evalJs(FIRST);
    step("A21 挂上第一个标签:标签行长出来", r1.tags > 0, { before: r0, after: r1 });
    await snap("A21-first-tag");
    await inv("promote_note_to_task", { id: ra, title: `${M} 甲` });
    await reloadIdeas();
    const r2 = await evalJs(FIRST);
    step("A21 转待办(标签行又空了):卡回到第一拍的位置、标签行仍不占", r2.tags === 0 && r2.topicsBelow === false && Math.abs(r2.top - r0.top) < 0.5, { before: r0, after: r2 });
  } catch (e) {
    out.runError = String(e?.stack ?? e);
  } finally {
    // ── 清场 ───────────────────────────────────────────────────────────────────
    try {
      await dropIme();
      if (tempSp) {
        await evalJs(`(()=>{localStorage.setItem("zhujian.last-space",${J(mainSp)});return 1})()`);
        await evalJs(`window.__TAURI__.core.invoke("activate_space",{spaceId:${J(mainSp)}})`).catch(() => {});
        await evalJs(`(()=>{location.reload();return 1})()`);
        await sleep(3500);
        await evalJs(`window.__TAURI__.core.invoke("reset_space",{spaceId:${J(tempSp)}})`).catch(() => {});
      }
      curSp = mainSp;
      await clearBar();
      await closePanes();
      const mine = (x) => (x.content ?? x.title ?? "").startsWith(M);
      for (const r of (await inv("list_timeline")).filter((x) => mine(x))) await inv("archive_note", { id: r.id }).catch(() => {});
      for (const r of (await inv("list_docs")).filter(mine)) await inv("archive_note", { id: r.id }).catch(() => {});
      for (const r of (await inv("list_trash")).filter(mine)) await inv("purge_note", { id: r.id }).catch(() => {});
      const left = [...(await inv("list_timeline")).filter(mine), ...(await inv("list_trash")).filter(mine), ...(await inv("list_docs")).filter(mine)];
      const spacesLeft = (await evalJs(`window.__TAURI__.core.invoke("list_spaces")`)).filter((x) => x.name === "W165M2");
      step("清场:探针条目零残留(时间轴、回收站、长文)、临时空间已删", left.length === 0 && spacesLeft.length === 0, { left: left.map((x) => x.id), spacesLeft });
      await evalJs(`(()=>{document.getElementById("w165m2-knife")?.remove();window.scrollTo(0,0);return 1})()`);
    } catch (e) {
      step("清场", false, String(e?.message ?? e));
    }
    await shell("settings", "put", "system", "user_rotation", rot0.user).catch(() => {});
    await shell("settings", "put", "system", "accelerometer_rotation", rot0.acc).catch(() => {});
    s.close();
  }
  out.pass = !out.runError && out.steps.length > 0 && out.steps.every((x) => x.ok === true || x.ok === "SKIPPED");
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
