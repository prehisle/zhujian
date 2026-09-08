// @cdp-run single
// 用户面 79 + UI 一致性 M8 验收 —— 「开面板」这件事的三格:面板从自己的顶部开始、关面把
// 时间轴还原到开面前的位置、搜索面开出来先说一句「搜得到什么」。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-pane-open.js
//
// 前置:停在**随记时间轴**(不在任何面板里)。库里的时间轴要够长 —— 「滚过一屏」那两格
// 靠它才有意义,滚不动就如实报 skipped(503 的判例:空测不许长得跟真绿一样)。
//
// ⚠ 为什么既有的 `cdp-acceptance-panes.js` 一直绿着而这个患一直在:那支判的是
// `paneTop < innerHeight`(「面板顶部在首屏内」)—— 而患的形是面板顶部跑到**视口上方**
// (真机量到 -405),`-405 < 800` 恒真 ⇒ 松了恒绿(memory `proxy-predicate-fails-both-ways`)。
// ⇒ 这里的判据两头都夹:`0 <= top < innerHeight`。
//
// ⚠ 断言刻意**不认中文**(只认结构与几何),故不需要「先切 zh」那道前置。
(async () => {
  const out = { pass: false, steps: [], readings: {} };
  const ok = (name, cond, extra) => {
    out.steps.push(extra === undefined ? { name, ok: !!cond } : { name, ok: !!cond, ...extra });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(80);
    }
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const topOf = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top) : null;
  };
  const docH = () => Math.round(document.documentElement.scrollHeight);
  const paneOpen = () => document.body.classList.contains("pane-open");
  // 「落在视口内」= 上不出边、下不过折。⛔ 别只写右半边(那正是既有资产恒绿的那一版)。
  const inFold = (t) => t !== null && t >= 0 && t < window.innerHeight;

  const vh = window.innerHeight;
  const openTopics = async () => {
    click(document.getElementById("topics-toggle"));
    await until(() => document.body.classList.contains("pane-open"), 2000);
    await until(() => document.querySelector("#topics-list .trow"), 3000); // 标签是异步拉的
    await sleep(120);
  };
  // 顶部「朱简」= 收面(main.ts 那条 toggle 路),与用户真按返回同一条 closePaneNow。
  // ⛔⛔ **采样必须采晚的那个**,这是判据的一部分:关面这一路是「closePaneNow 写回滚动位」
  // 与「settleHistory 那记 history.back() 弹出守门条目」两件事一前一后,而浏览器
  // `scrollRestoration:auto` 会在**弹出之后**把守门条目上存的 0 贴回来。⇒ 真机量到的形是
  // **同步读 1200、30ms 后变 0**:只读同步那一发,患还在也照样绿(79 的第二半就是这么逮到的)。
  const closePane = async () => {
    click(document.querySelector("header h1"));
    await until(() => !paneOpen(), 2000);
    const sync = Math.round(window.scrollY);
    await sleep(400); // > history.back() 的往返 + 浏览器贴回滚动位那一拍
    return { sync, settled: Math.round(window.scrollY) };
  };

  if (!ok("前置:开跑时没有面板开着", !paneOpen())) return JSON.stringify(out);

  // ---- ① 时间轴在顶:开面板照旧从顶部开始(这一格改前就该绿,是对照组) ----------
  window.scrollTo({ top: 0 });
  await sleep(120);
  const docFlat = docH();
  await openTopics();
  out.readings.pathTop = { paneTop: topOf("#topics-pane"), rowTop: topOf("#topics-list .trow"), scrollY: Math.round(window.scrollY) };
  ok("① 时间轴在顶 → 面板落在视口内", inFold(out.readings.pathTop.paneTop) && inFold(out.readings.pathTop.rowTop));
  await closePane();

  // ---- ② 时间轴滚过一屏:这才是 79 那个患 -------------------------------------
  const maxScroll = docFlat - vh;
  const target = Math.min(1200, maxScroll);
  out.readings.viewport = { vh, docFlat, maxScroll, target };
  if (maxScroll <= vh) {
    // ⛔ 不许把「滚不动」记成绿:时间轴短于一屏时,②③④ 三格量的都是与 ① 相同的场景。
    ok("②③④ skipped:时间轴滚不过一屏(库太短,本机验不了)", false, { skipped: true });
    out.pass = false;
    out.note = "时间轴不足两屏 ⇒ 79 的场景造不出来。换一台数据多的设备,或先播种到能滚过一屏。";
    return JSON.stringify(out);
  }
  window.scrollTo({ top: target });
  await sleep(150);
  const before = Math.round(window.scrollY);
  // 自证前置:真的滚过了一屏,而且滚到的位置就是待还原的那个数。
  if (!ok("前置:时间轴真滚过一屏", before > vh, { before, vh })) return JSON.stringify(out);
  await openTopics();
  const docOpen = docH();
  out.readings.pathScrolled = {
    paneTop: topOf("#topics-pane"),
    rowTop: topOf("#topics-list .trow"),
    scrollY: Math.round(window.scrollY),
    docFlat,
    docOpen,
  };
  // 机制自证:开面确实把文档变矮了(这正是 scrollY 会被钳、面板会「从中段开始」的由头)。
  ok("机制:开面后文档变矮", docOpen < docFlat, { docFlat, docOpen });
  ok("② 滚过一屏 → 面板仍落在视口内", inFold(out.readings.pathScrolled.paneTop) && inFold(out.readings.pathScrolled.rowTop));
  ok("② 补:开面后文档滚动位归零", out.readings.pathScrolled.scrollY === 0);

  // 阴性自证:把面板开着往下滚回 before,判据必须当场变红 —— 否则这条断言是恒真的空测。
  window.scrollTo({ top: before });
  await sleep(150);
  const knifeTop = topOf("#topics-pane");
  ok("阴性自证:面板被滚离顶部时判据会红", !inFold(knifeTop), { knifeTop });
  window.scrollTo({ top: 0 });
  await sleep(120);

  // ---- ③ 关面还原时间轴的位置(两发都要对:同步那发证明我们写进去了,晚那发证明没被冲掉)----
  const restore = await closePane();
  out.readings.restore = { before, ...restore };
  ok("③ 关面当场写回了开面前的位置", Math.abs(restore.sync - before) <= 2, { before, sync: restore.sync });
  ok("③ 补:落定之后仍在那儿(没被历史条目的滚动位冲掉)", Math.abs(restore.settled - before) <= 2, {
    before,
    settled: restore.settled,
  });

  // ---- ④ 面换面同层:中途换面板不许冲掉时间轴那个数 -----------------------------
  window.scrollTo({ top: target });
  await sleep(150);
  const before2 = Math.round(window.scrollY);
  await openTopics();
  click(document.getElementById("search-toggle")); // 面换面(同层,不压新的 history)
  await until(() => !document.getElementById("search-pane").hidden, 2000);
  await sleep(150);
  const searchTop = topOf("#search-pane");
  ok("④ 面换面后新面板也从顶部开始", inFold(searchTop), { searchTop });

  // ---- ⑤ M8:搜索面空态得说一句「搜得到什么」 -----------------------------------
  // 自证前置:先把结果区清空再关面重开 —— 否则上一轮留下的结果会让这一格变成空测
  // (⚠ 关面**不清**结果区是既有行为,资产不许假装它清了)。
  const box = document.getElementById("search-results");
  box.innerHTML = "";
  click(document.getElementById("search-toggle")); // toggle 关
  await until(() => !paneOpen(), 2000);
  click(document.getElementById("search-toggle")); // 再开 = 走 focusSearch
  await until(() => !document.getElementById("search-pane").hidden, 2000);
  await sleep(150);
  const hint = box.querySelector("p.muted.empty");
  out.readings.searchIdle = { html: box.innerHTML.slice(0, 120), text: hint ? hint.textContent.trim() : null };
  ok("⑤ 搜索面开出来就有空态说明", !!hint && hint.textContent.trim().length > 0);
  ok("⑤ 补:那句话落在视口内", inFold(hint ? Math.round(hint.getBoundingClientRect().top) : null));

  // ---- 收场:关面、时间轴回顶(⛔ 别把用户的列表留在半截位置上) -------------------
  const restore2 = await closePane();
  out.readings.restoreAfterSwap = { before2, ...restore2 };
  ok("④ 补:面换面之后关面仍还原到时间轴那个数", Math.abs(restore2.settled - before2) <= 2, {
    before2,
    settled: restore2.settled,
  });
  window.scrollTo({ top: 0 });
  await sleep(100);
  ok("收场:回到时间轴且没有面板开着", !paneOpen() && Math.round(window.scrollY) === 0);

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
