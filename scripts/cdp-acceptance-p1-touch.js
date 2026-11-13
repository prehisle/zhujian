// @cdp-run single
// 144 后续 P1 #10/#11(安卓):触区达标(底栏 44px 实高、操作面「完成」钮的触区同排一致(906 前是 .tick 48)、小按钮 ::before halo)
// + 空间「重置」入口降权(默认不常驻,收进「⋯」;确认钮全宽独行与取消拉开)。
// 只读断言 + 空间面板开合(不碰 reset-ok),evalfile 跑,pass=true 才算过。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond, extra) => {
    out.steps.push(extra === undefined ? { name, ok: !!cond } : { name, ok: !!cond, ...extra });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const halo = (el) => getComputedStyle(el, "::before").content !== "none";

  // ① 底栏按钮实高 ≥44
  // 只量显形的那几枚:「长文」没有长文时 `hidden`(offsetHeight 0),算进来空库上恒红(159 复跑撞到,是台架不是产品)。
  const navBtns = [...document.querySelectorAll("#bottombar button")].filter((b) => !b.hidden);
  ok("底栏按钮 ≥44px", navBtns.length > 0 && navBtns.every((b) => b.offsetHeight >= 44), { h: navBtns.map((b) => b.offsetHeight) });

  // ② 906:卡左边那枚勾完成的圆圈(.tick,此前这一格量它的 48 宽与「圈心钉第一行」)撤了 ⇒ 这一格改量接班的那一枚:
  //    操作面最前面的「完成」钮 —— 看得见的盒 + 上下那层 halo 的触区,与这一排别的钮一样高。
  //    146:任务行只在任务面——先切任务面再查,测完切回灵感面。没有「还没完成、看板有完成列」的任务卡就如实跳过。
  const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
  click(tasksBtn);
  await new Promise((r) => setTimeout(r, 200));
  ok("任务卡上不再有 .tick", !document.querySelector("#timeline .tick"));
  const openCard = [...document.querySelectorAll("#timeline article.card[data-id]:not(.done)")][0];
  if (openCard) {
    if (!openCard.querySelector(".panel")) click(openCard.querySelector(".content"));
    await new Promise((r) => setTimeout(r, 300));
    const cb = document.querySelector('#timeline .panel [data-pact="complete"]');
    if (cb) {
      const zoneOf = (b) => { const cs = getComputedStyle(b, "::before"); return cs.content === "none" ? 0 : b.clientHeight - parseFloat(cs.top) - parseFloat(cs.bottom); };
      const zone = zoneOf(cb);
      const next = zoneOf(document.querySelector('#timeline .panel [data-pact="edit"]'));
      // 这一排的触区 = 内盒 + 上下各 5 的 halo;V1986A 标准字号量到 43.3(整排如此)⇒ 判「完成」没比同排的钮小、且有 halo。
      ok("「完成」钮触区与同排的钮一样高(内盒 + halo,> 40)", zone > 40 && Math.abs(zone - next) < 0.5, { zone, next });
    } else ok("「完成」钮无可测(这张卡的看板没有完成列,跳过)", true, { skipped: true });
    click(document.querySelector("#timeline .panel")?.closest("article.card")?.querySelector(".content") ?? openCard.querySelector(".content")); // 收面
    await new Promise((r) => setTimeout(r, 200));
  } else ok("「完成」钮无任务行可测(跳过)", true, { skipped: true });
  click(document.querySelector('#bottombar [data-mode="ideas"]'));
  await new Promise((r) => setTimeout(r, 200));

  // ③ halo:头部「搜索」ghost 有 ::before 触区垫层
  const ghost = document.querySelector("button.ghost");
  ok("ghost 有 ::before halo", !!ghost && halo(ghost));

  // ④ 空间面板:默认行无常驻「重置」;「⋯」展开才出;确认态钮全宽
  const chip = document.getElementById("space-chip");
  const spacesBtn = document.getElementById("sync-spaces-btn");
  // 单空间时 chip 隐藏,走同步面底部「空间…」兜底入口(133);同步入口在头部
  if (chip.hidden && spacesBtn.hidden) {
    click(document.getElementById("sync-toggle"));
    await until(() => !spacesBtn.hidden, 2000);
  }
  click(chip.hidden ? spacesBtn : chip);
  const rowAct = await until(() => document.querySelector("#space-list .space-row [data-more]"));
  if (!ok("空间行有「⋯」入口", !!rowAct)) return JSON.stringify(out);
  ok("默认行无常驻「重置」", !document.querySelector("#space-list [data-reset]"));
  click(rowAct);
  const resetEntry = await until(() => document.querySelector("#space-list [data-reset]"), 1500);
  if (!ok("「⋯」展开出重置入口", !!resetEntry)) return JSON.stringify(out);
  click(resetEntry);
  const confirmBtn = await until(() => document.querySelector("#space-list [data-reset-ok]"), 1500);
  if (!ok("第一拍出确认态", !!confirmBtn)) return JSON.stringify(out);
  const rowW = confirmBtn.closest(".space-row").getBoundingClientRect().width;
  const cw = confirmBtn.getBoundingClientRect();
  const cancel = document.querySelector("#space-list [data-reset-cancel]").getBoundingClientRect();
  ok("确认钮全宽独行 ≥44px", cw.height >= 44 && cw.width > rowW * 0.8);
  ok("取消与确认拉开(不同行)", cancel.top >= cw.bottom);
  click(document.querySelector("#space-list [data-reset-cancel]"));
  await until(() => !document.querySelector("#space-list [data-reset-ok]"), 1500);
  ok("取消退回默认态", !document.querySelector("#space-list [data-reset-ok]"));

  // ⑤ 收面回时间轴
  click(document.querySelector("header h1"));
  await until(() => !document.body.classList.contains("pane-open"), 1500);

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
