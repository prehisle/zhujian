// 桌面隔离实例的「真输入」驱动(ux-walk-plan 走查用):走 CDP Input 域,事件从引擎入口进
// (命中测试、焦点、默认动作都走真路径),而不是页内 `dispatchEvent` 那种合成事件
// (memory `synthetic-events-bypass-hit-testing`:合成事件绕过命中测试,只证处理器)。
//
//   ZJ_CDP_PORT=9233 node scripts/desktop-input.mjs click <x> <y> [--double] [--right]
//   ZJ_CDP_PORT=9233 node scripts/desktop-input.mjs type "<文字>"          # Input.insertText(像输入法上屏)
//   ZJ_CDP_PORT=9233 node scripts/desktop-input.mjs key <键名> [--ctrl] [--shift] [--alt]
//        键名:Enter / Escape / Tab / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight /
//              PageUp / PageDown / Home / End / 单个字母或数字(配 --ctrl 做快捷键)
//   ZJ_CDP_PORT=9233 node scripts/desktop-input.mjs wheel <x> <y> <dy>     # 鼠标滚轮(正数往下)
//   ZJ_CDP_PORT=9233 node scripts/desktop-input.mjs focus                  # 报当前焦点元素(走查记「焦点在哪」)
//   全部带 [--page capture] 可切到捕获窗(默认 notebook 主窗)。坐标是 CSS 像素(先 eval getBoundingClientRect 取)。
//
// ⚠ 诚实边界:①`insertText` 不走输入法组字(拼音候选、组字中按回车那类只有真手能验,记成「用户手验」);
//   ②窗是 visible:false 也照样收事件,但**系统级**行为(全局热键、窗口拖动、系统剪贴板粘贴文件、
//   原生拖放)不在这条路上,别拿它的结果当那些的证据;③超时 ≠ 没做成(desktop-cdp 头注 428 判例)。
import { openSession, sleep } from "./lib/cdp.mjs";

const PORT = Number(process.env.ZJ_CDP_PORT || 9223);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`ZJ_CDP_PORT 不是合法端口:${process.env.ZJ_CDP_PORT}`);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const pageMatch = flag("--page") ? args[args.indexOf("--page") + 1] : "notebook";
const matches = (url) => (pageMatch === "capture" ? /\/(index\.html)?(\?.*)?$/.test(url) : url.includes(pageMatch));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && matches(t.url));
if (pages.length !== 1) throw new Error(`期望恰 1 条匹配「${pageMatch}」的 page,实得 ${pages.length}:${list.map((t) => t.url).join(" , ")}`);
const s = await openSession(pages[0].webSocketDebuggerUrl);
const send = (m, p) => s.send(m, p);

const KEYS = {
  Enter: [13, "\r"], Escape: [27], Tab: [9], Backspace: [8], Delete: [46],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39],
  PageUp: [33], PageDown: [34], Home: [36], End: [35],
};
const mods = (flag("--alt") ? 1 : 0) | (flag("--ctrl") ? 2 : 0) | (flag("--shift") ? 8 : 0);

const [cmd, a1, a2, a3] = args;
try {
  if (cmd === "click") {
    const x = Number(a1), y = Number(a2);
    const button = flag("--right") ? "right" : "left";
    const clickCount = flag("--double") ? 2 : 1;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let c = 1; c <= clickCount; c++) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount: c });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c });
    }
    console.log(`click ${button} ×${clickCount} @ ${x},${y}`);
  } else if (cmd === "type") {
    await send("Input.insertText", { text: a1 });
    console.log(`type ${JSON.stringify(a1)}`);
  } else if (cmd === "key") {
    let code, text;
    if (KEYS[a1]) [code, text] = KEYS[a1];
    else if (/^[a-zA-Z0-9]$/.test(a1)) code = a1.toUpperCase().charCodeAt(0);
    else throw new Error(`不认的键名:${a1}`);
    if (text === undefined && /^[a-zA-Z0-9]$/.test(a1) && !(mods & 3)) text = a1;
    const base = { key: KEYS[a1] ? a1 : a1, code: KEYS[a1] ? a1 : /\d/.test(a1) ? `Digit${a1}` : `Key${a1.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers: mods };
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", text, ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    console.log(`key ${a1} mods=${mods}`);
  } else if (cmd === "wheel") {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Number(a1), y: Number(a2), deltaX: 0, deltaY: Number(a3) });
    console.log(`wheel ${a3} @ ${a1},${a2}`);
  } else if (cmd === "focus") {
    const r = await send("Runtime.evaluate", {
      expression: `(() => { const e = document.activeElement; if (!e) return null; const b = e.getBoundingClientRect();
        return { tag: e.tagName, id: e.id || null, cls: String(e.className || "").slice(0, 80), text: (e.value ?? e.textContent ?? "").slice(0, 60),
                 rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], hasFocus: document.hasFocus() }; })()`,
      returnByValue: true,
    });
    console.log(JSON.stringify(r.result.value));
  } else {
    console.error("用法见文件头");
    process.exitCode = 2;
  }
  await sleep(150);
} finally {
  s.close?.();
}
