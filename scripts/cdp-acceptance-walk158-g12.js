// @cdp-run phase timeout=150000
// ⚠ 前置(905 定性):从**刚拉起、还没被真点过**的 app 上跑(`am force-stop` → monkey 拉起 → forward)。前面别的资产真点过屏之后 WebView 有系统焦点,
//   页内 `focus()` 会弹出真键盘 ⇒ 过滤框 ×、列内拖那几格连着红(不是产品红)。
// 158 G1 + G2(W2 走查用户全取的那批确定毛病)手机那半的页内可断言部分。两趟:
//   第一趟(phase 空)直调命令播种,回 `{needReload:true}`;驱动者 `eval 'location.reload()'` 后跑第二趟才验,
//   末尾把种子全部 purge、删标签(回收站 / 归档册零残留)。
// 第二趟验:
//  A3  「状态 ▾」换列:回执「已移到「X」」+「撤销」,那张卡的操作面收起;点撤销回到出发那列;
//  A5  撤销条读秒到点进余温态后,「撤销」钮不灰、点了照旧撤回;
//  A6 / A20 取消归档:回执带「撤销」(操作型回执、过了 3 s 仍满亮),点撤销 = 再归档回去;
//  A7 / A20 撤回为随记:回执带「撤销」,点了 = 转回待办且截止 / 优先级原样设回;
//  A9  点靠屏下方的卡:操作面(及「更多…」子面)展开后下沿在底栏之上;
//  A10 点提醒时间框框身 = 调 showPicker(系统选择器本身只能真机看,见原生半截);截止那一格不再是日期框
//      (应用评审取舍题 R2:换成一枚钮 + 应用自己的月历层)⇒ 这里只核「点那枚钮月历层开、取消即收、不弹系统选择器」,月历层本身归 picks-r;
//  A13 选中一枚标签再点开过滤框:标签行变窄后选中那枚仍整枚在行内;
//  A16 空着点「记下」说一声;滚到中段新建,保存后不拉回顶部、回执带「去看看」;
//  A19 「清空回收站」挪到面底、不通栏;编辑层「取消」的确认条左钮叫「接着改」(别的确认条照旧「取消」);
//      键盘收着时点过滤框的 × = 清字且不聚焦(不弹键盘)。
// 前置:界面语言中文;没开任何面板;竖屏(视口 < 720 宽,看板形不在此列)。
// 原生半截(每轮真机发,截图进 .zjshots/158-g12/phone/):
//   点设置 → 截止提醒的时间框中部 → 弹系统时间选择器;过滤框真打字后按返回收键盘、再真点 × → `mInputShown=false`;
//   点靠屏底的卡 → 截图看动作排在底栏之上。
// 阴性对照:把 ui.ts retireBar 里置灰那句加回去,A5 红在「余温里撤销钮没灰」;把 cardpanel 状态那支的
//   `setState(null)` 换回 `setMode(session, "actions")`,A3 红在「操作面收起」。
(async () => {
  const PHASE_KEY = "zj.w158g12.phase";
  const M = "W158G12";
  const out = { pass: false, steps: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra === undefined ? {} : { extra }) });
    return !!cond;
  };
  const I = window.__TAURI_INTERNALS__;
  const inv = (c, a) => I.invoke(c, { spaceId: "main", ...a });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const $ = (id) => document.getElementById(id);
  const card = (m) => [...document.querySelectorAll("#timeline article.card[data-id]")].find((c) => c.textContent.includes(m));
  const cardById = (id) => document.querySelector(`#timeline article.card[data-id="${id}"]`);
  const pact = (el, a) => el?.querySelector(`.panel [data-pact="${a}"]`) ?? null;
  const live = async () => await inv("list_timeline", {});
  const row = async (id) => (await live()).find((x) => x.id === id);
  const barActs = () => [...document.querySelectorAll("#error:not([hidden]) .bar-act")];
  const clearBar = () => {
    $("error").hidden = true;
    $("error").classList.remove("retiring");
  };
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  if (document.documentElement.lang !== "zh") {
    ok("前置:界面语言是中文", false, { htmlLang: document.documentElement.lang });
    return JSON.stringify(out);
  }
  const phase = localStorage.getItem(PHASE_KEY);
  if (!phase) {
    const ids = { fill: [] };
    ids.topic = await inv("create_topic", { title: "G12签" }); // 短名:真实标签多是两三个字,长名的 pill 比 142 宽的行还宽
    ids.st = await inv("create_task", { title: `${M}-换列`, dueOn: null, priority: null, topicId: ids.topic });
    ids.rv = await inv("create_task", { title: `${M}-撤回`, dueOn: today, priority: 3, topicId: null });
    ids.sl = await inv("create_task", { title: `${M}-归档`, dueOn: null, priority: null, topicId: null });
    await inv("update_task_status", { id: ids.sl, to: "done" });
    await inv("seal_task", { id: ids.sl });
    // 填充:让「待办」那节够长,A9 才挑得到一张能摆到屏底的卡(新建落列首 ⇒ 填充在上、上面三张在下)
    for (let i = 1; i <= 14; i++) ids.fill.push(await inv("create_task", { title: `${M}-填充${i}`, dueOn: null, priority: null, topicId: null }));
    localStorage.setItem(PHASE_KEY, JSON.stringify(ids));
    return JSON.stringify({ needReload: true });
  }
  const ids = JSON.parse(phase);
  const made = []; // 本趟 UI 新建的(A16)
  try {
    click(document.querySelector('#bottombar [data-mode="tasks"]'));
    if (!ok("前置:种子在任务面上", !!(await until(() => card(`${M}-换列`) && card(`${M}-填充14`), 8000)))) return JSON.stringify(out);
    ok("前置:竖屏(不是看板)", !document.body.classList.contains("board"));
    clearBar();

    // ---- A3:状态 ▾ 换列 ----
    const openPanel = async (el) => {
      el.scrollIntoView({ block: "center" });
      await sleep(150);
      if (!el.querySelector(".panel")) click(el.querySelector(".body"));
      return until(() => pact(cardById(el.dataset.id), "more"), 3000);
    };
    await openPanel(card(`${M}-换列`));
    click(pact(cardById(ids.st), "status"));
    const toDoing = await until(() => cardById(ids.st)?.querySelector('.panel [data-status="doing"]'), 2000);
    click(toDoing);
    ok("A3 换列后出回执「已移到「进行中」」", !!(await until(() => !$("error").hidden && $("error").textContent.includes("已移到「进行中」"), 4000)), $("error").textContent);
    ok("A3 回执带「撤销」", barActs().length >= 1 && barActs()[0].textContent === "撤销"); // 158 G3 起卡落到屏外时另挂「去看看」
    ok("A3 库里已在进行中", (await row(ids.st))?.stage === "doing");
    await until(() => cardById(ids.st), 3000);
    await sleep(300);
    ok("A3 那张卡的操作面收起", !document.querySelector("#timeline .panel"));
    click(barActs()[0]);
    ok("A3 撤销 = 回到待办", !!(await until(() => false, 1500), (await row(ids.st))?.stage === "todo"));
    // 165 / W5 Q6 起撤成了说一声:那条换成「已撤销」(不带钮),不再是一声不吭地收起
    ok("A3 点撤销后条换成「已撤销」", !!(await until(() => !$("error").hidden && $("error").textContent === "已撤销" && barActs().length === 0, 3000)), $("error").textContent);

    // ---- A5:余温里撤销照旧生效 ----
    await until(() => cardById(ids.st), 3000);
    await openPanel(cardById(ids.st));
    click(pact(cardById(ids.st), "status"));
    click(await until(() => cardById(ids.st)?.querySelector('.panel [data-status="doing"]'), 2000));
    ok("A5 再换一次列,回执出来", !!(await until(() => barActs().length >= 1, 4000)));
    ok("A5 读秒到点进余温态", !!(await until(() => $("error").classList.contains("retiring"), 8000)));
    const act5 = barActs()[0];
    ok("A5 余温里撤销钮没灰", !!act5 && !act5.disabled);
    const r5 = act5.getBoundingClientRect();
    const hit5 = document.elementFromPoint(r5.left + r5.width / 2, r5.top + r5.height / 2);
    ok("A5 余温里点撤销的位置落在撤销钮上", !!hit5 && act5.contains(hit5), hit5?.outerHTML?.slice(0, 60));
    click(act5);
    ok("A5 余温里点撤销 = 撤回了", !!(await until(() => false, 1500), (await row(ids.st))?.stage === "todo"));

    // ---- A7 / A20:撤回为随记 ----
    clearBar();
    await until(() => cardById(ids.rv), 3000);
    await openPanel(cardById(ids.rv));
    click(pact(cardById(ids.rv), "more"));
    click(await until(() => pact(cardById(ids.rv), "revert"), 2000));
    ok("A7 撤回确认条", !!(await until(() => !$("confirmbar").hidden, 2000)));
    ok("A19 别的确认条左钮照旧叫「取消」", $("confirmbar-no").textContent === "取消", $("confirmbar-no").textContent);
    click($("confirmbar-yes"));
    // 165 / W5:回执不再写「在底栏「随记」里」,去向交给另挂的「去看看」⇒ 两枚钮:撤销 + 去看看
    ok("A7 回执「已撤回为随记」带「撤销」「去看看」", !!(await until(() => barActs().map((b) => b.textContent).join() === "撤销,去看看" && $("error").textContent.includes("已撤回为随记") && !$("error").textContent.includes("底栏"), 4000)), $("error").textContent);
    ok("A20 撤回回执是操作型(6 s 那档)", $("error").classList.contains("with-act"));
    const rv0 = await row(ids.rv);
    ok("A7 库里已是随记、截止优先级清了", !!rv0 && rv0.stage !== "todo" && rv0.due_on === null && rv0.priority === null, rv0 && { stage: rv0.stage, due: rv0.due_on, p: rv0.priority });
    await sleep(3200);
    ok("A20 3.2 s 后撤回回执仍在且满亮", !$("error").hidden && !$("error").classList.contains("retiring"));
    click(barActs()[0]);
    await until(() => false, 1800);
    const rv1 = await row(ids.rv);
    ok("A7 撤销 = 回到待办,截止 / 优先级原样设回", !!rv1 && rv1.stage === "todo" && rv1.due_on === today && rv1.priority === 3, rv1 && { stage: rv1.stage, due: rv1.due_on, p: rv1.priority });

    // ---- A6 / A20:取消归档 ----
    clearBar();
    click(document.querySelector('#bottombar [data-pane="sealed"]'));
    const sealedCard = await until(() => document.querySelector(`#sealed-list [data-sealed="${ids.sl}"]`), 5000);
    ok("A6 归档册里有种子", !!sealedCard);
    if (sealedCard) {
      click(sealedCard);
      const ub = await until(() => document.querySelector(`#sealed-list [data-unseal="${ids.sl}"]`), 2000);
      click(ub);
      ok("A6 取消归档回执带「撤销」", !!(await until(() => barActs()[0]?.textContent === "撤销" && $("error").textContent.includes("已取消归档"), 4000)), $("error").textContent);
      ok("A6 取消归档 = 回到已完成", (await row(ids.sl))?.stage === "done");
      await sleep(3300);
      ok("A20 3.3 s 后取消归档回执仍满亮(此前 3 s 就淡)", !$("error").hidden && !$("error").classList.contains("retiring"));
      click(barActs()[0]);
      ok("A6 撤销 = 再归档回去", !!(await until(() => document.querySelector(`#sealed-list [data-sealed="${ids.sl}"]`), 4000)));
      ok("A6 …库里也归档了", (await inv("list_sealed_tasks", {})).some((x) => x.id === ids.sl));
    }

    // ---- A19:清空回收站挪到面底 ----
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    await until(() => !$("trash-pane").hidden, 3000);
    // 159(W3 Q1)起回收站分「随记」「任务」两段、各自末尾一枚「清空…」(此前一枚 `#trash-empty` 在面底)。
    // 这里仍只断 158 那条「不常驻列表最上面、不通栏」;两段与全宽确认归 cdp-acceptance-walk159-m1.js。
    // ⚠ 别等 `p.empty`:「读取中…」那行也是 `p.muted.empty`,等它 = 列表还没到就判「回收站是空的」(159 复跑撞到)。
    await until(() => $("trash-list").querySelector(".trash-sec") || $("trash-list").textContent.includes("回收站是空的"), 4000);
    const tes = [...$("trash-list").querySelectorAll("[data-trash-empty]")];
    if (tes.length === 0) {
      out.skipped = [...(out.skipped ?? []), "A19 清空钮:回收站是空的,两段都没有「清空…」"];
    } else {
      for (const te of tes) {
        const sec = te.closest(".trash-sec");
        const first = sec.querySelector("[data-trash], [data-trash-img]");
        ok(`A19 「${te.textContent}」在那一段的内容之后`, !!first && !!(first.compareDocumentPosition(te) & Node.DOCUMENT_POSITION_FOLLOWING));
        ok(`A19 「${te.textContent}」不通栏`, te.getBoundingClientRect().width < $("trash-pane").getBoundingClientRect().width * 0.7, { w: te.getBoundingClientRect().width, pane: $("trash-pane").getBoundingClientRect().width });
      }
    }
    click(document.querySelector('#bottombar [data-mode="tasks"]'));
    await until(() => !document.body.classList.contains("pane-open") && card(`${M}-换列`), 4000);

    // ---- A9:点靠屏下方的卡 ----
    clearBar();
    const nav = $("bottombar").getBoundingClientRect();
    const c9 = card(`${M}-填充7`);
    window.scrollBy(0, c9.getBoundingClientRect().top - (nav.top - 70));
    await sleep(200);
    const top9 = card(`${M}-填充7`).getBoundingClientRect().top;
    ok("A9 前置:卡摆到了底栏上沿往上 70 处", Math.abs(top9 - (nav.top - 70)) < 3, { top9, navTop: nav.top });
    const y0 = window.scrollY;
    click(card(`${M}-填充7`).querySelector(".body"));
    const p9 = await until(() => card(`${M}-填充7`)?.querySelector(".panel"), 2000);
    await sleep(100);
    ok("A9 操作面展开后页面跟着滚了", window.scrollY > y0, { y0, y1: window.scrollY });
    ok("A9 操作面下沿在底栏之上", !!p9 && p9.getBoundingClientRect().bottom <= $("bottombar").getBoundingClientRect().top, { pb: p9?.getBoundingClientRect().bottom, nav: $("bottombar").getBoundingClientRect().top });
    click(pact(card(`${M}-填充7`), "more"));
    const p9b = await until(() => pact(card(`${M}-填充7`), "del") && card(`${M}-填充7`).querySelector(".panel"), 2000);
    await sleep(100);
    ok("A9 「更多…」子面下沿也在底栏之上", !!p9b && p9b.getBoundingClientRect().bottom <= $("bottombar").getBoundingClientRect().top);

    // ---- A10:截止那枚钮开月历层(不弹系统选择器);提醒时间框框身 = showPicker ----
    click(pact(card(`${M}-填充7`), "back"));
    await until(() => pact(card(`${M}-填充7`), "due"), 2000);
    click(pact(card(`${M}-填充7`), "due"));
    const dateBtn = await until(() => card(`${M}-填充7`)?.querySelector('.panel [data-pact="due-pick"]'), 2000);
    let picked = 0;
    const orig = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      picked++;
    };
    try {
      click(dateBtn);
      const sheetOpen = await until(() => $("date-sheet").classList.contains("open"), 2000);
      ok("A10 点截止那枚钮开应用自己的月历层、不弹系统选择器", !!sheetOpen && picked === 0 && !card(`${M}-填充7`).querySelector(".panel input[type=date]"), { picked });
      click($("dp-cancel"));
      ok("A10 月历层点「取消」即收", !!(await until(() => !$("date-sheet").classList.contains("open"), 2000)));
      await sleep(300); // 等收层那记 history.back() 归账
      const tin = $("remind-time");
      click(tin);
      ok("A10 点提醒时间框框身弹选择器", picked === 1, { picked });
    } finally {
      HTMLInputElement.prototype.showPicker = orig;
    }
    click(card(`${M}-填充7`).querySelector(".body")); // 收面(值 picker 不是草稿)
    await until(() => !document.querySelector("#timeline .panel"), 2000);
    window.scrollTo(0, 0);
    await sleep(200);

    // ---- A13:标签选中后点开过滤框 ----
    const tagPill = () => document.querySelector(`#filter-topics .fpill[data-topic="${ids.topic}"]`) ?? [...document.querySelectorAll("#filter-topics .fpill")].find((b) => b.textContent.includes("G12签"));
    const tp = await until(tagPill, 3000);
    ok("A13 前置:标签行里有种子标签", !!tp);
    if (tp) {
      click(tp);
      await until(() => tagPill()?.classList.contains("active"), 2000);
      const rowEl = $("filter-topics");
      rowEl.scrollLeft = 0;
      const ft = $("filter-text");
      ft.focus();
      // ⚠ 台架:app 刚由 monkey 拉起、还没被真点过时 WebView 窗口没有系统焦点(`document.hasFocus()` false),
      //   focus() 换得到 activeElement 却不发 focusin ⇒ 框不张开。那时补发一记 focusin(真手势那半见原生半截)。
      if (!document.hasFocus()) ft.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      ok("A13 前置:过滤框张开了", !!(await until(() => ft.classList.contains("wide"), 1000)), { hasFocus: document.hasFocus() });
      await sleep(500); // 0.18 s 张开过渡 + ResizeObserver
      const rr = rowEl.getBoundingClientRect();
      const pr = tagPill().getBoundingClientRect();
      ok("A13 过滤框张开后选中那枚整枚在标签行里", pr.left >= rr.left - 1 && pr.right <= rr.right + 1, { row: [rr.left, rr.right], pill: [pr.left, pr.right], wide: ft.classList.contains("wide") });
      // ---- A19:打完字收了键盘(框仍握着焦点,× 只在有焦点时画)再点 × = 清字且放掉焦点 ----
      ft.value = "zz";
      ft.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      ok("A19 前置:框握着焦点、键盘收着(页内无真键盘)", document.activeElement === ft && !document.documentElement.classList.contains("kb-up"));
      const fr = ft.getBoundingClientRect();
      const pd = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: fr.right - 8, clientY: fr.top + fr.height / 2, pointerType: "touch" });
      ft.dispatchEvent(pd);
      ok("A19 点 × 清了字", ft.value === "");
      ok("A19 点 × 拦了默认动作并放掉焦点(不弹键盘)", pd.defaultPrevented && document.activeElement !== ft);
      await sleep(300);
      ok("A19 清字后列表照常回来", !!(await until(() => card(`${M}-换列`), 2000)));
      click(tagPill()); // 取消标签筛选
      await until(() => !tagPill()?.classList.contains("active"), 2000);
    }

    // ---- A19:编辑层取消确认条 ----
    window.scrollTo(0, 0);
    await sleep(200);
    await openPanel(card(`${M}-填充1`));
    click(pact(card(`${M}-填充1`), "edit"));
    ok("A19 开编辑层", !!(await until(() => !$("edit-scrim").hidden, 3000)));
    const et = $("edit-text");
    et.value = `${M}-填充1 改`;
    et.dispatchEvent(new Event("input", { bubbles: true }));
    click($("edit-cancel"));
    ok("A19 改过了点取消先问", !!(await until(() => !$("confirmbar").hidden, 2000)));
    ok("A19 确认条左钮叫「接着改」", $("confirmbar-no").textContent === "接着改", $("confirmbar-no").textContent);
    click($("confirmbar-no"));
    ok("A19 点「接着改」= 层还开着、字还在", !$("edit-scrim").hidden && et.value === `${M}-填充1 改`);
    click($("edit-cancel"));
    await until(() => !$("confirmbar").hidden, 2000);
    click($("confirmbar-yes"));
    ok("A19 丢掉后层收起", !!(await until(() => $("edit-scrim").hidden, 3000)));
    if (card(`${M}-填充1`)?.querySelector(".panel")) click(card(`${M}-填充1`).querySelector(".body"));
    await sleep(300);

    // ---- A16:空提交 / 中段新建 ----
    clearBar();
    click($("capture-fab"));
    await until(() => !$("capture-scrim").hidden, 2000);
    $("text").value = "  ";
    $("text").dispatchEvent(new Event("input", { bubbles: true }));
    click($("save"));
    ok("A16 空着点记下说一声", !!(await until(() => !$("error").hidden && $("error").textContent.includes("还没写字"), 2000)), $("error").textContent);
    ok("A16 …层还开着", !$("capture-scrim").hidden);
    $("text").value = "";
    $("text").dispatchEvent(new Event("input", { bubbles: true }));
    // 收层,滚到中段再新建
    $("capture-scrim").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await until(() => $("capture-scrim").hidden, 2000);
    clearBar();
    const mid = card(`${M}-填充10`);
    mid.scrollIntoView({ block: "start" });
    await sleep(300);
    const yMid = window.scrollY;
    ok("A16 前置:滚到了中段", yMid > 300, { yMid });
    click($("capture-fab"));
    await until(() => !$("capture-scrim").hidden, 2000);
    $("text").value = `${M}-中段新建`;
    $("text").dispatchEvent(new Event("input", { bubbles: true }));
    click($("save"));
    const newCard = await until(() => card(`${M}-中段新建`), 5000);
    if (newCard) made.push(newCard.dataset.id);
    await sleep(500);
    ok("A16 保存后没被拉回顶部", Math.abs(window.scrollY - yMid) < 40, { yMid, y: window.scrollY });
    const go = await until(() => (barActs().length === 1 && barActs()[0].textContent === "去看看" ? barActs()[0] : null), 2000);
    ok("A16 新卡不在屏上时回执「已记下」带「去看看」", !!go && $("error").textContent.includes("已记下"), $("error").textContent);
    if (go) {
      click(go);
      await sleep(1200);
      const nr = card(`${M}-中段新建`)?.getBoundingClientRect();
      ok("A16 点去看看 = 新卡进视野", !!nr && nr.bottom > 0 && nr.top < window.innerHeight, nr && { top: nr.top });
    }
  } catch (e) {
    ok("没抛异常", false, String(e));
  } finally {
    clearBar();
    if (document.body.classList.contains("pane-open")) click(document.querySelector('#bottombar [data-mode="tasks"]'));
    try {
      await inv("unseal_task", { id: ids.sl });
    } catch {}
    for (const id of [ids.st, ids.rv, ids.sl, ...ids.fill, ...made]) {
      for (const c of ["archive_task", "purge_task", "archive_note", "purge_note"]) {
        try {
          await inv(c, { id });
        } catch {}
      }
    }
    try {
      await inv("delete_topic", { id: ids.topic });
    } catch {}
    localStorage.removeItem(PHASE_KEY);
    const tl = await live();
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes(M)));
    ok("清场:归档册没有种子", !(await inv("list_sealed_tasks", {})).some((x) => String(x.title).includes(M)));
    ok("清场:回收站没有种子", !(await inv("list_trash", {})).some((x) => String(x.content).includes(M)));
    window.scrollTo(0, 0);
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
