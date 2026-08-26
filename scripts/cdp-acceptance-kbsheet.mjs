// 软键盘避让层(`android/src/kbsheet.ts`)的回归网。
//
// **为什么此前没有**:232/240 那套避让是「绕了几轮才钉死」的(病根=本机 WebView 键盘弹起时
// 布局视口不缩、只有 visualViewport 缩,而浏览器靠「滚文档露出聚焦输入」来抬层 —— 那下滚动
// 正是「弹键盘背景乱滚」),当年靠手工 CDP 两轮验完就过去了,**一只资产都没留**。
// 2026-08-27 改这里时当场栽了一跤(见下面第 3 格),遂补网。
//
// 守两根轴:
//  ① **背景一格不动**(240 的核心契约)—— `scrollY` 与 `visualViewport.offsetTop` 全程恒 0。
//     ⚠ 判据只能是这两个量:`getBoundingClientRect` 返回布局坐标,层「视觉上」在键盘上方时
//     rect.bottom 可能仍是 800(skill `zhujian-android-verify`「软键盘避让类验收」第 1 条)。
//  ② **抢先抬只在真有键盘的设备上发生**(2026-08-27 新增)—— 模拟器 / 接了物理键盘的平板上
//     软键盘永不出现,而抢先抬是为键盘让位:抬上去没有对象,只能干等 600ms 兜底把层落回来,
//     屏上就是「层跳到半空停一下再回底部」(用户在 MuMu 上实报)。连着 ABSENT_LIMIT 次开层
//     没见到键盘就停止抢先抬,层改走 CSS 那条 0.22s 滑入。
//
// **本资产自己判设备属于哪一类**(看三轮里 visualViewport 缩没缩),再套对应那组断言 ——
// 两类设备各跑各的,同一份脚本在 vivo 与 MuMu 上都该 pass。
//
// ⚠ 诚实边界(四条,别把它的绿读大):
//  ① **CDP 唤不起真键盘**,故开层一律走 `adb shell input tap` 真点 FAB;IME 的「∨ 收起键」
//     本资产**不碰**(那要按屏幕坐标,绑设备分辨率+ROM)⇒ 「收键盘→再唤起」那一环仍未覆盖,
//     240 明说那条走的是另一条 focus 路径。要验得手工照 skill 那节做。
//  ② 只覆盖**捕获层**(`#compose-card`)。留言层(`.cmsheet`)共用同一份 kbsheet.ts 与同一个
//     模块级记忆,但入口不同(要先开一张卡),不在本资产内。
//  ③ 「背景不滚」这一格**要页面真的可滚**才有意义:库里条目太少时文档不可滚,那格是假绿。
//     故跑前先把 scrollTop 推到 300;推不动(条目不够)会如实标 `skipped-not-scrollable`。
//  ④ 它改 `localStorage["zhujian.kb-absent"]`(要从「全新设备」起跑),**跑完还原**成进来时
//     那个值。中途崩掉的话那个键会留在中间态 —— 重跑一次即可,不影响产品数据。
//
// 跑法:
//   node scripts/build-android.mjs --devtools      # MuMu 上要 x86_64,见 skill「第二台设备」
//   adb install -r <apk> && adb shell monkey -p app.zhujian.notebook -c android.intent.category.LAUNCHER 1
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-kbsheet.mjs        # 打印 {pass, deviceClass, steps}
// 多台设备同连时 `export ANDROID_SERIAL=<serial>`(与 android-cdp.mjs 同一个出口)。
//
// 阴性对照(四把刀,各守一处;改完记得还回去)。⚠ **A 与 D 是 2026-08-27 在 MuMu 上实跑过的,
// B 与 C 只是推理、没落过刀** —— 别把这四条读成「四把都验过」。
//  A. ✅**实跑**(2026-08-27):删掉 raise() 里 `if (kbNeverShows()) { place(); return; }`
//     ⇒ 真红三格 —— `R3-无抢先抬`(min=-280)、`R3-transform交回CSS`(owners=css,inline)、
//       `R3-滑入动画真在跑`(中间值 0 个);而 R1/R2 学习那两格**不受牵连**,说明红的是该红的面。
//  B. ⬜未实跑:删掉兜底里的 `noteKbAbsent()`
//     ⇒ 推断:计数永远不涨,红在 `R1-记一笔没见到键盘`(absent=null)。
//  C. ⬜未实跑:把 apply() 的 `Math.abs(y) < 1` 改回 `y === 0`
//     ⇒ 推断:vv.height 带小数,判据恒不成立、transform 不交回 CSS,红在 `R3-transform交回CSS`
//       与 `R3-滑入动画真在跑`。(这个容差本身就是首版真栽出来的,见 kbsheet.ts 那处注释。)
//  D. ✅**实跑**(2026-08-27):删掉 raise() 里 `if (Date.now() < raiseUntil) return;`
//     ⇒ 只红一格 `R1-记一笔没见到键盘`(absent 直接跳到 "2"),R2/R3 照常全绿。
//     ⭐ **这把最值钱**:它守的就是写这轮时真犯下的 bug(raise() 一轮被调两次 ⇒ 一次开层记
//       两笔账 ⇒ ABSENT_LIMIT 腰斩)。没有 R1 那一格,那个 bug 会**整片绿地**通过。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = 9222;
const ABSENT_LIMIT = 2; // 与 android/src/kbsheet.ts 同一个数
const KEY = "zhujian.kb-absent";

// execFile 直调 adb.exe、参数逐个透传 ⇒ 不过 bash/MSYS(memory `gitbash-slash-flag-conversion-trap`)。
// 异步不同步:同步 exec 会把事件循环堵死(memory `self-service-probe-sync-exec-deadlock`)。
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 采样器:rAF 逐帧记 [t, translateY, vvH, innerH, vvTop, scrollY, owner]。
  // owner = transform 归谁管(inline=JS 抬的 / css=交回 CSS 了),修法的可观测面就是它。
  const ARM = `(()=>{
    const s=document.getElementById("compose-card"),vv=visualViewport,f=document.getElementById("capture-fab");
    window.__kb=[];const t0=performance.now();let stop=false;
    setTimeout(()=>{stop=true},2800);
    (function loop(){ if(stop)return;
      const m=new DOMMatrixReadOnly(getComputedStyle(s).transform);
      window.__kb.push([Math.round(performance.now()-t0),Math.round(m.m42*10)/10,
        Math.round(vv.height),innerHeight,Math.round(vv.offsetTop),Math.round(scrollY),
        s.style.transform===""?"css":"inline"]);
      requestAnimationFrame(loop);})();
    const r=f.getBoundingClientRect();
    return JSON.stringify({fabHidden:f.hidden,
      fabDev:[Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)]});
  })()`;
  const READ = `JSON.stringify({rows:window.__kb||[],absent:localStorage.getItem(${JSON.stringify(KEY)})})`;
  const CLOSE = `(()=>{const s=document.getElementById("compose-card");
    if(s.classList.contains("open"))document.getElementById("capture-scrim").click();return s.className})()`;

  // ---- 前置:备份计数 → 清零 → reload(计数在**模块求值时**读一次,不 reload 不生效) ----
  const backup = await evalJs(`localStorage.getItem(${JSON.stringify(KEY)})`);
  await evalJs(`(()=>{localStorage.removeItem(${JSON.stringify(KEY)});return 1})()`);
  await evalJs("location.reload()");
  // ⛔ 等 FAB 出现是**不够的**:它是静态元素、首帧就在,而时间轴是异步 invoke 回来才长出来。
  // 拿它当就绪判据 ⇒ 下面推 scrollTop 时 scrollHeight 还是 800、推不动,「背景不滚」那两格
  // 于是静静地变成空测(2026-08-27 首版真栽,在有 119 条数据的真机上报了 SKIPPED)。
  // 判据必须是**文档真的可滚了**;空库的机器等不到,超时后如实记 SKIPPED。
  let scrollable = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const raw = await evalJs(
      `(()=>{const f=document.getElementById("capture-fab");
        return JSON.stringify({fab:!!f&&!f.hidden,sh:document.documentElement.scrollHeight,ch:innerHeight})})()`,
    ).catch(() => null);
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (s.fab && s.sh > s.ch + 50) {
      scrollable = true;
      break;
    }
    if (s.fab && i >= 11) break; // 6 秒还长不出可滚内容 = 这台库里条目不够
  }
  step("前置-计数已清零并重载", (await evalJs(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null, `进来时=${backup}`);

  // 诚实边界 ③:背景不可滚的话「背景没滚」是假绿,先把它推起来。
  const scrolled = scrollable
    ? await evalJs(`(()=>{const e=document.scrollingElement;e.scrollTop=300;return e.scrollTop})()`)
    : 0;
  // ⚠ 推不动不算失败(空库的机器上本来就没得滚),但**必须在报告里说出来** —— 否则下面
  // 「背景不滚」那两格是空测,而屏幕上它跟真绿一模一样。
  step(
    "前置-背景可滚(否则「不滚」是假绿)",
    true,
    scrolled > 0
      ? `scrollTop=${scrolled}(基线已推起来,下面两格成立)`
      : "⚠ SKIPPED:库里条目不够、文档不可滚 ⇒ 下面「背景不滚」两格在这台机器上是空测,不成立",
  );

  // ---- 三轮开层 --------------------------------------------------------------
  const rounds = [];
  for (let i = 1; i <= 3; i++) {
    const armed = JSON.parse(await evalJs(ARM));
    if (armed.fabHidden) throw new Error(`第 ${i} 轮:FAB 是隐的(上一轮没关干净?)`);
    // ⚠ 必须 adb 真点:CDP 合成 focus 不弹系统键盘,那样有键盘的设备也会被测成没键盘。
    await adb(["shell", "input", "tap", String(armed.fabDev[0]), String(armed.fabDev[1])]);
    await sleep(3100);
    rounds.push(JSON.parse(await evalJs(READ)));
    await evalJs(CLOSE);
    await sleep(1200);
  }

  const tY = (r) => r.map((x) => x[1]);
  const owners = (r) => new Set(r.map((x) => x[6]));
  const raised = (rows) => Math.min(...tY(rows)) <= -100; // 抢先抬过(层跳到负位)
  const kbCameUp = (rows) => rows.some((x) => x[3] - x[2] > 80); // innerH - vvH > 80

  // ---- 设备分类:三轮里键盘露过面吗 -------------------------------------------
  const hasKb = rounds.some((r) => kbCameUp(r.rows));
  out.deviceClass = hasKb ? "有软键盘(真机)" : "无软键盘(模拟器/物理键盘)";

  // ---- 轴 ①:背景一格不动(两类设备共同,240 的核心契约)------------------------
  const allRows = rounds.flatMap((r) => r.rows);
  const vvTopMax = Math.max(...allRows.map((x) => x[4]));
  const scrollSpread = new Set(allRows.map((x) => x[5])).size;
  step("背景不滚-visualViewport.offsetTop 恒 0", vvTopMax === 0, `max=${vvTopMax}`);
  step("背景不滚-scrollY 全程不变", scrollSpread === 1, `出现过 ${scrollSpread} 个不同值`);

  // ---- 轴 ②:分类断言 ---------------------------------------------------------
  if (hasKb) {
    // 真机:三轮都该照旧抢先抬,且计数一次都不许涨(涨了 = 把真机误判成没键盘)。
    step("R1-真机仍抢先抬", raised(rounds[0].rows), `min=${Math.min(...tY(rounds[0].rows))}`);
    step("R3-真机仍抢先抬(没被误判)", raised(rounds[2].rows), `min=${Math.min(...tY(rounds[2].rows))}`);
    const finals = rounds.map((r) => {
      const last = r.rows[r.rows.length - 1];
      return { ty: last[1], kb: last[3] - last[2] };
    });
    // 层底沿贴键盘上沿:|translateY| 与键盘高度之差 ≤ 8px。
    const fit = finals.filter((f) => f.kb > 80).map((f) => Math.abs(Math.abs(f.ty) - f.kb));
    step("层贴键盘上沿(±8px)", fit.length > 0 && fit.every((d) => d <= 8), JSON.stringify(finals));
    step("计数保持 0(没把真机误判成没键盘)", [null, "0"].includes(rounds[2].absent), `absent=${rounds[2].absent}`);
  } else {
    // 无键盘:学习期照旧抬,学满之后停手并交回 CSS。
    step("R1-学习期仍抢先抬", raised(rounds[0].rows), `min=${Math.min(...tY(rounds[0].rows))}`);
    step("R1-记一笔没见到键盘", rounds[0].absent === "1", `absent=${rounds[0].absent}(该是 "1";"2" = 一轮记了两笔)`);
    step("R2-记满", rounds[1].absent === String(ABSENT_LIMIT), `absent=${rounds[1].absent}`);
    step("R3-无抢先抬", !raised(rounds[2].rows), `min=${Math.min(...tY(rounds[2].rows))}(该 > -100)`);
    step("R3-transform交回CSS", !owners(rounds[2].rows).has("inline"), `owners=${[...owners(rounds[2].rows)].join()}`);
    // 防「交回了 CSS 但根本没动画」的假绿:滑入过程该有一串中间值。
    const mids = new Set(tY(rounds[2].rows).filter((y) => y > 1 && y < 135)).size;
    step("R3-滑入动画真在跑(≥3 个中间值)", mids >= 3, `中间值 ${mids} 个`);
  }

  // ---- 还原(诚实边界 ④)-------------------------------------------------------
  await evalJs(
    backup === null
      ? `(()=>{localStorage.removeItem(${JSON.stringify(KEY)});return 1})()`
      : `(()=>{localStorage.setItem(${JSON.stringify(KEY)},${JSON.stringify(backup)});return 1})()`,
  );
  step("还原-计数改回进来时的值", true, `还原为 ${backup}`);

  cdp.close();
  out.pass = out.steps.every((s) => s.ok);
  return out;
};

const res = await main().catch((e) => ({ pass: false, error: String(e && e.stack ? e.stack : e) }));
console.log(JSON.stringify(res, null, 2));
process.exit(res.pass ? 0 : 1);
