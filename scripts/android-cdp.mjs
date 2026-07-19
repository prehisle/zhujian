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
// 依赖:node ≥ 22(全局 WebSocket/fetch)、adb 在 PATH。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 9222;

// execFileSync 直调 adb.exe、参数逐个透传 => 不过 bash/MSYS,/proc 路径不被转义。
const adb = (args) => execFileSync("adb", args, { encoding: "utf8" });

function findSocket() {
  const out = adb(["shell", "grep", "-a", "webview", "/proc/net/unix"]);
  const m = out.match(/(webview_devtools_remote_\d+)/);
  if (!m) throw new Error("未找到 webview devtools socket——app 是否为 devtools 构建且在前台?");
  return m[1];
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
    const to = setTimeout(() => rej(new Error("CDP 超时")), 10000);
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
  } else {
    console.error("用法: forward | info | eval <js> | evalfile <path>");
    process.exit(1);
  }
} catch (e) {
  console.error("错误:", e.message);
  process.exit(1);
}
