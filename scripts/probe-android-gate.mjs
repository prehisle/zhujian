#!/usr/bin/env node
// 量安卓冷启动闸「正在检查本机空间…」(`#gate`)在屏上待了多久 —— 用户面 95 的量法(680 立)。
//
//   node scripts/probe-android-gate.mjs [趟数]      # 前提:devtools 包已装、adb 只连着一台
//
// 走法:force-stop → `am start -W`(异步)→ 轮询 `/proc/net/unix` 等 WebView devtools socket →
// adb forward → 连 CDP → 每 ~15 ms 问一次 `#gate.hidden` 与 performance 读数,直到它翻成 true。
// 可见时长 = 闸翻 hidden 那一拍的 `performance.now()` − first-contentful-paint(同一份设备时钟)。
//
// ⭐ 探针:在文档还是 `loading` 时直接 `Runtime.evaluate` 一段包住 `window.setTimeout` 的代码,记下
//    delay 恰为 150(`resolveStartupGate` 的重试歇)与 1500(每次 `startup_gate` invoke 的超时)的
//    调用 ⇒ 1500 的个数 = invoke 次数、150 的个数 = 歇了几次。⛔ `Page.addScriptToEvaluateOnNewDocument`
//    在这里**恒来不及**:连上 CDP 时 `http://tauri.localhost/` 那份文档已经开始了,它只作用于下一份。
//
// 680 MuMu(x86_64 devtools 包,库里是验收资产留的少量数据)18 趟读数:可见 **87–383 ms,中位 160 ms**
// (模拟器刚起的头两趟 294 / 383,之后多在 120–250);带探针的 8 趟**全是 1 次 invoke、0 次歇** —— 后端在页面
// 第一次问时就已经 ready,可见时长的构成 = 前端问之前自己的启动活(privacyGate / renderSpaceChip / 字典,
// 50–170 ms)+ 一次 invoke 往返(35–180 ms)。⇒ 既不是「几十毫秒」也不是「上秒」,而且没有可摘的等待
// (不是轮询节拍、不是后端);藏文案只会把这 0.1–0.3 s 变成空屏。判「不动」,原文进归档(用户面 95)。
// ⚠ vivo 那台跑的是正式包、WebView 不可调试,没量;要量得先换装 devtools 包(android-verify 流程 A)。
import { execFileSync, spawn } from "node:child_process";
const PKG = "app.zhujian.notebook";
const PORT = 9222;
const adb = (args) => execFileSync("adb", args, { encoding: "utf8" }).trim();
const adbTry = (args) => { try { return adb(args); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runs = Number(process.argv[2] || 1);
// 包住 setTimeout 的探针(只记 150 / 1500 两档,别的原样放过)
const INJECT = "window.__probe=[];const _st=window.setTimeout;window.setTimeout=function(fn,d){if(d===150||d===1500)window.__probe.push({d:d,t:Math.round(performance.now())});return _st.apply(window,arguments)};";
const EXPR = "JSON.stringify({now:performance.now(),url:location.href,gate:(document.getElementById('gate')||{}).hidden,paint:performance.getEntriesByType('paint').map(e=>e.name+':'+Math.round(e.startTime)),ready:document.readyState,probe:window.__probe||null})";

async function once(idx) {
  adb(["shell", "am", "force-stop", PKG]);
  adbTry(["forward", "--remove", `tcp:${PORT}`]);
  await sleep(1500);
  const t0 = Date.now();
  const starter = spawn("adb", ["shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`]);
  let startOut = "";
  starter.stdout.on("data", (d) => (startOut += d));
  // 1) 等 socket(socket 名带 pid,每次冷启都变,所以 forward 必须每趟重建)
  let sock = null, tSock = 0;
  while (!sock) {
    const pid = adbTry(["shell", "pidof", PKG]).trim();
    if (pid && adbTry(["shell", "grep", "-a", "webview_devtools_remote_" + pid, "/proc/net/unix"]).includes("webview_devtools_remote_" + pid)) {
      sock = "webview_devtools_remote_" + pid; tSock = Date.now() - t0;
    }
    if (!sock) { if (Date.now() - t0 > 20000) throw new Error("20 s 没等到 devtools socket —— 装的是 devtools 包吗?"); await sleep(20); }
  }
  adb(["forward", `tcp:${PORT}`, `localabstract:${sock}`]);
  // 2) 等 page target
  let target = null;
  while (!target) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl); } catch {}
    if (!target) { if (Date.now() - t0 > 25000) throw new Error("25 s 没等到 page target"); await sleep(20); }
  }
  // 3) 连 ws,轮询
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = (expression) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
  const samples = [];
  let first = null, flip = null, injectedAt = null;
  while (Date.now() - t0 < 30000) {
    const v = (await evaluate(EXPR)).result?.result?.value;
    if (!v) { await sleep(15); continue; }
    const s = JSON.parse(v);
    s.host = Date.now() - t0;
    samples.push(s);
    if (!first) first = s;
    // 第一拍常是 about:blank(Tauri 先开空页再导航),探针要等到 tauri.localhost 那份文档出现才注
    if (injectedAt === null && s.url.startsWith("http://tauri.localhost")) injectedAt = (await evaluate(INJECT + "; document.readyState + '/' + Math.round(performance.now())")).result?.result?.value;
    if (s.gate === true) { flip = s; break; }
    await sleep(15);
  }
  ws.close();
  starter.kill();
  const paint = flip?.paint?.length ? flip.paint : first?.paint;
  const fcp = (paint || []).find((p) => p.startsWith("first-contentful-paint"));
  console.log(`\n=== 第 ${idx} 趟 ===`);
  console.log(`宿主侧:socket +${tSock} ms;${startOut.replace(/\s+/g, " ").match(/LaunchState: \w+.*?TotalTime: \d+/)?.[0] ?? "(am start -W 没报)"}`);
  console.log(`第一拍 +${first?.host} ms:页面 now=${first?.now?.toFixed(0)},ready=${first?.ready},url=${first?.url};探针注入于 ${injectedAt ?? "(没注)"}`);
  if (!flip) { console.log(`30 s 内闸没翻成 hidden!最后一拍:${JSON.stringify(samples.at(-1))}`); return; }
  console.log(`闸翻 hidden:页面 now=${flip.now.toFixed(0)},paint=${JSON.stringify(paint)},采样 ${samples.length} 拍;探针=${JSON.stringify(flip.probe)}(1500 = 每次 invoke,150 = 每次歇)`);
  if (fcp) console.log(`⇒ 可见时长 ≈ ${flip.now.toFixed(0)} − ${fcp.split(":")[1]} = ${(flip.now - Number(fcp.split(":")[1])).toFixed(0)} ms(采样粒度 ~15 ms + 一次 evaluate 往返)`);
  else console.log("⇒ 没拿到 first-contentful-paint,这趟算不出可见时长(连上得太晚)");
}

for (let i = 1; i <= runs; i++) await once(i);
