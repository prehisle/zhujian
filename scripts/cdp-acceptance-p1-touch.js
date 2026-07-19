// 144 后续 P1 #10/#11(安卓):触区达标(底栏 44px 实高、.tick 48、小按钮 ::before halo)
// + 空间「重置」入口降权(默认不常驻,收进「⋯」;确认钮全宽独行与取消拉开)。
// 只读断言 + 空间面板开合(不碰 reset-ok),evalfile 跑,pass=true 才算过。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
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
  const navBtns = [...document.querySelectorAll("#bottombar button")];
  ok("底栏按钮 ≥44px", navBtns.length > 0 && navBtns.every((b) => b.offsetHeight >= 44));

  // ② .tick 宽 48。146:任务行只在任务面——先切任务面再查(启动恒落灵感面,
  //    不切则永走「跳过」的空测),测完切回灵感面。
  const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
  click(tasksBtn);
  await new Promise((r) => setTimeout(r, 200));
  const tick = document.querySelector("#timeline .tick");
  ok(tick ? ".tick 宽 ≥48px" : ".tick 无任务行可测(跳过)", tick ? tick.offsetWidth >= 48 : true);
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
