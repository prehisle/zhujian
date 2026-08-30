// user-44 第三刀(安卓):标签面「删除」的回归资产。
// 安卓侧没有 wdio 套件,这件的回归全靠它(与 514 rename / 548 color-create 同族)。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-delete.js
// 自带播种(两个标签:甲挂 2 条随记、乙 0 挂载)与清场(finally 里删净)。
//
// # 判据(⛔ 别只验「能删」——那半恒绿得很便宜)
//  ① 常态行**没有**删除入口(克制:删除藏在改名态里,列表上零常驻危险钮)。
//  ② 点名字进改名态:第三枚「删除」在,且是 warn 形(颜色与「取消」那枚 ghost 不同——
//     样式真生效的字据,不是 class 在不在)。
//  ③ 「删除」触区 ≥44 高、五点真打(elementFromPoint;halo 是 ::before,打点才作数)。
//  ④ 第一拍:改名态**收**(行回常态,取消/超时零残留)+ 底部确认条弹出、话术带名带数
//     (「{n} 项」)、第二拍钮是「删除」。
//  ⑤ 取消(cb-no)→ 条收、库里原样。
//  ⑥ 超时(6s 窗)→ 条自动收、库里原样 —— 两拍确认的「没接第二拍」分支。
//  ⑦ 第二拍(cb-yes)→ 库里没了 + 行从列表消失(⛔ 连身份判 data-topic===id,548 的坑:
//     关面不清 DOM,同名残余行会骗过纯文本判)+ 提示条「已删除标签」。
//  ⑧ **卡片 chip 摘掉**(refreshTimeline 的唯一字据)——载体随记卡上不再有这枚 chip。
//  ⑨ **条目本身不动**:两条载体随记后端还在(「只摘标签、内容不动」那半)。
//  ⑩ 0 挂载的乙:话术是简版(不带「项/item」——「0 项」是句空话);删除照常落库。
//  ⑪ 别的行不受影响(删甲后乙的行还以自己的 id 站着)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  合成 click 证的是「处理器接对了」,证不了「手指点得到」—— 那半由 ③ 守几何,再由驱动侧
//  swipe 真点一次收口。「确认条挂着时切空间 ⇒ 旧确认作废」要真切空间,页内不造(建空间 =
//  永久残留),那半靠 doDelete 的 space 复核代码审。busy 重入拦同理(页内造不出稳定在飞窗口)。
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
  const err = () => document.getElementById("error");
  const bar = () => document.getElementById("confirmbar");
  const barQ = () => document.getElementById("confirmbar-q").textContent;
  const topicIn = async (id) => (await inv("list_topics_full")).some((t) => t.id === id);
  const delBtn = () => list().querySelector(".tn-del");
  const openRename = async (title) => {
    rowOf(title).click();
    return until(() => !!list().querySelector(".tn-input"), 2000);
  };

  const A0 = "ZJ44删甲", B0 = "ZJ44删乙"; // ⚠ 名里别带「项/item」字 —— ⑩ 的简版话术判据靠排除它们
  const pane = () => document.getElementById("topics-pane");
  const toggle = () => document.getElementById("topics-toggle").click();
  let a = null, b = null, note1 = null, note2 = null;
  try {
    // ⛔ 播种前先把标签面收起来(列表只在开面那一刻拉一次;514 的坑,照抄纪律)。
    if (!pane().hidden) { toggle(); await until(() => pane().hidden, 2000); }

    // ---- 播种(幂等:同名已在就复用) ----
    const pre = await inv("list_topics_full");
    const byT = Object.fromEntries(pre.map((t) => [t.title, t.id]));
    a = byT[A0] ?? (await inv("create_topic", { title: A0 }));
    b = byT[B0] ?? (await inv("create_topic", { title: B0 }));
    note1 = await inv("capture_idea", { content: "ZJ44删-载体1" });
    note2 = await inv("capture_idea", { content: "ZJ44删-载体2" });
    await inv("file_note_to_topic", { id: note1, topicId: a, newTitle: null });
    await inv("file_note_to_topic", { id: note2, topicId: a, newTitle: null });

    toggle();
    // ⛔ 连身份判(data-topic === 这一趟的 id),别只匹配文本(548 的残余 DOM 坑)。
    const freshA = () => rowOf(A0)?.closest(".trow")?.dataset.topic === a;
    const freshB = () => rowOf(B0)?.closest(".trow")?.dataset.topic === b;
    ok("标签面开得出来(且是这一趟的行,不是残余 DOM)", await until(() => freshA() && freshB(), 4000));
    if (!freshA()) throw new Error("播种的标签没出现在列表里(或屏上是旧残余),后面全不用跑了");

    // ---- ① 常态行没有删除入口 ----
    ok("① 常态列表零删除钮(删除藏在改名态里)", !delBtn());

    // ---- ② 改名态里第三枚「删除」 ----
    await openRename(A0);
    ok("② 改名态里「删除」钮在", !!delBtn(), delBtn()?.textContent);
    ok("② 文字是「删除」族", /删除|Delete/.test(delBtn()?.textContent ?? ""));
    const ghost = list().querySelector("[data-rename-cancel]");
    ok("② warn 形真生效(颜色 ≠ 取消那枚 ghost)",
      !!delBtn() && !!ghost && getComputedStyle(delBtn()).color !== getComputedStyle(ghost).color,
      `${delBtn() && getComputedStyle(delBtn()).color} vs ${ghost && getComputedStyle(ghost).color}`);

    // ---- ③ 触区五点真打(halo 是 ::before,命中算宿主钮) ----
    const r = delBtn().getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const pts = [[cx, cy - 21], [cx, cy + 21], [r.x + 3, cy], [r.right - 3, cy], [cx, cy]];
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y));
    ok("③ 五点全落在「删除」上(触区 ~44)", hits.every((e) => e && e.closest?.(".tn-del")),
      hits.map((e) => (e ? e.className || e.tagName : "null")).join(","));

    // ---- ④ 第一拍:改名态收 + 确认条弹出、话术带名带数 ----
    delBtn().click();
    ok("④ 第一拍 → 改名态收(行回常态)", await until(() => !list().querySelector(".tn-input"), 2000));
    ok("④ 底部确认条弹出", await until(() => !bar().hidden, 2000));
    ok("④ 话术带名带数(2 项)", new RegExp(A0).test(barQ()) && /2 项|2 item/.test(barQ()), barQ());
    const yes = document.getElementById("confirmbar-yes");
    ok("④ 第二拍钮是「删除」", /删除|Delete/.test(yes.textContent), yes.textContent);

    // ---- ⑤ 取消 → 条收、库里原样 ----
    document.getElementById("confirmbar-no").click();
    ok("⑤ 取消 → 条收", await until(() => bar().hidden, 2000));
    ok("⑤ 取消 → 库里原样", await topicIn(a));

    // ---- ⑥ 超时(6s 窗)→ 条自动收、库里原样 ----
    await openRename(A0);
    delBtn().click();
    await until(() => !bar().hidden, 2000);
    ok("⑥ 超时前条开着", !bar().hidden);
    await sleep(6800); // CONFIRM_REVERT_MS = 6s(timing.ts),留 0.8s 余量
    ok("⑥ 超时 → 条自动收", bar().hidden);
    ok("⑥ 超时 → 库里原样", await topicIn(a));

    // ---- ⑦ 第二拍 → 真删 ----
    err().hidden = true; // 清提示条,防串味
    await openRename(A0);
    delBtn().click();
    await until(() => !bar().hidden, 2000);
    document.getElementById("confirmbar-yes").click();
    ok("⑦ 第二拍 → 库里没了", await until(async () => !(await topicIn(a)), 4000));
    ok("⑦ 行从列表消失(按 id 判)", await until(() =>
      ![...list().querySelectorAll(".trow")].some((row) => row.dataset.topic === a), 3000));
    ok("⑦ 提示条说「已删除标签」", await until(() => !err().hidden && /已删除标签|Tag deleted/.test(err().textContent), 3000),
      err().textContent.trim().slice(0, 30));

    // ---- ⑧ 卡片 chip 摘掉(refreshTimeline 字据) ----
    const chipOnCard = (noteId) => {
      const card = document.querySelector(`#timeline [data-id="${noteId}"]`);
      if (!card) return null; // 卡不在视口/没渲 ⇒ 判不了,由 until 继续等
      return [...card.querySelectorAll(".chip")].some((c) => c.textContent.trim() === A0);
    };
    ok("⑧ 载体卡 chip 摘掉", await until(() => chipOnCard(note1) === false, 4000), String(chipOnCard(note1)));

    // ---- ⑨ 条目本身不动 ----
    const tl = await inv("list_timeline");
    ok("⑨ 两条载体随记后端还在(只摘标签、内容不动)",
      tl.some((x) => x.id === note1) && tl.some((x) => x.id === note2));

    // ---- ⑪ 别的行不受影响 ----
    ok("⑪ 乙的行还以自己的 id 站着", freshB());

    // ---- ⑩ 0 挂载的乙:简版话术 + 真删 ----
    await openRename(B0);
    delBtn().click();
    await until(() => !bar().hidden, 2000);
    ok("⑩ 0 挂载 → 简版话术(不带 项/item)", new RegExp(B0).test(barQ()) && !/项|item/.test(barQ()), barQ());
    document.getElementById("confirmbar-yes").click();
    ok("⑩ 乙也真删了", await until(async () => !(await topicIn(b)), 4000));

    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out, null, 1);
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.pass = false;
    return JSON.stringify(out, null, 1);
  } finally {
    // 清场(⛔ archive → purge,不是 delete_note —— 514 攒过 10 条尸体的教训)。
    for (const n of [note1, note2]) {
      try { if (n) { await inv("archive_note", { id: n }); await inv("purge_note", { id: n }); } } catch { /* 已经没了就算了 */ }
    }
    for (const id of [a, b]) {
      try { if (id) await inv("delete_topic", { id }); } catch { /* 正常:⑦/⑩ 已删 */ }
    }
  }
})();
