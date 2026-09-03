// 安卓「截止提醒」的回归资产(用户面 39①;桌面那半由 e2e `due-reminder.e2e.js` 盯着,
// 安卓没有 wdio 套件,回归全靠它)。
//
// 跑法:CDP_TIMEOUT_MS=120000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-due-reminder.js
//   ⭐ **单趟形,不用 reload** —— 与同族的 `cdp-acceptance-due-summary.js`(四趟)刻意不同:
//   那支验的是**屏上那枚钮**,而钮读的是前端的 `list_timeline` 快照 ⇒ 改完数据必须真刷新一次;
//   这支验的是**判定那条路**,而 `reminder.ts` 每次判定都现去 `list_tasks` 拉一趟
//   ⇒ 播完种当场就能问。⛔ 别照着那支加 phase/reload,加了只是白跑三趟。
//
// ⭐ **真通知在系统面,页内断言够不着它** —— 这支断的是产品自己的观察缝:
// 判定完成时广播的 `zhujian:due-remind-done`(detail.body:string|null)+ localStorage 水位。
// 「通知真的弹得出来」那半**由驱动侧一格补上**(⭐ 桌面那边只能靠人眼,这一端能量到):
//     adb shell pm grant app.zhujian.notebook android.permission.POST_NOTIFICATIONS
//     …点「试一条」…
//     adb shell dumpsys notification --noredact | grep -A3 app.zhujian.notebook
//   ⇒ 通知栏里真有一条、标题是「截止提醒」才算数。⛔ 别把本文件的绿读成「通知显示出来了」。
//
// ⚠ **权限那道系统对话框页内点不到**(原生模态)⇒ 跑这支之前先 `pm grant`(见上),
//   否则 ④ 那格会卡在授权框上:判定里 `notify()` 会先问权限。⚠ 但 `due-remind-done`
//   是**发通知之前**广播的,所以即使没授权,本文件的判据仍然全部成立(只是 logcat 里
//   会多一句「截止提醒发送失败」)—— 那正是「记账在发送之前」这条设计的副产品。
//
// # 判据(⛔ 承重的是 ④⑤⑥⑦⑧⑨ 六格 —— 「到点报什么」「至多一天一条」「关着不响」
//   「没到点不响」「无事不说话但记账」「只有快到期时一个字都不说」)
//  ① 设置面那一节五件都在,且**没有被 data-needs 摘掉**(= 这一端 HAS_NOTIFICATION 为真的自证)。
//  ② 开关两个方向都真落 localStorage;关着时报点输入是禁用的。
//  ③ 报点改成 07:30 真落库(`change` 事件那条路)。
//  ④ 到点即报:正文 = 「逾期 M · 今天 N」那把尺**现算**的期望值(⛔ 不写死数字:
//     这台设备上本来就可能躺着带截止的任务,绝对数是错判据),水位记成今天。
//  ⑤ 同一天不再报;清掉水位才会再报。⭐ 带**分辨器**:两次之间再加一张逾期卡,
//     于是正例的正文必是**新**数 —— 只数条数不够(「中间那次误报了」会把水位写上、
//     让正例被去重顶掉,总数还是对的)。
//  ⑥ 关着不响、再开就响(同样带分辨器)。
//  ⑦ 07:29 < 07:30 不响;到点才响。
//  ⑧ 到点无事:`body=null`(不说话)但水位照记 —— 「今天已经算过了」与「今天说过话了」
//     是两件事,搞混会让空日子每 30 秒判一次。
//  ⑨ **只剩快到期时,通知一个字都不说**(559 那条取舍的安卓那半:那段「3 天内 K」只进
//     屏上那枚钮)。⭐ 前置**自证数据局面**:同一刻 `list_tasks` 里今天/逾期恰好 0 条、
//     而 3 天内 ≥1 条 —— 否则「没说话」可能只是因为库里什么都没有。
//     ⚠ 屏上那枚钮在这个局面下**真的会说话**那半,归 `cdp-acceptance-due-summary.js` 的
//     ⑪ 格(它有 reload,看得到投影);两支合起来才是完整的一对。
//  ⑩ **清场干净**:验完**看板与回收站**里一条 `ZJDR-` 种子都不剩(软删完还 `purge_task`
//     彻底删 —— 这支要在真手机的真数据里跑,只软删等于往用户回收站塞五条垃圾)。
//     ⭐ 它是判据不是礼节 —— 清场失败是安静的(那几条 catch 是为了不让清场的错盖掉正文
//     判据),本资产第一版就用错了命令(任务要 `archive_task` / `purge_task`,`archive_note`
//     与 `purge_note` 只受理灵感),22 格连绿两趟而库里躺着 11 条种子。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  - 真通知的显示、图标、点开行为:见上面驱动侧那一格(dumpsys 只证「投进了通知栏」)。
//  - `POST_NOTIFICATIONS` 那道系统对话框的真实点按(允许 / 不允许 / 拒两次后不再弹)。
//  - 墙钟到点(真等到 09:00):判据全用注入的 `detail.now`,跨本地午夜那一格与桌面同界。
//  - 「app 切后台 / 息屏之后定时拍还准不准」:那是 WebView 的节流行为,页内量不了。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const dayShift = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const LAST = "zhujian.due-remind.last";
  const CFG = "zhujian.due-remind";
  const today = dayShift(0);

  // 判定日志:装在 document 上,与产品那条广播同源。
  window.__remindLog = [];
  const onDone = (e) => window.__remindLog.push(e.detail);
  document.addEventListener("zhujian:due-remind-done", onDone);
  const log = () => window.__remindLog;
  const fireOnce = (now) =>
    document.dispatchEvent(new CustomEvent("zhujian:due-remind-check", { detail: { now } }));
  /** 正例:补发直到日志到 n 条。判定有不重入闸(`checking`),上一拍还没收尾时新事件会被吞;
   *  幂等由水位保证(记过账之后的 dispatch 全是同步跳过,不会多记)。 */
  const fireUntil = async (now, n) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      fireOnce(now);
      await sleep(120);
      if (log().length >= n) return true;
    }
    return false;
  };

  /** 现算期望正文(两语通吃 —— 这台机器的 `<html lang>` 可能是 en)。 */
  const expectedBody = async () => {
    const tasks = await inv("list_tasks");
    let late = 0;
    let now = 0;
    for (const t of tasks) {
      if (t.status === "done" || !t.due_on) continue;
      if (t.due_on < today) late++;
      else if (t.due_on === today) now++;
    }
    const forms =
      late > 0
        ? [`逾期 ${late} · 今天 ${now}`, `${late} overdue · ${now} today`]
        : [`今天到期 ${now}`, `${now} due today`];
    return { late, now, forms };
  };

  const T = {
    today: "ZJDR-今天到期",
    late: "ZJDR-昨天就该交",
    x1: "ZJDR-分辨器一",
    x2: "ZJDR-分辨器二",
    soon: "ZJDR-后天才到期",
  };
  const seeded = [];
  const seed = async (title, dueOn) => {
    const id = await inv("capture_todo", { content: title });
    if (dueOn !== null) await inv("set_task_due", { id, dueOn });
    seeded.push(id);
    return id;
  };

  // 库里既有的带截止任务:⑧⑨ 要把它们临时摘掉,清场时逐条还回去。
  const preexisting = (await inv("list_tasks")).filter((t) => t.due_on !== null).map((t) => ({ id: t.id, due_on: t.due_on }));

  /** 清场:种子软删 + 既有任务的截止逐条还回去 + 两个键删掉(⛔ 别把 07:30 留在这台设备上)。
   *  ⭐ **任务走 `archive_task`,不是 `archive_note`** —— 后者只受理灵感(见 ⑩ 那格的注)。
   *  幂等:重复调用时每条都会被下面的 catch 吃掉。 */
  const cleanup = async () => {
    for (const id of seeded) {
      try {
        await inv("archive_task", { id });
      } catch {
        /* 清场失败不许盖掉正文判据 —— 它由 ⑩ 那格独立报出来 */
      }
      try {
        // ⭐ **软删完还要从回收站彻底删掉**(`purge_task`,同样是任务专用的那条):
        // 这支资产是要在**真手机上、真数据里**跑的,只软删就等于往用户的回收站里
        // 塞五条 `ZJDR-` 垃圾。⚠ 桌面那支 e2e 只软删,那是因为它跑在一次性 profile 上。
        await inv("purge_task", { id });
      } catch {
        /* 同上 */
      }
    }
    for (const t of preexisting) {
      try {
        await inv("set_task_due", { id: t.id, dueOn: t.due_on });
      } catch {
        /* 同上 */
      }
    }
    localStorage.removeItem(CFG);
    localStorage.removeItem(LAST);
    await closeSettings(); // ⛔ 别把开着的面留给下一趟(理由同 openSettings 头注)
  };

  /** 开设置面。⛔ **别盲点那枚齿轮** —— 它是 toggle:面已经开着时点一下是**收**,
   *  于是 `paintRemindRow()` 不会跑,屏上留着上一趟的值。⚠ 这不是假想的形:本资产
   *  第一版就这么栽的(前一发探针脚本把面留开着了 ⇒ ① 那格读到上一趟的 07:30,
   *  而 `cfg` 明明是 null;⭐ 是那格自己把工装的病喊出来的)。⇒ 先收再开,保证是**新开**。
   *  同族记述在 skill `zhujian-android-verify`「卡片操作面板可能本来就开着」那条。 */
  const openSettings = async () => {
    if (!$("settings-pane").hidden) {
      $("settings-toggle").click();
      await sleep(300);
    }
    $("settings-toggle").click();
    await sleep(500);
  };
  const closeSettings = async () => {
    if (!$("settings-pane").hidden) {
      $("settings-toggle").click();
      await sleep(300);
    }
  };

  try {
    // ---- ① 设置面那一节在,且没被摘掉 ------------------------------------------
    await openSettings();
    const parts = {
      h2: [...document.querySelectorAll('#settings-pane h2[data-needs="notification"]')].length,
      seg: !!$("remind-seg"),
      time: !!$("remind-time"),
      test: !!$("remind-test"),
      sub: [...document.querySelectorAll('#settings-pane p[data-i18n="reminder.sub"]')].length,
    };
    ok("① 设置面「截止提醒」五件都在", parts.h2 === 1 && parts.seg && parts.time && parts.test && parts.sub === 1, parts);
    ok(
      "① 这一端 HAS_NOTIFICATION 为真:data-needs 没把它摘掉",
      !$("remind-seg").hidden && !$("remind-time").closest(".row").hidden,
      { segHidden: $("remind-seg").hidden },
    );
    // 开面时 paintRemindRow 已跑过 ⇒ 默认形(开 · 09:00)应当在屏上。
    ok("① 默认形上屏:开着 · 09:00", $("remind-time").value === "09:00" && $("remind-seg").querySelector('[data-remind="on"]').classList.contains("on"), {
      time: $("remind-time").value,
      cfg: localStorage.getItem(CFG),
    });

    // ---- ② 开关两个方向 ----------------------------------------------------------
    $("remind-seg").querySelector('[data-remind="off"]').click();
    await sleep(150);
    ok("② 关:落 localStorage 且报点输入禁用", JSON.parse(localStorage.getItem(CFG)).on === false && $("remind-time").disabled === true, {
      cfg: localStorage.getItem(CFG),
      disabled: $("remind-time").disabled,
    });
    $("remind-seg").querySelector('[data-remind="on"]').click();
    await sleep(150);
    ok("② 开:落 localStorage 且报点输入解禁", JSON.parse(localStorage.getItem(CFG)).on === true && $("remind-time").disabled === false);

    // ---- ③ 报点改成 07:30 --------------------------------------------------------
    $("remind-time").value = "07:30";
    $("remind-time").dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
    ok("③ 报点 07:30 真落库", localStorage.getItem(CFG) === JSON.stringify({ on: true, time: "07:30" }), {
      cfg: localStorage.getItem(CFG),
    });
    // 面收起来:后面几格不需要它,留着开面会让判定期的 list_tasks 与 UI 抢同一把库锁,
    // 而且**下一趟跑这支时会读到开着的面**(见 openSettings 头上那条)。
    await closeSettings();

    // ---- ④ 到点即报 --------------------------------------------------------------
    await seed(T.today, today);
    await seed(T.late, dayShift(-1));
    const want4 = await expectedBody();
    localStorage.removeItem(LAST);
    const got4 = await fireUntil("07:30", 1);
    ok("④ 到点报了一条", got4 && log().length === 1, { log: log() });
    ok("④ 正文 = 现算的那把尺(逾期 M · 今天 N)", want4.late > 0 && log()[0] && want4.forms.includes(log()[0].body), {
      body: log()[0] ? log()[0].body : null,
      want: want4.forms,
    });
    ok("④ 水位记成今天", localStorage.getItem(LAST) === today, { last: localStorage.getItem(LAST) });

    // ---- ⑤ 至多一天一条 ----------------------------------------------------------
    fireOnce("23:59"); // 水位还在:该同步跳过
    await sleep(400);
    ok("⑤ 水位在:同一天不再报", log().length === 1, { log: log().length });
    await seed(T.x1, dayShift(-2)); // 分辨器:让下一条正文必是新数
    const want5 = await expectedBody();
    localStorage.removeItem(LAST);
    const got5 = await fireUntil("07:30", 2);
    ok("⑤ 清掉水位就再报", got5 && log().length === 2, { log: log().length });
    ok("⑤ 正文是**新**数(分辨器:证明中间那次真没报)", log()[1] && want5.forms.includes(log()[1].body), {
      body: log()[1] ? log()[1].body : null,
      want: want5.forms,
    });

    // ---- ⑥ 关着不响、再开就响 ----------------------------------------------------
    localStorage.setItem(CFG, JSON.stringify({ on: false, time: "07:30" }));
    localStorage.removeItem(LAST);
    fireOnce("23:59");
    await sleep(400);
    ok("⑥ 关着:一声不响", log().length === 2, { log: log().length });
    await seed(T.x2, dayShift(-3)); // 分辨器
    const want6 = await expectedBody();
    localStorage.setItem(CFG, JSON.stringify({ on: true, time: "07:30" }));
    const got6 = await fireUntil("23:59", 3);
    ok("⑥ 再开就响", got6 && log().length === 3, { log: log().length });
    ok("⑥ 正文是新数(证明关着那次真没报)", log()[2] && want6.forms.includes(log()[2].body), {
      body: log()[2] ? log()[2].body : null,
      want: want6.forms,
    });

    // ---- ⑦ 没到报点不响 ----------------------------------------------------------
    localStorage.removeItem(LAST);
    fireOnce("07:29");
    await sleep(400);
    ok("⑦ 07:29 < 07:30:不响", log().length === 3, { log: log().length });
    const got7 = await fireUntil("07:30", 4);
    ok("⑦ 到点那次才响", got7 && log().length === 4, { log: log().length });

    // ---- ⑧ 到点无事:不说话但记账 ------------------------------------------------
    for (const t of [...preexisting, ...seeded.map((id) => ({ id }))]) {
      await inv("set_task_due", { id: t.id, dueOn: null });
    }
    localStorage.removeItem(LAST);
    const got8 = await fireUntil("07:30", 5);
    ok("⑧ 无事那次也出了 done 事件", got8 && log().length === 5, { log: log().length });
    ok("⑧ body = null(今天不说话)", log()[4] && log()[4].body === null, { body: log()[4] ? log()[4].body : "(没有第 5 条)" });
    ok("⑧ 水位照记(算过了 ≠ 说过话了)", localStorage.getItem(LAST) === today, { last: localStorage.getItem(LAST) });

    // ---- ⑨ 只剩快到期:一个字都不说 ----------------------------------------------
    const soonId = await seed(T.soon, dayShift(2)); // 窗口内(DUE_SOON_DAYS = 3)
    // 前置自证:这一刻的库真的是「今天/逾期 0 条、3 天内 ≥1 条」那个局面。
    const nowTasks = (await inv("list_tasks")).filter((t) => t.status !== "done" && t.due_on);
    const attn = nowTasks.filter((t) => t.due_on <= today).length;
    const soon = nowTasks.filter((t) => t.due_on > today && t.due_on <= dayShift(3)).length;
    ok("⑨ 前置:局面确实是「只剩快到期」(今天/逾期 0 · 3 天内 ≥1)", attn === 0 && soon >= 1, { attn, soon });
    localStorage.removeItem(LAST);
    const got9 = await fireUntil("07:30", 6);
    ok("⑨ 判定跑了", got9 && log().length === 6, { log: log().length });
    ok("⑨ 通知仍 body = null(559 那段「3 天内 K」刻意不进通知)", log()[5] && log()[5].body === null, {
      body: log()[5] ? log()[5].body : "(没有第 6 条)",
    });
    void soonId;

    // ---- ⑩ 清场,并**把清干净了这件事也当一格判据** ------------------------------
    // ⭐ 这一格不是礼节:清场失败是**安静的**(下面 cleanup 里逐条 catch 掉,免得清场
    // 的错盖掉正文判据),而本资产第一版正是这么栽的 —— 22 格连绿两趟,库里躺着 11 条
    // 种子没人知道(用错了命令:任务要 `archive_task`,`archive_note` 只受理灵感,
    // 它答的是「这条灵感不存在或已在回收站」)。⇒ 残留必须自己会说话。
    await cleanup();
    const left = (await inv("list_tasks")).filter((t) => t.title.includes("ZJDR-")).map((t) => t.title);
    const leftTrash = (await inv("list_trash")).filter((t) => (t.content || "").includes("ZJDR-")).length;
    ok("⑩ 清场干净:看板与回收站里一条种子都不剩", left.length === 0 && leftTrash === 0, { leftovers: left, leftInTrash: leftTrash });

    out.pass = out.steps.every((s) => s.ok);
    return out;
  } finally {
    document.removeEventListener("zhujian:due-remind-done", onDone);
    await cleanup(); // 异常路径也要清(幂等:已经清过的那趟里每条都会被 catch 掉)
  }
})();
