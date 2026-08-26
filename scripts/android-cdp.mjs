// 朱笺安卓 UI 验收工装 —— 经 Chrome DevTools 协议(CDP)驱动 WebView。
// 只对「--features devtools 构建」的 APK 有效(发版包 WebView 不可调试,是安全前提)。
//
// 为什么存在:安卓界面跑在系统 WebView 里,uiautomator 拿不到 DOM,靠肉眼估屏幕坐标
// 点击既慢又易点偏,两拍确认的 3s 窗口也赶不上。开 devtools 后可用 JS 选择器精确
// 点击 / 读 DOM 断言,验收全程脚本化、可复现、无坐标。
//
// 前置:
//   1) cd android && npx tauri android build --apk --target aarch64 --features devtools
//   2) adb install -r <devtools APK>  然后启动 app 到前台
//   3) node scripts/android-cdp.mjs forward     # 自动找 socket 建 adb forward
// 用法:
//   node scripts/android-cdp.mjs forward         # 建立 tcp:9222 -> WebView devtools socket
//   node scripts/android-cdp.mjs info            # 列 CDP page targets
//   node scripts/android-cdp.mjs eval '<js>'     # 页面内执行 JS,打印返回值(JSON)
//   node scripts/android-cdp.mjs evalfile <path> # 从文件读 JS 执行(长脚本免转义)
//   node scripts/android-cdp.mjs swipe x1 y1 x2 y2 [steps]  # 真实触摸滑动(CSS 视口坐标,
//                                                   走 Input.dispatchTouchEvent 原生管线,含 touch-action)
// 依赖:node ≥ 22(全局 WebSocket/fetch)、adb 在 PATH。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 9222;

// 单条 CDP 调用的上限。默认 10s 够绝大多数断言;**阴性对照那种「专等失败」的跑法**
// 每个失败的 until 都要等满超时,总时长会翻几倍 —— 那时用 CDP_TIMEOUT_MS 放宽。
// ⚠ 必须在模块级:evaluate 与 session(swipe 的路)都用它——曾被误塞进 evaluate
// 函数体内,swipe 一跑就 ReferenceError。
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 10000);

// execFileSync 直调 adb.exe、参数逐个透传 => 不过 bash/MSYS,/proc 路径不被转义。
const adb = (args) => execFileSync("adb", args, { encoding: "utf8" });

// ⛔ **别拿「第一条 webview_devtools socket」当答案**(490 真栽):socket 名字里那个数字是
// **进程 pid**,而一台手机上可能同时有别的 app 也开着可调试 WebView —— 那台 vivo 上就有两条
// (`…_17737` 是别的 app、`…_26559` 才是朱简)。抓错了的现象是**没有报错的沉默**:forward 建得
// 好好的,`/json/version` 却连不上或答的是别人的页面。⇒ 先问「朱简的 pid 是多少」,只认那一条;
// 认不到就响亮说,⛔ 不许退回「那就用第一条吧」(设计铁律「绝不回退兜底」)。
const PKG = "app.zhujian.notebook";

function findSocket() {
  const ps = adb(["shell", "ps", "-A", "-o", "PID,NAME"]);
  const pids = ps
    .split("\n")
    .filter((l) => l.trim().endsWith(PKG))
    .map((l) => l.trim().split(/\s+/)[0]);
  const out = adb(["shell", "grep", "-a", "webview", "/proc/net/unix"]);
  const socks = [...new Set(out.match(/webview_devtools_remote_\d+/g) ?? [])];
  if (!socks.length) throw new Error("未找到 webview devtools socket——app 是否为 devtools 构建且在前台?");
  if (!pids.length) throw new Error(`设备上没有 ${PKG} 的进程——先把 app 拉到前台`);
  const mine = socks.filter((s) => pids.includes(s.replace("webview_devtools_remote_", "")));
  if (!mine.length) {
    throw new Error(
      `设备上有 ${socks.length} 条 devtools socket(${socks.join(" ")}),但没有一条属于 ${PKG}` +
        `(pid ${pids.join(" ")})——装的是发版包(WebView 不可调试)?先装 devtools 包。`,
    );
  }
  return mine[0];
}

function forward() {
  const sock = findSocket();
  adb(["forward", `tcp:${PORT}`, `localabstract:${sock}`]);
  console.log(`forward tcp:${PORT} -> ${sock}`);
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return r.json();
}

async function pageTarget() {
  const ts = await targets();
  const p = ts.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!p) throw new Error("无 page target(先跑 forward,且 app 在前台)");
  return p;
}

async function evaluate(expr) {
  const p = await pageTarget();
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  const id = 1;
  const out = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("CDP 超时")), CDP_TIMEOUT_MS);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(to);
      if (m.error) return rej(new Error(JSON.stringify(m.error)));
      const r = m.result;
      if (r?.exceptionDetails)
        return rej(new Error(r.exceptionDetails.exception?.description || "页面 JS 抛异常"));
      res(r?.result);
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      }),
    );
  });
  ws.close();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 开一条 CDP 会话跑多条命令(swipe 要在同一连接上连发 touchStart/Move/End)。
async function session(fn) {
  const p = await pageTarget();
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), CDP_TIMEOUT_MS);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== myId) return;
        ws.removeEventListener("message", onMsg);
        clearTimeout(to);
        if (m.error) return rej(new Error(JSON.stringify(m.error)));
        res(m.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

// 真实触摸滑动:一次 touchStart → 若干 touchMove → touchEnd。坐标是 CSS 视口像素
// (直接用 getBoundingClientRect 的值,不换算设备像素);走原生输入管线,故 touch-action、
// 滚动识别、pointer capture 都真实生效——正是合成 PointerEvent 测不到的那半截。
async function swipe(x1, y1, x2, y2, steps = 12) {
  await session(async (send) => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await sleep(16);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "forward") forward();
  else if (cmd === "info") console.log(JSON.stringify(await targets(), null, 2));
  else if (cmd === "eval") {
    const r = await evaluate(rest.join(" "));
    console.log(JSON.stringify(r?.value ?? r, null, 2));
  } else if (cmd === "evalfile") {
    const r = await evaluate(readFileSync(rest[0], "utf8"));
    console.log(JSON.stringify(r?.value ?? r, null, 2));
  } else if (cmd === "swipe") {
    const [x1, y1, x2, y2, steps] = rest.map(Number);
    if ([x1, y1, x2, y2].some(Number.isNaN)) throw new Error("用法: swipe x1 y1 x2 y2 [steps]");
    await swipe(x1, y1, x2, y2, Number.isNaN(steps) ? 12 : steps);
    console.log(`swipe (${x1},${y1}) -> (${x2},${y2})`);
  } else {
    console.error("用法: forward | info | eval <js> | evalfile <path> | swipe x1 y1 x2 y2 [steps]");
    process.exit(1);
  }
} catch (e) {
  console.error("错误:", e.message);
  process.exit(1);
}
