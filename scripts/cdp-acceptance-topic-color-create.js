// user-44 第二刀(安卓):标签面「点色点改颜色 + 面头新建标签」的回归资产。
// 安卓侧没有 wdio 套件,这两件的回归全靠它(与 514 的 cdp-acceptance-topic-rename.js 同族)。
//
// 跑法:CDP_TIMEOUT_MS=60000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-color-create.js
// 自带播种(两个标签 + 一条挂着甲的随记)与清场(finally 里删净,含本资产自己建出来的标签)。
//
// # 判据(⛔ 别只验「能改色/能新建」——那半恒绿得很便宜)
//  颜色:
//  ① 每行有**常驻**色钮(无色标签渲空圈,有色渲实心点)—— 无色也要有入口。
//  ② 色钮触区 ≥44 高、五点真打(elementFromPoint;⛔ 别读 CSS 里写没写)。
//  ③ 点色钮进颜色态:8 色块 + 无色块 + 取消都在、色块 ≥36、current 标在当前色上、别的行不动。
//  ④ 点色块落库 + 行内色点变实心 + **卡片 chip 着色跟上**(refreshTimeline 的唯一字据)。
//  ⑤ 再进颜色态 current 在刚选的色上;点「无」→ 清色落库、色点回空圈。
//  ⑥ 取消不改 · ⑦ Esc 不改(两条退路各是一条分支)。
//  ⑧ 编辑态互斥:改名态开着时点色钮 ⇒ 改名收、色态开(四态单开)。
//  新建:
//  ⑨ 面头钮在;⑩ 点开列表顶出输入行(placeholder / 焦点);
//  ⑪ Enter 落库 + 提示条 + 列表跟上;⑫ 「建」钮那条路也通;
//  ⑬ 重名被拒(core 说话,前端不预校验);⑭ **空名不发写**:编辑态留着、不弹错(那不是校验,
//     是别发一趟必拒的写 —— 与「一个字没改」同一格纪律);⑮ 取消 / Esc 收起;
//  ⑯ 新建行不是标签行(无 data-topic / 无拖手柄)—— 拖排序的邻居判定排除它的结构性字据。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  合成 click 证的是「处理器接对了」,证不了「手指点得到」—— 那半由 ② 的 elementFromPoint
//  守几何,再由驱动侧 swipe 真点一次收口。「新建行开着时远端刷新不拆行」要远端事件,页内造不出,
//  靠 topicsInteracting() 的代码审。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(80);
    }
    return false;
  };
  // ⚠ #topics-list 每次 render 整片重建 ⇒ 一律现查,别缓存节点。
  const list = () => document.getElementById("topics-list");
  const rowOf = (title) =>
    [...list().querySelectorAll(".tname")].find((n) => n.textContent.trim() === title);
  const colorBtnOf = (title) => rowOf(title)?.closest(".trow")?.querySelector(".tcolor") ?? null;
  const swatches = () => [...list().querySelectorAll(".tc-swatch")];
  const err = () => document.getElementById("error");
  const colorOf = async (id) => (await inv("list_topics_full")).find((t) => t.id === id)?.color ?? null;

  const A0 = "ZJ44色甲", B0 = "ZJ44色乙", C0 = "ZJ44新建丙", D0 = "ZJ44新建丁";
  const HEX = "#3f8272"; // 调色板第 4 枚(松石)
  const pane = () => document.getElementById("topics-pane");
  const toggle = () => document.getElementById("topics-toggle").click();
  let a = null, b = null, note = null;
  const createdIds = []; // ⑪/⑫ 建出来的,finally 删净
  try {
    // ⛔ 播种前先把标签面收起来(列表只在开面那一刻拉一次;514 的坑,照抄纪律)。
    if (!pane().hidden) { toggle(); await until(() => pane().hidden, 2000); }

    // ---- 播种(幂等:同名已在就复用;甲清成无色当 ① 的空圈样本) ----
    const pre = await inv("list_topics_full");
    const byT = Object.fromEntries(pre.map((t) => [t.title, t.id]));
    a = byT[A0] ?? (await inv("create_topic", { title: A0 }));
    b = byT[B0] ?? (await inv("create_topic", { title: B0 }));
    for (const t of [C0, D0]) if (byT[t]) await inv("delete_topic", { id: byT[t] }); // 上一趟没清净的
    await inv("set_topic_color", { id: a, color: null });
    note = await inv("capture_idea", { content: "ZJ44-载体" });
    await inv("file_note_to_topic", { id: note, topicId: a, newTitle: null });

    toggle();
    // ⛔ 判据必须**连身份一起判**(data-topic === 这一趟播种的 id),不能只看「同名行在」——
    // 关面不清列表 DOM,上一趟删掉的同名标签还以旧 id 站在屏上;只判文本会第一拍就命中
    // 残余行,拿旧 id 去写被 core 拒「主题不存在」。首跑(冷 DOM)恒绿、复跑必红,
    // 本资产第一版就是这么栽的(字据:「设置标签颜色失败:主题不存在,影响行数 0」)。
    const fresh = () => rowOf(A0)?.closest(".trow")?.dataset.topic === a;
    ok("标签面开得出来(且是这一趟的行,不是残余 DOM)", await until(fresh, 4000));
    if (!fresh()) throw new Error("播种的标签没出现在列表里(或屏上是旧残余),后面全不用跑了");

    // ---- ① 常驻色钮:无色渲空圈 ----
    const cb = colorBtnOf(A0);
    ok("每行有色钮(BUTTON)", !!cb && cb.tagName === "BUTTON", cb?.tagName);
    const dot = cb?.querySelector(".tdot");
    ok("无色标签渲空圈(.none,虚线描边)", !!dot && dot.classList.contains("none") &&
      getComputedStyle(dot).borderTopStyle === "dashed", dot && getComputedStyle(dot).borderTopStyle);

    // ---- ② 色钮触区:≥44 高 + 五点真打 ----
    const r = cb.getBoundingClientRect();
    ok("色钮触区高 ≥44(吃满行内)", r.height >= 44, `${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const pts = [[cx, cy - 21], [cx, cy + 21], [r.x + 3, cy], [r.right - 3, cy], [cx, cy]];
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y));
    ok("五点全落在色钮上", hits.every((e) => e && (e.classList.contains("tcolor") || e.closest?.(".tcolor"))),
      hits.map((e) => (e ? e.className || e.tagName : "null")).join(","));

    // ---- ③ 进颜色态 ----
    cb.click();
    ok("点色钮进颜色态", await until(() => swatches().length > 0, 2000));
    const sw = swatches();
    ok("8 色块 + 无色块都在", sw.length === 9 && sw.filter((s) => s.classList.contains("none")).length === 1,
      String(sw.length));
    ok("取消钮在", !!list().querySelector("[data-color-cancel]"));
    ok("色块 ≥36(触屏)", sw.every((s) => s.getBoundingClientRect().width >= 36 && s.getBoundingClientRect().height >= 36),
      sw[0] && `${sw[0].getBoundingClientRect().width.toFixed(1)}`);
    ok("无色标签 current 在「无」上", sw.find((s) => s.classList.contains("none"))?.classList.contains("current") === true &&
      sw.filter((s) => s.classList.contains("current")).length === 1);
    ok("别的行不受影响", !!rowOf(B0));

    // ---- ④ 点色块:落库 + 色点实心 + 卡片 chip 着色 ----
    err().hidden = true; // 清提示条,防串味
    const sw4 = list().querySelector(`[data-swatch="${HEX}"]`);
    ok("④ 色块此刻在文档里(没游离)", !!sw4 && sw4.isConnected);
    sw4.click();
    // saveColor 一进门就收态重画 ⇒ 这一格把「点没接上」与「接上了但写失败」二分开
    ok("④ 点后色块行立刻收(saveColor 真进来了)", !list().querySelector(".tc-edit"));
    ok("点色块 → 落库", await until(async () => (await colorOf(a)) === HEX, 4000),
      `color=${await colorOf(a)} err=${err().hidden ? "(hidden)" : err().textContent.trim().slice(0, 80)}`);
    ok("点色块 → 行内色点变实心", await until(() => {
      const d = colorBtnOf(A0)?.querySelector(".tdot");
      return !!d && !d.classList.contains("none");
    }, 3000));
    const chipTinted = () => {
      const card = document.querySelector(`#timeline [data-id="${note}"]`);
      const chip = card && [...card.querySelectorAll(".chip")].find((c) => c.textContent.trim() === A0);
      return chip ? chip.classList.contains("tinted") : null;
    };
    ok("卡片 chip 着色跟上(refreshTimeline 真跑了)", await until(() => chipTinted() === true, 4000),
      String(chipTinted()));

    // ---- ⑤ 再进:current 在刚选的色上;清色回空圈 ----
    colorBtnOf(A0).click();
    await until(() => swatches().length > 0, 2000);
    const cur = swatches().filter((s) => s.classList.contains("current"));
    ok("current 标在刚选的色上", cur.length === 1 && cur[0].dataset.swatch === HEX, cur[0]?.dataset.swatch);
    swatches().find((s) => s.classList.contains("none")).click();
    ok("点「无」→ 清色落库", await until(async () => (await colorOf(a)) === null, 4000), String(await colorOf(a)));
    ok("清色 → 色点回空圈", await until(() => {
      const d = colorBtnOf(A0)?.querySelector(".tdot");
      return !!d && d.classList.contains("none");
    }, 3000));

    // ---- ⑥ 取消不改 · ⑦ Esc 不改 ----
    colorBtnOf(A0).click();
    await until(() => swatches().length > 0, 2000);
    list().querySelector("[data-color-cancel]").click();
    ok("取消 → 退回读态", await until(() => swatches().length === 0, 2000));
    ok("取消 → 库里原样(仍无色)", (await colorOf(a)) === null);
    colorBtnOf(A0).click();
    await until(() => swatches().length > 0, 2000);
    list().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Esc → 退回读态", await until(() => swatches().length === 0, 2000));
    ok("Esc → 库里原样", (await colorOf(a)) === null);

    // ---- ⑧ 互斥:改名态开着时点色钮 ⇒ 改名收、色态开 ----
    rowOf(A0).click();
    await until(() => !!list().querySelector(".tn-input"), 2000);
    colorBtnOf(B0).click();
    ok("改名态开着时点色钮 → 改名收、色态开(四态单开)",
      await until(() => swatches().length > 0 && !list().querySelector(".tn-input"), 2000));
    list().querySelector("[data-color-cancel]").click();
    await until(() => swatches().length === 0, 2000);

    // ---- ⑨/⑩ 新建入口与输入行 ----
    const nb = document.getElementById("topics-new");
    ok("面头「新建标签」钮在", !!nb && nb.tagName === "BUTTON");
    nb.click();
    const createRow = () => list().querySelector("[data-create-row]");
    ok("点开 → 列表顶出输入行", await until(() => !!createRow(), 2000));
    const ci = () => createRow()?.querySelector(".tn-input");
    ok("输入行在列表最顶", createRow() === list().firstElementChild);
    ok("焦点落在输入框", document.activeElement === ci());
    ok("placeholder 是「标签名」族", !!ci()?.placeholder, ci()?.placeholder);
    // ⑯ 结构性字据:新建行不是标签行(拖排序邻居判定按 data-topic 排除它)
    ok("新建行无 data-topic / 无拖手柄", !createRow().dataset.topic && !createRow().querySelector("[data-drag]"));

    // ---- ⑭ 空名:不发写、编辑态留着、不弹错 ----
    err().hidden = true;
    ci().value = "   ";
    createRow().querySelector("[data-create-save]").click();
    await sleep(400);
    ok("空名 → 编辑态留着(没收起)", !!createRow());
    ok("空名 → 不弹错(没发写,不是 core 拒的)", err().hidden === true);
    ok("空名 → 焦点回输入框", document.activeElement === ci());

    // ---- ⑪ Enter 落库 ----
    ci().value = C0;
    ci().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ok("Enter → 落库", await until(async () => {
      const t = (await inv("list_topics_full")).find((x) => x.title === C0);
      if (t) { if (!createdIds.includes(t.id)) createdIds.push(t.id); return true; }
      return false;
    }, 4000));
    ok("Enter → 输入行收起", await until(() => !createRow(), 2000));
    ok("Enter → 列表里出现", await until(() => !!rowOf(C0), 3000));
    ok("提示条说「已建标签」", !err().hidden && /已建标签|Tag created/.test(err().textContent),
      err().textContent.trim().slice(0, 30));

    // ---- ⑫ 「建」钮那条路 ----
    nb.click();
    await until(() => !!createRow(), 2000);
    ci().value = D0;
    createRow().querySelector("[data-create-save]").click();
    ok("点「建」→ 落库", await until(async () => {
      const t = (await inv("list_topics_full")).find((x) => x.title === D0);
      if (t) { if (!createdIds.includes(t.id)) createdIds.push(t.id); return true; }
      return false;
    }, 4000));

    // ---- ⑬ 重名被拒(core 说话) ----
    err().hidden = true;
    nb.click();
    await until(() => !!createRow(), 2000);
    ci().value = C0;
    createRow().querySelector("[data-create-save]").click();
    ok("重名 → 屏上有话说(core 原文)", await until(() => !err().hidden && /已存在|exists/.test(err().textContent), 3000),
      err().textContent.trim().slice(0, 40));
    ok("重名 → 库里只有一枚", (await inv("list_topics_full")).filter((x) => x.title === C0).length === 1);

    // ---- ⑮ 取消 / Esc 收起 ----
    nb.click();
    await until(() => !!createRow(), 2000);
    createRow().querySelector("[data-create-cancel]").click();
    ok("取消 → 收起", await until(() => !createRow(), 2000));
    nb.click();
    await until(() => !!createRow(), 2000);
    ci().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Esc → 收起", await until(() => !createRow(), 2000));

    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out, null, 1);
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.pass = false;
    return JSON.stringify(out, null, 1);
  } finally {
    // 清场(⛔ archive → purge,不是 delete_note —— 514 攒过 10 条尸体的教训)。
    try {
      if (note) { await inv("archive_note", { id: note }); await inv("purge_note", { id: note }); }
    } catch { /* 已经没了就算了 */ }
    for (const id of [a, b, ...createdIds]) {
      try { if (id) await inv("delete_topic", { id }); } catch { /* 同上 */ }
    }
  }
})();
