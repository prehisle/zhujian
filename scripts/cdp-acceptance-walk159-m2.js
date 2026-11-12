// @cdp-run single timeout=300000
// 159(W3 走查用户全取的那批)手机前端第二波 —— 搜索 + 筛选 + 空间 + 挪空间 + 返回键 —— 的页内可断言部分。单趟、自播种、自清场。
//   node scripts/android-cdp.mjs forward
//   CDP_TIMEOUT_MS=300000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-walk159-m2.js
// 逐条(编号同 .zjshots/W3-walk/清单.md):
//  A3   从搜索结果点进一条(时间轴 / 回收站 / 长文)后,返回键入口(`__zhujianHandleBack`,原生返回键调的就是它)
//       回到搜索结果:词、结果、滚动位都在、焦点不进框;再按一次回时间轴;再按 = 无层可关(交回系统)—— 中间不留空炮。
//       落点卡的操作面开着时,第一下先收操作面、第二下才回搜索。用户自己点底栏走开 = 不再回搜索。
//  A14  落点那张卡挂定位框(朱砂描边 + 柔光,比 1.2 s 的 flash 长、几秒后自己褪);回收站里的命中落到对应段的那一条。
//  A17  从结果回到搜索页 / 顶栏再开搜索:结果列表停在原来的滚动位。
//  A4   有结果时也写「改过的旧版本也一起搜」;只在旧版本命中的那张标「命中改过的旧版本」、点进去落点卡上说去哪儿看。
//  Q8   打字停一下自动出结果(去抖:连敲几下只发一次 search_notes;组字期间不发、上屏才发);一改词旧结果当场清掉;
//       写「N 条匹配」、命中词标红;随记页筛着时写「筛出 N 条」、过滤词标红;多选标签写出选了哪几枚。
//  A5   清完筛选,标签条滚回开头、「所有」看得见。
//  Q12  回收站命中写「回收站 · 任务 / 随记 / 长文」;回收站里任务的小章叫「任务」(不叫列名「待办」)。
//  主控补 彻底删除一条的确认:「无法恢复」,带图时说连带几张配图。
//  A11  新建空间 / 改当前空间名撞名:字留着、框下红字「已有同名空间「…」」、不带「出错:」、顶部不弹错;空名同形。
//  Q7   设置里有「空间…」,开的是空间那一页。
//  Q6   切空间回执「已切到「…」」;多空间时记一笔灰字写空间名;每个空间各记自己的筛选和滚动位(切走再切回还原)。
//  Q4   随记卡 / 长文的移动界面同一套话(「这边不留」「编辑历史」);挪完回执是普通提示条、带「去看看」,
//       点了 = 切到目标空间、落到新生的那一条(挂定位框)。
// 前置:界面语言中文;首启告知已点掉;竖屏手机宽(< 720);没开任何面;当前空间有足够多的随记(时间轴可滚过 2500px,
//   空间滚动位那格要它);已有至少一个别的空间也行、没有也行(本趟自建「W159M2空间」并在收尾删掉)。
// 原生半截(合成事件证不了的,每轮真机复走,截图进 .zjshots/159-m2/phone/):真点搜索结果后 `adb shell input keyevent 4`
//   / 真手势返回回到搜索结果、再按回时间轴、再按退到桌面;搜狗真打字(组字下划线期间不出结果、上屏后出);
//   落点卡的定位框肉眼看得见、几秒后褪。
(async () => {
  const M = "W159M2";
  const out = { pass: false, steps: [], skipped: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra === undefined ? {} : { extra }) });
    return !!cond;
  };
  const I = window.__TAURI__.core.invoke;
  const home = (await I("list_spaces")).find((s) => s.current)?.id;
  if (!home) return JSON.stringify({ error: "取不到当前空间" });
  const inv = (c, a, sp = home) => I(c, { spaceId: sp, ...(a || {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };
  const $ = (id) => document.getElementById(id);
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const clearBar = () => {
    $("error").hidden = true;
    $("error").classList.remove("retiring");
  };
  const type = (el, v, init) => {
    el.value = v;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, ...(init || {}) }));
  };
  const back = () => window.__zhujianHandleBack();
  const paneOpen = (id) => !$(id).hidden && document.body.classList.contains("pane-open");
  const noPane = () => !document.body.classList.contains("pane-open");
  const navMode = (m) => document.querySelector(`#bottombar [data-mode="${m}"]`);
  const closePanes = async () => {
    if (!noPane()) click(navMode("ideas"));
    await until(noPane, 2000);
  };
  const curSpace = async () => (await I("list_spaces")).find((s) => s.current)?.id;
  const hitCards = () => [...$("search-results").querySelectorAll(".card[data-hit]")];
  const hitCard = (id) => $("search-results").querySelector(`.card[data-hit="${id}"]`);
  const tlCard = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };
  const settle = async (el) => {
    // 平滑滚动停下:连两拍 top 不变
    let last = NaN;
    for (let i = 0; i < 40; i++) {
      const top = el.getBoundingClientRect().top;
      if (top === last) return;
      last = top;
      await sleep(80);
    }
  };
  const search = async (q) => {
    if (!paneOpen("search-pane")) click($("search-toggle"));
    await until(() => paneOpen("search-pane"), 2000);
    type($("search-input"), q);
    return until(() => hitCards().length > 0 && $("search-results").querySelector(".hit-head"), 6000);
  };

  if (document.documentElement.lang !== "zh") return JSON.stringify({ error: "前置:界面语言要中文" });
  if (document.body.classList.contains("widescreen")) return JSON.stringify({ error: "前置:要竖屏手机宽(非宽屏形)" });
  if (!noPane()) return JSON.stringify({ error: "前置:先收掉开着的面" });

  // ---- IPC 记数(Q8 去抖):安卓上 Tauri 一律走 window.ipc.postMessage,换成转发壳记 search_notes 的发数 ----
  const ipc0 = window.ipc;
  const calls = {};
  const shell = {
    postMessage(data) {
      try {
        const m = JSON.parse(data);
        calls[m.cmd] = (calls[m.cmd] || 0) + 1;
      } catch {}
      return ipc0.postMessage(data);
    },
  };
  try {
    window.ipc = shell;
  } catch {}
  const counting = window.ipc === shell;
  const nSearch = () => calls.search_notes || 0;

  // ---- 播种 ----
  const ids = { notes: [], tasks: [], topics: [], space: null };
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const tagsWereOpen = $("filterbar").classList.contains("tags-open") && !$("filterbar").classList.contains("tags-fit");
  try {
    const capture = async (content) => {
      const id = await inv("capture_idea", { content });
      ids.notes.push(id);
      return id;
    };
    ids.flow = [];
    for (let i = 1; i <= 8; i++) ids.flow.push(await capture(`${M}-流水${i} 发票\n第二行\n第三行`));
    ids.old = await capture(`${M}-旧 青柠 一句`);
    await inv("edit_note", { id: ids.old, content: `${M}-旧 改过了 一句` });
    ids.task = await inv("create_task", { title: `${M}-任务 发票`, dueOn: null, priority: null, topicId: null });
    ids.tasks.push(ids.task);
    ids.trImg = await capture(`${M}-回收站带图 发票`);
    for (let i = 0; i < 2; i++) await inv("add_item_image", { itemId: ids.trImg, mime: "image/png", dataB64: PNG });
    ids.trOne = await capture(`${M}-回收站单 发票`);
    ids.trTask = await inv("create_task", { title: `${M}-回收站任务 发票`, dueOn: null, priority: null, topicId: null });
    ids.tasks.push(ids.trTask);
    ids.trDoc = await inv("capture_doc", { content: `# ${M}-回收站长文 发票\n\n正文。` });
    ids.notes.push(ids.trDoc);
    await inv("archive_note", { id: ids.trImg });
    await inv("archive_note", { id: ids.trOne });
    await inv("archive_task", { id: ids.trTask });
    await inv("archive_note", { id: ids.trDoc });
    ids.sealed = await inv("create_task", { title: `${M}-归档任务 发票`, dueOn: null, priority: null, topicId: null });
    ids.tasks.push(ids.sealed);
    await inv("complete_task", { id: ids.sealed });
    await inv("seal_task", { id: ids.sealed });
    ids.doc = await inv("capture_doc", { content: `# ${M}-活长文 发票\n\n正文一段。` });
    ids.notes.push(ids.doc);
    ids.tA = await inv("create_topic", { title: `${M}甲` });
    ids.tB = await inv("create_topic", { title: `${M}乙` });
    ids.topics.push(ids.tA, ids.tB);
    for (const i of [0, 1, 2]) await inv("file_note_to_topic", { id: ids.flow[i], topicId: ids.tA, newTitle: null });
    for (const i of [3, 4]) await inv("file_note_to_topic", { id: ids.flow[i], topicId: ids.tB, newTitle: null });
    ids.space = await I("create_space", { name: `${M}空间` });

    // ================= 搜索:Q8 去抖 / 改词清旧 / 组字 =================
    ok("前置:换上 IPC 记数壳", counting);
    click($("search-toggle"));
    await until(() => paneOpen("search-pane"), 2000);
    const sin = $("search-input");
    const n0 = nSearch();
    // 连敲四下(每下间隔 < 去抖窗口),只该发一次
    for (const v of [`${M}`, `${M} `, `${M} 发`, `${M} 发票`]) {
      type(sin, v);
      await sleep(30);
    }
    ok("Q8 打字停一下自动出结果(不点「搜」)", !!(await until(() => hitCards().length > 0, 6000)));
    await sleep(400);
    ok("Q8 连敲四下只发一次 search_notes(去抖)", nSearch() - n0 === 1, { calls: nSearch() - n0 });
    const db = await inv("search_notes", { query: `${M} 发票` });
    ok("Q8 写「N 条匹配」且 N = 库里命中数", $("search-results").querySelector(".hit-head b")?.textContent === `${db.length} 条匹配`, {
      head: $("search-results").querySelector(".hit-head")?.textContent,
      db: db.length,
    });
    ok("Q8 …N = 画出来的卡数", hitCards().length === db.length);
    ok("A4 有结果时也写「改过的旧版本也一起搜」", $("search-results").querySelector(".hit-head")?.textContent.includes("改过的旧版本都一起搜"));
    const fc = hitCard(ids.flow[0]);
    const marks = [...(fc?.querySelectorAll(".content mark.hit") ?? [])].map((m) => m.textContent);
    ok("Q8 命中词标红(每个词都标)", marks.includes("发票") && marks.includes(M), marks);
    ok("Q8 标红是朱砂淡底(视觉本体)", !!fc && getComputedStyle(fc.querySelector("mark.hit")).fontWeight >= 600 && getComputedStyle(fc.querySelector("mark.hit")).backgroundColor !== "rgba(0, 0, 0, 0)");
    ok("Q8 卡脚的章 / 标签不标红", !fc?.querySelector("footer mark"));
    // 改词:旧结果当场清掉
    type(sin, `${M} 发票x`);
    ok("Q8 一改词旧结果当场清掉(同一拍)", hitCards().length === 0 && $("search-results").textContent.includes("搜索中"), $("search-results").textContent.slice(0, 30));
    await until(() => !$("search-results").textContent.includes("搜索中"), 6000);
    // 改一个字又在去抖窗口里删掉(回到屏上那个词之前的词):旧结果已清、在途作废 ⇒ 得重搜,别停在「搜索中…」
    type(sin, `${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    type(sin, `${M} 发票y`);
    type(sin, `${M} 发票`);
    ok("Q8 改一个字又删掉:结果回来(不卡在「搜索中…」)", !!(await until(() => hitCards().length === db.length, 6000)), $("search-results").textContent.slice(0, 30));
    // 组字:期间不发、上屏才发
    const n1 = nSearch();
    type(sin, `${M} fapiao`, { isComposing: true });
    ok("Q8 组字期间旧结果也清、不说「搜索中」", hitCards().length === 0 && !$("search-results").textContent.includes("搜索中"));
    await sleep(600);
    ok("Q8 组字期间不发 search_notes", nSearch() === n1, { calls: nSearch() - n1 });
    sin.value = `${M} 发票`;
    sin.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "发票" }));
    ok("Q8 上屏(compositionend)后出结果", !!(await until(() => hitCards().length === db.length, 6000)));
    ok("Q8 …上屏那一下只发一次", nSearch() - n1 === 1, { calls: nSearch() - n1 });
    // 回车 = 现在搜(不等去抖)
    const n2 = nSearch();
    sin.value = `${M} 青柠`;
    sin.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ok("Q8 回车当场发(不等去抖)", nSearch() - n2 === 1);
    // A4:只在旧版本里命中
    const oc = await until(() => hitCard(ids.old), 6000);
    ok("A4 只在旧版本命中的那张在结果里", !!oc && hitCards().length === 1, hitCards().length);
    ok("A4 卡上标「命中改过的旧版本」", oc?.querySelector(".old-hit")?.textContent === "命中改过的旧版本");
    ok("A4 …那枚是虚线框(不是标签的样子)", !!oc && getComputedStyle(oc.querySelector(".old-hit")).borderTopStyle === "dashed");

    // ================= A3 / A14 / A17:时间轴落点 =================
    await search(`${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    // 回收站命中的章(Q12)
    const pill = (id) => hitCard(id)?.querySelector(".pill")?.textContent;
    ok("Q12 回收站里的卡片写「回收站 · 卡片」(mbopt 第二波:任务 → 卡片)", pill(ids.trTask) === "回收站 · 卡片", pill(ids.trTask));
    ok("Q12 回收站里的随记写「回收站 · 随记」", pill(ids.trOne) === "回收站 · 随记", pill(ids.trOne));
    ok("Q12 回收站里的长文写「回收站 · 长文」", pill(ids.trDoc) === "回收站 · 长文", pill(ids.trDoc));
    ok("Q12 活卡片写「卡片」、归档写「归档」", pill(ids.task) === "卡片" && pill(ids.sealed) === "归档");
    // 滚到结果中段,记下位置
    const target = hitCard(ids.flow[4]);
    target.scrollIntoView({ block: "center" });
    await sleep(200);
    const y0 = window.scrollY;
    ok("前置:结果列表滚离顶部", y0 > 100, y0);
    click(target.querySelector(".body"));
    const landed = await until(() => noPane() && tlCard(ids.flow[4])?.classList.contains("located") && tlCard(ids.flow[4]), 8000);
    ok("A14 点结果落到时间轴那张卡、挂定位框", !!landed);
    if (landed) {
      await settle(landed);
      ok("A14 落点卡在屏内", inView(landed), landed.getBoundingClientRect().top);
      const cs = getComputedStyle(landed);
      ok("A14 定位框看得见(朱砂描边 + 阴影,判视觉本体)", cs.boxShadow !== "none" && cs.borderTopColor !== getComputedStyle(tlCard(ids.flow[3]) ?? landed).borderTopColor, { shadow: cs.boxShadow.slice(0, 60), border: cs.borderTopColor });
      await sleep(1500);
      ok("A14 1.5 s 后还在(比旧的 1.2 s flash 长)", landed.classList.contains("located"));
      ok("A14 …几秒后自己褪掉", !!(await until(() => !landed.classList.contains("located"), 5000)));
    }
    // 落点卡开操作面 → 第一下返回先收操作面
    click(tlCard(ids.flow[4]).querySelector(".body"));
    await until(() => tlCard(ids.flow[4])?.querySelector(".panel"), 2000);
    ok("前置:落点卡操作面开着", !!tlCard(ids.flow[4])?.querySelector(".panel"));
    ok("A3 第一下返回被页面接住", back() === true);
    await sleep(500);
    ok("A3 …先收落点卡的操作面、搜索面还没开", !tlCard(ids.flow[4])?.querySelector(".panel") && noPane());
    ok("A3 第二下返回被页面接住", back() === true);
    const reopened = await until(() => paneOpen("search-pane"), 3000);
    ok("A3 回到搜索结果", !!reopened);
    ok("A3 …词还在", $("search-input").value === `${M} 发票`);
    ok("A3 …结果还在", hitCards().length === db.length);
    await sleep(300);
    ok("A17 …滚动位还在(不回顶)", Math.abs(window.scrollY - y0) <= 4, { now: window.scrollY, was: y0 });
    ok("A17 …焦点不进框(不弹键盘、不滚回顶)", document.activeElement !== $("search-input"));
    ok("A3 再按一下返回:收搜索面回时间轴", back() === true && !!(await until(noPane, 3000)));
    await sleep(500);
    ok("A3 再按:无层可关、交回系统(中间不留空炮)", back() === false);

    // ================= A3 / A14:回收站落点(对应段那一条) =================
    await search(`${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    click(hitCard(ids.trTask).querySelector(".body"));
    const tcard = await until(() => paneOpen("trash-pane") && document.querySelector(`#trash-list [data-trash="${ids.trTask}"].located`), 8000);
    ok("A14 回收站命中:开回收站、那一条挂定位框", !!tcard);
    ok("A14 …落在「任务」那一段", !!tcard?.closest('.trash-sec[data-sec="tasks"]'));
    if (tcard) {
      await settle(tcard);
      ok("A14 …那一条在屏内", inView(tcard), tcard.getBoundingClientRect().top);
      ok("Q12 回收站里卡片的小章叫「卡片」", tcard.querySelector(".pill")?.textContent === "卡片", tcard.querySelector(".pill")?.textContent);
    }
    ok("A3 回收站落点按返回 → 回搜索结果", back() === true && !!(await until(() => paneOpen("search-pane") && hitCards().length > 0, 3000)));
    ok("A3 …回收站那一面收了", $("trash-pane").hidden);
    ok("A3 再按 → 时间轴", back() === true && !!(await until(noPane, 3000)));
    await sleep(400);
    ok("A3 再按 → 交回系统", back() === false);

    // ================= A3:长文落点 =================
    await search(`${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    click(hitCard(ids.doc).querySelector(".body"));
    const docOpen = await until(() => paneOpen("docs-pane") && $("docs-body")?.textContent.includes(`${M}-活长文`), 8000);
    ok("A3 长文命中:开长文面落到那一篇", !!docOpen);
    ok("A3 长文落点按返回 → 回搜索结果(不是长文列表)", back() === true && !!(await until(() => paneOpen("search-pane") && hitCards().length > 0, 3000)));
    ok("A3 再按 → 时间轴", back() === true && !!(await until(noPane, 3000)));
    await sleep(400);
    ok("A3 再按 → 交回系统", back() === false);

    // ================= A3:用户自己走开 = 不再回搜索 =================
    await search(`${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    click(hitCard(ids.flow[2]).querySelector(".body"));
    await until(() => noPane() && tlCard(ids.flow[2])?.classList.contains("located"), 8000);
    click(navMode("tasks")); // 底栏换面
    await sleep(500);
    ok("A3 落点上点底栏走开之后,返回 = 交回系统(不弹回搜索)", back() === false && noPane());
    click(navMode("ideas"));
    await sleep(300);

    // ================= A4:旧版本命中的落点说一句 =================
    await search(`${M} 青柠`);
    const oc2 = await until(() => hitCard(ids.old), 6000);
    click(oc2.querySelector(".body"));
    const oldLanded = await until(() => noPane() && tlCard(ids.old)?.classList.contains("located") && tlCard(ids.old), 8000);
    ok("A4 点旧版本命中:落点卡上说去「历史」里看", oldLanded?.querySelector(".locate-note")?.textContent.includes("「历史」"), oldLanded?.querySelector(".locate-note")?.textContent);
    back();
    await until(() => paneOpen("search-pane"), 3000);

    // ================= A17:顶栏再开搜索也不回顶 =================
    await search(`${M} 发票`);
    await until(() => hitCards().length === db.length, 6000);
    window.scrollTo(0, Math.round((document.scrollingElement.scrollHeight - window.innerHeight) / 2)); // 结果列表中段
    await sleep(200);
    const y1 = window.scrollY;
    click($("search-toggle")); // 收
    await until(noPane, 2000);
    click($("search-toggle")); // 再开
    await until(() => paneOpen("search-pane"), 2000);
    await sleep(300);
    ok("A17 顶栏收了再开:结果停在原来的滚动位", y1 > 100 && Math.abs(window.scrollY - y1) <= 4, { now: window.scrollY, was: y1 });
    ok("A17 …焦点不进框", document.activeElement !== $("search-input"));
    click($("search-toggle"));
    await until(noPane, 2000);

    // ================= 回收站:彻底删除一条的确认(主控补) =================
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    await until(() => paneOpen("trash-pane") && document.querySelector(`#trash-list [data-trash="${ids.trImg}"]`), 6000);
    const askPurge = async (id) => {
      const c = document.querySelector(`#trash-list [data-trash="${id}"]`);
      c.scrollIntoView({ block: "center" });
      click(c.querySelector(".body"));
      const pb = await until(() => document.querySelector(`#trash-list [data-trash="${id}"] [data-trash-act="purge"]`), 2000);
      click(pb);
      await until(() => !$("confirmbar").hidden, 2000);
      const q = $("confirmbar-q").textContent;
      click($("confirmbar-no"));
      await until(() => $("confirmbar").hidden, 2000);
      click(document.querySelector(`#trash-list [data-trash="${id}"] .body`)); // 收操作面
      return q;
    };
    const qImg = await askPurge(ids.trImg);
    ok("彻底删除带图那条:确认写连带几张配图、无法恢复", qImg === "彻底删除这条和它的 2 张配图?无法恢复", qImg);
    const qOne = await askPurge(ids.trOne);
    ok("彻底删除没图那条:确认写无法恢复、不提配图", qOne === "彻底删除这条?无法恢复", qOne);
    await closePanes();

    // ================= Q8 / A5:随记页筛选 =================
    if (tagsWereOpen) click($("filter-expand")); // 收起成单行横滑(A5 要的那一形)
    await sleep(300);
    const pillOf = (tid) => document.querySelector(`#filter-topics .fpill[data-topic-id="${tid}"]`);
    ok("前置:时间轴上有本趟的两枚标签", !!pillOf(ids.tA) && !!pillOf(ids.tB));
    const ftop = $("filter-topics");
    click(pillOf(ids.tA));
    await sleep(200);
    const sum = $("filter-sum");
    ok("Q8 筛一枚标签:写「筛出 3 条 · 标签「…」」", !sum.hidden && sum.textContent === `筛出 3 条 · 标签「${M}甲」`, sum.textContent);
    click(pillOf(ids.tB));
    await sleep(200);
    ok("Q8 多选:写出选了哪几枚", sum.textContent === `筛出 5 条 · 标签「${M}甲、${M}乙」挂任一个都算`, sum.textContent);
    ok("Q8 …条数 = 屏上卡数", document.querySelectorAll("#timeline .card[data-id]").length === 5);
    const ft = $("filter-text");
    type(ft, "流水4");
    await until(() => document.querySelectorAll("#timeline .card[data-id]").length === 1, 2000);
    ok("Q8 加过滤词:条数跟着走", sum.textContent.startsWith("筛出 1 条"), sum.textContent);
    ok("Q8 过滤词在卡上标红", [...document.querySelectorAll("#timeline .card .content mark.hit")].map((m) => m.textContent).join() === "流水4");
    type(ft, "");
    await until(() => document.querySelectorAll("#timeline .card[data-id]").length === 5, 2000);
    ok("Q8 清掉过滤词:标红也没了", !document.querySelector("#timeline mark.hit"));
    if (ftop.scrollWidth > ftop.clientWidth + 20 && !$("filterbar").classList.contains("tags-open")) {
      ftop.scrollLeft = ftop.scrollWidth; // 横划到最右:「所有」滚出去
      await sleep(100);
      const allPill = ftop.querySelector(".fpill");
      const offBefore = allPill.getBoundingClientRect().right <= ftop.getBoundingClientRect().left + 1;
      click(pillOf(ids.tA));
      await sleep(100);
      click(pillOf(ids.tB)); // 最后一枚取消 = 清完
      await sleep(200);
      const ar = ftop.querySelector(".fpill").getBoundingClientRect();
      const rr = ftop.getBoundingClientRect();
      ok("A5 清完筛选,标签条滚回开头、「所有」看得见", offBefore && ftop.scrollLeft === 0 && ar.left >= rr.left - 1 && ar.right <= rr.right + 1, { offBefore, sl: ftop.scrollLeft });
      ok("A5 …「所有」是选中态", ftop.querySelector(".fpill").classList.contains("active"));
    } else {
      out.skipped.push("A5:标签条一行装得下(或摊开着),横滑不出去 —— 换标签多的空间验");
      click(pillOf(ids.tA));
      await sleep(100);
      click(pillOf(ids.tB));
      await sleep(200);
    }
    ok("Q8 没在筛:那一行收起", sum.hidden);

    // ================= Q7:设置里的「空间…」 =================
    click($("settings-toggle"));
    await until(() => paneOpen("settings-pane"), 2000);
    ok("Q7 设置里有「空间…」", $("settings-spaces-btn")?.textContent === "空间…" && $("settings-spaces-btn").getBoundingClientRect().height > 0);
    click($("settings-spaces-btn"));
    ok("Q7 点了开的是空间那一页", !!(await until(() => paneOpen("spaces") && $("space-list").querySelector(".space-row"), 3000)));
    ok("Q7 同步页那枚「空间…」照留(元素在)", !!$("sync-spaces-btn"));

    // ================= A11:撞名 / 空名 =================
    clearBar();
    const sn = $("space-new-name");
    type(sn, `${M}空间`);
    click($("space-create"));
    const ne = await until(() => !$("space-new-err").hidden && $("space-new-err"), 4000);
    ok("A11 新建撞名:框下红字「已有同名空间「…」」", ne?.textContent === `已有同名空间「${M}空间」`, ne?.textContent);
    ok("A11 …不带「出错:」、顶部不弹错", !!ne && !ne.textContent.includes("出错") && $("error").hidden);
    ok("A11 …字留在框里", sn.value === `${M}空间`);
    ok("A11 …红字是朱砂色(视觉本体)", !!ne && getComputedStyle(ne).color !== getComputedStyle(document.querySelector(".sync .fine") ?? document.body).color);
    type(sn, `${M}空间x`);
    ok("A11 一动笔红字就收", $("space-new-err").hidden);
    type(sn, "");
    click($("space-create"));
    ok("A11 空名:框下说要起名字", !$("space-new-err").hidden && $("space-new-err").textContent === "给空间起个名字(比如「家庭」)", $("space-new-err").textContent);
    ok("A11 …顶部不弹错", $("error").hidden);
    type(sn, "");
    click($("space-list").querySelector("[data-rename]"));
    const ri = await until(() => $("space-rename-input"), 2000);
    type(ri, `${M}空间`);
    click($("space-list").querySelector("[data-rename-ok]"));
    const re = await until(() => $("space-list").querySelector(".space-err"), 4000);
    ok("A11 改名撞名:框下红字、留在改名态", re?.textContent === `已有同名空间「${M}空间」`, re?.textContent);
    ok("A11 …框里是刚打的字", $("space-rename-input")?.value === `${M}空间`);
    ok("A11 …顶部不弹错", $("error").hidden);
    click($("space-list").querySelector("[data-rename-cancel]"));
    await until(() => !$("space-rename-input"), 2000);
    ok("A11 取消后红字收", !$("space-list").querySelector(".space-err"));

    // ================= Q6:回执 / 灰字 / 各记各的筛选与位置 =================
    const switchTo = async (sid) => {
      if (!paneOpen("spaces")) {
        click($("space-chip"));
        await until(() => paneOpen("spaces") && $("space-list").querySelector(`[data-switch="${sid}"]`), 3000);
      }
      await until(() => $("space-list").querySelector(`[data-switch="${sid}"]`), 3000);
      clearBar();
      click($("space-list").querySelector(`[data-switch="${sid}"]`));
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && (await curSpace()) !== sid) await sleep(100);
      return until(() => !$("error").hidden && $("error").textContent.startsWith("已切到") && $("error").textContent, 4000);
    };
    await closePanes();
    // 主空间:筛「甲」+ 记下位置(先不筛滚到深处,再筛;筛的那一刻记下的是筛前位置)
    window.scrollTo(0, 0);
    const deep = Math.min(1500, document.scrollingElement.scrollHeight - window.innerHeight - 10);
    window.scrollTo(0, deep);
    await sleep(200);
    const yHome = window.scrollY;
    ok("前置:主空间时间轴滚得动", yHome > 300, yHome);
    const r1 = await switchTo(ids.space);
    ok("Q6 切过去回执「已切到「…」」", r1 === `已切到「${M}空间」`, r1);
    ok("Q6 多空间时记一笔灰字写空间名", $("text").placeholder === `随手记一笔,记进「${M}空间」…`, $("text").placeholder);
    const homeLabel = (await I("list_spaces")).find((s) => s.id === home);
    const homeName = homeLabel?.name ?? "默认空间";
    const r2 = await switchTo(home);
    ok("Q6 切回来回执", r2 === `已切到「${homeName}」`, r2);
    await until(() => document.querySelector("#timeline .card[data-id]"), 6000);
    await sleep(500);
    ok("Q6 切走再切回:滚动位还原", Math.abs(window.scrollY - yHome) <= 30, { now: window.scrollY, was: yHome });
    // 筛选记忆
    window.scrollTo(0, 0);
    await until(() => pillOf(ids.tA), 3000);
    click(pillOf(ids.tA));
    await sleep(200);
    await switchTo(ids.space);
    ok("Q6 另一个空间不带过去这边的筛选", $("filter-sum").hidden || !$("filter-sum").textContent.includes(`${M}甲`));
    await switchTo(home);
    await until(() => pillOf(ids.tA), 6000);
    ok("Q6 切回来:这边的筛选还原(那枚还亮着)", pillOf(ids.tA)?.classList.contains("active"));
    ok("Q6 …筛选条那一行也回来了", !$("filter-sum").hidden && $("filter-sum").textContent.includes(`${M}甲`), $("filter-sum").textContent);
    click(pillOf(ids.tA)); // 清掉
    await sleep(200);

    // ================= Q4:移动界面同一套话 + 回执带「去看看」 =================
    const mv = tlCard(ids.flow[7]);
    mv.scrollIntoView({ block: "center" });
    click(mv.querySelector(".body"));
    await until(() => tlCard(ids.flow[7])?.querySelector('[data-pact="more"]'), 2000);
    click(tlCard(ids.flow[7]).querySelector('[data-pact="more"]'));
    await until(() => tlCard(ids.flow[7])?.querySelector('[data-pact="move"]'), 2000);
    click(tlCard(ids.flow[7]).querySelector('[data-pact="move"]'));
    const warn = await until(() => tlCard(ids.flow[7])?.querySelector(".movewarn")?.textContent, 2000);
    ok("Q4 随记卡的移动说明:「这边不留」+「编辑历史」", warn === "移到别的空间 = 那边新生一条、这边不留;编辑历史会随移动永久删除,不迁入目标空间。", warn);
    click(tlCard(ids.flow[7]).querySelector(`[data-move-to="${ids.space}"]`));
    await until(() => !$("confirmbar").hidden, 2000);
    ok("Q4 两拍确认的问句", $("confirmbar-q").textContent === `移到「${M}空间」?编辑历史会永久删除`, $("confirmbar-q").textContent);
    clearBar();
    click($("confirmbar-yes"));
    const mbar = await until(() => !$("error").hidden && $("error").textContent.startsWith("已移到") && $("error"), 6000);
    ok("Q4 挪完回执「已移到「…」」", !!mbar && mbar.querySelector("span")?.textContent === `已移到「${M}空间」`, mbar?.textContent);
    ok("Q4 …是普通提示条(notice 那档)、带「去看看」", !!mbar && mbar.classList.contains("notice") && [...mbar.querySelectorAll(".bar-act")].map((b) => b.textContent).join() === "去看看");
    await sleep(2400);
    ok("Q4 …2.2 s 之后还在(同一通道、读得完)", !$("error").hidden && $("error").textContent.startsWith("已移到"));
    click($("error").querySelector(".bar-act"));
    let sw = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && (sw = await curSpace()) !== ids.space) await sleep(100);
    }
    ok("Q4 点「去看看」= 切到目标空间", sw === ids.space);
    // ⚠ 手机只有当前空间是活的(max_live=1):目标空间要等切过去才读得动
    const moved = (await inv("list_timeline", {}, ids.space)).find((x) => String(x.content).startsWith(`${M}-流水8`));
    ok("前置:目标空间里新生了那一条", !!moved);
    const ml = await until(() => moved && tlCard(moved.id)?.classList.contains("located") && tlCard(moved.id), 8000);
    ok("Q4 …落到新生的那一条、挂定位框", !!ml);
    if (ml) {
      await settle(ml);
      ok("Q4 …那一条在屏内", inView(ml));
    }
    // 长文的移动说明同一套话
    await switchTo(home);
    await closePanes();
    click(document.querySelector('#bottombar [data-pane="docs"]'));
    const docRow = await until(() => paneOpen("docs-pane") && $("docs-body").querySelector(`[data-doc="${ids.doc}"]`), 6000);
    click(docRow);
    const more = await until(() => [...$("docs-body").querySelectorAll("button")].find((b) => b.textContent === "更多…"), 4000);
    click(more);
    const mvb = await until(() => [...$("docs-body").querySelectorAll("button")].find((b) => b.textContent === "移动"), 2000);
    click(mvb);
    const dwarn = await until(() => $("docs-body").querySelector(".movewarn")?.textContent, 2000);
    ok("Q4 长文的移动说明与随记卡逐字相同(说「编辑历史」、不说「历史版本」)", dwarn === warn, dwarn);
    const dt = [...$("docs-body").querySelectorAll(".movewarn ~ .lane button")].find((b) => b.textContent.includes(`${M}空间`));
    click(dt);
    await until(() => !$("confirmbar").hidden, 2000);
    ok("Q4 长文的确认问句与随记卡相同", $("confirmbar-q").textContent === `移到「${M}空间」?编辑历史会永久删除`, $("confirmbar-q").textContent);
    click($("confirmbar-no"));
    await closePanes();
  } catch (e) {
    ok("没抛异常", false, String(e && e.stack ? e.stack : e));
  } finally {
    clearBar();
    if (!$("confirmbar").hidden) click($("confirmbar-no"));
    try {
      window.ipc = ipc0;
    } catch {}
    // 回到原空间
    if ((await curSpace()) !== home) {
      try {
        if (!paneOpen("spaces")) click($("space-chip"));
        await until(() => $("space-list").querySelector(`[data-switch="${home}"]`), 3000);
        click($("space-list").querySelector(`[data-switch="${home}"]`));
        const t0 = Date.now();
        while (Date.now() - t0 < 8000 && (await curSpace()) !== home) await sleep(100);
      } catch {}
    }
    await closePanes();
    for (const id of [...ids.notes, ...ids.tasks]) {
      for (const c of ["unseal_task", "archive_task", "purge_task", "archive_note", "purge_note"]) {
        try {
          await inv(c, { id });
        } catch {}
      }
    }
    for (const id of ids.topics) {
      try {
        await inv("delete_topic", { id });
      } catch {}
    }
    if (ids.space) {
      try {
        await I("reset_space", { spaceId: ids.space });
      } catch (e) {
        ok("清场:删掉本趟的空间", false, String(e));
      }
    }
    if (tagsWereOpen && !$("filterbar").classList.contains("tags-open")) click($("filter-expand"));
    const tl = await inv("list_timeline");
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes(M)));
    ok("清场:回收站没有种子", !(await inv("list_trash")).some((x) => String(x.content).includes(M)));
    ok("清场:归档里没有种子", !(await inv("list_sealed_tasks")).some((x) => String(x.title).includes(M)));
    ok("清场:标签没有种子", !(await inv("list_topics_full")).some((x) => String(x.title).includes(M)));
    ok("清场:本趟的空间删掉了", !(await I("list_spaces")).some((s) => s.id === ids.space));
    ok("清场:回到原空间", (await curSpace()) === home);
    window.scrollTo(0, 0);
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
