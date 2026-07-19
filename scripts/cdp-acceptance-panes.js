// 121 面板接管视图验收 —— 开任一面板应收起 compose+时间轴、面板落在顶部(诊断不再埋底)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-panes.js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null;
  const topOf = (el) => Math.round(el.getBoundingClientRect().top);
  // 143:诊断入口自底栏挪同步面(#sync-diag-btn),开合改点它;其余仍走底栏。
  // 146:去向已摘,底栏 pane 只剩回收站/归档册。
  const PANES = [
    { pane: "trash", el: "trash-pane" },
    { pane: "sealed", el: "sealed-pane" },
    { pane: "diag", el: "diag", btn: "#sync-diag-btn" },
  ];
  const compose = document.querySelector(".compose");
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
      composeHidden: !visible(compose),
      timelineHidden: !visible(timeline),
    });
    document.querySelector(p.btn ?? `#bottombar [data-pane="${p.pane}"]`).click(); // 再点关掉
    await sleep(150);
  }
  const closedComposeBack = visible(compose) && visible(timeline); // 全关后恢复
  const pass =
    rows.every((r) => r.paneVisible && r.paneAboveFold && r.composeHidden && r.timelineHidden) &&
    closedComposeBack;
  return { viewportH: vh, rows, closedComposeBack, pass };
})();
