// 桌面看大图的缩放通道(245 立,606 遮罩搬进独立窗之后重写)。跑法:
//   node scripts/desktop-cdp.mjs evalfile scripts/cdp-acceptance-desktop-lightbox-zoom.js --page lightbox
// (先按 desktop-cdp.mjs 文件头带 CDP 环境变量起 app;⭐ 606 起本支自给自足,自己造图自己开图。)
//
// ⭐ **245 那个患本身已经结构性地不可能了,别把这支读成还在守它**:那时遮罩与界面字号缩放
// (`zoom.ts`)挂在**同一个 document** 上、又都只看 ctrlKey ⇒ 大图那支若只 preventDefault
// 不 stopPropagation,一记滚轮会同时缩图和缩界面字号(还写进 localStorage,关掉大图回不去)。
// 606 起遮罩自己是一只独立窗,那只窗**根本没装 `zoom.ts`** ⇒ 两处同时缩这件事没有发生的地方了。
//
// 于是这一支今天守的是剩下的两格,都还实实在在:
//  ①**图自己缩得动**(Ctrl+滚轮 → 渲染宽真的变大)—— 那是 makeImageViewer 的活;
//  ②**遮罩窗一个字都不许写界面字号那个键**。⚠ 这一格不是废话:两个窗**同源**(tauri.localhost)
//    ⇒ localStorage 是共享的,遮罩窗真要是哪天误引了 zoom.ts,受害的是笔记本窗、而且是持久的。
//    ⛔ 别因为「它现在没引」就把这格删掉:那正是这格要看着的事。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const zoomNow = () => localStorage.getItem("zhujian.zoom");
  const out = { zoomBefore: zoomNow() };

  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = 240;
  const cx2 = cv.getContext("2d");
  cx2.fillStyle = "#c0392b";
  cx2.fillRect(0, 0, 320, 240);
  await window.__TAURI__.event.emitTo("lightbox", "lightbox://open", {
    kind: "data",
    src: cv.toDataURL("image/png"),
    alt: "验收",
    from: "notebook",
    monitor: null,
  });
  for (let i = 0; i < 60 && !document.querySelector(".img-lightbox"); i++) await sleep(50);
  const scroller = document.querySelector(".img-lightbox");
  if (!scroller) return JSON.stringify({ ...out, error: "大图没打开" });
  for (let i = 0; i < 60; i++) {
    const im = document.querySelector("img.img-lightbox-img");
    if (im && im.style.visibility !== "hidden" && im.getBoundingClientRect().width > 0) break;
    await sleep(50);
  }
  const img = scroller.querySelector("img.img-lightbox-img");
  const widthBefore = img ? img.getBoundingClientRect().width : 0;

  // `hitsFromLightbox` 是探针的**阴性对照**:没它就分不清「冒泡被掐住了」和「探针根本没装上」。
  // 606 起它恒 0 的理由变了(不再是 stopPropagation 挡住,而是本窗 document 上没有别人),
  // 留着仍有用 —— 它顺带证明「遮罩确实吃掉了这记滚轮、没漏给别人」。
  let hits = 0;
  const probe = (e) => {
    if (e.ctrlKey) hits++;
  };
  document.addEventListener("wheel", probe);
  try {
    const r = scroller.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    hits = 0;
    for (let i = 0; i < 3; i++) {
      scroller.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -100,
          clientX: cx,
          clientY: cy,
          bubbles: true,
          cancelable: true,
        }),
      );
      await sleep(60);
    }
    await sleep(300);
    out.hitsFromLightbox = hits; // 期望 0:事件不该冒到 document
    out.imgGrew = (img ? img.getBoundingClientRect().width : 0) > widthBefore + 1; // 图自己得缩放
    out.uiZoomUntouched = zoomNow() === out.zoomBefore; // 界面字号那个键纹丝不动(两窗同源共享)

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 30 && document.querySelector(".img-lightbox"); i++) await sleep(100);
    out.lightboxClosed = !document.querySelector(".img-lightbox");
  } finally {
    document.removeEventListener("wheel", probe);
  }
  out.pass =
    out.hitsFromLightbox === 0 &&
    out.imgGrew === true &&
    out.uiZoomUntouched === true &&
    out.lightboxClosed === true;
  return JSON.stringify(out);
})();
