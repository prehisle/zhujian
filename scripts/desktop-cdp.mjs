// 桌面朱笺 WebView2 CDP 驱动(android-cdp.mjs 的桌面孪生;134 手法、142 首次全程实战)。
// 生产 exe 即可用、无需 devtools feature——重启 app 前设好环境变量:
//   PowerShell:
//     $env:WEBVIEW2_USER_DATA_FOLDER='G:\yj2026\zhujian\.cdp-profile'
//     $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
//     Start-Process <app.exe>
// 上面第一行钉死 profile 目录很重要:不设的话,若上一个同 exe 实例的默认 profile 目录
// 还没释放(taskkill 强杀不算干净退出),WebView2 会 fallback 去 C:\Windows\SystemTemp
// 新开一个 scoped_dir<pid>_<random>,taskkill 掉后就成永久垃圾(2026-07-29 实踩,发现
// 系统临时目录攒了一堆同类)。钉死后每次复用同一目录,不再新增。
// 用法: node scripts/desktop-cdp.mjs eval '<js>' | evalfile <path>
//       node scripts/desktop-cdp.mjs shot <out.png> [--clip x,y,w,h] [--scale N]
//       (默认选 notebook 页;所有命令带 [--page capture] 可切页,
//        **旗标一律放在位置参数后面** —— 位置参数是按 argv[2]/argv[3] 取的)
//       [--timeout 毫秒] 等一条 CDP 应答多久,默认 30000
//
// ⚠ **别把驱动的超时读成「操作失败」**(428 实栽):debug 形的恢复要 **43 秒**,
//   驱动这边抛「CDP 超时」,而**页面里那段脚本照旧跑到底、事情真做成了**(那次是去盘上
//   看见第三个空间文件真的出现了才发现的)。⇒ 结论一律去**盘上与 DOM 上**取。
//   慢命令把 `--timeout` 调大即可,⛔ **别把默认值一律加长** —— 30 秒短,正是它抓得住
//   「页面挂死」的原因。
// ⚠ 同族第二格:`evalfile` 走的是**文件内容当表达式**,而 `\n` 一类转义在 shell heredoc /
//   `node -e` 里会被吃掉 ⇒ **别用管道拼脚本**,用编辑器把文件写出来再喂给它。
// shot 走 Page.captureScreenshot,窗口即使 visible:false 也能出图(核验 UI 美观/布局);
// 要按元素定位先用 eval 读 getBoundingClientRect() 拿坐标,再把 --clip 传进来。
//
// 驱动真窗铁律(142 险些踩坑):点任何按钮前先读前端源码确认真实提交机制——
// 桌面空间改名表单是「输入+回车」根本没有确定按钮,模糊文本匹配去找“确定”会点到
// 别的元素(那次撞上的是带 ✓ 标记的当前空间行,纯属侥幸是 no-op);合成
// KeyboardEvent("keydown",{key:"Enter"}) 提交。验收完记得重启 app 关调试口。
import { readFileSync, writeFileSync } from "node:fs";

// ⚠ **490 起可换口**:验收里会同时开两只桌面朱简(一只当"老设备"、一只当被测端),
// 两只不能挤同一个调试口。⛔ 坏值不静默退回默认(「绝不回退兜底」)。
const PORT = (() => {
  const raw = process.env.ZJ_CDP_PORT;
  if (raw === undefined || raw === "") return 9223;
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0 || v > 65535) {
    console.error(`ZJ_CDP_PORT 不是合法端口:${raw}`);
    process.exit(2);
  }
  return v;
})();
// 默认 30 秒:**短是它的功能**(页面挂死时早点告诉你),慢命令显式放大。
// 坏值不静默退回默认(「绝不回退兜底」):写错了当场说,免得下一句超时读数没人信。
const TIMEOUT = (() => {
  const i = process.argv.indexOf("--timeout");
  if (i < 0) return 30000;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`--timeout 要一个正数(毫秒),收到:${process.argv[i + 1]}`);
    process.exit(2);
  }
  return v;
})();
const pageMatch = process.argv.includes("--page")
  ? process.argv[process.argv.indexOf("--page") + 1]
  : "notebook";

// 捕获浮窗的 URL 是应用根(dev 下 `http://localhost:1420/`、生产 `.../index.html`),
// 不含子串 "capture" —— `--page capture` 得按「根页 / 或 index.html」匹配,否则 dev/fast
// 模式下 includes("capture") 永远落空(235 实踩:曾为此临时另写脚本)。
function matches(url) {
  if (pageMatch === "capture") return /\/(index\.html)?(\?.*)?$/.test(url);
  return url.includes(pageMatch);
}

// ⛔ 超时 ≠ 操作失败:428 那次页面里的脚本照旧跑到底了。话里必须把这句带上,
//    否则下一个人会照着「失败」去回滚一件其实已经做成的事。
function timeoutSay(method) {
  return (
    `CDP 等 ${method} 的应答超过 ${TIMEOUT}ms —— ⚠ 这只说明**驱动这边不等了**,` +
    `页面里那段脚本很可能照旧跑到底、事情真做成了(428 判例)。` +
    `结论去盘上 / DOM 上取;确实是慢命令就 --timeout 调大(⛔ 别改默认值)。`
  );
}

async function pageTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const ts = await r.json();
  const p = ts.find((t) => t.type === "page" && matches(t.url) && t.webSocketDebuggerUrl);
  if (!p) throw new Error(`无匹配 page target(${pageMatch}):` + ts.map((t) => t.url).join(", "));
  return p;
}

async function evaluate(expr) {
  const p = await pageTarget();
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  const out = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(timeoutSay("Runtime.evaluate"))), TIMEOUT);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        clearTimeout(to);
        // 协议层报错(不是页面里抛的)也要说人话 —— 否则下面读 out.result 会
        // 崩成「Cannot read properties of undefined」,把 CDP 的原话吃掉。
        if (m.error) return rej(new Error("Runtime.evaluate: " + JSON.stringify(m.error)));
        res(m.result);
      }
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  ws.close();
  if (out.exceptionDetails) throw new Error("页面异常:" + JSON.stringify(out.exceptionDetails));
  return out.result;
}

async function screenshot(outPath, clip) {
  const p = await pageTarget();
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  let seq = 0;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++seq;
      const to = setTimeout(() => rej(new Error(timeoutSay(method))), TIMEOUT);
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === myId) {
          clearTimeout(to);
          ws.removeEventListener("message", on);
          m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result);
        }
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  await send("Page.enable");
  const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  ws.close();
  if (!shot || !shot.data) throw new Error("截图无数据(窗口未绘制?)");
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  return outPath;
}

const cmd = process.argv[2];
if (cmd === "eval") {
  console.log(JSON.stringify(await evaluate(process.argv[3]), null, 2));
} else if (cmd === "evalfile") {
  console.log(JSON.stringify(await evaluate(readFileSync(process.argv[3], "utf8")), null, 2));
} else if (cmd === "shot") {
  const out = process.argv[3];
  if (!out) throw new Error("shot 需要输出路径:shot <out.png> [--clip x,y,w,h] [--scale N]");
  const clipArg = process.argv.includes("--clip") ? process.argv[process.argv.indexOf("--clip") + 1] : null;
  const scaleArg = process.argv.includes("--scale") ? Number(process.argv[process.argv.indexOf("--scale") + 1]) : 1;
  let clip = null;
  if (clipArg) {
    const [x, y, width, height] = clipArg.split(",").map(Number);
    clip = { x, y, width, height, scale: scaleArg };
  }
  console.log("saved " + (await screenshot(out, clip)));
} else {
  console.error("用法: eval '<js>' | evalfile <path> | shot <out.png> [--clip x,y,w,h] [--scale N]  [--page capture] [--timeout 毫秒]");
  process.exit(1);
}
