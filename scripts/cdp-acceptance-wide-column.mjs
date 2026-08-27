// 511 一次性探针:证明「宽屏限宽居中」那条规则在**手机竖屏上是彻底的 no-op**。
//
// 判据不是读 CSS 也不是讲道理,是**把视口真的改成手机竖屏再量**:
// 内容块的宽度必须恰等于 body 内容盒宽(= 视口宽 - 左右 padding),
// 且左右 margin 必须都是 0px、FAB 距右缘必须恰是 16px。
// 任何一格不符,就说明这条规则在窄屏上并非无害。
//
// 跑法:先 `node scripts/android-cdp.mjs forward`,再 `node scripts/probe-width-noop.mjs`
// 跑完会清掉 override(finally),别中途 Ctrl+C。
const BASE = "http://127.0.0.1:9222";

const targets = await (await fetch(`${BASE}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("没有可用的 page target —— forward 建好了吗?装的是 devtools 包吗?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const measure = async (label) => {
  const { result } = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(()=>{
      const q = (s) => document.querySelector(s);
      const cs = (s) => getComputedStyle(q(s));
      const bodyPad = parseFloat(getComputedStyle(document.body).paddingLeft);
      const avail = document.body.clientWidth - 2 * bodyPad;
      const w = (s) => Math.round(q(s).getBoundingClientRect().width * 10) / 10;
      return {
        vw: innerWidth,
        avail: Math.round(avail * 10) / 10,
        timeline: w("#timeline"),
        timelineML: cs("#timeline").marginLeft,
        timelineMR: cs("#timeline").marginRight,
        filterbar: w("#filterbar"),
        fabRightGap: Math.round((innerWidth - q("#capture-fab").getBoundingClientRect().right) * 10) / 10,
      };
    })()`,
  });
  return { label, ...result.value };
};

const rows = [];
try {
  // 手机竖屏三档 + 手机横屏一档。dpr 照抄设备的 2.25,mobile:true 走移动端布局路径。
  for (const [label, width, height] of [
    ["手机竖屏 360", 360, 800],
    ["手机竖屏 412", 412, 915],
    ["手机横屏 740", 740, 412],
    ["刚好到阈值 668", 668, 900],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 2.25, mobile: true,
    });
    await new Promise((r) => setTimeout(r, 350));
    rows.push(await measure(label));
  }
} finally {
  await send("Emulation.clearDeviceMetricsOverride");
  await new Promise((r) => setTimeout(r, 300));
  rows.push(await measure("清掉 override(回真实宽屏)"));
  ws.close();
}

console.log(JSON.stringify(rows, null, 1));

// ⚠ **两半判据缺一不可,理由值得写下来**:
//   下面「窄屏 no-op」那半是**证明不了这个功能存在**的 —— 把那条规则整个删掉,窄屏各档
//   照样「宽度==可用宽 / 边距 0 / FAB 16px」,它会安安静静全绿。⇒ 必须另有一半去钉
//   **宽屏上真的收窄了**,那才是这条规则唯一能被证伪的地方(阴性对照刀就落在这一格)。
const narrow = rows.filter((r) => r.vw < 640);
const noop = narrow.filter(
  (r) => r.timeline !== r.avail || r.timelineML !== "0px" || r.timelineMR !== "0px" || r.fabRightGap !== 16,
);
// 宽屏那半:取最后一行(override 已清、回到设备真实宽度)。
const wide = rows[rows.length - 1];
const capped = wide.vw > 668 && wide.timeline === 640 && wide.timeline < wide.avail
  && parseFloat(wide.timelineML) > 1 && Math.abs(parseFloat(wide.timelineML) - parseFloat(wide.timelineMR)) < 1
  && wide.fabRightGap > 16;

console.log(noop.length === 0
  ? `✅ 窄屏 no-op:${narrow.length} 个窄档全部「宽度==可用宽 / 边距 0 / FAB 16px」`
  : `❌ 窄屏上并非无害:${JSON.stringify(noop)}`);
console.log(capped
  ? `✅ 宽屏真收窄:视口 ${wide.vw} 上 timeline=${wide.timeline}(可用宽 ${wide.avail})、左右边距 ${wide.timelineML} 对称、FAB 距右 ${wide.fabRightGap}`
  : `❌ 宽屏没收窄(这条规则没生效 / 被删了):${JSON.stringify(wide)}`);
const pass = noop.length === 0 && capped;
console.log(pass ? "\n✅ pass" : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
