// 桌面朱笺 WebView2 CDP 驱动(android-cdp.mjs 的桌面孪生;134 手法、142 首次全程实战)。
// 生产 exe 即可用、无需 devtools feature——重启 app 前设好环境变量:
//   PowerShell: $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; Start-Process <app.exe>
// 用法: node scripts/desktop-cdp.mjs eval '<js>' | evalfile <path> [--page capture](默认选 notebook 页)
//
// 驱动真窗铁律(142 险些踩坑):点任何按钮前先读前端源码确认真实提交机制——
// 桌面空间改名表单是「输入+回车」根本没有确定按钮,模糊文本匹配去找“确定”会点到
// 别的元素(那次撞上的是带 ✓ 标记的当前空间行,纯属侥幸是 no-op);合成
// KeyboardEvent("keydown",{key:"Enter"}) 提交。验收完记得重启 app 关调试口。
import { readFileSync } from "node:fs";

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

const cmd = process.argv[2];
if (cmd === "eval") {
  console.log(JSON.stringify(await evaluate(process.argv[3]), null, 2));
} else if (cmd === "evalfile") {
  console.log(JSON.stringify(await evaluate(readFileSync(process.argv[3], "utf8")), null, 2));
} else {
  console.error("用法: eval '<js>' | evalfile <path> [--page capture]");
  process.exit(1);
}
