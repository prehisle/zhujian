// 桌面看大图的缩放通道归属(245 回归资产)。跑法:
//   node scripts/desktop-cdp.mjs evalfile scripts/cdp-acceptance-desktop-lightbox-zoom.js
// (先按 desktop-cdp.mjs 文件头带 CDP 环境变量起 app;需要笔记本里**至少有一条带配图的条目**,
//  灵感/看板都行——脚本点的是页面上第一枚 `.img-thumb-img`。)
//
// 立的是 245 那条规矩:**大图开着时,滚轮缩放归大图**。241 的界面字号缩放挂在 document 上、
// 同样只看 ctrlKey,大图那支若只 preventDefault 不 stopPropagation,两处会同时缩——图缩一档、
// 界面字号也被静默改一档还写进 localStorage(关掉大图回不去、重启还在),回执 badge 又被遮罩
// 盖住看不见。四条断言里两条是「不该失效的那一半」,别只验能缩。
//
// 合成 WheelEvent 够用:这条患是纯 DOM 冒泡行为,与原生滚轮走同一条传播路径(手势/触摸类
// 才必须走原生输入管线)。`hitsFromPage === 1` 是探针的阴性对照——没它就分不清「冒泡被掐」
// 和「探针根本没装上」。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const zoomNow = () => localStorage.getItem("zhujian.zoom");
  const out = { zoomBefore: zoomNow() };
  let hits = 0;
  const probe = (e) => {
    if (e.ctrlKey) hits++;
  };
  document.addEventListener("wheel", probe); // 与 zoom.ts 同相位(document 冒泡)
  try {
    const thumb = document.querySelector("img.img-thumb-img");
    if (!thumb) return JSON.stringify({ error: "页面上没有带配图的条目,先造一条再跑" });
    thumb.click(); // 点的是内层 img——handler 挂在它身上,点外层 .img-thumb 不开图
    for (let i = 0; i < 40 && !document.querySelector(".img-lightbox"); i++) await sleep(100);
    const scroller = document.querySelector(".img-lightbox");
    if (!scroller) return JSON.stringify({ error: "大图没打开" });
    await sleep(600); // 等取字节/解码/撑窗定形(163 的 viewportSettle)
    const img = scroller.querySelector("img.img-lightbox-img");
    const widthBefore = img ? img.getBoundingClientRect().width : 0;

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
    out.uiZoomUntouched = zoomNow() === out.zoomBefore; // 界面字号纹丝不动

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 30 && document.querySelector(".img-lightbox"); i++) await sleep(100);
    out.lightboxClosed = !document.querySelector(".img-lightbox");
    await sleep(300);

    // 不该失效的那一半:大图关着时,Ctrl+滚轮仍归界面字号(且探针确实装上了)。
    hits = 0;
    document.body.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -100,
        clientX: 400,
        clientY: 400,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(500);
    out.hitsFromPage = hits; // 期望 1
    out.globalZoomStillWorks = zoomNow() !== out.zoomBefore;
    // 复原:反向滚回去,别把跑验收的人的字号留在别处(zoom 是纯本地持久化设置)。
    document.body.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: 100,
        clientX: 400,
        clientY: 400,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(500);
    out.zoomRestored = zoomNow() === out.zoomBefore;
  } finally {
    document.removeEventListener("wheel", probe);
  }
  out.pass =
    out.hitsFromLightbox === 0 &&
    out.imgGrew === true &&
    out.uiZoomUntouched === true &&
    out.lightboxClosed === true &&
    out.hitsFromPage === 1 &&
    out.globalZoomStillWorks === true &&
    out.zoomRestored === true;
  return JSON.stringify(out);
})();
