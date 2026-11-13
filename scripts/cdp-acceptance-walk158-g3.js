// @cdp-run phase timeout=180000
// ⚠ 前置(905 定性):从**刚拉起、还没被真点过**的 app 上跑(`am force-stop` → monkey 拉起 → forward)。前面别的资产真点过屏之后 WebView 有系统焦点,
//   页内 `focus()` 会弹出真键盘 ⇒ 过滤框 ×、列内拖那几格连着红(不是产品红)。
// 158 G3(W2 走查规矩 Q1–Q13,用户全取 ★)手机那半的页内可断言部分。两趟(同 walk158-g12):
//   第一趟(phase 空)直调命令播种,回 `{needReload:true}`;驱动者 `eval 'location.reload()'` 后跑第二趟才验,
//   末尾把种子全部 purge、删标签、还原截止提醒水位(回收站 / 归档册零残留)。
// 第二趟验:
//  Q1  「列 ▾」换到屏外那一节:回执带「撤销」+「去看看」;点「去看看」= 卡进视野且闪一下;
//  Q7  撤销回**原位置**(此前落列尾):换列后撤销,卡回到原列里原来那两张之间;
//      长按拖(页内合成 PointerEvent 驱动 carddrag 的逻辑半;真手势见原生半截):拿起态、落点线、
//      跨列落在指定那张之前、回执 + 撤销回原位;只看到期时长按说一句、不拿起;
//  Q2  已完成卡上的勾点得动 = 回待办(回执「已移到「待办」」+ 撤销);撤销 = 回已完成原位置;
//  Q3  单张归档不问、回执带撤销;「已完成」节头「全部归档」问一次、回执「已归档 N 条」带撤销 + 去看看,撤销 = 全部回来;
//      取消归档回执带「去看看」,点了 = 收归档页、卡进视野;
//  Q4  已完成卡的截止只写 M/D、不带逾期色;Q13 逾期一天写「逾期 1 天」、归档卡写日期;
//  Q5  「列 ▾」那排叫「列」、底下灰字「列在电脑上管理」;状态筛选那排轴标叫「列」;
//  Q8  任务面筛着东西时返回键入口(__zhujianHandleBack)= 清筛选并消费;没筛选时不消费;
//  Q9  竖屏节头带计数;选一枚标签后列 chip 的计数跟着筛;
//  Q10 点通知(zhujian-notif-tap 事件,真通知见原生半截)= 进任务面、只看到期;提醒正文带「3 天内」;
//  Q11 「更多…」里有「复制」,点了回执「已复制这张卡的文字」。
// 前置:界面语言中文;没开任何面板;竖屏(视口 < 720 宽);测试机库里没有别的已完成任务(Q3 全部归档按条数断)。
// 原生半截(每轮真机发,截图进 .zjshots/158-g3/phone/):`adb shell input draganddrop` 长按拖一张卡到屏底边 → 自动滚、
//   落进下一节;看板根上筛着标签按 `keyevent 4` → 筛选清掉、app 仍在前台,再按 → 离开;设置「试一条」→ 下拉通知栏
//   点那条 → 进任务面只看到期。
// 阴性对照:把 taskmove.putBack 换回 update_task_status,Q7 红在「撤销回原位置」;把 carddrag 的 LONG_PRESS_MS 调到
//   5000,Q7 拖拽那几格红在「拿起态」。
(async () => {
  const PHASE_KEY = "zj.w158g3.phase";
  const M = "W158G3";
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
      const v = await fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const $ = (id) => document.getElementById(id);
  const card = (m) => [...document.querySelectorAll("#timeline article.card[data-id]")].find((c) => c.querySelector(".content")?.textContent === m);
  const cardById = (id) => document.querySelector(`#timeline article.card[data-id="${id}"]`);
  const pact = (el, a) => el?.querySelector(`.panel [data-pact="${a}"]`) ?? null;
  const tasks = async () => await inv("list_tasks", {});
  const colIds = async (stage) => (await tasks()).filter((x) => x.status === stage).map((x) => x.id);
  const stageOf = async (id) => (await tasks()).find((x) => x.id === id)?.status ?? null;
  const barActs = () => [...document.querySelectorAll("#error:not([hidden]) .bar-act")];
  const barTexts = () => barActs().map((b) => b.textContent);
  const clearBar = () => {
    $("error").hidden = true;
    $("error").classList.remove("retiring");
  };
  const ymd = (off) => {
    const d = new Date();
    d.setDate(d.getDate() + off);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 120 && r.top < $("bottombar").getBoundingClientRect().top - 20;
  };
  const openPanel = async (el) => {
    el.scrollIntoView({ block: "center" });
    await sleep(150);
    if (!el.querySelector(".panel")) click(el.querySelector(".body"));
    return until(() => pact(cardById(el.dataset.id), "more"), 3000);
  };
  const closePanels = async () => {
    const p = document.querySelector("#timeline .panel");
    if (p) click(p.closest("article.card").querySelector(".body .content"));
    await until(() => !document.querySelector("#timeline .panel"), 2000);
  };

  if (document.documentElement.lang !== "zh") {
    ok("前置:界面语言是中文", false, { htmlLang: document.documentElement.lang });
    return JSON.stringify(out);
  }
  const phase = localStorage.getItem(PHASE_KEY);
  if (!phase) {
    const ids = { fill: [] };
    const mk = (title, dueOn = null, topicId = null) => inv("create_task", { title, dueOn, priority: null, topicId });
    ids.topic = await inv("create_topic", { title: "G3签" });
    // 新建落列首 ⇒ 先建的在下面:丁(待办最底,挨着「进行中」那节)→ 填充 → 丙乙甲(待办最上)
    ids.ding = await mk(`${M}-丁`, null, ids.topic); // 带标签:Q7 跨列拖在「筛着这枚标签」下做(三节各一张、同屏,顺带走筛选下的换算)
    for (let i = 1; i <= 12; i++) ids.fill.push(await mk(`${M}-填充${i}`));
    ids.yest = await mk(`${M}-昨天`, ymd(-1));
    ids.today = await mk(`${M}-今天`, ymd(0));
    ids.soon = await mk(`${M}-后天`, ymd(2));
    ids.bing = await mk(`${M}-丙`);
    ids.yi = await mk(`${M}-乙`);
    ids.jia = await mk(`${M}-甲`);
    ids.doing = await mk(`${M}-进行`, null, ids.topic);
    await inv("update_task_status", { id: ids.doing, to: "doing" });
    ids.done1 = await mk(`${M}-完成一`, ymd(-2), ids.topic);
    ids.done2 = await mk(`${M}-完成二`);
    await inv("update_task_status", { id: ids.done2, to: "done" });
    await inv("update_task_status", { id: ids.done1, to: "done" });
    localStorage.setItem(PHASE_KEY, JSON.stringify(ids));
    return JSON.stringify({ needReload: true });
  }
  const ids = JSON.parse(phase);
  const REMIND_LAST = "zhujian.due-remind.last";
  const remindLast0 = localStorage.getItem(REMIND_LAST);
  try {
    click(document.querySelector('#bottombar [data-mode="tasks"]'));
    if (!ok("前置:种子在任务面上", !!(await until(() => card(`${M}-甲`) && card(`${M}-完成一`), 8000)))) return JSON.stringify(out);
    ok("前置:竖屏(不是看板)", !document.body.classList.contains("board"));
    const doneCount0 = (await colIds("done")).length; // 走查种子可能也有已完成的卡:全部归档按这个数断
    clearBar();

    // ---- Q4 / Q13:截止的写法 ----
    const due = (m) => card(m)?.querySelector(".chip.due");
    const [, dm, dd] = ymd(-2).split("-").map(Number);
    ok("Q4 已完成卡的截止只写日期", due(`${M}-完成一`)?.textContent === `${dm}/${dd}`, due(`${M}-完成一`)?.textContent);
    ok("Q4 …不带逾期色", !due(`${M}-完成一`)?.classList.contains("overdue"));
    ok("Q13 逾期一天写「逾期 1 天」", due(`${M}-昨天`)?.textContent === "逾期 1 天", due(`${M}-昨天`)?.textContent);

    // ---- Q9:节头计数 + chip 计数随筛选 ----
    const secCount = (stage) => document.querySelector(`#timeline > .tl-group[data-col="${stage}"] .tl-count`)?.textContent;
    ok("Q9 竖屏节头带计数(已完成)", secCount("done") === String(doneCount0), secCount("done"));
    ok("Q9 …进行中节头计数", secCount("doing") === String((await colIds("doing")).length), secCount("doing"));
    ok("Q5 列筛选那排轴标叫「列」", document.querySelector("#filter-stages .faxis")?.textContent === "列");
    const chipN = (stage) => document.querySelector(`#filter-stages .fpill[data-stage="${stage}"] .fn`)?.textContent;
    const tagPill = () => [...document.querySelectorAll("#filter-topics .fpill")].find((b) => b.textContent.includes("G3签"));
    const tp = await until(tagPill, 3000);
    ok("Q9 前置:标签行里有种子标签", !!tp);
    const todoAll = chipN("todo");
    click(tp);
    await until(() => tagPill()?.classList.contains("active"), 2000);
    ok("Q9 筛标签后列 chip 计数跟着筛(待办 1 / 进行中 1 / 已完成 1)", chipN("todo") === "1" && chipN("doing") === "1" && chipN("done") === "1", {
      before: todoAll,
      todo: chipN("todo"),
      doing: chipN("doing"),
      done: chipN("done"),
    });

    // ---- Q8:返回键先清筛选 ----
    ok("Q8 筛着标签时返回 = 被消费", window.__zhujianHandleBack() === true);
    ok("Q8 …筛选清掉了", !tagPill()?.classList.contains("active") && chipN("todo") === todoAll);
    ok("Q8 …说了一声", !$("error").hidden && $("error").textContent.includes("再按一次返回离开"), $("error").textContent);
    ok("Q8 没筛选时返回不消费(交给系统离开)", window.__zhujianHandleBack() === false);
    clearBar();

    // ---- Q5 / Q1 / Q7:列 ▾ 换到屏外,撤销回原位 ----
    const todo0 = await colIds("todo");
    const yiAt = todo0.indexOf(ids.yi);
    await openPanel(card(`${M}-乙`));
    click(pact(cardById(ids.yi), "status"));
    await until(() => cardById(ids.yi)?.querySelector('.panel [data-status="doing"]'), 2000);
    const lane = cardById(ids.yi).querySelector(".panel .lane .lab")?.textContent;
    ok("Q5 「列 ▾」那排叫「列」", lane === "列", lane);
    ok("Q5 …底下灰字「列在电脑上管理」", cardById(ids.yi).querySelector(".panel .colhint")?.textContent === "列在电脑上管理");
    ok("Q5 …值 chip 也叫「列」", cardById(ids.yi).querySelector('.panel')?.textContent.includes("列"));
    click(cardById(ids.yi).querySelector('.panel [data-status="doing"]'));
    ok("Q1 换列回执带「撤销」「去看看」(卡落到屏外那节)", !!(await until(() => barTexts().join() === "撤销,去看看", 4000)), barTexts());
    ok("Q7 前置:库里已在进行中且排在列尾", (await colIds("doing")).at(-1) === ids.yi);
    click(barActs()[0]);
    await until(async () => (await stageOf(ids.yi)) === "todo", 3000);
    const todo1 = await colIds("todo");
    ok("Q7 撤销 = 回到待办原位置(此前落列尾)", todo1.indexOf(ids.yi) === yiAt, { was: yiAt, now: todo1.indexOf(ids.yi), len: todo1.length });
    // 再换一次,点「去看看」
    clearBar();
    await until(() => cardById(ids.yi), 3000);
    window.scrollTo(0, 0);
    await sleep(200);
    await openPanel(cardById(ids.yi));
    click(pact(cardById(ids.yi), "status"));
    click(await until(() => cardById(ids.yi)?.querySelector('.panel [data-status="doing"]'), 2000));
    const go = await until(() => barActs().find((b) => b.textContent === "去看看"), 4000);
    ok("Q1 第二次换列同样带「去看看」", !!go);
    if (go) {
      click(go);
      const seen = await until(() => cardById(ids.yi) && inView(cardById(ids.yi)) && cardById(ids.yi).classList.contains("flash"), 3000);
      ok("Q1 点「去看看」= 卡进视野并闪一下", !!seen);
    }
    await inv("reorder_task", { id: ids.yi, fromStatus: "doing", toStatus: "todo", baseTargetIds: await colIds("todo"), orderedIds: todo0 }); // 摆回原位,后面要用
    clearBar();

    // ---- Q2:已完成卡的勾点回待办 ----
    const doneOrd = await colIds("done");
    await until(() => card(`${M}-完成二`), 3000);
    const tick = card(`${M}-完成二`).querySelector(".tick input");
    ok("Q2 已完成卡上的勾不是 disabled", !!tick && tick.checked && !tick.disabled);
    tick.click();
    ok("Q2 点勾 = 回待办,回执「已移到「待办」」带撤销", !!(await until(() => barTexts()[0] === "撤销" && $("error").textContent.includes("已移到「待办」"), 4000)), $("error").textContent);
    ok("Q2 库里已在待办", (await stageOf(ids.done2)) === "todo");
    click(barActs()[0]);
    await until(async () => (await stageOf(ids.done2)) === "done", 3000);
    ok("Q2 撤销 = 回已完成原位置", JSON.stringify(await colIds("done")) === JSON.stringify(doneOrd), { was: doneOrd, now: await colIds("done") });
    clearBar();

    // ---- Q11:复制 ----
    await until(() => card(`${M}-丙`), 3000);
    await openPanel(card(`${M}-丙`));
    click(pact(cardById(ids.bing), "more"));
    const cp = await until(() => pact(cardById(ids.bing), "copy"), 2000);
    ok("Q11 「更多…」里有「复制」", cp?.textContent === "复制");
    if (cp) {
      click(cp);
      ok("Q11 点了回执「已复制这张卡的文字」", !!(await until(() => !$("error").hidden && $("error").textContent === "已复制这张卡的文字", 3000)), $("error").textContent);
    }
    await closePanels();
    clearBar();

    // ---- Q3:单张归档不问 ----
    await until(() => card(`${M}-完成二`), 3000);
    await openPanel(card(`${M}-完成二`));
    click(pact(cardById(ids.done2), "more"));
    click(await until(() => pact(cardById(ids.done2), "seal"), 2000));
    await sleep(300);
    ok("Q3 单张归档不弹确认", $("confirmbar").hidden);
    ok("Q3 …回执「已归档」带撤销", !!(await until(() => barTexts()[0] === "撤销" && $("error").textContent.includes("已归档"), 3000)), $("error").textContent);
    ok("Q3 …库里归档了", (await inv("list_sealed_tasks", {})).some((x) => x.id === ids.done2));
    click(barActs()[0]);
    ok("Q3 撤销 = 回已完成", !!(await until(async () => (await stageOf(ids.done2)) === "done", 3000)));
    clearBar();

    // ---- Q3:全部归档 ----
    await until(() => document.querySelector('#timeline > .tl-group[data-col="done"] .tl-count')?.textContent === String(doneCount0), 3000); // 等轴重画追上库
    const sa = await until(() => document.querySelector('#timeline > .tl-group[data-col="done"] .tl-sec [data-seal-all]'), 3000);
    ok("Q3 「已完成」节头有「全部归档」", sa?.textContent === "全部归档");
    if (sa) {
      click(sa);
      ok("Q3 全部归档问一次(带条数)", !!(await until(() => !$("confirmbar").hidden && $("confirmbar-q").textContent.includes(`${doneCount0} 张`), 2000)), $("confirmbar-q").textContent);
      click($("confirmbar-yes"));
      ok(`Q3 回执「已归档 ${doneCount0} 条」带「撤销」「去看看」`, !!(await until(() => $("error").textContent.includes(`已归档 ${doneCount0} 条`) && barTexts().join() === "撤销,去看看", 4000)), { t: $("error").textContent, a: barTexts() });
      ok("Q3 …已完成那节没了", (await colIds("done")).length === 0);
      click(barActs()[0]);
      ok("Q3 撤销 = 全都回已完成", !!(await until(async () => (await colIds("done")).length === doneCount0, 6000)));
    }
    clearBar();

    // ---- Q3 / Q13:取消归档回执带「去看看」;归档卡写日期 ----
    await inv("seal_task", { id: ids.done1 });
    click(document.querySelector('#bottombar [data-pane="sealed"]'));
    const sc = await until(() => document.querySelector(`#sealed-list [data-sealed="${ids.done1}"]`), 5000);
    ok("Q13 归档页头写「归档」", !!document.querySelector("#sealed-pane h2, #sealed-pane .pane-title") && /归档/.test($("sealed-pane").textContent));
    // 165 / W5 Q14 起两端一个写法:今天的写「今天 HH:MM」、别的天「M月D日 HH:MM」—— 都写明是哪天(此前今天的只写时刻)
    ok("Q13 归档卡写明是哪天(完成于 今天 HH:MM / M月D日 HH:MM)", /完成于 (今天|\d+月\d+日) \d\d:\d\d/.test(sc?.querySelector("time")?.textContent ?? ""), sc?.querySelector("time")?.textContent);
    if (sc) {
      click(sc);
      click(await until(() => document.querySelector(`#sealed-list [data-unseal="${ids.done1}"]`), 2000));
      const g = await until(() => barActs().find((b) => b.textContent === "去看看"), 4000);
      ok("Q3 取消归档回执带「撤销」「去看看」", !!g && barTexts()[0] === "撤销", barTexts());
      if (g) {
        click(g);
        ok("Q3 点「去看看」= 收归档页、卡进视野", !!(await until(() => !document.body.classList.contains("pane-open") && cardById(ids.done1) && inView(cardById(ids.done1)), 4000)));
      }
    }
    clearBar();

    // ---- Q7:长按拖(页内合成 PointerEvent;真手势见原生半截)----
    const pe = (type, el, x, y) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, isPrimary: true, button: 0, pointerType: "touch", clientX: x, clientY: y }));
    const ctr = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
    };
    window.scrollTo(0, 0);
    await sleep(200);
    click(await until(tagPill, 3000)); // 筛「G3签」:待办 [丁] / 进行中 [进行] / 已完成 [完成一],同屏
    await until(() => tagPill()?.classList.contains("active") && cardById(ids.ding) && cardById(ids.doing), 3000);
    await sleep(300);
    const dingEl = cardById(ids.ding);
    ok("Q7 前置:丁与「进行」同屏", inView(dingEl) && inView(cardById(ids.doing)));
    const todoBefore = await colIds("todo");
    const dingAt = todoBefore.indexOf(ids.ding);
    const a = ctr(dingEl);
    pe("pointerdown", dingEl.querySelector(".content"), a.x, a.y);
    await sleep(250);
    ok("Q7 长按未到点:还没拿起", !dingEl.classList.contains("lifted"));
    await sleep(300);
    ok("Q7 长按到点:卡拿起来了", dingEl.classList.contains("lifted"));
    const tgt = ctr(cardById(ids.doing));
    pe("pointermove", document.body, a.x, tgt.top + 6);
    await sleep(200);
    const ln = document.querySelector(".drag-line");
    ok("Q7 落点线出来了、在「进行」上沿附近", !!ln && !ln.hidden && Math.abs(parseFloat(ln.style.top) - (cardById(ids.doing).getBoundingClientRect().top - 5)) < 3, ln && { line: ln.style.top, card: cardById(ids.doing).getBoundingClientRect().top });
    pe("pointerup", document.body, a.x, tgt.top + 6);
    ok("Q7 放下:拿起态与落点线都收了", !dingEl.classList.contains("lifted") && !document.querySelector(".drag-line"));
    await until(async () => (await stageOf(ids.ding)) === "doing", 3000);
    const doingNow = await colIds("doing");
    ok("Q7 落进进行中、排在「进行」之前", doingNow.indexOf(ids.ding) === doingNow.indexOf(ids.doing) - 1, doingNow);
    ok("Q7 回执「已移到「进行中」」带撤销", !!(await until(() => barTexts()[0] === "撤销" && $("error").textContent.includes("已移到「进行中」"), 3000)), $("error").textContent);
    click(barActs()[0]);
    await until(async () => (await stageOf(ids.ding)) === "todo", 3000);
    ok("Q7 撤销 = 回待办原位置", (await colIds("todo")).indexOf(ids.ding) === dingAt, { was: dingAt, now: (await colIds("todo")).indexOf(ids.ding) });
    clearBar();
    click(tagPill()); // 取消标签筛选
    await until(() => !tagPill()?.classList.contains("active"), 2000);
    // 列内拖:丙拖到甲之前
    window.scrollTo(0, 0);
    await sleep(300);
    const bingEl = card(`${M}-丙`);
    const jiaEl = card(`${M}-甲`);
    const b = ctr(bingEl);
    pe("pointerdown", bingEl.querySelector(".content"), b.x, b.y);
    await sleep(550);
    pe("pointermove", document.body, b.x, jiaEl.getBoundingClientRect().top + 4);
    await sleep(200);
    pe("pointerup", document.body, b.x, jiaEl.getBoundingClientRect().top + 4);
    await until(async () => {
      const c = await colIds("todo");
      return c.indexOf(ids.bing) === c.indexOf(ids.jia) - 1;
    }, 3000);
    const tc = await colIds("todo");
    ok("Q7 列内拖:丙落在甲之前", tc.indexOf(ids.bing) === tc.indexOf(ids.jia) - 1, tc.slice(0, 4));
    ok("Q7 列内拖回执「已挪到这里」带撤销", !!(await until(() => $("error").textContent.includes("已挪到这里") && barTexts()[0] === "撤销", 3000)), $("error").textContent);
    click(barActs()[0]);
    ok("Q7 列内拖撤销 = 回原位", !!(await until(async () => JSON.stringify(await colIds("todo")) === JSON.stringify(todoBefore), 3000)));
    clearBar();
    // 拖完没把操作面顺手开了
    await sleep(300);
    ok("Q7 拖完没开操作面", !document.querySelector("#timeline .panel"));

    // ---- Q10:点通知 = 进任务面只看到期;提醒正文带「3 天内」 ----
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
    await until(() => document.body.dataset.view === "ideas", 2000);
    window.dispatchEvent(new Event("zhujian-notif-tap"));
    ok("Q10 点通知进任务面", !!(await until(() => document.body.dataset.view === "tasks", 2000)));
    ok("Q10 …只看到期那枚按下了", !!document.querySelector("#filter-stages .fdue.active"));
    const shown = [...document.querySelectorAll("#timeline article.card .content")].map((c) => c.textContent);
    ok("Q10 …屏上是到期的那几张(逾期 + 今天 + 3 天内),没有别的", shown.includes(`${M}-昨天`) && shown.includes(`${M}-今天`) && shown.includes(`${M}-后天`) && !shown.includes(`${M}-甲`), shown.slice(0, 8));
    // Q7 只看到期时长按:说一句、不拿起
    const yc = card(`${M}-昨天`);
    const y = ctr(yc);
    pe("pointerdown", yc.querySelector(".content"), y.x, y.y);
    await sleep(550);
    ok("Q7 只看到期时长按不拿起、说一句为什么", !yc.classList.contains("lifted") && $("error").textContent.includes("不能拖"), $("error").textContent);
    pe("pointerup", document.body, y.x, y.y);
    clearBar();
    click(document.querySelector("#filter-stages .fdue"));
    await sleep(200);
    // 提醒正文:清水位、注入「现在 23:59」强制判一次(通知权限没给也照样广播正文)
    localStorage.removeItem(REMIND_LAST);
    const body = await new Promise((res) => {
      const h = (e) => {
        document.removeEventListener("zhujian:due-remind-done", h);
        res(e.detail.body);
      };
      document.addEventListener("zhujian:due-remind-done", h);
      document.dispatchEvent(new CustomEvent("zhujian:due-remind-check", { detail: { now: "23:59" } }));
      setTimeout(() => res("(超时)"), 8000);
    });
    ok("Q10 提醒正文与汇总钮同一句(带「3 天内」)", typeof body === "string" && /逾期 \d+ · 今天 \d+ · 3 天内 \d+/.test(body), body);
  } catch (e) {
    ok("没抛异常", false, String(e));
  } finally {
    clearBar();
    if (remindLast0 === null) localStorage.removeItem(REMIND_LAST);
    else localStorage.setItem(REMIND_LAST, remindLast0);
    if (document.body.classList.contains("pane-open")) click(document.querySelector('#bottombar [data-mode="tasks"]'));
    const all = [ids.ding, ids.yest, ids.today, ids.soon, ids.bing, ids.yi, ids.jia, ids.doing, ids.done1, ids.done2, ...ids.fill];
    for (const id of all) {
      try {
        await inv("unseal_task", { id });
      } catch {}
      for (const c of ["archive_task", "purge_task"]) {
        try {
          await inv(c, { id });
        } catch {}
      }
    }
    try {
      await inv("delete_topic", { id: ids.topic });
    } catch {}
    localStorage.removeItem(PHASE_KEY);
    const tl = await inv("list_timeline", {});
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes(M)));
    ok("清场:归档册没有种子", !(await inv("list_sealed_tasks", {})).some((x) => String(x.title).includes(M)));
    ok("清场:回收站没有种子", !(await inv("list_trash", {})).some((x) => String(x.content).includes(M)));
    window.scrollTo(0, 0);
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
