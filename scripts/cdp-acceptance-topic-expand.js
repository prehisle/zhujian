// user-44 第五刀(安卓):标签面「点条数展开看名下随记 + 任务」的回归资产。
// 安卓侧没有 wdio 套件,这一面的回归全靠它。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-expand.js
// ⚠ 单条 CDP 调用 10s 上限,这支有多轮等待 ⇒ 必须给 CDP_TIMEOUT_MS(同标签面另外几支)。
// ⚠ **语言前置**:本支按中文文案认段头 ⇒ 跑前 `localStorage.setItem("zhujian.lang","zh")` + reload,
//    收尾 `removeItem`。⛔ 英文机上不设它会安静地少跑几格(skill 那条 559 判例)。
// 自带播种(一枚带 1 随记 + 1 任务的标签、一枚空标签)与清场(finally 里删净),跑完库里不留东西。
//
// # 判据(⛔ 别只验「点了会展开」—— 那半恒绿得很便宜)
//  ① 计数是 BUTTON、带 `data-expand`、`aria-expanded` 真随状态翻(它是 ::after 那枚 `›` 记号的
//     唯一驱动 —— 没有记号这就又是一处隐藏能力,判例:用户面 49)。
//  ② **触区 ≥44 高 + `elementFromPoint` 五点真打**(§2.3)。⛔ 不是「读 CSS 里写没写」——
//     514 判例:宿主的 `overflow:hidden` 会把伪元素触区裁掉而屏上看不出来。
//     ⭐ 自证前置:同行的 `.tname` / `.tcolor` 必须都在,否则「没被邻居抢走」是句空话。
//  ③ 展开后两段都在,**条数与库对得上**、随记显时刻、任务显**它真实所在列的列名**。
//     ⭐ 自证前置:种子标签必须真有 1 随记 + 1 任务(0/0 的话「两段都在」恒真 = 空测)。
//  ④ 再点一次收起(`.tbody` 消失、aria 回 false)。
//  ⑤ **至多一枚展开**:点另一行 → 旧的收、新的开(这一端刻意与桌面的多开不同)。
//  ⑥ 空标签展开出的是**两句空态文案**,不是一片空白。
//  ⑦ 合并态里**不渲展开面**(那时整行是选择目标,展开面会挡路)。
//  ⑧ 展开着的标签被删掉后,展开态**跟着作废**(loadTopics 里那道 live 判据);⛔ 留着它下一拍
//     会去 tasksByTopic 里查一个死 id。
//  ⑨ 展开面**纯只读**:整块 `.tbody` 里一个 button / input / [data-*] 动作锚都不许有。
//  ⑩ **拖排序的邻居集不被展开面污染** —— `initDrag` 的 `siblings()` 只认 `.trow[data-topic]`,
//     展开一枚之后那个集合必须一个不多一个不少(否则拖动会拿 undefined 当锚点发给 reorder)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  **原生触摸不在这支里** —— 页内脚本发不了 `Input.dispatchTouchEvent`,③④⑤ 用的是合成
//  `el.click()`:它证的是「处理器接对了」,证不了「手指点得到」。后者由 ② 的五点守几何,
//  再由驱动侧 `node scripts/android-cdp.mjs swipe <cx> <cy> <cx> <cy>` 手工真点一次收口。
//  **到期日 / 优先级不在展开面上**(实现时的取舍,见 topics.ts 那段注释)⇒ 这支也不验它们。
//
// # 阴性对照(⛔ 改判据后重跑一遍再说它有牙齿)
//  刀 A 注 `.tcount{min-height:0;margin:0}` ⇒ ② 的「触区高」当场红。
//  刀 B 注 `.tcount{pointer-events:none}` ⇒ ② 的「五点」全落 `.trow` 当场红。
//  刀 C(行为刀,要重建包)把 `expandedId = expandedId === expandFor ? null : expandFor`
//        改成恒 `= expandFor` ⇒ ④「再点收起」当场红。
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
  // ⚠ 一律按 **本趟的 id** 定位,⛔ 别按文本(548 判例:关面不清 DOM,同名残余行会先命中)。
  const rowOf = (id) => list().querySelector(`.trow[data-topic="${id}"]`);
  const countOf = (id) => list().querySelector(`.tcount[data-expand="${id}"]`);
  const bodyOf = (id) => list().querySelector(`.tbody[data-body="${id}"]`);
  const bodies = () => list().querySelectorAll(".tbody").length;
  const dragSiblings = () => list().querySelectorAll(".trow[data-topic]").length;
  const toggle = () => document.getElementById("topics-toggle").click();
  const paneOpen = () => !document.getElementById("topics-new").hidden;

  let full = null, empty = null, note = null, task = null;
  try {
    // ⛔ **播种前先把面收起来**:列表只在开面那一刻拉一次(loadTopics),面开着时播的种进不了 DOM。
    if (paneOpen()) { toggle(); await sleep(300); }
    full = await inv("create_topic", { title: "ZJ44e满" });
    empty = await inv("create_topic", { title: "ZJ44e空" });
    note = await inv("capture_idea", { content: "ZJ44e随记内容" });
    await inv("file_note_to_topic", { id: note, topicId: full, newTitle: null });
    task = await inv("create_task", { title: "ZJ44e任务内容", dueOn: null, priority: null, topicId: full });

    // ⭐ 自证前置(③⑥ 的判据全靠它):种子真是 1 随记 + 1 任务 / 0 + 0,不然那两格是空测。
    const tree = await inv("list_topics_full");
    const tasks = await inv("list_tasks");
    const fullNotes = tree.find((t) => t.id === full)?.notes.length ?? -1;
    const fullTasks = tasks.filter((t) => t.topics.some((p) => p.id === full)).length;
    const emptyNotes = tree.find((t) => t.id === empty)?.notes.length ?? -1;
    const emptyTasks = tasks.filter((t) => t.topics.some((p) => p.id === empty)).length;
    ok("前置:满标签真是 1 随记 + 1 任务", fullNotes === 1 && fullTasks === 1, { fullNotes, fullTasks });
    ok("前置:空标签真是 0 + 0", emptyNotes === 0 && emptyTasks === 0, { emptyNotes, emptyTasks });
    // 任务此刻在哪一列 —— ③ 的列名判据要和它比,⛔ 别写死「待办」(列可改名/自定义)。
    const taskStage = tasks.find((t) => t.topics.some((p) => p.id === full))?.status ?? null;
    const cols = await inv("list_board_columns");
    const col = cols.find((c) => c.id === taskStage);
    const colName = col ? (col.title_overridden ? col.title : null) : null;

    toggle();
    await sleep(200);
    ok("面开了、两枚种子都在", await until(() => rowOf(full) && rowOf(empty)));

    // ---- ① 计数是钮、带 data-expand、aria 初始为 false --------------------------
    const c = countOf(full);
    ok("① 计数是 BUTTON 且带 data-expand", c && c.tagName === "BUTTON", { tag: c && c.tagName });
    ok("① aria-expanded 初始 false", c && c.getAttribute("aria-expanded") === "false");
    ok("① `›` 记号真渲出来了(::after 有内容)", c && getComputedStyle(c, "::after").content.includes("›"), {
      content: c && getComputedStyle(c, "::after").content,
    });

    // ---- ② 触区 + 五点(自证前置:邻居真在) ------------------------------------
    const row = rowOf(full);
    ok("② 自证前置:同行 .tname / .tcolor 都在", !!row.querySelector(".tname") && !!row.querySelector(".tcolor"));
    row.scrollIntoView({ block: "center" });
    await sleep(120);
    const r = c.getBoundingClientRect();
    ok("② 触区高 ≥44", r.height >= 44, { h: Math.round(r.height * 100) / 100 });
    const pts = [
      [r.x + r.width / 2, r.y + r.height / 2],
      [r.x + 2, r.y + 2],
      [r.right - 2, r.y + 2],
      [r.x + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    const hits = pts.map(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e ? (e === c || c.contains(e) ? "self" : e.className || e.tagName) : "null";
    });
    ok("② 五点全落在计数钮上(没被邻居抢)", hits.every((h) => h === "self"), { hits });

    // ---- ⑩ 拖排序的邻居集不被污染 ------------------------------------------------
    const sibBefore = dragSiblings();
    c.click();
    ok("③ 点了就展开", await until(() => !!bodyOf(full)));
    ok("⑩ 展开后 .trow[data-topic] 一个不多一个不少", dragSiblings() === sibBefore, {
      before: sibBefore, after: dragSiblings(),
    });
    ok("① aria-expanded 翻成 true", countOf(full).getAttribute("aria-expanded") === "true");

    // ---- ③ 两段内容 ---------------------------------------------------------------
    const body = bodyOf(full);
    const heads = [...body.querySelectorAll(".tb-h")].map((h) => h.textContent.trim());
    ok("③ 两段段头且条数与库对得上", heads.length === 2 && heads[0] === "随记 1" && heads[1] === "任务 1", { heads });
    const texts = [...body.querySelectorAll(".tb-text")].map((e) => e.textContent);
    ok("③ 随记与任务的正文都印出来了", texts.includes("ZJ44e随记内容") && texts.includes("ZJ44e任务内容"), { texts });
    ok("③ 随记带时刻", !!body.querySelector(".tb-when")?.textContent.trim());
    const shownCol = body.querySelector(".tb-col")?.textContent.trim() ?? null;
    ok("③ 任务显的是它真实所在列的列名", !!shownCol && (colName === null || shownCol === colName), {
      shownCol, stage: taskStage, colName,
    });
    ok("③ 满标签这块没有空态句", body.querySelectorAll(".tb-empty").length === 0);

    // ---- ⑨ 纯只读 -----------------------------------------------------------------
    const actionable = body.querySelectorAll("button, input, a, [data-expand], [data-rename], [data-del]").length;
    ok("⑨ 展开面里一个动作锚都没有", actionable === 0, { actionable });

    // ---- ④ 再点收起 ---------------------------------------------------------------
    countOf(full).click();
    ok("④ 再点一次就收起", await until(() => !bodyOf(full) && bodies() === 0));
    ok("④ aria 回 false", countOf(full).getAttribute("aria-expanded") === "false");

    // ---- ⑤ 至多一枚 ---------------------------------------------------------------
    countOf(full).click();
    await until(() => !!bodyOf(full));
    countOf(empty).click();
    ok("⑤ 点另一行:旧的收、新的开,全场恰一块", await until(() => bodyOf(empty) && !bodyOf(full) && bodies() === 1));

    // ---- ⑥ 空态 -------------------------------------------------------------------
    const eb = bodyOf(empty);
    const empties = [...eb.querySelectorAll(".tb-empty")].map((e) => e.textContent.trim());
    ok("⑥ 空标签给两句空态文案,不是一片空白", empties.length === 2 && empties.every((s) => s.length > 0), { empties });
    ok("⑥ 空态那两段的段头是 0", [...eb.querySelectorAll(".tb-h")].map((h) => h.textContent.trim()).join("|") === "随记 0|任务 0");

    // ---- ⑦ 合并态不渲展开面 --------------------------------------------------------
    document.getElementById("topics-merge").click();
    ok("⑦ 合并态里一块展开面都没有", await until(() => bodies() === 0 && !!list().querySelector(".mrow")));
    list().querySelector("[data-merge-cancel]").click();
    await until(() => !list().querySelector(".mrow"));

    // ---- ⑧ 展开着的标签被删 → 展开态作废 --------------------------------------------
    countOf(full).click();
    ok("⑧ 前置:删之前它真展开着", await until(() => !!bodyOf(full)));
    await inv("delete_topic", { id: full });
    full = null; // 已删,finally 别再删一次
    toggle(); await sleep(250); toggle(); // 收再开 = 走一遍 loadTopics
    ok("⑧ 标签没了,展开面也没了", await until(() => bodies() === 0 && !!rowOf(empty)), {
      bodies: bodies(),
    });
  } catch (e) {
    ok("跑飞了", false, { error: String(e && e.stack ? e.stack : e) });
  } finally {
    // 清场:⚠ 按 stage 分家 —— 任务用 archive_task/purge_task,随记用 archive_note/purge_note。
    try { if (task) { await inv("archive_task", { id: task }); await inv("purge_task", { id: task }); } } catch (e) { out.cleanTask = String(e); }
    try { if (note) { await inv("archive_note", { id: note }); await inv("purge_note", { id: note }); } } catch (e) { out.cleanNote = String(e); }
    try { if (full) await inv("delete_topic", { id: full }); } catch (e) { out.cleanFull = String(e); }
    try { if (empty) await inv("delete_topic", { id: empty }); } catch (e) { out.cleanEmpty = String(e); }
    // 清场干净当判据(skill 那条:catch 会把 delete_note 的拒吞掉,回收站里悄悄攒尸体)。
    try {
      const left = (await inv("list_topics_full")).filter((t) => /^ZJ44e/.test(t.title)).length;
      const trash = (await inv("list_trash")).filter((r) => /^ZJ44e/.test(r.content)).length;
      ok("清场干净(标签 0、回收站 0)", left === 0 && trash === 0, { left, trash });
    } catch (e) { ok("清场干净", false, { error: String(e) }); }
  }
  out.pass = out.steps.every((s) => s.ok);
  out.total = out.steps.length;
  out.failed = out.steps.filter((s) => !s.ok).map((s) => s.name);
  return JSON.stringify(out);
})()
