// 511 一次性探针:证明「宽屏限宽居中」那条规则在**手机竖屏上是彻底的 no-op**,且在**宽屏上真收窄**。
//
// 判据不是读 CSS 也不是讲道理,是**把视口真的改成那个宽度再量**:
// 窄档内容块的宽度必须恰等于 body 内容盒宽(= 视口宽 - 左右 padding),
// 且左右 margin 必须都是 0px、FAB 距右缘必须恰是 16px。
// 任何一格不符,就说明这条规则在窄屏上并非无害。
//
// ⭐ **宽屏那半一律显式覆盖视口,⛔ 别再「清掉覆盖、指望设备自己是宽的」**(backlog 测试与工装 64,757 改):
// 设备的密度与方向都是会被人改的环境变量 —— MuMu 被转成竖屏 1440×2560 @ 640dpi 之后原生视口只剩 360,
// vivo V1986A 原生也是 360 ⇒ 旧写法那一步恒红,而它恰是本资产**唯一能证伪**的那半(见文末)。
// 设备原生视口宽多少照样量、照样印(`native`),**只当读数不当判据**(同 kbsheet「先判设备属于哪一类」)。
// 558 用显式宽覆盖量过的对拍参照:1280 → 内容列 640 / 边距 306+306;800 → 640 / 66+66;360 → 332 / 0。
//
// 跑法:先 `node scripts/android-cdp.mjs forward`,再 `node scripts/cdp-acceptance-wide-column.mjs`
// (打印 `{pass, native, rows, steps}`,退出码 0 = 过)。零写入:只动视口覆盖,不碰库。
// 跑完会清掉 override(finally)并核「真回到了原生宽度」,别中途 Ctrl+C。
// ⚠ 空库上 `#filterbar` 是 `hidden`(没有条目就不出筛选条)⇒ 量它的边距时临时摘掉 hidden、量完放回
// (`filterbarForced` 如实标出)。量的是 CSS 规则的解,不是这块条该不该露面。
//
// 阴性对照(757 在 vivo V1986A 实跑;CSS 刀页内注入,不用重建):
//  刀 1 `#filterbar,#timeline,.sync,.compose{max-width:none!important}`(511 那条限宽整条失效)
//   ⇒ 红「宽屏真收窄」两档 + 「宽屏筛选条居中」;窄屏 no-op 照绿(它本来就证明不了这条规则存在)。
//  刀 2 同一组选择器 `margin-left:0!important`(宽度收了、却靠左贴着)⇒ 同样红那三格。
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const PORT = Number(process.env.CDP_PORT || 9222);
const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl);

// 604 补2:除了宽度,**filterbar 的左右边距也要量**。此前这里只有宽度,而
// 「宽度确实收到 640 了、却靠左贴着」正是 max-width 生效、但 margin:auto 被后面某条规则
// 覆盖掉的样子 —— 那一格真栽过:给 #filterbar 加 sticky 时写了 margin 简写(0 -14px 12px),
// 把 auto 冲掉 ⇒ 平板 / 横屏上筛选条不再居中,而**手机竖屏一点看不出来**。
// ⚠ 注释别写进下面那个模板字符串里 —— 里头的反引号会把模板提前闭合(真栽过,语法错)。
const JS_MEASURE = `(()=>{
  const q = (s) => document.querySelector(s);
  const bar = q("#filterbar");
  const forced = bar.hidden;
  if (forced) bar.hidden = false;
  try {
    const cs = (s) => getComputedStyle(q(s));
    const bodyPad = parseFloat(getComputedStyle(document.body).paddingLeft);
    const avail = document.body.clientWidth - 2 * bodyPad;
    const w = (s) => Math.round(q(s).getBoundingClientRect().width * 10) / 10;
    return {
      vw: innerWidth,
      dpr: devicePixelRatio,
      avail: Math.round(avail * 10) / 10,
      timeline: w("#timeline"),
      timelineML: cs("#timeline").marginLeft,
      timelineMR: cs("#timeline").marginRight,
      filterbar: w("#filterbar"),
      filterbarML: cs("#filterbar").marginLeft,
      filterbarMR: cs("#filterbar").marginRight,
      filterbarForced: forced,
      fabRightGap: Math.round((innerWidth - q("#capture-fab").getBoundingClientRect().right) * 10) / 10,
    };
  } finally {
    if (forced) bar.hidden = true;
  }
})()`;

const measure = async (label) => ({ label, ...(await s.evaluate(JS_MEASURE)) });

// 窄 / 过渡四档(竖屏两档判 no-op;横屏 740 与阈值 668 只当读数,同改前)与宽屏两档(判收窄)。
// dpr 照抄 2.25,mobile:true 走移动端布局路径。
const NARROW = [
  ["手机竖屏 360", 360, 800],
  ["手机竖屏 412", 412, 915],
  ["手机横屏 740", 740, 412],
  ["刚好到阈值 668", 668, 900],
];
const WIDE = [
  ["宽屏 800", 800, 1280],
  ["宽屏 1280", 1280, 800],
];

const native = await measure("原生(无覆盖)");
const rows = [];
let restored;
try {
  for (const [label, width, height] of [...NARROW, ...WIDE]) {
    await s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2.25, mobile: true });
    await sleep(350);
    rows.push(await measure(label));
  }
} finally {
  await s.send("Emulation.clearDeviceMetricsOverride");
  await sleep(300);
  restored = await measure("清掉 override(回原生)");
  s.close();
}

const steps = [];
const step = (name, ok, extra) => steps.push({ name, ok: !!ok, ...(extra === undefined ? {} : { extra }) });

// ⚠ **两半判据缺一不可,理由值得写下来**:
//   下面「窄屏 no-op」那半是**证明不了这个功能存在**的 —— 把那条规则整个删掉,窄屏各档
//   照样「宽度==可用宽 / 边距 0 / FAB 16px」,它会安安静静全绿。⇒ 必须另有一半去钉
//   **宽屏上真的收窄了**,那才是这条规则唯一能被证伪的地方(阴性对照刀就落在这一格)。
const narrow = rows.filter((r) => r.vw < 640);
for (const r of narrow) {
  step(
    `窄屏 no-op:${r.label}(宽度==可用宽 / 边距 0 / FAB 16px)`,
    r.timeline === r.avail && r.timelineML === "0px" && r.timelineMR === "0px" && r.fabRightGap === 16,
    { vw: r.vw, timeline: r.timeline, avail: r.avail, ml: r.timelineML, mr: r.timelineMR, fab: r.fabRightGap },
  );
}
// 自证前置:窄档确实量到了(这半不许静默缩成 0 格)。⚠ 改前那版把「清掉覆盖后的原生行」也算进窄档,
// 原生宽度现在只当读数 ⇒ 这里恰是 360 / 412 两档。
step("前置:360 / 412 两个窄档都量到了", narrow.length === 2, { n: narrow.length });

const wide = rows.filter((r) => WIDE.some(([label]) => label === r.label));
for (const r of wide) {
  step(
    `宽屏真收窄:${r.label}(内容列 640 < 可用宽、左右边距对称且 >1、FAB 跟着列右缘走)`,
    r.vw === Number(r.label.split(" ").pop()) &&
      r.timeline === 640 &&
      r.timeline < r.avail &&
      parseFloat(r.timelineML) > 1 &&
      Math.abs(parseFloat(r.timelineML) - parseFloat(r.timelineMR)) < 1 &&
      r.fabRightGap > 16,
    { vw: r.vw, timeline: r.timeline, avail: r.avail, ml: r.timelineML, mr: r.timelineMR, fab: r.fabRightGap },
  );
}

// 604 补2:**筛选条居中**单独判一格,落在最宽那档上。
const w1280 = rows.find((r) => r.label === "宽屏 1280");
step(
  "宽屏筛选条居中(margin:auto 没被后面的规则覆盖)",
  !!w1280 && parseFloat(w1280.filterbarML) > 1 && Math.abs(parseFloat(w1280.filterbarML) - parseFloat(w1280.filterbarMR)) < 1,
  w1280 && { filterbar: w1280.filterbar, ml: w1280.filterbarML, mr: w1280.filterbarMR, forced: w1280.filterbarForced },
);

// 覆盖真清干净了:回到的是开跑前量到的原生宽度(别把设备留在 1280 的假视口上)。
step("清场:override 已清、视口回到原生宽度", restored.vw === native.vw, { native: native.vw, after: restored.vw });

const pass = steps.every((x) => x.ok);
console.log(JSON.stringify({ pass, native: { vw: native.vw, dpr: native.dpr, timeline: native.timeline, ml: native.timelineML }, rows, steps }, null, 1));
for (const x of steps) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : ` ${JSON.stringify(x.extra)}`}`);
console.log(`\n设备原生视口 ${native.vw}(dpr ${native.dpr})—— 只是读数;宽屏半已显式覆盖到 800 / 1280。`);
console.log(pass ? "✅ pass" : "❌ FAIL");
process.exit(pass ? 0 : 1);
