// 桌面朱笺 WebView2 CDP 驱动(android-cdp.mjs 的桌面孪生;134 手法、142 首次全程实战)。
// 生产 exe 即可用、无需 devtools feature——重启 app 前设好环境变量:
//   PowerShell: $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; Start-Process <app.exe>
// 用法: node scripts/desktop-cdp.mjs eval '<js>' | evalfile <path>
//       node scripts/desktop-cdp.mjs shot <out.png> [--clip x,y,w,h] [--scale N]
//       (默认选 notebook 页;所有命令带 [--page capture] 可切页)
// shot 走 Page.captureScreenshot,窗口即使 visible:false 也能出图(核验 UI 美观/布局);
// 要按元素定位先用 eval 读 getBoundingClientRect() 拿坐标,再把 --clip 传进来。
//
// 驱动真窗铁律(142 险些踩坑):点任何按钮前先读前端源码确认真实提交机制——
// 桌面空间改名表单是「输入+回车」根本没有确定按钮,模糊文本匹配去找“确定”会点到
// 别的元素(那次撞上的是带 ✓ 标记的当前空间行,纯属侥幸是 no-op);合成
// KeyboardEvent("keydown",{key:"Enter"}) 提交。验收完记得重启 app 关调试口。
import { readFileSync, writeFileSync } from "node:fs";

const PORT = 9223;
const pageMatch = process.argv.includes("--page")
  ? process.argv[process.argv.indexOf("--page") + 1]
  : "notebook";

async function pageTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const ts = await r.json();
  const p = ts.find((t) => t.type === "page" && t.url.includes(pageMatch) && t.webSocketDebuggerUrl);
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
    const to = setTimeout(() => rej(new Error("CDP 超时")), 30000);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        clearTimeout(to);
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
      const to = setTimeout(() => rej(new Error(`CDP 超时:${method}`)), 30000);
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
  console.error("用法: eval '<js>' | evalfile <path> | shot <out.png> [--clip x,y,w,h] [--scale N]  [--page capture]");
  process.exit(1);
}
