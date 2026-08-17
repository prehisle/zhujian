// 任务面状态 chips(404+1):筛选区新增「状态」行(全部+四态,带全量计数),点谁只看谁段。
// 覆盖:chips 成员与计数 / 单选投影 / 点已选=回全部 / 状态筛空的专属空态 / 新任务落面自动清维 /
// 搜索定位命中被状态维藏着的卡时该维自清。全程 UI 驱动真数据,finally 清场(建的三条彻底删)。
//   CDP_TIMEOUT_MS=60000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-stage-chips.js
// ⚠ 必须放宽超时:三次建卡 + 一次勾完成 + 搜索跳转 + 三次两拍彻底删,10s 默认上限不够。
// 断言语言无关:不认中文词,认 data-stage / .fpill.active / 计数变化 / 卡片 id 在不在。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 5000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const cb = document.getElementById("confirmbar");
  const bar = () => document.getElementById("filter-stages");
  const chip = (stage) => bar().querySelector(`[data-stage="${stage}"]`);
  const chipCount = (stage) => Number(chip(stage)?.querySelector(".fn")?.textContent ?? "-1");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const compose = async (marker) => {
    const ta = document.getElementById("text");
    ta.value = marker;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    return card?.dataset.id ?? null;
  };
  const purge = async (id) => {
    if (!id) return;
    let del = null;
    for (let i = 0; i < 3 && !del; i++) {
      const c = cardOf(id);
      if (!c) break;
      click(c.querySelector(".content"));
      del = await until(() => cardOf(id)?.querySelector('.panel [data-pact="del"]'), 1500);
    }
    if (del) {
      click(del);
      await until(() => !cb.hidden, 1500);
      click(document.getElementById("confirmbar-yes"));
      await until(() => !cardOf(id));
    }
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    const row = await until(() => document.querySelector(`[data-trash="${id}"]`), 2500);
    if (row) {
      click(row.querySelector('[data-trash-act="purge"]'));
      await until(() => !cb.hidden, 1500);
      click(document.getElementById("confirmbar-yes"));
      await until(() => !document.querySelector(`[data-trash="${id}"]`));
    }
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    await until(() => !document.body.classList.contains("pane-open"), 1500);
  };

  const stamp = Date.now();
  const m1 = `【CDP验收】状态chips甲 ${stamp}`;
  const m2 = `【CDP验收】状态chips乙 ${stamp}`;
  const m3 = `【CDP验收】状态chips丙 ${stamp}`;
  let t1 = null;
  let t2 = null;
  let t3 = null;
  try {
    // ── ① 任务面 + 两条种子(乙勾成已完成 ⇒ 面上同时有两个 stage)──
    const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasksBtn);
    if (!ok("切到任务面", await until(() => tasksBtn.classList.contains("active"), 2000)))
      return JSON.stringify(out);
    t1 = await compose(m1);
    t2 = await compose(m2);
    if (!ok("两条种子任务入面", !!t1 && !!t2)) return JSON.stringify(out);
    const tick = cardOf(t2)?.querySelector(".tick input");
    if (!ok("乙卡有勾框", !!tick)) return JSON.stringify(out);
    click(tick);
    // 勾框 disabled 是乐观回执、chips 计数才是权威刷新落账的信号——等后者,别抢在
    // 「乐观 DOM 已变、lastItems 未变」的窗口里读计数(本资产首版实踩,三支连环红)。
    ok("勾完成落账(已完成计数入账)", (await until(() => chipCount("done") >= 1, 4000)) !== null);

    // ── ② chips 行的成员与计数(全量口径)──
    const stages = [...bar().querySelectorAll("[data-stage]")].map((b) => b.dataset.stage);
    ok("chips = 全部+四态、固定成员", stages.join(",") === "all,todo,doing,confirming,done");
    ok("初始「全部」active", chip("all").classList.contains("active"));
    ok("待办计数 ≥1(含甲)", chipCount("todo") >= 1);
    const doingCount = chipCount("doing");

    // ── ③ 单选投影:点「已完成」只剩该段 ──
    click(chip("done"));
    ok("done chip 转 active", await until(() => chip("done")?.classList.contains("active"), 1500));
    ok("只渲染一段", document.querySelectorAll("#timeline .tl-group").length === 1);
    ok("乙在、甲不在", !!cardOf(t2) && !cardOf(t1));

    // ── ④ 搜索定位命中被藏的卡:状态维自清 ──
    click(document.getElementById("search-toggle"));
    const si = document.getElementById("search-input");
    si.value = m1;
    click(document.getElementById("search-btn"));
    const hit = await until(() => document.querySelector(`#search-results [data-hit="${t1}"]`), 4000);
    if (ok("搜到被状态维藏着的甲", !!hit)) {
      click(hit.querySelector(".content"));
      ok(
        "定位自清状态维:甲现身并闪卡",
        await until(() => !document.body.classList.contains("pane-open") && cardOf(t1)?.classList.contains("flash"), 4000),
      );
      ok("chips 回「全部」", chip("all").classList.contains("active"));
    }

    // ── ⑤ 状态筛空的专属空态(进行中通常 0;有数据就退而验只剩该段)──
    click(chip("doing"));
    await until(() => chip("doing")?.classList.contains("active"), 1500);
    if (doingCount === 0) {
      ok("筛空:无卡 + 空态文案", document.querySelectorAll("#timeline .card").length === 0 && !!document.querySelector("#timeline .empty"));
    } else {
      ok("(数据非空)只剩进行中一段", document.querySelectorAll("#timeline .tl-group").length === 1);
    }

    // ── ⑥ 新任务落面自动清维(clearFilter 一体)──
    t3 = await compose(m3);
    ok("筛着「进行中」时新建的丙立即可见", !!t3 && !!cardOf(t3));
    ok("清维回「全部」", chip("all").classList.contains("active"));

    // ── ⑦ 点已选中的状态 = 回全部(toggle)──
    click(chip("todo"));
    await until(() => chip("todo")?.classList.contains("active"), 1500);
    click(chip("todo"));
    ok("再点已选中的待办 = 回全部", await until(() => chip("all")?.classList.contains("active"), 1500));
    ok("全部态下多段并存", document.querySelectorAll("#timeline .tl-group").length >= 2);
  } finally {
    await purge(t1);
    await purge(t2);
    await purge(t3);
  }
  const gone = (id) => !id || (!cardOf(id) && !document.querySelector(`[data-trash="${id}"]`));
  ok("清场:三条种子零残留(只看自己仨,不管存量回收站)", gone(t1) && gone(t2) && gone(t3));
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
