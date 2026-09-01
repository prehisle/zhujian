// 安卓任务面「到期汇总钮」的回归资产(用户面 60-D:对齐桌面 502 顶栏那枚「逾期 M · 今天 N」
// + 556-B 的紧急度排序;**60-A 起再挂一段「N 天内 K」**= 快到期提前预警,窗口 3 天)。
// 桌面那半由 e2e 两支盯着(task-time / due-reminder),安卓没有 wdio 套件,回归全靠它。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-due-summary.js
//   **幂等四趟形**(seed → reload → 验①-⑨+摆好⑪的局 → reload → 验⑪+清场 → reload → 验⑩;
//   每趟之间 `node scripts/android-cdp.mjs eval 'location.reload()'`)。前三趟回
//   {needReload:true},**第四趟才回最终 {pass, steps}**(前几趟的 steps 存在 localStorage 里
//   跨 reload 带过来,于是 pass 仍是单一判据、不用人去合并几份 JSON)。
//   ⚠ 为什么非要分趟:①前端只在启动/切面/同步事件时重查 list_timeline,不 reload 改过的
//   任务进不了投影;②判据 ⑩「清完场钮该消失」与 ⑪「只剩快到期时钮该怎么说」都必须在
//   **改完数据之后的一次真刷新**上看,同一趟里前端的 lastItems 还停在旧快照上,当场问等于没问。
//   ⚠ 60-A 之前这是三趟形,⑪ 那一趟是新加的。
//
// # 判据(⛔ 承重的是 ②③⑤⑥⑪ 五格 —— 「算了什么」「不算什么」「只剩它们」「谁排前面」
//   「今天没事但后天有的时候它还说不说话」)
//  ① 钮在任务面出现,且是 #filter-stages 的**第一个孩子**(「状态」轴标之前)。
//     .fstages 是单行横滑的,摆末尾在窄屏上等于没做 ⇒ 位置本身是判据的一部分。
//  ② 计数只算「未完成 ∧(今天到期 / 已逾期 / 3 天内到期)」:播种造了 6 种情形,
//     期望 late=2 / now=1 / soon=1。⭐ 其中 **已完成但早已逾期**那条必须被排除
//     (556-G 那条裁决的安卓那半);**+4 天那条**必须被排除(60-A 的窗口上界);
//     无截止日那条同样不算。
//     ⭐ **+3 与 +4 两张卡是一对边界刀**:只有「+3 算上、+4 没算上」同时成立,才证明
//     上界真的画在 3 与 4 之间 —— 少任何一张,把窗口改成 0 天或改成 30 天都能绿。
//  ③ 计数**不随任何筛选收缩**:挂上一个状态维筛选(只看某一列)后钮上的数一字不变 ——
//     它答的是「今天我该处理什么」,那句话的意思不该被当前视野改写。
//  ④ 有逾期时挂 .late(朱砂描边);未点开时不挂 .active。
//     ⛔ 朱砂只跟着**逾期**走,快到期不该让它上身 —— 那格在 ⑪ 里验(那时 late=0)。
//  ⑤ 点一下 → .active 上身,时间轴上**恰好只剩那 4 条**(+4 天 / 无截止 / 已完成逾期
//     三条都得消失)。
//  ⑥ 段内按截止升序:逾期最久的排最前(LATE5 → LATE1 → TODAY → SOON)。⚠ 播种顺序
//     **刻意反着来**(TODAY 先建、LATE5 最后建),不排序的话它们就是反的 ⇒ 这一格能证伪。
//  ⑦ dueOnly 叠上「只看已完成那一列」→ 交集为空 ⇒ 走到期专属空态(main.noneDue),
//     ⛔ 不是「该状态下没有任务」那句(那句在这儿是错的:那一列真有任务)。
//  ⑧ 再点一次 → .active 卸掉,七条被藏起的卡全回来。
//  ⑨ 灵感面没有这枚钮(它是任务面专属的一维)。
//  ⑪ **只剩快到期**(把逾期/今天那三条的截止摘掉)⇒ 钮**仍在**、说的是「N 天内到期 K」、
//     且**不挂 .late**。⭐ 这一格是 60-A 的核心价值:「今天没事、但后天有」正是提前预警
//     最该说话的那天。⛔ 它同时是旧隐藏条件(late+now==0 就藏起)的阴性对照 —— 不改那个
//     条件,这一格必红(钮会整枚消失)。
//  ⑩ 清完场后钮整枚消失(late+now+soon=0 ⇒ 不渲染)—— 这一格是**唯一能证伪「钮恒显」的那半**。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  - 合成 click 证的是「处理器接对了」,证不了手指点得到;那半靠 .fpill 既有的触区
//    (与状态 chips 同皮同尺寸,229 那轮量过)。
//  - 朱砂描边**长什么样**没验(只验 class 挂没挂上)—— 颜色那半由 check-contrast /
//    check-theme-drift 两道门禁各守一角。
//  - 跨本地午夜的重算没验(桌面那边有 armMidnightRefresh,安卓这一维跟着刷新走)。
//  - 「3」这个窗口值两端各写一份(桌面 DUE_SOON_DAYS / 安卓同名常数),**没有门禁核它俩相等**;
//    这支只能证安卓那份是 3,改窗口要两处一起改。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(80);
    }
    return false;
  };
  const dayShift = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const KEY = "zj.duesum.seed";
  const RESULTS_KEY = "zj.duesum.steps"; // 上一趟的 steps 跨 reload 带到下一趟
  const PHASE_KEY = "zj.duesum.phase"; // 60-A 起要跑到第四趟,光靠 RESULTS_KEY 在不在分不开了
  const T = {
    late5: "ZJDS-逾期五天",
    late1: "ZJDS-逾期一天",
    today: "ZJDS-今天到期",
    soon: "ZJDS-三天后到期", // 窗口内(+3 = DUE_SOON_DAYS,含)
    far: "ZJDS-四天后到期", // 窗口外(+4),边界刀的另一半
    doneLate: "ZJDS-做完了但早逾期",
    noDue: "ZJDS-没有截止日",
  };

  const $ = (id) => document.getElementById(id);
  const dueBtn = () => document.querySelector("#filter-stages .fdue");
  const mine = () =>
    [...document.querySelectorAll("#timeline [data-id]")]
      .map((c) => (c.textContent || "").trim())
      .filter((s) => s.includes("ZJDS-"))
      .map((s) => s.match(/ZJDS-[^\s]*/)[0]);
  /** 任务面就绪:投影真的落过一次(卡片或空态二选一)。⛔ 别拿静态元素在不在当替身
   *  (skill 503 那条:`#capture-fab` 首帧就在,拿它当就绪会在数据还没到时开始断言)。 */
  const toTasks = async () => {
    document.querySelector("[data-mode=tasks]").click();
    await until(() => $("timeline").querySelector("[data-id]") || $("timeline").querySelector(".empty"), 8000);
    await sleep(300);
  };

  const phase = localStorage.getItem(PHASE_KEY);

  // ---- 第四趟:清完场之后的复核(判据 ⑩)-----------------------------------
  if (phase === "verify-gone") {
    out.steps = JSON.parse(localStorage.getItem(RESULTS_KEY) || "[]");
    localStorage.removeItem(RESULTS_KEY);
    localStorage.removeItem(PHASE_KEY);
    await toTasks();
    ok("清场干净:一条种子都不剩", mine().length === 0, { leftovers: mine() });
    // ⚠ 前置要显式记下来:任务面若整个空了,renderFilterBar 会**提前返回**(只把整条
    // 筛选栏 hidden,并不清空 #filter-stages 的孩子)⇒ 那种情形下 ⑩ 会**恒真地过**。
    // 把「筛选栏这会儿是显示着的」单独记一格,免得一次空过被读成一次真过。
    const barShown = $("filterbar") && !$("filterbar").hidden;
    ok("⑩ 前置:任务面非空 ⇒ 筛选栏真在渲染(否则下一格是空过)", !!barShown, {
      filterbarHidden: $("filterbar") ? $("filterbar").hidden : null,
    });
    ok("⑩ 库里没有到期/快到期任务时,钮整枚不渲染(唯一能证伪「钮恒显」的那半)", !dueBtn(), {
      barHtml: $("filter-stages") ? $("filter-stages").innerHTML.slice(0, 160) : null,
    });
    out.pass = out.steps.every((s) => s.ok);
    return out;
  }

  let seed = null;
  try {
    seed = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    seed = null;
  }

  // ---- 第三趟:只剩快到期时钮该怎么说(判据 ⑪),验完清场 -------------------
  if (phase === "verify-soon-only") {
    out.steps = JSON.parse(localStorage.getItem(RESULTS_KEY) || "[]");
    try {
      await toTasks();
      const b = dueBtn();
      // 「3 天内到期 1」/「1 due within 3d」—— 两语通吃,免得英文机上整支跑不了。
      const EXPECT_SOON_ONLY = ["3 天内到期 1", "1 due within 3d"];
      const txt = b ? b.textContent.trim() : "";
      // ⚠ 前置自证:上一趟真的把那三条的截止摘掉了(否则下面在验别的局面)。
      const still = mine();
      ok("⑪ 前置:逾期/今天那三条已不在到期口径内(屏上七条都还在,只是没了截止日)", still.length === 7, {
        still,
      });
      ok("⑪ 只剩快到期时,钮仍在(⛔ 旧的「late+now==0 就藏起」在这儿必红)", !!b, {
        barHtml: $("filter-stages") ? $("filter-stages").innerHTML.slice(0, 160) : null,
      });
      ok("⑪ 说的是「N 天内到期 K」那一句(不是「今天到期 0」)", EXPECT_SOON_ONLY.includes(txt), { text: txt });
      ok("⑪ 没有逾期 ⇒ 不挂 .late(快到期不是坏消息,不该抢眼)", b && !b.classList.contains("late"));
      // 点开只看到期:此刻窗口内只有那一条,+4 天那条仍要被筛掉。
      if (b) {
        b.click();
        await sleep(250);
        const shown = mine();
        ok("⑪ 点开 → 恰剩那一条快到期的", shown.length === 1 && shown[0] === T.soon, { shown });
        dueBtn() && dueBtn().click();
        await sleep(200);
      }
    } finally {
      // 清场:任务一律 archive_task → purge_task(⛔ 别用 delete_note,存储层守护只许硬删
      // 「inbox 且未归档」,归档后必被拒而 catch 会把拒吞掉,回收站会攒尸体)。
      for (const id of Object.values(seed || {})) {
        try {
          await inv("archive_task", { id });
          await inv("purge_task", { id });
        } catch {
          /* 已经没了就算了,下一条 */
        }
      }
      localStorage.removeItem(KEY);
      localStorage.setItem(RESULTS_KEY, JSON.stringify(out.steps));
      localStorage.setItem(PHASE_KEY, "verify-gone");
    }
    return { needReload: true, phase: "cleanup-done", stepsSoFar: out.steps.length };
  }

  // ---- 播种(第一趟)------------------------------------------------------
  if (seed === null) {
    // ⚠⚠ **建的顺序是判据的一部分,别顺手调**(第一版栽在这儿:我按「与期望序相反」去建,
    // 而 `list_timeline` 渲的是**新的在前** ⇒ 一反一反正好抵消,自然序恰好就是期望序,
    // 于是拿掉排序那把刀 ⑥ 照样绿 = 空测)。今天的形:**逾期最久的先建、快到期的最后建**
    // ⇒ 自然序 = 三天后 / 今天 / 逾期1 / 逾期5(错的),排序必须把它翻过来。
    // ⭐ 光靠这个顺序还不够 —— 下面 ⑥ 那格另有一道**自证前置**(自然序必须真的 ≠ 期望序),
    // 免得哪天后端换了排序口径,这一格又安静地退化成空测。
    const late5 = await inv("create_task", { title: T.late5, dueOn: dayShift(-5), priority: null, topicId: null });
    const late1 = await inv("create_task", { title: T.late1, dueOn: dayShift(-1), priority: null, topicId: null });
    const today = await inv("create_task", { title: T.today, dueOn: dayShift(0), priority: null, topicId: null });
    const soon = await inv("create_task", { title: T.soon, dueOn: dayShift(3), priority: null, topicId: null });
    const far = await inv("create_task", { title: T.far, dueOn: dayShift(4), priority: null, topicId: null });
    const noDue = await inv("create_task", { title: T.noDue, dueOn: null, priority: null, topicId: null });
    const doneLate = await inv("create_task", { title: T.doneLate, dueOn: dayShift(-9), priority: null, topicId: null });
    await inv("update_task_status", { id: doneLate, to: "done" });
    seed = { today, late1, late5, soon, far, noDue, doneLate };
    localStorage.setItem(KEY, JSON.stringify(seed));
    return { needReload: true, seeded: seed };
  }

  // ---- 验 ①-⑨ + 摆好 ⑪ 的局(第二趟)------------------------------------
  const stageBtns = () => [...document.querySelectorAll("#filter-stages .fpill:not(.fdue)")];
  const emptyText = () => ($("timeline").querySelector(".empty") || {}).textContent || "";
  // 「逾期 2 · 今天 1 · 3 天内 1」/「2 overdue · 1 today · 1 within 3d」—— 两语通吃。
  const EXPECT_LATE = ["逾期 2 · 今天 1 · 3 天内 1", "2 overdue · 1 today · 1 within 3d"];

  try {
    // 落到任务面(底栏钮),等投影把我的种子卡都渲出来。
    await toTasks();
    const arrived = await until(() => mine().length >= 7, 8000);
    ok("0 任务面 7 条种子都在", arrived, { seen: mine() });
    // ⛔ 前置没满足就别往下跑:后面每一格都以「种子在屏上」为前提,硬跑出来的红是工装的红
    // 不是产品的红(skill「跑既有资产的三条」第 1 条)。仍然走 finally 摆局。
    if (arrived) {

    // ① 位置:第一个孩子,且「状态」轴标在它后面
    const bar = $("filter-stages");
    const b = dueBtn();
    ok("① 到期钮在,且是筛选行第一个孩子", b && bar.firstElementChild === b, {
      first: bar.firstElementChild ? bar.firstElementChild.className : null,
    });
    ok("① 「状态」轴标仍在,排在它后面", bar.querySelector(".faxis") && bar.children[1] === bar.querySelector(".faxis"));

    // ②④ 计数与皮肤
    const txt0 = b ? b.textContent.trim() : "";
    ok("② 计数 = 逾期2·今天1·3天内1(完成的逾期条 / +4 天 / 无截止 都不算)", EXPECT_LATE.includes(txt0), {
      text: txt0,
    });
    ok("④ 有逾期 ⇒ 挂 .late", b && b.classList.contains("late"));
    ok("④ 未点开 ⇒ 不挂 .active", b && !b.classList.contains("active"));

    // ③ 计数不随筛选收缩。⚠⚠ **挑哪一列是判据的一部分**(第一版栽在这儿:挑的是第一个真列
    // 「待办」,而三条到期种子全在那一列 ⇒ 就算计数真的跟着筛选走,数也一模一样 = 空测)。
    // 今天挑的是**一条到期种子都没有的那一列**(已完成),并把「它确实一条都没有」单独记一格
    // 自证 —— 跟着筛选走的实现在这儿会掉到 0、钮当场消失。
    const cntCol = stageBtns().find((x) => x.dataset.stage === "done");
    cntCol.click();
    await sleep(250);
    const inCol = mine();
    ok("③ 前置:所选那一列一条到期/快到期种子都没有(否则 ③ 是空测)", !inCol.some((s) => /逾期五天|逾期一天|今天到期|三天后/.test(s)), {
      inCol,
    });
    ok("③ 挂上状态筛选后计数一字不变(它算的是整块任务面)", dueBtn() && dueBtn().textContent.trim() === txt0, {
      after: dueBtn() ? dueBtn().textContent.trim() : null,
    });
    stageBtns()[0].click(); // 回「全部」
    await sleep(250);

    // ⑥ 前置(自证不空测):先记下**不排序时**这四条的相对次序 —— 它必须与期望序不同,
    // 否则下面那格无论排没排序都会绿。⚠ 这一格是拿刀 B(拿掉排序)跑出来的:第一版没有它,
    // 刀落上了 ⑥ 照样绿。
    const natural = mine().filter((s) => /逾期五天|逾期一天|今天到期|三天后/.test(s));
    const EXPECT_ORDER = [T.late5, T.late1, T.today, T.soon];
    ok("⑥ 前置:自然序 ≠ 期望序(否则 ⑥ 是空测)", natural.join("|") !== EXPECT_ORDER.join("|"), { natural });

    // ⑤ 点开 → 只剩那四条
    dueBtn().click();
    await sleep(250);
    const shown = mine();
    ok("⑤ .active 上身", dueBtn() && dueBtn().classList.contains("active"));
    ok("⑤ 恰剩逾期5/逾期1/今天/三天后 四条", shown.length === 4, { shown });
    ok("⑤ 窗口外(+4 天)那条不在 —— 边界刀的另一半", !shown.some((s) => s.includes("四天后")), { shown });
    ok("⑤ 无截止那条不在", !shown.some((s) => s.includes("没有截止日")), { shown });
    ok("⑤ 已完成但逾期那条不在", !shown.some((s) => s.includes("做完了")), { shown });

    // ⑥ 段内按紧急度升序(前置见上:自然序与它不同,所以这一格真的在量排序)
    ok("⑥ 逾期最久的排最前(五天 < 一天 < 今天 < 三天后)", shown.join("|") === EXPECT_ORDER.join("|"), {
      order: shown,
      natural,
    });

    // ⑦ dueOnly 叠「已完成」那一列 ⇒ 交集空 ⇒ 到期专属空态
    const doneCol = stageBtns().find((x) => x.dataset.stage === "done");
    ok("⑦ 找得到「已完成」那一列的 chip", !!doneCol);
    if (doneCol) {
      doneCol.click();
      await sleep(250);
      const et = emptyText();
      ok("⑦ 交集为空时走到期专属空态,不是「该状态下没有任务」", /到期|due/i.test(et) && !/「.*」下没有任务|No tasks under/.test(et), {
        empty: et,
      });
      stageBtns()[0].click();
      await sleep(200);
    }

    // ⑧ 再点一次回全部
    dueBtn().click();
    await sleep(250);
    ok("⑧ .active 卸掉", dueBtn() && !dueBtn().classList.contains("active"));
    ok("⑧ 七条种子全回来", mine().length === 7, { shown: mine() });

    // ⑨ 灵感面没有这枚钮
    document.querySelector("[data-mode=ideas]").click();
    await sleep(250);
    ok("⑨ 灵感面无到期钮", !dueBtn());
    document.querySelector("[data-mode=tasks]").click();
    await sleep(250);

    } // if (arrived)

    // ⑪ 与 ⑩ 都要在**改完数据之后的一次真刷新**上看 ⇒ 把这一趟的账带过去,下一趟收口。
    return { needReload: true, phase: "verified-1-9", stepsSoFar: out.steps.length };
  } finally {
    // 摆 ⑪ 的局:把「逾期/今天」那三条的截止摘掉,只留 +3 天那条在到期口径里
    // (⛔ 别删卡 —— ⑪ 的前置要数它们还在屏上,那才分得开「摘了截止」与「卡没了」)。
    for (const id of [seed.late5, seed.late1, seed.today]) {
      try {
        await inv("set_task_due", { id, dueOn: null });
      } catch {
        /* 摆局失败会让 ⑪ 的前置那格当场红,不用在这儿吞第二次 */
      }
    }
    localStorage.setItem(RESULTS_KEY, JSON.stringify(out.steps));
    localStorage.setItem(PHASE_KEY, "verify-soon-only");
  }
})();
