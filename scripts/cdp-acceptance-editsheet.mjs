// 编辑层(706)的软键盘避让回归网 —— `kbsheet.ts` 的**第三位租客**。
//
// 为什么要单独一支:`cdp-acceptance-kbsheet.mjs` 的诚实边界 ② 写着「只覆盖捕获层
// (`#compose-card`)」—— 入口不同的层它进不去。706 把「编辑」从卡片内联搬到了屏底这座层
// (`android/src/editsheet.ts`),入口是**先开一张卡的操作面、再点编辑**,且它比捕获层多两样
// 东西:`reserveTop = 56`(限高,层顶不许被顶出屏外)与一行「取消 / 保存」按钮 —— 而 706 的
// 起因之一正是「浮动 ＋ 盖住了保存钮」。⇒ 这两样都得在**真软键盘**下量,而模拟器弹不出键盘
// (skill 里那条 503),所以本资产只在 vivo 上有意义。
//
// 守五根轴(前三根与 kbsheet 同源,后两根是编辑层独有的):
//  ① **背景一格不动**:`scrollY` 与 `visualViewport.offsetTop` 全程恒定,外加机制两格
//     (开层期间 `html.kb-locked` 上着 / 收层后解掉)。⚠ 这根轴的「结果」那格在当前这台
//     vivo 上**证伪不了**(等价的刀下去照样绿),别读成守住了 —— 由头与边界见下面刀 B。
//  ② **键盘一起视口真的缩了**(原生 `applyImeInsets()` 在位的正面字据)+ **层底沿贴着可见区
//     底沿** + **transform 全程归 CSS**(JS 没再插手几何)。
//  ③ **收层后视口复原**(没有幽灵 padding)。
//  ④ **保存钮整个在可见区内**(706 的用户面主诉:从前被浮动 ＋ 盖着)+ **浮动 ＋ 全程不可见**
//     (`body.panel-open #capture-fab{display:none}` 那条的地面真相)。
//  ⑤ **限高真的夹住了**:层顶 ≥ `RESERVE_TOP`(56),且 textarea 还剩得下可写高度 ——
//     键盘一起可见区只剩一半,这是「层没被顶出屏外、也没把输入框压成一条缝」的判据。
//
// ⚠ 诚实边界(四条,别把它的绿读大):
//  ① **没有软键盘的设备**(MuMu / 接物理键盘)上轴 ②③④⑤ 的键盘那半没有对象 —— 如实标
//     SKIPPED 而不是绿。⛔ 这条退路**只由系统的 `mInputShown` 打开**,页面里的读数说了不算
//     (2026-08-28 kbsheet 的刀 A 实证:拿「视口缩没缩」当分类判据,把 ime inset 整个拆掉
//     也会走到这条退路上,三格一起转成 SKIPPED-绿)。
//  ② 本资产**一个字都不写库**:它借用户库里现成的一张卡开编辑层,不打字、只点取消,末尾回读
//     卡片正文当字据。⛔ 别为了省事改成「自己建一张卡再删」—— 那要走两拍确认删+回收站销毁,
//     在用户日常在用的机器上多一条留残渣的路(639 就是那么在真机回收站里攒下三条的)。
//  ③ IME 的「∨ 收起键」不碰(要按屏幕坐标、绑设备分辨率+ROM),「收键盘→层怎么办」未覆盖。
//  ④ 脏稿闸(`onDismiss` 时 `isDirty()` 拦截)不在本资产内 —— 那要打字,与边界 ② 冲突。
//
// 跑法(设备上得是 devtools 包,且 app 在前台):
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-editsheet.mjs          # 打印 {pass, deviceClass, steps}
// 多台设备同连时 `export ANDROID_SERIAL=<serial>`(与 android-cdp.mjs 同一个出口)。
//
// 阴性对照(三把,**全部页内注入、零重建**,2026-09-19 在 vivo/Android 16 上各跑过一趟)。
// 下刀:`node scripts/android-cdp.mjs eval '<注入>'` → 跑本资产 → 再 eval 那句 remove 还回去。
//  A. ✅ 守轴 ④:把层整个推到可见区下面
//     注入 `(()=>{const s=document.createElement("style");s.id="__knife";
//            s.textContent="#edit-sheet.open{transform:translateY(96px)!important}";
//            document.head.appendChild(s);return 1})()`
//     ⇒ 实测红两格:`层底沿贴着可见区底沿`(bottom 612 / 可见 516)与 `保存钮整个在可见区内`
//       (钮 564–600 掉到 516 以下);其余十三格全绿,`transform 全程归 CSS` 也照常绿
//       (刀改的是 CSS 不是 inline)⇒ 轴 ④ 独立可证伪。
//  B. ⚠⚠ **这把刀没红,而刀本身是生效的** —— 记在这儿当边界,⛔ 别读成「轴 ① 守住了」。
//     注入 同上但 `textContent="html.kb-locked{overflow:auto!important}"`
//     (页内量过 `getComputedStyle(document.documentElement).overflow`:hidden → auto,
//      锁的**效果**确实被拆掉了,不是刀没落上)
//     ⇒ 本资产 15 格全绿;**同一把刀改测捕获层 `cdp-acceptance-kbsheet.mjs` 也全绿**。
//     即:这台机器上「键盘一起 Chromium 滚文档去露焦点框」那个现象**当前根本不发生**
//     ⇒ `背景不滚-scrollY 全程不变` 这一格在 vivo/Android 16 上是**空测**,证伪不了。
//     ⭐ 它在 2026-08-28 红过(kbsheet.mjs 刀 C:拿掉 `kbsheet.open()` 里的 `setLock(true)`,
//       scrollY 300 一路滚到 557)—— 那是**重建形**的刀。⇒ 轴留着别拆,但要重新验它只能走
//       重建形,CSS 刀在这台上接不住。
//     ❓ 未验的猜想(⛔ 别当结论传下去):原生 `applyImeInsets()` 把视口真缩了之后,焦点框
//       从来不会落到可见区外,浏览器也就没有「露焦点框」的动机。要证它得把原生那半拆掉重建。
//  C. ✅ 守轴 ⑤:把限高拆掉并把输入框撑高
//     注入 同上但 `textContent="#edit-sheet{max-height:none!important}#edit-text{min-height:1400px}"`
//     ⇒ 实测只红一格:`层顶不越 reserveTop(56)`(层顶 -953 = 整个顶出屏外)。
//  ⛔ 三把都改回去再收工:`node scripts/android-cdp.mjs eval '(()=>{const s=document.getElementById("__knife");if(s)s.remove();return !document.getElementById("__knife")})()'`
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = 9222;
const RESERVE_TOP = 56; // 与 android/src/editsheet.ts 的常量同值;改那边记得改这里

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「此刻软键盘到底起没起」—— 必须问系统,不许问页面(与 kbsheet.mjs 同一位法官,由头在那支的
// imeShown 那段:判据与被测对象同源就无法证伪)。fail-closed:读不出就 null,调用处判红。
async function imeShown() {
  const out = await adb(["shell", "dumpsys", "input_method"]).catch(() => null);
  if (!out) return null;
  const m = out.stdout.match(/mInputShown=(true|false)/);
  return m ? m[1] === "true" : null;
}

async function connect() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  const page = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page target——先 `node scripts/android-cdp.mjs forward`,且 app 在前台");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 20000);
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

const main = async () => {
  const out = { pass: false, deviceClass: null, steps: [] };
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: !!ok, detail: String(detail) });
    return !!ok;
  };

  const cdp = await connect();
  const { send } = cdp;
  // ⚠ 页内一律 IIFE:`Runtime.evaluate` 的每一发跑在同一个全局作用域里,顶层 const 第二次就是
  // SyntaxError、整段一行不执行(skill 里踩过两轮的 391)。
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (await evalJs(expr).catch(() => false)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  /** 取元素中心的**设备像素**坐标(`input tap` 吃这个;swipe 吃 CSS 视口坐标,别搞混——627)。 */
  const centerDev = async (sel) =>
    JSON.parse(
      await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e)return "null";const r=e.getBoundingClientRect();
        return JSON.stringify([Math.round((r.x+r.width/2)*devicePixelRatio),
          Math.round((r.y+r.height/2)*devicePixelRatio),Math.round(r.top)])})()`),
    );

  let spacerAdded = false;
  try {
    // ── 前置 ────────────────────────────────────────────────────────────────
    // 时间轴是异步 invoke 回来才长出来的,静态元素首帧就在 ⇒ 等的是卡片不是骨架。
    const ready = await until(`!!document.querySelector("#timeline [data-id]")`, 12000);
    if (!step("前置-时间轴有卡了", ready)) return out;

    // 层可能开着(cardPanel.restore 跨重画接回 / 上一支资产留下的)—— 先收干净再量基线。
    await evalJs(`(()=>{const s=document.getElementById("edit-sheet");
      if(s.classList.contains("open"))document.getElementById("edit-cancel").click();
      const c=document.getElementById("compose-card");
      if(c.classList.contains("open"))document.getElementById("capture-scrim").click();return 1})()`);
    await sleep(900);
    const baseIH = await evalJs("innerHeight");
    step("前置-量到基线视口高", baseIH > 0, `innerHeight=${baseIH}`);

    // 轴 ① 要文档**真的可滚**才不是空测。用户真机 94 条任务本来就够,但空库的测试机上不够 ⇒
    // 不够就自己塞一个高 div 撑起来(只动 DOM、不写数据),跑完摘掉。⛔ 别退回 SKIPPED。
    const scrolled = await evalJs(`(()=>{const e=document.scrollingElement;
      let added=false;
      if(e.scrollHeight-e.clientHeight<600){let sp=document.getElementById("__esspacer");
        if(!sp){sp=document.createElement("div");sp.id="__esspacer";sp.style.height="1600px";
          document.getElementById("timeline").appendChild(sp);added=true;}}
      e.scrollTop=300;return JSON.stringify([e.scrollTop,added])})()`);
    const [scrollTop, added] = JSON.parse(scrolled);
    spacerAdded = added;
    step("前置-背景可滚且已推到 scrollTop=300(否则「不滚」是假绿)", scrollTop === 300, `scrollTop=${scrollTop}${added ? "(台架撑高)" : "(用户真库自带)"}`);

    // 挑一张**整个落在可见区内**的卡:要真 tap 它的编辑钮,半张在屏外的坐标点不准。
    const picked = JSON.parse(
      await evalJs(`(()=>{const vh=visualViewport.height;
        const c=[...document.querySelectorAll("#timeline [data-id]")].find(x=>{
          const r=x.getBoundingClientRect();return r.top>8&&r.bottom<vh-72&&r.height>40;});
        if(!c)return "null";
        return JSON.stringify({id:c.dataset.id,text:(c.querySelector(".content")?.textContent??"").slice(0,80)})})()`),
    );
    if (!step("前置-挑到一张整卡在可见区内", !!picked, picked ? `id=${picked.id}` : "没有整卡在可见区内")) return out;
    const cardSel = `#timeline [data-id="${picked.id}"]`;

    // 开操作面(合成点击够用:这一步不需要弹键盘)。⚠ 面可能本来就开着,再点一次是**收** ⇒
    // 先看编辑钮在不在,别盲点(skill 里那条)。
    if (!(await evalJs(`!!document.querySelector('${cardSel} .panel [data-pact="edit"]')`))) {
      await evalJs(`(()=>{document.querySelector('${cardSel} .content').click();return 1})()`);
    }
    if (!step("前置-卡片操作面开着、编辑钮在", await until(`!!document.querySelector('${cardSel} .panel [data-pact="edit"]')`, 3000)))
      return out;

    // ── 采样器 ───────────────────────────────────────────────────────────────
    // rAF 逐帧记 [t, translateY, vvH, innerH, vvTop, scrollY, owner, 层底, 层顶, 输入框高,
    //            保存钮顶, 保存钮底, 浮动＋可见吗]
    const ARM = `(()=>{const s=document.getElementById("edit-sheet"),vv=visualViewport;
      const sv=document.getElementById("edit-save"),ta=document.getElementById("edit-text");
      const fab=document.getElementById("capture-fab");
      window.__es=[];const t0=performance.now();let stop=false;
      setTimeout(()=>{stop=true},2800);
      (function loop(){ if(stop)return;
        const m=new DOMMatrixReadOnly(getComputedStyle(s).transform);
        const r=s.getBoundingClientRect(),b=sv.getBoundingClientRect();
        window.__es.push([Math.round(performance.now()-t0),Math.round(m.m42*10)/10,
          Math.round(vv.height),innerHeight,Math.round(vv.offsetTop),Math.round(scrollY),
          s.style.transform===""?"css":"inline",Math.round(r.bottom),Math.round(r.top),
          Math.round(ta.getBoundingClientRect().height),Math.round(b.top),Math.round(b.bottom),
          (fab&&fab.offsetParent!==null)?1:0]);
        requestAnimationFrame(loop);})();
      return JSON.stringify({open:s.classList.contains("open")})})()`;

    // ── 两轮开层(第二轮验重复开层不漂移)──────────────────────────────────
    const rounds = [];
    const lockedWhileOpen = [];
    const imeUp = [];
    for (let i = 1; i <= 2; i++) {
      const armed = JSON.parse(await evalJs(ARM));
      if (armed.open) throw new Error(`第 ${i} 轮:编辑层已经开着(上一轮没收干净?)`);
      // ⛔ 坐标要连读两拍相同了才用:面重渲/滚动没停时量到的是中途那一帧,点出去偏几十像素、
      //    落在别的元素上且一声不响(696 两台上各栽一次,与「轻点偶尔不落上」同形而重试无用)。
      let c = await centerDev(`${cardSel} .panel [data-pact="edit"]`);
      for (let k = 0; k < 6; k++) {
        await sleep(200);
        const c2 = await centerDev(`${cardSel} .panel [data-pact="edit"]`);
        if (c2 && c && c2[2] === c[2]) { c = c2; break; }
        c = c2;
      }
      if (!c) throw new Error(`第 ${i} 轮:编辑钮不见了`);
      // ⚠ 必须 adb 真点:CDP 合成 click 不弹系统键盘,那样有键盘的设备也会被测成没键盘。
      await adb(["shell", "input", "tap", String(c[0]), String(c[1])]);
      await sleep(3100);
      imeUp.push(await imeShown()); // 独立法官:问系统,别问页面
      lockedWhileOpen.push(await evalJs(`document.documentElement.classList.contains("kb-locked")`));
      rounds.push(JSON.parse(await evalJs(`JSON.stringify(window.__es||[])`)));
      // 收层走「取消」(合成点击够用)—— 没打过字就不脏,onDismiss 的脏稿闸不会拦。
      await evalJs(`(()=>{document.getElementById("edit-cancel").click();return 1})()`);
      await sleep(1400);
      if (!(await until(`!document.getElementById("edit-sheet").classList.contains("open")`, 3000)))
        throw new Error(`第 ${i} 轮:点了取消层没收`);
    }

    // 键盘落下 + 视口复原要等:轮询到基线为止,超时就拿最后一个数去判(别拿 sleep 顶)。
    await until(`innerHeight===${baseIH}`, 3000);
    const afterIH = await evalJs("innerHeight");
    const lockedAfterClose = await evalJs(`document.documentElement.classList.contains("kb-locked")`);

    const allRows = rounds.flat();
    const owners = new Set(allRows.map((x) => x[6]));
    const shrunk = (rows) => rows.some((x) => baseIH - x[3] > 80);
    const minIH = (rows) => Math.min(...rows.map((x) => x[3]));
    const tails = rounds.map((r) => r[r.length - 1]);

    const imeKnown = imeUp.every((v) => v !== null);
    const hasKb = imeKnown && imeUp.every(Boolean);
    out.deviceClass = !imeKnown
      ? "判不出(读不到系统 IME 状态)"
      : hasKb
        ? "有软键盘(两轮系统都报 mInputShown=true)"
        : "无软键盘(模拟器/物理键盘)";

    // ── 轴 ①:背景一格不动 ──────────────────────────────────────────────────
    const vvTopMax = Math.max(...allRows.map((x) => x[4]));
    const scrollVals = [...new Set(allRows.map((x) => x[5]))];
    step("背景不滚-visualViewport.offsetTop 恒 0", vvTopMax === 0, `max=${vvTopMax}`);
    step("背景不滚-scrollY 全程不变", scrollVals.length === 1, `出现过 ${scrollVals.length} 个值:${scrollVals.join()}`);
    step("开层期间背景滚动锁上着", lockedWhileOpen.every(Boolean), `两轮=${lockedWhileOpen.join()}`);
    step("收层后锁解掉了", lockedAfterClose === false, `locked=${lockedAfterClose}`);

    // ── 轴 ②③④⑤:键盘那半 ────────────────────────────────────────────────
    const shrankOk = rounds.every(shrunk);
    if (!imeKnown) {
      // fail-closed:法官没到场不许放行(⛔ 别退回「那就当没键盘吧」)。
      step("前置-读得到系统 IME 状态", false, `imeUp=${JSON.stringify(imeUp)}(dumpsys input_method 里没有 mInputShown)`);
    } else if (hasKb) {
      step(
        "键盘起时视口真的缩了(原生 ime inset 在位)",
        shrankOk,
        `系统报键盘已起;基线 ${baseIH} → 两轮最矮 ${rounds.map(minIH).join(" / ")}`,
      );
      // ⛔ 下面三格**必须与上一格连坐**:视口不缩时层贴 bottom:0 也满足「在可见区内」,只是那片
      //    可见区整个被键盘盖着 —— 那正是病根,却会报绿(kbsheet 刀 A 实证过同一个洞)。
      const fits = tails.map((t) => ({ bottom: t[7], visible: t[2], ok: Math.abs(t[7] - t[2]) <= 2 }));
      step(
        "层底沿贴着可见区底沿(不在键盘下、也不停在半空)",
        shrankOk && fits.every((f) => f.ok),
        shrankOk ? JSON.stringify(fits) : "视口没缩 ⇒ 页面自报的可见区不可信,本格连坐判红",
      );
      const saves = tails.map((t) => ({ top: t[10], bottom: t[11], visible: t[2], ok: t[10] >= 0 && t[11] <= t[2] + 1 }));
      step(
        "保存钮整个在可见区内(706 主诉:从前被浮动＋盖着)",
        shrankOk && saves.every((s) => s.ok),
        shrankOk ? JSON.stringify(saves) : "视口没缩 ⇒ 连坐判红",
      );
      const tops = tails.map((t) => ({ sheetTop: t[8], ok: t[8] >= RESERVE_TOP - 1 }));
      step(
        `层顶不越 reserveTop(${RESERVE_TOP})`,
        shrankOk && tops.every((t) => t.ok),
        shrankOk ? JSON.stringify(tops) : "视口没缩 ⇒ 连坐判红",
      );
      const tas = tails.map((t) => t[9]);
      step(
        "键盘起着时输入框仍有可写高度(≥48px)",
        shrankOk && tas.every((h) => h >= 48),
        `两轮 textarea 高 ${tas.join(" / ")}px`,
      );
      step("收层后视口复原(没有幽灵 padding)", afterIH === baseIH, `基线 ${baseIH} → 收层后 ${afterIH}`);
    } else {
      const why =
        `⚠ SKIPPED:**系统报这台没弹软键盘**(mInputShown=false,模拟器/物理键盘)⇒ 轴 ②③④⑤ 的键盘那半在这台上是空测。` +
        `⛔ 这条退路只由系统那位打开,视口缩没缩说了不算(kbsheet 2026-08-28 阴性对照实证)`;
      step("键盘起时视口真的缩了(原生 ime inset 在位)", true, why);
    }

    // ── 与键盘无关、两类设备共同的几格 ────────────────────────────────────
    step("transform 全程归 CSS(JS 没再插手几何)", !owners.has("inline"), `owners=${[...owners].join()}`);
    step("开层期间浮动＋不可见(body.panel-open 那条的地面真相)", allRows.every((x) => x[12] === 0), `可见帧数=${allRows.filter((x) => x[12] === 1).length}/${allRows.length}`);
    // 防「交给了 CSS 但根本没动画」的假绿:滑入过程该有一串中间值(收起态 translateY(110%))。
    const ys = rounds[0].map((x) => x[1]);
    const maxY = Math.max(...ys);
    const mids = new Set(ys.filter((y) => y > 1 && y < maxY - 1)).size;
    step("滑入动画真在跑(≥3 个中间值)", mids >= 3, `收起态 ${maxY} → 0,中间值 ${mids} 个`);

    // ── 收场:收掉操作面,回读卡片正文当「一个字都没写库」的字据 ──────────
    await evalJs(`(()=>{const c=document.querySelector('${cardSel} .content');if(c)c.click();return 1})()`);
    await sleep(600);
    const after = await evalJs(
      `(()=>{const c=document.querySelector('${cardSel} .content');return c?c.textContent.slice(0,80):null})()`,
    );
    step("卡片正文一字未改(本资产不写库)", after === picked.text, after === picked.text ? "同一串" : `前「${picked.text}」→ 后「${after}」`);
  } finally {
    if (spacerAdded)
      await evalJs(`(()=>{const s=document.getElementById("__esspacer");if(s)s.remove();return 1})()`).catch(() => {});
    cdp.close();
  }

  out.pass = out.steps.every((s) => s.ok);
  return out;
};

const res = await main().catch((e) => ({ pass: false, error: String(e && e.stack ? e.stack : e) }));
console.log(JSON.stringify(res, null, 2));
process.exit(res.pass ? 0 : 1);
