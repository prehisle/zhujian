// 桌面看大图的**关闭手感**(246 立的两条,606 遮罩搬进独立窗之后重写)。跑法:
//   node scripts/desktop-cdp.mjs evalfile scripts/cdp-acceptance-desktop-lightbox-close.js --page lightbox
// (先按 desktop-cdp.mjs 文件头带 CDP 环境变量起 app。⭐ **606 起本支自给自足**:它自己画一张
//  canvas、自己给遮罩窗发一条 `lightbox://open`,不再要求「笔记本里先有一条带配图的条目」。
//  ⛔ 别改回「点第一枚 .img-thumb-img」——那枚缩略图在**另一个页面**上,一支 evalfile 够不着。)
//
// 立的是 246 那两条:
//  ① 点图关闭不再白等半秒,且**遮罩里的图先卸、窗口后藏**——藏窗要让 WebView 把整个窗口重排
//    一遍,全尺寸位图不该陪着一起重绘;而遮罩要等 hide 跑完才撤,这段是用户报的「关闭好卡」。
//    `shed` 排在 `gone` 之前就是「先卸后藏」的地面真相。
//  ② 缩短延迟不能把双击切取向误关掉:兜底是 pointerdown 一按下就 clearTimeout,所以真双击
//    (两次**按下**间隔 140ms)必须活下来。这条是阴性对照,别只验关得快。
// 合成事件够用:这两条都是纯 DOM 时序,不经原生输入管线;`detail:1` 必须给——单击关那支
// 明确判 `e.detail !== 1` 才安排关闭。
//
// ⚠ **本支刻意不量窗口几何**:开图请求里 `monitor` 送 null(遮罩窗保持自己当前尺寸),
// 「铺满哪块显示器」归 e2e 与人工验收,不是这一支的判据。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = {};

  // 自己造一张 320×240 的图喂给自己的开图事件。图必须**比视口小**:①「整图放得下」才走单击
  // 关那支(溢出时是拖着滚,不关);②双击切取向那格才有得切。
  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = 240;
  const cx2 = cv.getContext("2d");
  cx2.fillStyle = "#c0392b";
  cx2.fillRect(0, 0, 320, 240);
  const src = cv.toDataURL("image/png");

  const openIt = async () => {
    await window.__TAURI__.event.emitTo("lightbox", "lightbox://open", {
      kind: "data",
      src,
      alt: "验收",
      from: "notebook",
      monitor: null,
    });
    for (let i = 0; i < 60 && !q(".img-lightbox"); i++) await sleep(50);
    for (let i = 0; i < 60; i++) {
      const im = q("img.img-lightbox-img");
      if (im && im.style.visibility !== "hidden" && im.getBoundingClientRect().width > 0) break;
      await sleep(50);
    }
    return q("img.img-lightbox-img");
  };
  const at = (img) => {
    const r = img.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const press = (img, x, y) =>
    img.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        isPrimary: true,
        pointerId: 1,
      }),
    );
  const clickN = (img, x, y, detail) =>
    img.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }),
    );

  // ---- ① 关闭:多久关掉 + 是不是「先卸图后藏窗」 -------------------------------
  let img = await openIt();
  if (!img) return JSON.stringify({ error: "大图没打开(emitTo 没到?遮罩窗的 listener 没装上?)" });
  out.clickCloses = img.style.cursor !== "grab"; // 整图放得下 → 单击关那支才生效
  {
    // 顺序探针走 MutationObserver 而非轮询:两次 DOM 变动之间只隔着一趟 hide 的 IPC,
    // 8ms 的轮询未必插得进去,只有 records 的先后能作证。
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
    const p = at(img);
    const t0 = performance.now();
    press(img, p.x, p.y);
    clickN(img, p.x, p.y, 1);
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
  // 606 新增的一格:关掉之后遮罩窗本体必须**真的藏起来** —— 它是置顶窗,不藏就一直盖着整块屏幕
  // (那是这一版架构最贵的失败模式,而它在 DOM 上一点痕迹都没有)。
  out.windowHidden = !(await window.__TAURI__.window.getCurrentWindow().isVisible());

  // ---- ② 阴性对照:真双击(两次按下隔 140ms)不许被缩短后的延迟提前关掉 -----------
  img = await openIt();
  if (!img) return JSON.stringify({ ...out, error: "第二次没打开" });
  {
    const p = at(img);
    const wBefore = img.getBoundingClientRect().width;
    press(img, p.x, p.y);
    clickN(img, p.x, p.y, 1);
    await sleep(140); // 人双击的典型两次按下间隔
    press(img, p.x, p.y); // 这一下负责撤销上一击挂着的「待关」
    clickN(img, p.x, p.y, 2);
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
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
  await sleep(300);
  out.windowHiddenAtEnd = !(await window.__TAURI__.window.getCurrentWindow().isVisible());

  out.pass =
    out.clickCloses === true &&
    out.closingImmediately === true &&
    out.closeMs !== null &&
    out.closeMs < 500 &&
    out.shedBeforeGone === true &&
    out.windowHidden === true &&
    out.survivedDoubleClick === true &&
    out.closingCancelled === true &&
    out.escStillCloses === true &&
    out.windowHiddenAtEnd === true;
  return JSON.stringify(out);
})();
