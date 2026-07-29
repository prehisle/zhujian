// 桌面看大图的**关闭手感**(246 回归资产)。跑法:
//   node scripts/desktop-cdp.mjs evalfile scripts/cdp-acceptance-desktop-lightbox-close.js
// (先按 desktop-cdp.mjs 文件头带 CDP 环境变量起 app;需要笔记本里**至少有一条带配图的条目**
//  ——脚本点的是页面上第一枚 `.img-thumb-img`。)
//
// 立的是 246 那两条:
//  ① 点图关闭不再白等半秒(CLICK_DELAY 500→250),且**遮罩里的图先卸、窗口后缩**——缩窗要让
//    WebView 把整个主窗重排一遍,全尺寸位图不该陪着一起重绘;而遮罩要等窗口还原完才撤,这段
//    是用户报的「关闭好卡」。`shedAt < goneAt` 就是「先卸后缩」的地面真相。
//  ② 缩短延迟不能把双击切取向误关掉:兜底是 pointerdown 一按下就 clearTimeout,所以真双击
//    (两次**按下**间隔 140ms)必须活下来。这条是阴性对照,别只验关得快。
// 合成事件够用:这两条都是纯 DOM 时序,不经原生输入管线;`detail:1` 必须给——单击关那支
// 明确判 `e.detail !== 1` 才安排关闭。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = {};

  const thumb = q("img.img-thumb-img");
  if (!thumb) return JSON.stringify({ error: "页面上没有带配图的条目,先造一条再跑" });
  const vw0 = window.innerWidth;

  const openIt = async () => {
    q("img.img-thumb-img").click(); // 点内层 img(handler 挂它身上)
    for (let i = 0; i < 40 && !q(".img-lightbox"); i++) await sleep(50);
    await sleep(900); // 取字节 + 解码 + 撑窗 + viewportSettle 定形
    return q("img.img-lightbox-img");
  };
  const at = (img) => {
    const r = img.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const press = (img, cx, cy) =>
    img.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        button: 0,
        isPrimary: true,
        pointerId: 1,
      }),
    );
  const clickN = (img, cx, cy, detail) =>
    img.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, detail }),
    );

  // ---- ① 关闭:多久关掉 + 是不是「先卸图后缩窗」 -------------------------------
  let img = await openIt();
  if (!img) return JSON.stringify({ error: "大图没打开" });
  out.viewportGrown = window.innerWidth !== vw0; // 撑过窗才有「缩窗」这段可测
  out.clickCloses = img.style.cursor !== "grab"; // 整图放得下 → 单击关那支才生效
  {
    // 顺序探针走 MutationObserver 而非轮询:没撑过窗时「卸图」与「撤遮罩」落在同一帧里,
    // 8ms 的轮询根本插不进去,只有 records 的先后能作证。撑过窗时两者之间还隔着整段缩窗。
    const seq = [];
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.target.classList && r.target.classList.contains("img-lightbox") && r.removedNodes.length)
          seq.push("shed"); // 遮罩自己的孩子被清空 = shedVisuals
        if (
          r.target === document.body &&
          [...r.removedNodes].some((n) => n.classList && n.classList.contains("img-lightbox"))
        )
          seq.push("gone"); // 遮罩本体离场
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    const { cx, cy } = at(img);
    const t0 = performance.now();
    press(img, cx, cy);
    clickN(img, cx, cy, 1);
    // 同步查(handler 是同步跑的):点下去**立刻**开始淡出才算有回执——延迟那段的存在理由是
    // 给双击留取消的机会,不是让用户对着静止画面等。这条是 246 二轮的核心契约。
    out.closingImmediately = !!q(".img-lightbox.closing");
    let goneAt = null;
    while (performance.now() - t0 < 6000) {
      if (!q(".img-lightbox")) {
        goneAt = performance.now() - t0;
        break;
      }
      await sleep(8);
    }
    await sleep(50); // 让最后一批 mutation records 派完
    mo.disconnect();
    out.closeMs = goneAt === null ? null : Math.round(goneAt);
    out.seq = seq.join(">");
    out.shedBeforeGone = seq.indexOf("shed") >= 0 && seq.indexOf("shed") < seq.indexOf("gone");
  }
  await sleep(400);
  out.viewportRestored = window.innerWidth === vw0;

  // ---- ② 阴性对照:真双击(两次按下隔 140ms)不许被缩短后的延迟提前关掉 -----------
  img = await openIt();
  if (!img) return JSON.stringify({ ...out, error: "第二次没打开" });
  {
    const { cx, cy } = at(img);
    const wBefore = img.getBoundingClientRect().width;
    press(img, cx, cy);
    clickN(img, cx, cy, 1);
    await sleep(140); // 人双击的典型两次按下间隔
    press(img, cx, cy); // 这一下负责撤销上一击挂着的「待关」
    clickN(img, cx, cy, 2);
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    await sleep(600); // 越过 CLICK_DELAY:兜底若失效,这会儿图早没了
    out.survivedDoubleClick = !!q(".img-lightbox");
    out.closingCancelled = !q(".img-lightbox.closing"); // 淡出被撤销、内容平滑回来(不许留残影)
    // 只作信息:图比视口小时 fit 与 fill 的基准都被 1:1 封顶,尺寸本就该一样,不能当判据。
    const now = q("img.img-lightbox-img");
    out.modeToggled = !!now && Math.abs(now.getBoundingClientRect().width - wBefore) > 1;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  for (let i = 0; i < 40 && q(".img-lightbox"); i++) await sleep(50);
  out.escStillCloses = !q(".img-lightbox");

  out.pass =
    out.clickCloses === true &&
    out.closingImmediately === true &&
    out.closeMs !== null &&
    out.closeMs < 500 &&
    out.shedBeforeGone === true &&
    out.viewportRestored === true &&
    out.survivedDoubleClick === true &&
    out.closingCancelled === true &&
    out.escStillCloses === true;
  return JSON.stringify(out);
})();
