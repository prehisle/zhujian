// @cdp-run single timeout=180000
// 159(W3 走查用户全取的那批)手机前端第一波 —— 回收站 + 标签 + 零碎 —— 的页内可断言部分。单趟、自播种、自清场。
//   node scripts/android-cdp.mjs forward
//   CDP_TIMEOUT_MS=180000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-walk159-m1.js
// 逐条(编号同 .zjshots/W3-walk/清单.md):
//  Q1/A1 回收站一页分「随记」「任务」两段,段头各数各的;长文归随记段;已删配图跟着宿主的段走;每段末尾一枚「清空…」。
//  A19  清空的确认是全宽那一档(执行钮横贯整条、取消在它下面),确认句说清是哪一段、几条、几张配图;
//       执行钮不落在「清空…」钮的原落点上;别的确认(彻底删除一条)照旧是普通形。
//  Q1   (前置成立时)清空随记那段:随记段空了、任务段的种子与任务宿主的已删图都还在;再清任务那段。
//  A7   彻底删除一条给回执「已彻底删除」。
//  A15  回收站里带图那条画出两枚缩略图,点开是只读查看器。
//  A16  回收站与搜索结果:很长那条夹到八行、长一枚「展开」(点它只翻折叠、不开操作面);长文画成题目 + 摘要、不露「#」
//       (搜索里**回收站的**长文要命中带 `trash_kind`,命令面没透出时那格进 skipped);
//       清单画成方框、不露「- [ ]」;标签页展开里同样不露(随记那行、任务那行都验)。
//  A17  回收站里还原一条不跳回顶部;离开回收站再回来回到原处。
//  A18  提示条落在顶栏下沿之下:提示条在场时点顶栏「搜索」那一点命中的是「搜索」钮。
//  A23  底栏 / 顶栏的字不可选(user-select:none)。
//  Q2   底栏「回收站」「归档」常在,分隔线也在;「长文」只在有长文时在。
//  Q5   合并:先点要留下的(高亮 + 提示换成「把谁并进「X」?」),再点要并进来的 → 确认句方向对、落库方向对。
//  Q12  标签行计数写「N 条随记 · M 个任务」且与库对得上;新建重名 → 字留在框里、框下红字、不带「出错:」、顶部不弹错;
//       空名 → 框下「标签名不能为空」;改名重名同样留字留态;新建成功 → 滚到它、闪一下;页尾说明;类型框下的说明;
//       改色时色板那行留着名字;超长名字折行显示全名。
// 前置:界面语言中文;首启告知已点掉;竖屏手机宽(< 720,非宽屏形);没开任何面。
//   ⚠ 清空那两格要**回收站里除本趟种子外没有别的**(它们真会彻底删掉一整段)—— 不成立时那两格进 `skipped`、点「取消」收场,
//   其余照跑。真机上要验清空,先在界面上把回收站清干净再跑。
// 原生半截(合成事件证不了的,每轮真机 `adb input` 复走,截图进 .zjshots/159-m1/phone/):长按底栏字不弹系统菜单;
//   清空回收站翻到面底真点两下(第二下落在「取消」或留白上,不清);提示条在场时真点顶栏空间名 / 搜索;
//   回收站里还原一条后真划的位置不变;只有一个标签的空间里标签条不切字。
(async () => {
  const M = "W159M1";
  const out = { pass: false, steps: [], skipped: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra === undefined ? {} : { extra }) });
    return !!cond;
  };
  const I = window.__TAURI__.core.invoke;
  const space = (await I("list_spaces")).find((s) => s.current)?.id;
  if (!space) return JSON.stringify({ error: "取不到当前空间" });
  const inv = (c, a) => I(c, { spaceId: space, ...(a || {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(60);
    }
    return null;
  };
  const $ = (id) => document.getElementById(id);
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const clearBar = () => {
    $("error").hidden = true;
    $("error").classList.remove("retiring");
  };
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const navPane = (p) => document.querySelector(`#bottombar [data-pane="${p}"]`);
  const navMode = (m) => document.querySelector(`#bottombar [data-mode="${m}"]`);
  const closePanes = async () => {
    if (document.body.classList.contains("pane-open")) click(navMode("ideas"));
    await until(() => !document.body.classList.contains("pane-open"), 2000);
  };
  const openTrash = async () => {
    await closePanes();
    click(navPane("trash"));
    await until(() => !$("trash-pane").hidden, 3000);
    return until(() => $("trash-list").querySelector(".trash-sec"), 6000);
  };
  const sec = (s) => document.querySelector(`#trash-list .trash-sec[data-sec="${s}"]`);
  const trashCard = (id) => document.querySelector(`#trash-list [data-trash="${id}"]`);
  const inSec = (s, id) => !!sec(s)?.querySelector(`[data-trash="${id}"]`);

  if (document.documentElement.lang !== "zh") return JSON.stringify({ error: "前置:界面语言要中文" });
  if (document.body.classList.contains("widescreen")) return JSON.stringify({ error: "前置:要竖屏手机宽(非宽屏形)" });

  // ---- 播种 ----
  const ids = { notes: [], tasks: [], topics: [] };
  const LONG = [`${M}-长条`, ...Array.from({ length: 15 }, (_, i) => `第 ${i + 2} 行:很长的一条随记,用来看回收站与搜索里会不会整段摊开。`)].join("\n");
  const preTrash = await inv("list_trash");
  const preImgs = await inv("list_removed_images", { scope: "all" });
  const trashWasEmpty = preTrash.length === 0 && preImgs.length === 0;
  try {
    const capture = async (content) => {
      const id = await inv("capture_idea", { content });
      ids.notes.push(id);
      return id;
    };
    // 回收站里的:很长的随记 / 带两张图的随记 / 清单 / 长文 / 单删用 / 还原用 / 填充若干 / 一个任务
    ids.long = await capture(LONG);
    ids.img2 = await capture(`${M}-带两张图`);
    for (let i = 0; i < 2; i++) await inv("add_item_image", { itemId: ids.img2, mime: "image/png", dataB64: PNG });
    ids.ck = await capture(`${M}-清单\n- [ ] 买菜\n- [x] 洗衣`);
    ids.doc = await inv("capture_doc", { content: `# ${M}-长文题目\n\n第一段。\n\n第二段。` });
    ids.notes.push(ids.doc);
    ids.one = await capture(`${M}-单删`);
    ids.back = await capture(`${M}-还原`);
    for (let i = 1; i <= 6; i++) await capture(`${M}-填充${i}\n第二行\n第三行`);
    ids.task = await inv("create_task", { title: `${M}-任务`, dueOn: null, priority: null, topicId: null });
    ids.tasks.push(ids.task);
    // 删的顺序 = 回收站里的倒序(最近删的在前):还原用那条删在最早 ⇒ 它在随记段靠下,A17 要往下划才看得到
    await inv("archive_note", { id: ids.back });
    for (const id of ids.notes.filter((x) => ![ids.back, ids.doc].includes(x))) await inv("archive_note", { id });
    await inv("archive_note", { id: ids.doc });
    await inv("archive_task", { id: ids.task });
    // 活着的宿主各删一张图:随记宿主那张归随记段、任务宿主那张归任务段
    ids.liveNote = await capture(`${M}-活随记 有图`);
    const ln = await inv("add_item_image", { itemId: ids.liveNote, mime: "image/png", dataB64: PNG });
    await inv("delete_item_image", { imageId: ln.id });
    ids.liveNoteImg = ln.id;
    // 任务正文也带一段清单:标签页展开里任务那行同样不许露「- [ ]」(A16;接手时补的一格 —— 第一版只验了随记那行)
    ids.liveTask = await inv("create_task", { title: `${M}-活任务 有图\n- [ ] 甲\n- [x] 乙`, dueOn: null, priority: null, topicId: null });
    ids.tasks.push(ids.liveTask);
    const lt = await inv("add_item_image", { itemId: ids.liveTask, mime: "image/png", dataB64: PNG });
    await inv("delete_item_image", { imageId: lt.id });
    ids.liveTaskImg = lt.id;
    // 搜索 / 标签页用的活条目
    ids.liveLong = await capture(LONG.replace(`${M}-长条`, `${M}-活长条`));
    ids.liveDoc = await inv("capture_doc", { content: `# ${M}-活长文\n\n正文一段。` });
    ids.notes.push(ids.liveDoc);
    // 标签:合并用的两枚(「并」挂在一条清单随记上)、重名用、超长名
    ids.tKeep = await inv("create_topic", { title: `${M}留` });
    ids.tFold = await inv("create_topic", { title: `${M}并` });
    ids.topics.push(ids.tKeep, ids.tFold);
    ids.liveCk = await capture(`${M}-活清单\n- [ ] 一项\n- [x] 两项`);
    await inv("file_note_to_topic", { id: ids.liveCk, topicId: ids.tFold, newTitle: null });
    await inv("add_task_topic", { id: ids.liveTask, topicId: ids.tFold });
    const LONGTAG = `${M}一个特别特别特别长的标签名字用来看标签页那一行会不会折行显示全名`;
    ids.tLong = await inv("create_topic", { title: LONGTAG });
    ids.topics.push(ids.tLong);

    // ================= 回收站 =================
    const opened = await openTrash();
    ok("前置:回收站开出两段", !!opened);
    const trash = await inv("list_trash");
    const removed = await inv("list_removed_images", { scope: "all" });
    // Q1:两段 + 段头计数
    const idsIn = (s) => [...sec(s).querySelectorAll("[data-trash]")].map((c) => c.dataset.trash);
    ok("Q1 两段:随记在前、任务在后", sec("ideas") && sec("tasks") && !!(sec("ideas").compareDocumentPosition(sec("tasks")) & Node.DOCUMENT_POSITION_FOLLOWING));
    ok("Q1 段头写「随记」「任务」", sec("ideas").querySelector(".tl-sec").textContent.startsWith("随记") && sec("tasks").querySelector(".tl-sec").textContent.startsWith("任务"));
    const nIdeasDom = idsIn("ideas").length;
    const nTasksDom = idsIn("tasks").length;
    ok("Q1 随记段头的数 = 该段卡数", Number(sec("ideas").querySelector(".tl-count").textContent) === nIdeasDom, nIdeasDom);
    ok("Q1 任务段头的数 = 该段卡数", Number(sec("tasks").querySelector(".tl-count").textContent) === nTasksDom, nTasksDom);
    ok("Q1 两段卡数之和 = 回收站总数", nIdeasDom + nTasksDom === trash.length, { dom: nIdeasDom + nTasksDom, db: trash.length });
    ok("Q1 随记 / 长文进随记段", inSec("ideas", ids.long) && inSec("ideas", ids.doc) && !inSec("tasks", ids.doc));
    ok("Q1 任务进任务段", inSec("tasks", ids.task) && !inSec("ideas", ids.task));
    ok("Q1 随记宿主的已删图在随记段", !!sec("ideas").querySelector(`[data-trash-img="${ids.liveNoteImg}"]`));
    ok("Q1 任务宿主的已删图在任务段", !!sec("tasks").querySelector(`[data-trash-img="${ids.liveTaskImg}"]`) && !sec("ideas").querySelector(`[data-trash-img="${ids.liveTaskImg}"]`));
    ok("Q1 每段末尾一枚「清空…」", $("trash-empty-ideas")?.textContent === "清空随记回收站" && $("trash-empty-tasks")?.textContent === "清空任务回收站");
    ok("Q1 「清空…」在那一段的卡之后", !!(sec("ideas").querySelector("[data-trash]").compareDocumentPosition($("trash-empty-ideas")) & Node.DOCUMENT_POSITION_FOLLOWING));
    ok("Q1 「清空…」不通栏(次级钮)", $("trash-empty-ideas").getBoundingClientRect().width < $("trash-pane").getBoundingClientRect().width * 0.7);
    void removed;

    // A15:带两张图那条
    const c2 = trashCard(ids.img2);
    ok("A15 回收站里带图那条画出两枚缩略图", c2?.querySelectorAll(".thumbs .thumb[data-img]").length === 2);
    c2?.scrollIntoView({ block: "center" });
    const filled = await until(() => c2?.querySelector(".thumb img")?.getAttribute("src"), 6000);
    ok("A15 缩略图取得到字节(宿主在回收站里也行)", !!filled);
    click(c2.querySelector(".thumb"));
    const viewer = $("viewer");
    ok("A15 点缩略图开查看器", !!(await until(() => !viewer.hidden, 3000)));
    ok("A15 查看器是只读(藏掉删除)", viewer.classList.contains("readonly"));
    ok("A15 点缩略图不开操作面", !c2.querySelector(".panel"));
    click(viewer);
    await until(() => viewer.hidden, 3000);

    // A16:长条折叠 / 长文 / 清单
    const cl = trashCard(ids.long);
    const body = cl?.querySelector(".content");
    ok("A16 回收站长条夹住(八行)", !!body && body.classList.contains("clamped") && body.style.maxHeight !== "", body?.style.maxHeight);
    ok("A16 回收站长条长一枚「展开」", cl?.querySelector(".fold-toggle")?.textContent.startsWith("展开"));
    ok("A16 回收站长条卡不占满一屏(< 视口一半)", cl.getBoundingClientRect().height < window.innerHeight / 2, cl.getBoundingClientRect().height);
    click(cl.querySelector(".fold-toggle"));
    ok("A16 点「展开」= 摊开、不开操作面", !body.classList.contains("clamped") && !cl.querySelector(".panel"));
    click(cl.querySelector(".fold-toggle"));
    ok("A16 再点 = 收回", body.classList.contains("clamped"));
    const cd = trashCard(ids.doc);
    ok("A16 回收站长文画成题目 + 摘要", cd?.classList.contains("doc-card") && cd.querySelector(".doc-title")?.textContent === `${M}-长文题目`);
    ok("A16 回收站长文不露「#」", !cd?.querySelector(".body").textContent.replace(/#\d/g, "").includes("#"), cd?.querySelector(".body").textContent.slice(0, 60));
    ok("A16 回收站长文小签仍写「长文」", cd?.querySelector(".pill")?.textContent === "长文");
    const cc = trashCard(ids.ck);
    ok("A16 回收站清单画成方框、不露「- [ ]」", cc?.querySelectorAll(".ckbox").length === 2 && !/- \[[ x]\]/.test(cc.textContent));

    // A19:清空的确认是全宽那一档
    const trig = $("trash-empty-ideas");
    trig.scrollIntoView({ block: "end" });
    window.scrollTo(0, document.scrollingElement.scrollHeight); // 翻到面底:「清空…」落在屏底,正是确认条出现的地方
    await sleep(300);
    clearBar();
    click($("trash-empty-tasks")); // 面底那枚(任务段在下)
    const bar = $("confirmbar");
    ok("A19 点「清空任务回收站」弹确认", !!(await until(() => !bar.hidden, 2000)));
    const q = $("confirmbar-q").textContent;
    ok("A19 确认句说清是任务那段、几个任务、几张配图", q.startsWith("清空任务回收站?") && q.includes("个任务") && q.includes("张配图") && q.includes("随记那段不动"), q);
    ok("A19 是全宽那一档(heavy)", bar.classList.contains("heavy"));
    const br = bar.getBoundingClientRect();
    const yr = $("confirmbar-yes").getBoundingClientRect();
    const nr = $("confirmbar-no").getBoundingClientRect();
    ok("A19 执行钮全宽", yr.width >= br.width - 40, { yes: yr.width, bar: br.width });
    ok("A19 取消在执行钮下面、拉开", nr.top >= yr.bottom + 4, { yesBottom: yr.bottom, noTop: nr.top });
    const tr = $("trash-empty-tasks").getBoundingClientRect();
    ok("A19 执行钮不落在「清空…」的原落点上", yr.bottom <= tr.top || yr.top >= tr.bottom, { yes: [yr.top, yr.bottom], trig: [tr.top, tr.bottom] });
    const cx = tr.left + tr.width / 2;
    const cy = tr.top + tr.height / 2;
    const hitTrig = document.elementFromPoint(cx, cy);
    ok("A19 原落点上命中的不是执行钮", !$("confirmbar-yes").contains(hitTrig), hitTrig?.outerHTML?.slice(0, 60));
    click($("confirmbar-no"));
    await until(() => bar.hidden, 2000);
    ok("A19 收起后 heavy 摘掉、位移清零", !bar.classList.contains("heavy") && bar.style.transform === "");

    // A7 + 别的确认照旧普通形
    clearBar();
    const c1 = trashCard(ids.one);
    c1.scrollIntoView({ block: "center" });
    click(c1.querySelector(".body"));
    const pb = await until(() => trashCard(ids.one)?.querySelector('[data-trash-act="purge"]'), 2000);
    click(pb);
    await until(() => !bar.hidden, 2000);
    ok("A19 彻底删除一条的确认是普通形(不全宽)", !bar.classList.contains("heavy"));
    click($("confirmbar-yes"));
    // 165 / W5 Q15 起回执写出删的是哪条:「已彻底删除「…」」(整条没字才照旧那一句)
    ok("A7 彻底删除给回执「已彻底删除「…」」", !!(await until(() => !$("error").hidden && $("error").textContent.startsWith("已彻底删除「"), 4000)), $("error").textContent);
    ok("A7 …库里真没了", !(await inv("list_trash")).some((x) => x.id === ids.one));

    // A18:提示条在场时点顶栏「搜索」那一点
    const er = $("error").getBoundingClientRect();
    const hr = document.querySelector("body > header").getBoundingClientRect();
    ok("A18 提示条在顶栏下沿之下", !$("error").hidden && er.top >= hr.bottom - 0.5, { bar: er.top, head: hr.bottom });
    const st = $("search-toggle").getBoundingClientRect();
    const hitS = document.elementFromPoint(st.left + st.width / 2, st.top + st.height / 2);
    ok("A18 提示条在场时点「搜索」命中「搜索」钮", $("search-toggle").contains(hitS), hitS?.outerHTML?.slice(0, 60));
    const sc = $("space-chip");
    if (!sc.hidden) {
      const scr = sc.getBoundingClientRect();
      ok("A18 …点空间名命中空间名", sc.contains(document.elementFromPoint(scr.left + scr.width / 2, scr.top + scr.height / 2)));
    }

    // A17:还原一条不跳回顶部;离开再回来回到原处
    clearBar();
    const cb = trashCard(ids.back);
    cb.scrollIntoView({ block: "center" });
    await sleep(300);
    const y0 = window.scrollY;
    ok("A17 前置:滚到了中段", y0 > 200, y0);
    click(cb.querySelector(".body"));
    click(await until(() => trashCard(ids.back)?.querySelector('[data-trash-act="restore"]'), 2000));
    await until(() => !trashCard(ids.back), 5000);
    await sleep(400);
    ok("A17 还原后不跳回顶部", Math.abs(window.scrollY - y0) < 120, { y0, y: window.scrollY });
    const y1 = window.scrollY;
    click(navMode("ideas"));
    await until(() => !document.body.classList.contains("pane-open"), 2000);
    click(navPane("trash"));
    await until(() => !$("trash-pane").hidden, 2000);
    await sleep(800);
    ok("A17 离开回收站再回来回到原处", Math.abs(window.scrollY - y1) < 4, { y1, y: window.scrollY });

    // Q1:清空随记那段 / 任务那段(只在回收站里只有本趟种子时真清)
    if (trashWasEmpty) {
      clearBar();
      window.scrollTo(0, 0);
      click($("trash-empty-ideas"));
      await until(() => !bar.hidden, 2000);
      const qi = $("confirmbar-q").textContent;
      ok("Q1 清空随记的确认句:随记那段、几条、几张配图", qi.startsWith("清空随记回收站?") && /\d+ 条和 1 张配图/.test(qi) && qi.includes("任务那段不动"), qi);
      click($("confirmbar-yes"));
      ok("Q1 回执「随记回收站已清空」", !!(await until(() => $("error").textContent === "随记回收站已清空", 5000)), $("error").textContent);
      await until(() => !sec("ideas")?.querySelector("[data-trash], [data-trash-img]"), 5000);
      ok("Q1 清完随记段空了(写「没有删掉的随记。」)", sec("ideas")?.querySelector(".tl-empty")?.textContent === "没有删掉的随记。");
      ok("Q1 任务段的种子还在", inSec("tasks", ids.task));
      const left = await inv("list_trash");
      ok("Q1 库里:随记一条不剩、任务还在", !left.some((x) => ids.notes.includes(x.id)) && left.some((x) => x.id === ids.task));
      const imgs = await inv("list_removed_images", { scope: "all" });
      ok("Q1 库里:随记宿主的已删图没了、任务宿主的还在", !imgs.some((g) => g.item_id === ids.liveNote) && imgs.some((g) => g.item_id === ids.liveTask));
      clearBar();
      click($("trash-empty-tasks"));
      await until(() => !bar.hidden, 2000);
      ok("Q1 清空任务的确认句", $("confirmbar-q").textContent.startsWith("清空任务回收站?这一段的 1 个任务和 1 张配图"), $("confirmbar-q").textContent);
      click($("confirmbar-yes"));
      ok("Q1 回执「任务回收站已清空」", !!(await until(() => $("error").textContent === "任务回收站已清空", 5000)));
      ok("Q1 两段都清完 = 「回收站是空的。」", !!(await until(() => $("trash-list").textContent.includes("回收站是空的。"), 4000)));
      ok("Q2 清空后底栏「回收站」仍在", !navPane("trash").hidden);
    } else {
      out.skipped.push(`Q1 真清空两格:开跑前回收站里已有 ${preTrash.length} 条、${preImgs.length} 组已删图(不是本趟种子),不清它们`);
    }

    // Q2 / A23:底栏
    await closePanes();
    ok("Q2 底栏「回收站」「归档」常在", !navPane("trash").hidden && !navPane("sealed").hidden);
    ok("Q2 分隔线常在", !$("nav-sep").hidden);
    const hasDoc = (await inv("list_timeline")).some((i) => i.kind === "doc");
    ok("Q2 「长文」只在有长文时在", navPane("docs").hidden === !hasDoc, { hasDoc, hidden: navPane("docs").hidden });
    const us = (el) => getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect;
    ok("A23 底栏钮的字不可选", us(navMode("ideas")) === "none" && us(navPane("trash")) === "none", us(navMode("ideas")));
    ok("A23 顶栏钮的字不可选", us($("search-toggle")) === "none");

    // ================= 搜索(只验卡片正文渲染那块) =================
    clearBar();
    // 回收站里的长文(放在清空之后种,免得被那两格清掉)
    ids.trashDoc = await inv("capture_doc", { content: `# ${M}-回收长文\n\n正文。` });
    ids.notes.push(ids.trashDoc);
    await inv("archive_note", { id: ids.trashDoc });
    $("search-toggle").click();
    await until(() => !$("search-pane").hidden, 2000);
    $("search-input").value = M;
    click($("search-btn"));
    await until(() => $("search-results").querySelector(`[data-hit="${ids.liveLong}"]`), 6000);
    const hl = $("search-results").querySelector(`[data-hit="${ids.liveLong}"]`);
    ok("A16 搜索结果长条夹住、长「展开」", !!hl?.querySelector(".content.clamped") && !!hl.querySelector(".fold-toggle"));
    const hd = $("search-results").querySelector(`[data-hit="${ids.liveDoc}"]`);
    ok("A16 搜索结果长文画成题目、不露「#」", hd?.querySelector(".doc-title")?.textContent === `${M}-活长文` && !hd.querySelector(".body").textContent.includes("#"));
    // 回收站里的长文:要命中带上 trash_kind(core 那半)才认得出;命令面还没透出它的构建上照随记画,记 skipped
    const rawHits = await inv("search_notes", { query: M });
    const tdHit = rawHits.find((h) => h.id === ids.trashDoc);
    const ht = $("search-results").querySelector(`[data-hit="${ids.trashDoc}"]`);
    if (tdHit && tdHit.trash_kind !== undefined) {
      ok("A16 搜索结果里回收站的长文也画成题目、不露「#」", ht?.querySelector(".doc-title")?.textContent === `${M}-回收长文` && !ht.querySelector(".body").textContent.includes("#"));
    } else {
      out.skipped.push("A16 回收站长文的搜索卡:命令面没透出 trash_kind,照随记画(core 那半落地后这格才判)");
    }
    const hc = $("search-results").querySelector(`[data-hit="${ids.liveCk}"]`);
    ok("A16 搜索结果清单画成方框", hc?.querySelectorAll(".ckbox").length === 2 && !/- \[[ x]\]/.test(hc.textContent));
    const paneBefore = $("search-pane").hidden;
    click(hl.querySelector(".fold-toggle"));
    await sleep(200);
    ok("A16 搜索里点「展开」只翻折叠、不跳走", !paneBefore && !$("search-pane").hidden && !hl.querySelector(".content").classList.contains("clamped"));

    // ================= 标签页 =================
    await closePanes();
    $("topics-toggle").click();
    await until(() => !$("topics-pane").hidden, 2000);
    const trow = (id) => $("topics-list").querySelector(`.trow[data-topic="${id}"]`);
    await until(() => trow(ids.tFold), 6000);
    // Q12 计数
    const tree = await inv("list_topics_full");
    const tasks = await inv("list_tasks");
    const fold = tree.find((x) => x.id === ids.tFold);
    const nTasksFold = tasks.filter((x) => x.topics.some((tp) => tp.id === ids.tFold)).length;
    ok("Q12 计数写「N 条随记 · M 个任务」且与库对得上", trow(ids.tFold).querySelector(".tcount").textContent.replace(/\s/g, "") === `${fold.notes.length}条随记·${nTasksFold}个任务`, trow(ids.tFold).querySelector(".tcount").textContent);
    ok("Q12 页尾说明:点名字改名删除、点色点改颜色", $("topics-pane").querySelector("p.fine").textContent.includes("点名字改名、删除") && $("topics-pane").querySelector("p.fine").textContent.includes("点色点改颜色"));
    // A16 标签页展开
    click(trow(ids.tFold).querySelector(".tcount"));
    const tb = await until(() => $("topics-list").querySelector(`.tbody[data-body="${ids.tFold}"]`), 2000);
    ok("A16 标签页展开里随记那行清单画成方框", tb?.querySelectorAll(".tb-sec:first-child .ckbox").length === 2);
    const taskRow = [...(tb?.querySelectorAll(".tb-item") ?? [])].find((r) => r.textContent.includes(`${M}-活任务`));
    ok("A16 标签页展开里任务那行清单也画成方框", taskRow?.querySelectorAll(".ckbox").length === 2, taskRow?.textContent);
    ok("A16 标签页展开里不露「- [ ]」「- [x]」", !!tb && !/- \[[ x]\]/.test(tb.textContent));
    click(trow(ids.tFold).querySelector(".tcount"));
    // WM-22 超长名字折行
    const ln2 = trow(ids.tLong).querySelector(".tname");
    ok("Q12 超长标签名折行显示全名(不截断)", ln2.scrollWidth <= ln2.clientWidth + 1 && ln2.getBoundingClientRect().height > 30 && getComputedStyle(ln2).whiteSpace !== "nowrap", { h: ln2.getBoundingClientRect().height });
    // WM-31 改色留名
    click(trow(ids.tKeep).querySelector(".tcolor"));
    ok("Q12 改色时色板那行留着标签名", (await until(() => trow(ids.tKeep)?.querySelector(".tc-name"), 2000))?.textContent === `${M}留`);
    click(trow(ids.tKeep).querySelector("[data-color-cancel]"));
    // WM-30 类型说明
    click(trow(ids.tKeep).querySelector(".tname"));
    const kindAdd = await until(() => trow(ids.tKeep)?.querySelector(".tk-add"), 2000);
    click(kindAdd);
    ok("Q12 类型框下一行说明", !!(await until(() => $("topics-list").querySelector(".tk-hint")?.textContent.includes("类型是给标签归一类"), 2000)));
    $("topics-list").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !$("topics-list").querySelector(".tk-input"), 2000);

    // A13:新建重名 / 空名 / 成功
    clearBar();
    click($("topics-new"));
    const inp = await until(() => $("topics-list").querySelector("[data-create-row] .tn-input"), 2000);
    const type = (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type(inp, `${M}留`);
    click($("topics-list").querySelector("[data-create-save]"));
    const err1 = await until(() => $("topics-list").querySelector("[data-create-row] .tn-err"), 4000);
    ok("A13 新建重名:框下红字说已存在", err1?.textContent === `标签「${M}留」已存在`, err1?.textContent);
    ok("A13 …红字不带「出错:」", !!err1 && !err1.textContent.includes("出错"));
    ok("A13 …打的字还在框里", $("topics-list").querySelector("[data-create-row] .tn-input")?.value === `${M}留`);
    ok("A13 …顶部没弹错误条", $("error").hidden);
    type($("topics-list").querySelector("[data-create-row] .tn-input"), "x");
    ok("A13 一动笔红字就收", !$("topics-list").querySelector(".tn-err"));
    type($("topics-list").querySelector("[data-create-row] .tn-input"), "   ");
    click($("topics-list").querySelector("[data-create-save]"));
    ok("A13 空名点「建」说「标签名不能为空」", (await until(() => $("topics-list").querySelector("[data-create-row] .tn-err"), 2000))?.textContent === "标签名不能为空");
    ok("A13 …框还在、焦点在框里", document.activeElement === $("topics-list").querySelector("[data-create-row] .tn-input"));
    type($("topics-list").querySelector("[data-create-row] .tn-input"), `${M}新`);
    window.scrollTo(0, 0);
    click($("topics-list").querySelector("[data-create-save]"));
    ok("A13 成功:回执「已建标签」", !!(await until(() => !$("error").hidden && $("error").textContent === "已建标签", 4000)));
    const created = (await inv("list_topics_full")).find((x) => x.title === `${M}新`);
    if (created) ids.topics.push(created.id);
    const newRow = await until(() => created && trow(created.id), 2000);
    ok("Q12 新建的那枚闪一下", !!newRow?.classList.contains("flash"));
    await sleep(900); // 平滑滚动
    const nrr = newRow?.getBoundingClientRect();
    ok("Q12 新建的那枚滚到眼前", !!nrr && nrr.top >= 0 && nrr.bottom <= window.innerHeight, nrr && { top: nrr.top, bottom: nrr.bottom });
    ok("A13 成功后新建行收起", !$("topics-list").querySelector("[data-create-row]"));
    // A13:改名重名
    clearBar();
    click(trow(created.id).querySelector(".tname"));
    const rin = await until(() => trow(created.id)?.querySelector(".tn-input"), 2000);
    type(rin, `${M}留`);
    click(trow(created.id).querySelector("[data-rename-save]"));
    const err2 = await until(() => trow(created.id)?.querySelector(".tn-err"), 4000);
    ok("A13 改名重名:框下红字、留在改名态", err2?.textContent === `标签「${M}留」已存在`, err2?.textContent);
    ok("A13 …框里是刚打的字(没退回原名)", trow(created.id)?.querySelector(".tn-input")?.value === `${M}留`);
    ok("A13 …顶部没弹错误条", $("error").hidden);
    click(trow(created.id).querySelector("[data-rename-cancel]"));
    await until(() => !trow(created.id)?.querySelector(".tn-input"), 2000);
    ok("A13 取消后红字收、名字没变", !$("topics-list").querySelector(".tn-err") && trow(created.id).querySelector(".tname").textContent === `${M}新`);

    // Q5:合并先点要留下的
    clearBar();
    click($("topics-merge"));
    await until(() => $("topics-list").querySelector(".mhint"), 2000);
    ok("Q5 合并态提示「先点要留下的标签」", $("topics-list").querySelector(".mhint-txt").textContent === "先点要留下的标签");
    click(trow(ids.tKeep));
    await until(() => trow(ids.tKeep)?.classList.contains("mkeep"), 2000);
    ok("Q5 第一击:那枚高亮(要留下的)", trow(ids.tKeep).classList.contains("mkeep") && getComputedStyle(trow(ids.tKeep)).outlineStyle === "solid");
    ok("Q5 提示换成「把谁并进「X」?」", $("topics-list").querySelector(".mhint-txt").textContent === `把谁并进「${M}留」?点要并进来的标签`);
    click(trow(ids.tFold));
    await until(() => !bar.hidden, 2000);
    ok("Q5 确认句:把后点的并入先点的", $("confirmbar-q").textContent.startsWith(`把「${M}并」并入「${M}留」?`), $("confirmbar-q").textContent);
    click($("confirmbar-yes"));
    await until(() => !$("error").hidden && $("error").textContent === "已合并", 4000);
    const after = await inv("list_topics_full");
    ok("Q5 落库:后点的那枚没了、先点的那枚还在", !after.some((x) => x.id === ids.tFold) && after.some((x) => x.id === ids.tKeep));
    const ckRow = (await inv("list_timeline")).find((x) => x.id === ids.liveCk);
    ok("Q5 落库:挂载转到留下的那枚", !!ckRow && ckRow.topics.some((tp) => tp.id === ids.tKeep));
  } catch (e) {
    ok("没抛异常", false, String(e && e.stack ? e.stack : e));
  } finally {
    clearBar();
    if (!$("confirmbar").hidden) click($("confirmbar-no"));
    if (!$("viewer").hidden) click($("viewer"));
    await closePanes();
    for (const id of [...ids.notes, ...ids.tasks]) {
      for (const c of ["archive_task", "purge_task", "archive_note", "purge_note"]) {
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
    const tl = await inv("list_timeline");
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes(M)));
    ok("清场:回收站没有种子", !(await inv("list_trash")).some((x) => String(x.content).includes(M)));
    ok("清场:已删配图里没有种子的宿主", !(await inv("list_removed_images", { scope: "all" })).some((g) => String(g.content).includes(M)));
    ok("清场:标签没有种子", !(await inv("list_topics_full")).some((x) => String(x.title).includes(M)));
    window.scrollTo(0, 0);
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
