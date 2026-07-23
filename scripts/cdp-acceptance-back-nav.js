// 143 返回键层账本 + 查看器手势 的页内可断言部分(evalfile 跑,pass=true 才算过)。
// 硬件返回键本身没法在页内断言,那半截走 runbook(**146 真机取证照出大坑:wry 层
// 从未注册,且 WebView.canGoBack() 对 pushState 同文档条目恒 false——返回恒 finish,
// 页内断言全绿也测不到;终局修复=MainActivity 自注册回调调 JS 原子入口
// window.__zhujianHandleBack()(关层/收扫码/合并在飞,回 false 才放行退 app),
// Kotlin 侧 single-flight+500ms 超时 fail-open。此半截每轮必跑**):
//   开面板 → adb shell input keyevent 4 → 断言 pane-open 消失且 topResumedActivity 仍是朱简;
//   时间轴无层态(灵感面或任务面,146 起 mode 不压层)→ keyevent 4 → 应退到桌面(一次即退,不留空炮)。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const paneOpen = () => document.body.classList.contains("pane-open");
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  // ① 底栏 toggle:开回收站 → 再点一次收面回时间轴(146:去向已摘,锚换 trash)
  const trashBtn = document.querySelector('#bottombar [data-pane="trash"]');
  click(trashBtn);
  await new Promise((r) => setTimeout(r, 100));
  ok("底栏开回收站", paneOpen() && !document.getElementById("trash-pane").hidden);
  click(trashBtn);
  await new Promise((r) => setTimeout(r, 100));
  ok("再点一次收面", !paneOpen());

  // ② 点头部「朱简」收面
  click(document.querySelector('#bottombar [data-pane="trash"]'));
  await new Promise((r) => setTimeout(r, 100));
  click(document.querySelector("header h1"));
  await new Promise((r) => setTimeout(r, 100));
  ok("头部朱简收面", !paneOpen());

  // ③ 查看器手势数学:摆一张 200×200,合成双指 60→160 应得 scale≈2.667;
  //    放大态合成单击不关;数学断言完直接复原(不走关闭路,免动 history 账本)。
  const v = document.getElementById("viewer");
  const img = document.getElementById("viewer-img");
  img.src =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="tomato"/></svg>',
    );
  v.hidden = false;
  await new Promise((r) => setTimeout(r, 300)); // 等 load 量基座
  const pe = (type, id, x, y) =>
    v.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true }));
  pe("pointerdown", 1, 150, 400);
  pe("pointerdown", 2, 210, 400);
  pe("pointermove", 1, 100, 400);
  pe("pointermove", 2, 260, 400);
  pe("pointerup", 1, 100, 400);
  pe("pointerup", 2, 260, 400);
  const m = /scale\(([\d.]+)\)/.exec(img.style.transform);
  ok("捏合 60→160 得 ~2.667 倍", m && Math.abs(parseFloat(m[1]) - 8 / 3) < 0.01);
  click(v); // 放大态单击:不许关
  await new Promise((r) => setTimeout(r, 400));
  ok("放大态单击不关", !v.hidden);
  // 147 修:放大态「图N」角标淡出(zoomed 类 + cap opacity 0),免与图重合
  ok(
    "放大态角标淡出",
    v.classList.contains("zoomed") &&
      getComputedStyle(document.getElementById("viewer-cap")).opacity === "0",
  );
  v.hidden = true;
  img.src = "";
  img.style.transform = "";
  v.classList.remove("zoomed"); // 手动清场(绕过 resetZoom),类也一并摘

  // ④ viewport 锁缩放的静态锚
  const meta = document.querySelector('meta[name="viewport"]').content;
  ok("viewport 锁 user-scalable", /user-scalable=no/.test(meta) && /maximum-scale=1/.test(meta));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
