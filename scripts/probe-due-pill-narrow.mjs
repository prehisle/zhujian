// 一次性探针(用户面 60-D):到期汇总钮摆在 `.fstages` 行**最前**是个取舍 —— 它把状态
// chips 往右推。MuMu 的 CSS 视口量不出真手机上的代价 ⇒ 把视口真改成 412×915(常见手机
// 竖屏那一档)再量:钮自己有没有被挤没、整行还剩多少、以及收起态下钮是不是整枚可见。
//
// ⛔ 它不是回归资产(不进套件):形状与数字都随字体与语言变,钉死了只会变成噪声。
// 它答的是一次性的那个问题「窄屏上这个位置站得住吗」,答完就该被截图与判断取代。
//
// 跑法:先 `node scripts/android-cdp.mjs forward`,再 `node scripts/probe-due-pill-narrow.mjs`
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
const evalIn = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { returnByValue: true, expression });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  return result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await sleep(900);
  const out = await evalIn(`(()=>{
    const bar = document.getElementById("filter-stages");
    const due = bar && bar.querySelector(".fdue");
    if (!due) return { error: "钮不在 —— 库里没有到期任务?先播种" };
    const br = due.getBoundingClientRect();
    const barR = bar.getBoundingClientRect();
    // 「整枚可见」= 钮的右缘没有超出行的可视右缘(行是横滑的,超出就得滑才看得到)
    const fullyVisible = br.left >= barR.left - 0.5 && br.right <= barR.right + 0.5;
    // 钮之后这一行还剩多少可视宽度给状态 chips
    const leftForStages = barR.right - br.right;
    const stages = [...bar.querySelectorAll(".fpill:not(.fdue)")].map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim().slice(0, 12), vis: r.left >= barR.left - 0.5 && r.right <= barR.right + 0.5 };
    });
    return {
      viewport: innerWidth + "x" + innerHeight,
      dueText: due.textContent.trim(),
      dueW: +br.width.toFixed(1),
      barW: +barR.width.toFixed(1),
      dueFullyVisible: fullyVisible,
      leftForStages: +leftForStages.toFixed(1),
      stagesVisible: stages,
      rowScrolls: bar.scrollWidth > bar.clientWidth + 1,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await send("Emulation.clearDeviceMetricsOverride");
  ws.close();
}
