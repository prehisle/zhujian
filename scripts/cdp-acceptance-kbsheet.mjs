// 软键盘避让(`MainActivity.applyImeInsets()` + `android/src/kbsheet.ts`)的回归网。
//
// **这一版守的东西和上一版不是同一件事**(2026-08-28 重写)。上一版守的是一套「JS 自己猜键盘
// 多高、把层 transform 上去」的机器(抢先抬 280px + kb-absent 学习计数),那套已经整个退休 ——
// 病根查清了:**WebView 直接缩 visual viewport 是 M139 才有的能力**(官方版本表见
// developer.android.com/develop/ui/views/layout/webapps/understand-window-insets),而
// `enableEdgeToEdge()` 之后窗口也不再为输入法收缩 ⇒ 在 WebView 138 的机器上(vivo V1986A /
// Android 12)页面里 `innerHeight` / `visualViewport` / `scrollY` **一个数都不动**,层贴
// `bottom:0` 就贴到了键盘底下,而前端怎么写都够不着。修法在原生侧:把 ime inset 变成内容视图
// 的 padding、并把 ime 那格归零再往下发。
//
// 于是本资产守三根轴:
//  ① **背景一格不动**(240 的核心契约)—— `scrollY` 与 `visualViewport.offsetTop` 全程恒 0,
//     外加机制那两格(锁上了 / 解掉了)。⚠ 视口改成真缩之后这个老患**换了个形回来**:键盘一起
//     Chromium 会滚文档去露焦点输入框(真机 A/B 各 5 次:不锁 5/5 滚 +277px,锁上 5/5 不动),
//     修法 = 开层期间 `html.kb-locked { overflow:hidden }`(kbsheet.ts)。
//  ② **键盘一起,视口真的缩了**(原生那半的正面字据)+ **层底沿贴着可见区底沿**(既不在键盘
//     底下、也不停在半空)+ **transform 全程归 CSS**(JS 没再抬)。
//  ③ **收层后视口复原**(`innerHeight` 回到基线)—— 守的是原生侧那个选择:归零用
//     `Insets.NONE` 而**不是** `WindowInsetsCompat.CONSUMED`,后者会让 WebView 收不到后续
//     inset 更新、键盘收起时留下「幽灵 padding」(官方文档点名的坑)。
//
// ⚠ 诚实边界(四条,别把它的绿读大):
//  ① **CDP 唤不起真键盘**,故开层一律走 `adb shell input tap` 真点 FAB;IME 的「∨ 收起键」
//     本资产**不碰**(那要按屏幕坐标,绑设备分辨率+ROM)⇒ 「收键盘→再唤起」那一环仍未覆盖。
//  ② 只覆盖**捕获层**(`#compose-card`)。留言层(`.cmsheet`)共用同一份 kbsheet.ts,但入口
//     不同(要先开一张卡),不在本资产内。
//  ③ 「背景不滚」这一格要文档真的可滚才有意义。⛔ 上一版在这里认栽(空库就记 SKIPPED),而这台
//     测试机恰好空库 ⇒ 那两格一直是空测,偏偏这轮真机 A/B 证明背景确实会滚。现在**台架自己
//     往时间轴尾巴塞一个高 div** 把文档撑起来(只动 DOM、不写数据),跑完摘掉。
//  ④ **没有软键盘的设备**(模拟器 / 接了物理键盘的平板)上轴 ②③ 的「键盘」那半没有对象 ——
//     如实标 SKIPPED 而不是绿(轴 ① 与「transform 归 CSS」照样成立、照样判)。⛔ 这条退路
//     **只由系统的 `mInputShown` 打开**,页面里的读数说了不算(见 imeShown 那段:首版拿视口
//     缩没缩当分类判据,结果刀 A 下整个转成 SKIPPED-绿)。
//
// 跑法:
//   node scripts/build-android.mjs --devtools
//   node scripts/android-install-auto.mjs <apk> && adb shell monkey -p app.zhujian.notebook -c android.intent.category.LAUNCHER 1
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-kbsheet.mjs        # 打印 {pass, deviceClass, steps}
// 多台设备同连时 `export ANDROID_SERIAL=<serial>`(与 android-cdp.mjs 同一个出口)。
//
// 阴性对照(三把,各守一根轴;**三把都在 2026-08-28 真机实跑过**,改完记得还回去。
// ⚠ 每把都要重建 APK,一把约 4 分钟;⛔ 构建那步的退出码要真读 —— 有一趟 build 挂了而后面的
// `adb install` 照旧把**上一只**包装了上去,那一跑整份是废的,差点当成结论)。
//  A. ✅ 把 `MainActivity.onWebViewCreate` 里的 `applyImeInsets()` 注释掉
//     ⇒ 红两格:`键盘起时视口真的缩了`(系统报键盘已起,而 innerHeight 802→802 一动不动)与
//       连坐的 `层底沿贴着可见区底沿`。其余六格照常绿。
//     ⭐ 这把最值钱,而且**它当场逮到了本资产自己的一个洞**:首版把「视口缩没缩」当设备分类
//       判据,于是这一刀下来资产不但没红,还认定「这台没有软键盘」⇒ 三格一起转成 SKIPPED-绿。
//       改成问系统 `mInputShown` 之后才真红。⛔ 别把那个判据改回页面自己的读数。
//  B. ✅ 在 `kbsheet.open()` 里加回一句抢先抬(`sheet.style.transform = "translateY(-280px)"`)
//     ⇒ 红两格:`transform 全程归 CSS`(owners=inline)与 `滑入动画真在跑`(中间值 0 —— 抢先抬
//       是瞬移,过场没了)。⚠ 那一刀下层停在 bottom 229 / 可见区 509 = 停在半空,而首版的
//       「层在可见区内」判据**放过了它** ⇒ 判据已收紧成「贴着底沿(±2px)」。
//  C. ✅ 拿掉 `open()` 里的 `setLock(true)`(即不锁背景滚动)
//     ⇒ 红两格:`背景不滚-scrollY 全程不变`(300 一路滚到 557,14 个不同值)与
//       `开层期间背景滚动锁上着`。其余九格全绿 —— 说明锁那根轴是独立可证伪的。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = 9222;

// execFile 直调 adb.exe、参数逐个透传 ⇒ 不过 bash/MSYS(memory `gitbash-slash-flag-conversion-trap`)。
// 异步不同步:同步 exec 会把事件循环堵死(memory `self-service-probe-sync-exec-deadlock`)。
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「此刻软键盘到底起没起」—— **必须问系统,不许问页面**。
//
// ⚠ 这是 2026-08-28 阴性对照当场逮出来的洞:首版拿「视口缩没缩」当设备分类判据,于是把
// `applyImeInsets()` 整个注释掉之后,资产不但没红,反而认定「这台设备没有软键盘」⇒ 三格
// 一起转成 SKIPPED-绿。**判据与被测对象同源就无法证伪**(memory `verification-independence`)。
// 现在由系统的 IME 状态当法官:它与我们改的那条 inset 链路完全无关。
// fail-closed:读不出这一位就返回 null,调用处判红并说明理由,⛔ 不许当成「没键盘」。
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

  // 页内取值。⚠ 一律 IIFE 包起来:`eval` 的每一发跑在同一个全局作用域里,顶层 const 第二次
  // 就是 SyntaxError、整段一行不执行(skill 里那条踩过两轮的坑)。
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };

  // 采样器:rAF 逐帧记 [t, translateY, vvH, innerH, vvTop, scrollY, owner, 层底沿]。
  // owner = transform 归谁管(css=交给 CSS 了 / inline=JS 又插手了),这是轴 ② 最后一格的观测面。
  const ARM = `(()=>{
    const s=document.getElementById("compose-card"),vv=visualViewport,f=document.getElementById("capture-fab");
    window.__kb=[];const t0=performance.now();let stop=false;
    setTimeout(()=>{stop=true},2800);
    (function loop(){ if(stop)return;
      const m=new DOMMatrixReadOnly(getComputedStyle(s).transform);
      window.__kb.push([Math.round(performance.now()-t0),Math.round(m.m42*10)/10,
        Math.round(vv.height),innerHeight,Math.round(vv.offsetTop),Math.round(scrollY),
        s.style.transform===""?"css":"inline",Math.round(s.getBoundingClientRect().bottom)]);
      requestAnimationFrame(loop);})();
    const r=f.getBoundingClientRect();
    return JSON.stringify({fabHidden:f.hidden,baseIH:innerHeight,locked:document.documentElement.classList.contains("kb-locked"),
      fabDev:[Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)]});
  })()`;
  const READ = `JSON.stringify(window.__kb||[])`;
  const CLOSE = `(()=>{const s=document.getElementById("compose-card");
    if(s.classList.contains("open"))document.getElementById("capture-scrim").click();return s.className})()`;

  // ---- 前置:关掉可能开着的层,量基线视口高 ------------------------------------
  await evalJs(CLOSE);
  await sleep(800);
  const baseIH = await evalJs("innerHeight");

  // ⛔ 等 FAB 出现是**不够的**:它是静态元素、首帧就在,而时间轴是异步 invoke 回来才长出来。
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const ready = await evalJs(
      `(()=>{const f=document.getElementById("capture-fab");return !!f&&!f.hidden&&!!document.getElementById("timeline")})()`,
    ).catch(() => false);
    if (ready) break;
  }
  step("前置-量到基线视口高", baseIH > 0, `innerHeight=${baseIH}`);

  // 「背景不滚」这一格**要文档真的可滚**才有意义。⚠ 上一版在这里认栽:库里条目不够就记 SKIPPED,
  // 而这台测试机恰好是空库 ⇒ 那两格一直是空测,**而 2026-08-28 真机 A/B 证明背景确实会滚 +277px**
  // (5/5)。所以现在由台架**自己把文档撑高**:往时间轴尾巴上塞一个纯装饰的高 div(只动 DOM、
  // 不写任何数据),跑完摘掉。⛔ 别退回 SKIPPED —— 那等于把这轮真正修的东西放空。
  const scrolled = await evalJs(`(()=>{
    let sp=document.getElementById("__kbspacer");
    if(!sp){sp=document.createElement("div");sp.id="__kbspacer";sp.style.height="1600px";
      document.getElementById("timeline").appendChild(sp);}
    const e=document.scrollingElement;e.scrollTop=300;return e.scrollTop})()`);
  step("前置-背景已撑高并推到 scrollTop=300(否则「不滚」是假绿)", scrolled === 300, `scrollTop=${scrolled}`);

  // ---- 两轮开层(第二轮验重复开层不漂移)---------------------------------------
  const rounds = [];
  const lockedWhileOpen = [];
  const imeUp = [];
  for (let i = 1; i <= 2; i++) {
    const armed = JSON.parse(await evalJs(ARM));
    if (armed.fabHidden) throw new Error(`第 ${i} 轮:FAB 是隐的(上一轮没关干净?)`);
    // ⚠ 必须 adb 真点:CDP 合成 focus 不弹系统键盘,那样有键盘的设备也会被测成没键盘。
    await adb(["shell", "input", "tap", String(armed.fabDev[0]), String(armed.fabDev[1])]);
    await sleep(3100);
    imeUp.push(await imeShown()); // ⚠ 独立法官:问系统,别问页面(见 imeShown 那段的由头)
    lockedWhileOpen.push(await evalJs(`document.documentElement.classList.contains("kb-locked")`));
    rounds.push(JSON.parse(await evalJs(READ)));
    await evalJs(CLOSE);
    await sleep(1200);
  }
  // 收层 + 键盘落下之后视口该回到基线(轴 ③:幽灵 padding 的哨兵)。
  const afterIH = await evalJs("innerHeight");
  const lockedAfterClose = await evalJs(`document.documentElement.classList.contains("kb-locked")`);
  // 台架自己塞的那个高 div 摘掉(纯 DOM,不涉数据)。
  await evalJs(`(()=>{const s=document.getElementById("__kbspacer");if(s)s.remove();return 1})()`);

  const allRows = rounds.flat();
  const tY = (r) => r.map((x) => x[1]);
  const owners = (r) => new Set(r.map((x) => x[6]));
  // 「键盘起来了」的唯一判据:视口比基线矮了一大截(原生 ime inset 一到,视图就真缩)。
  const shrunk = (rows) => rows.some((x) => baseIH - x[3] > 80);
  const minIH = (rows) => Math.min(...rows.map((x) => x[3]));

  // ⛔ 设备分类只认系统那位,**不认视口有没有缩** —— 后者正是被测对象本身。
  const imeKnown = imeUp.every((v) => v !== null);
  const hasKb = imeKnown && imeUp.every(Boolean);
  out.deviceClass = !imeKnown
    ? "判不出(读不到系统 IME 状态)"
    : hasKb
      ? "有软键盘(两轮系统都报 mInputShown=true)"
      : "无软键盘(模拟器/物理键盘)";

  // ---- 轴 ①:背景一格不动(两类设备共同,240 的核心契约)------------------------
  const vvTopMax = Math.max(...allRows.map((x) => x[4]));
  const scrollSpread = new Set(allRows.map((x) => x[5])).size;
  step("背景不滚-visualViewport.offsetTop 恒 0", vvTopMax === 0, `max=${vvTopMax}`);
  step(
    "背景不滚-scrollY 全程不变",
    scrollSpread === 1,
    `出现过 ${scrollSpread} 个不同值:${[...new Set(allRows.map((x) => x[5]))].join()}`,
  );
  // 上一格是「结果」,这两格是「机制」:锁真的上了、也真的解了(解不掉 = 收层后背景再也滚不动)。
  step("开层期间背景滚动锁上着", lockedWhileOpen.every(Boolean), `两轮=${lockedWhileOpen.join()}`);
  step("收层后锁解掉了", lockedAfterClose === false, `locked=${lockedAfterClose}`);

  // ---- 轴 ②:视口真的缩了 + 层在可见区内 + JS 没插手几何 -----------------------
  if (!imeKnown) {
    // fail-closed:法官都没到场,不许放行(⛔ 别退回「那就当没键盘吧」)。
    step("前置-读得到系统 IME 状态", false, `imeUp=${JSON.stringify(imeUp)}(dumpsys input_method 里没有 mInputShown)`);
  } else if (hasKb) {
    const shrankOk = rounds.every(shrunk);
    step(
      "键盘起时视口真的缩了(原生 ime inset 在位)",
      shrankOk,
      `系统报键盘已起;基线 ${baseIH} → 两轮最矮 ${rounds.map(minIH).join(" / ")}`,
    );
    // 层整个落在可见区内 = 用户看得见它。
    // ⛔ **必须与上一格连坐**:视口不缩时层贴 bottom:0 也满足「在可见区内」,只是那片可见区
    // 整个被键盘盖着 —— 那正是病根,却会在这里报绿(2026-08-28 阴性对照实证:刀 A 下本格
    // 曾以 bottom 803 ≤ visible 803 通过)。页面自报的「可见区」只有在视口真缩时才可信。
    const tails = rounds.map((r) => r[r.length - 1]);
    const fits = tails.map((t) => ({ bottom: t[7], visible: t[2], ok: Math.abs(t[7] - t[2]) <= 2 }));
    step(
      "层底沿贴着可见区底沿(不在键盘下、也不在半空)",
      shrankOk && fits.every((f) => f.ok),
      shrankOk ? JSON.stringify(fits) : "视口没缩 ⇒ 页面自报的可见区不可信,本格连坐判红",
    );
    step(
      "收层后视口复原(没有幽灵 padding)",
      afterIH === baseIH,
      `基线 ${baseIH} → 收层后 ${afterIH}`,
    );
  } else {
    step(
      "键盘起时视口真的缩了(原生 ime inset 在位)",
      true,
      `⚠ SKIPPED:**系统报这台没弹软键盘**(mInputShown=false,模拟器/物理键盘)⇒ 本格与「层在可见区内」「视口复原」在这台上是空测。` +
        `⛔ 这条退路只由系统那位打开,视口缩没缩说了不算 —— 否则把 ime inset 拆掉也会走到这里(2026-08-28 阴性对照实证)`,
    );
  }
  step("transform 全程归 CSS(JS 没再抬)", !owners(allRows).has("inline"), `owners=${[...owners(allRows)].join()}`);
  // 防「交给了 CSS 但根本没动画」的假绿:滑入过程该有一串中间值。
  const mids = new Set(tY(rounds[0]).filter((y) => y > 1 && y < 135)).size;
  step("滑入动画真在跑(≥3 个中间值)", mids >= 3, `中间值 ${mids} 个`);

  cdp.close();
  out.pass = out.steps.every((s) => s.ok);
  return out;
};

const res = await main().catch((e) => ({ pass: false, error: String(e && e.stack ? e.stack : e) }));
console.log(JSON.stringify(res, null, 2));
process.exit(res.pass ? 0 : 1);
