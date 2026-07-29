// 121 面板接管视图验收 —— 开任一面板应收起时间轴、面板落在顶部(诊断不再埋底);全关回时间轴。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-panes.js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // ⚠ 别用 offsetParent 判可见:240 起捕获层 `.compose` 是 position:fixed(滑到屏下),
  // fixed 元素 offsetParent 恒 null——旧判据把它误读成「隐藏」,`closedComposeBack` 自
  // 240 起恒 false(那几轮没跑本资产才没暴露)。改用 display + rect 面积判真可见。
  const visible = (el) => {
    if (!el) return false;
    if (getComputedStyle(el).display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const topOf = (el) => Math.round(el.getBoundingClientRect().top);
  const paneOpen = () => document.body.classList.contains("pane-open");
  // 143:诊断入口自底栏挪同步面;**250 再挪进设置面(#settings-diag-btn)**,开合改点它。
  // 146:去向已摘,底栏 pane 只剩回收站/归档册。
  // 250:设置面本身也入列,入口是顶栏齿轮 #settings-toggle(不在底栏)。
  const PANES = [
    { pane: "trash", el: "trash-pane" },
    { pane: "sealed", el: "sealed-pane" },
    { pane: "settings", el: "settings-pane", btn: "#settings-toggle" },
    { pane: "diag", el: "diag", btn: "#settings-diag-btn" },
  ];
  const timeline = document.getElementById("timeline");
  const vh = window.innerHeight;
  const rows = [];
  for (const p of PANES) {
    document.querySelector(p.btn ?? `#bottombar [data-pane="${p.pane}"]`).click();
    await sleep(300);
    const el = document.getElementById(p.el);
    rows.push({
      pane: p.pane,
      paneVisible: visible(el),
      paneTop: topOf(el),
      paneAboveFold: topOf(el) < vh, // 面板顶部在首屏内 = 开屏可见(诊断埋底会 > vh)
      paneOpenClass: paneOpen(), // body.pane-open 接管:CSS 靠它收 compose+时间轴
      timelineHidden: !visible(timeline),
    });
    document.querySelector(p.btn ?? `#bottombar [data-pane="${p.pane}"]`).click(); // 再点关掉
    await sleep(150);
  }
  // 全关后:回到时间轴(可见)、pane-open 摘掉(compose 底部层随之可再唤起,240 后
  // 它平时本就滑在屏下、不作可见判据)。
  const closedBackToTimeline = visible(timeline) && !paneOpen();
  const pass =
    rows.every((r) => r.paneVisible && r.paneAboveFold && r.paneOpenClass && r.timelineHidden) &&
    closedBackToTimeline;
  return { viewportH: vh, rows, closedBackToTimeline, pass };
})();
