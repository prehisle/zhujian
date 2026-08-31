// 安卓任务面「到期汇总钮」的回归资产(用户面 60-D:对齐桌面 502 顶栏那枚「逾期 M · 今天 N」
// + 556-B 的紧急度排序)。桌面那半由 e2e 两支盯着(task-time / due-reminder),安卓没有
// wdio 套件,回归全靠它。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-due-summary.js
//   **幂等三趟形**(seed → reload → 验+清场 → reload → 复核;每趟之间
//   `node scripts/android-cdp.mjs eval 'location.reload()'`)。前两趟回 {needReload:true},
//   **第三趟才回最终 {pass, steps}**(前两趟的 steps 存在 localStorage 里跨 reload 带过来,
//   于是 pass 仍是单一判据、不用人去合并两份 JSON)。
//   ⚠ 为什么非要三趟:①前端只在启动/切面/同步事件时重查 list_timeline,不 reload 新任务
//   进不了投影;②判据 ⑩「清完场钮该消失」必须在**清场之后的一次真刷新**上看,同一趟里
//   前端的 lastItems 还停在旧快照上,当场问等于没问。
//
// # 判据(⛔ 承重的是 ②③⑤⑥ 四格 —— 「算了什么」「不算什么」「只剩它们」「谁排前面」)
//  ① 钮在任务面出现,且是 #filter-stages 的**第一个孩子**(「状态」轴标之前)。
//     .fstages 是单行横滑的,摆末尾在窄屏上等于没做 ⇒ 位置本身是判据的一部分。
//  ② 计数只算「未完成 ∧ 今天到期或已逾期」:播种造了 5 种情形,期望 late=2 / now=1。
//     ⭐ 其中 **已完成但早已逾期**那条必须被排除(556-G 那条裁决的安卓那半);
//     未来到期、无截止日两条同样不算。
//  ③ 计数**不随任何筛选收缩**:挂上一个状态维筛选(只看某一列)后钮上的数一字不变 ——
//     它答的是「今天我该处理什么」,那句话的意思不该被当前视野改写。
//  ④ 有逾期时挂 .late(朱砂描边);未点开时不挂 .active。
//  ⑤ 点一下 → .active 上身,时间轴上**恰好只剩那 3 条**(未来 / 无截止 / 已完成逾期
//     三条都得消失)。
//  ⑥ 段内按截止升序:逾期最久的排最前(LATE5 → LATE1 → TODAY)。⚠ 播种顺序**刻意反着来**
//     (TODAY 先建、LATE5 最后建),不排序的话它们就是反的 ⇒ 这一格能证伪。
//  ⑦ dueOnly 叠上「只看已完成那一列」→ 交集为空 ⇒ 走新的到期专属空态(main.noneDue),
//     ⛔ 不是「该状态下没有任务」那句(那句在这儿是错的:那一列真有任务)。
//  ⑧ 再点一次 → .active 卸掉,三条被藏起的卡全回来。
//  ⑨ 灵感面没有这枚钮(它是任务面专属的一维)。
//  ⑩ 清完场后钮整枚消失(late+now=0 ⇒ 不渲染)—— 这一格是**唯一能证伪「钮恒显」的那半**。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  - 合成 click 证的是「处理器接对了」,证不了手指点得到;那半靠 .fpill 既有的触区
//    (与状态 chips 同皮同尺寸,229 那轮量过)。
//  - 朱砂描边**长什么样**没验(只验 class 挂上了)—— 颜色那半由 check-contrast /
//    check-theme-drift 两道门禁各守一角。
//  - 跨本地午夜的重算没验(桌面那边有 armMidnightRefresh,安卓这一维跟着刷新走)。
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
  const RESULTS_KEY = "zj.duesum.steps"; // 第二趟的 steps 跨 reload 带到第三趟
  const T = {
    late5: "ZJDS-逾期五天",
    late1: "ZJDS-逾期一天",
    today: "ZJDS-今天到期",
    future: "ZJDS-三天后",
    doneLate: "ZJDS-做完了但早逾期",
    noDue: "ZJDS-没有截止日",
  };

  const $ = (id) => document.getElementById(id);
  const dueBtn = () => document.querySelector("#filter-stages .fdue");

  // ---- 第三趟:清完场之后的复核(判据 ⑩)-----------------------------------
  const carried = localStorage.getItem(RESULTS_KEY);
  if (carried !== null) {
    out.steps = JSON.parse(carried);
    localStorage.removeItem(RESULTS_KEY);
    document.querySelector("[data-mode=tasks]").click();
    // ⚠ 就绪判据要是「投影真的落过一次」——卡片或空态二选一,别拿静态元素在不在当替身
    // (skill 503 那条:`#capture-fab` 首帧就在,拿它当就绪会在数据还没到时开始断言)。
    await until(() => $("timeline").querySelector("[data-id]") || $("timeline").querySelector(".empty"), 8000);
    await sleep(300);
    const leftovers = [...document.querySelectorAll("#timeline [data-id]")]
      .map((c) => (c.textContent || "").trim())
      .filter((s) => s.includes("ZJDS-"));
    ok("清场干净:一条种子都不剩", leftovers.length === 0, { leftovers });
    // ⚠ 前置要显式记下来:任务面若整个空了,renderFilterBar 会**提前返回**(只把整条
    // 筛选栏 hidden,并不清空 #filter-stages 的孩子)⇒ 那种情形下 ⑩ 会**恒真地过**。
    // 把「筛选栏这会儿是显示着的」单独记一格,免得一次空过被读成一次真过。
    const barShown = $("filterbar") && !$("filterbar").hidden;
    ok("⑩ 前置:任务面非空 ⇒ 筛选栏真在渲染(否则下一格是空过)", !!barShown, {
      filterbarHidden: $("filterbar") ? $("filterbar").hidden : null,
    });
    ok("⑩ 库里没有到期任务时,钮整枚不渲染(唯一能证伪「钮恒显」的那半)", !dueBtn(), {
      barHtml: $("filter-stages") ? $("filter-stages").innerHTML.slice(0, 160) : null,
    });
    out.pass = out.steps.every((s) => s.ok);
    return out;
  }

  // ---- 播种(第一趟)------------------------------------------------------
  let seed = null;
  try {
    seed = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    seed = null;
  }
  if (seed === null) {
    // ⚠⚠ **建的顺序是判据的一部分,别顺手调**(第一版栽在这儿:我按「与期望序相反」去建,
    // 而 `list_timeline` 渲的是**新的在前** ⇒ 一反一反正好抵消,自然序恰好就是期望序,
    // 于是拿掉排序那把刀 ⑥ 照样绿 = 空测)。今天的形:**逾期最久的先建、今天到期的最后建**
    // ⇒ 自然序 = 今天 / 逾期1 / 逾期5(错的),排序必须把它翻过来。
    // ⭐ 光靠这个顺序还不够 —— 下面 ⑥ 那格另有一道**自证前置**(自然序必须真的 ≠ 期望序),
    // 免得哪天后端换了排序口径,这一格又安静地退化成空测。
    const late5 = await inv("create_task", { title: T.late5, dueOn: dayShift(-5), priority: null, topicId: null });
    const late1 = await inv("create_task", { title: T.late1, dueOn: dayShift(-1), priority: null, topicId: null });
    const today = await inv("create_task", { title: T.today, dueOn: dayShift(0), priority: null, topicId: null });
    const future = await inv("create_task", { title: T.future, dueOn: dayShift(3), priority: null, topicId: null });
    const noDue = await inv("create_task", { title: T.noDue, dueOn: null, priority: null, topicId: null });
    const doneLate = await inv("create_task", { title: T.doneLate, dueOn: dayShift(-9), priority: null, topicId: null });
    await inv("update_task_status", { id: doneLate, to: "done" });
    seed = { today, late1, late5, future, noDue, doneLate };
    localStorage.setItem(KEY, JSON.stringify(seed));
    return { needReload: true, seeded: seed };
  }

  // ---- 验 + 清场(第二趟)-------------------------------------------------
  const stageBtns = () => [...document.querySelectorAll("#filter-stages .fpill:not(.fdue)")];
  const titles = () =>
    [...document.querySelectorAll("#timeline [data-id]")].map((c) => (c.textContent || "").trim());
  const mine = () => titles().filter((s) => s.includes("ZJDS-")).map((s) => s.match(/ZJDS-[^\s]*/)[0]);
  const emptyText = () => ($("timeline").querySelector(".empty") || {}).textContent || "";
  // 「逾期 2 · 今天 1」/「2 overdue · 1 today」—— 两语通吃,免得英文机上整支跑不了。
  const EXPECT_LATE = ["逾期 2 · 今天 1", "2 overdue · 1 today"];

  try {
    // 落到任务面(底栏钮),等投影把我的种子卡都渲出来。
    document.querySelector("[data-mode=tasks]").click();
    const arrived = await until(() => mine().length >= 6, 8000);
    ok("0 任务面 6 条种子都在", arrived, { seen: mine() });
    // ⛔ 前置没满足就别往下跑:后面每一格都以「种子在屏上」为前提,硬跑出来的红是工装的红
    // 不是产品的红(skill「跑既有资产的三条」第 1 条)。仍然走 finally 清场。
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
    ok("② 计数 = 逾期2·今天1(完成的逾期条 / 未来 / 无截止 都不算)", EXPECT_LATE.includes(txt0), { text: txt0 });
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
    ok("③ 前置:所选那一列一条到期种子都没有(否则 ③ 是空测)", !inCol.some((s) => /逾期五天|逾期一天|今天到期/.test(s)), {
      inCol,
    });
    ok("③ 挂上状态筛选后计数一字不变(它算的是整块任务面)", dueBtn() && dueBtn().textContent.trim() === txt0, {
      after: dueBtn() ? dueBtn().textContent.trim() : null,
    });
    stageBtns()[0].click(); // 回「全部」
    await sleep(250);

    // ⑥ 前置(自证不空测):先记下**不排序时**这三条的相对次序 —— 它必须与期望序不同,
    // 否则下面那格无论排没排序都会绿。⚠ 这一格是拿刀 B(拿掉排序)跑出来的:第一版没有它,
    // 刀落上了 ⑥ 照样绿。
    const natural = mine().filter((s) => /逾期五天|逾期一天|今天到期/.test(s));
    const EXPECT_ORDER = ["ZJDS-逾期五天", "ZJDS-逾期一天", "ZJDS-今天到期"];
    ok("⑥ 前置:自然序 ≠ 期望序(否则 ⑥ 是空测)", natural.join("|") !== EXPECT_ORDER.join("|"), { natural });

    // ⑤ 点开 → 只剩那三条
    dueBtn().click();
    await sleep(250);
    const shown = mine();
    ok("⑤ .active 上身", dueBtn() && dueBtn().classList.contains("active"));
    ok("⑤ 恰剩逾期5/逾期1/今天三条", shown.length === 3, { shown });
    ok("⑤ 未来到期那条不在", !shown.some((s) => s.includes("三天后")), { shown });
    ok("⑤ 无截止那条不在", !shown.some((s) => s.includes("没有截止日")), { shown });
    ok("⑤ 已完成但逾期那条不在", !shown.some((s) => s.includes("做完了")), { shown });

    // ⑥ 段内按紧急度升序(前置见上:自然序与它不同,所以这一格真的在量排序)
    ok("⑥ 逾期最久的排最前(五天 < 一天 < 今天)", shown.join("|") === EXPECT_ORDER.join("|"), {
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
    ok("⑧ 六条种子全回来", mine().length === 6, { shown: mine() });

    // ⑨ 灵感面没有这枚钮
    document.querySelector("[data-mode=ideas]").click();
    await sleep(250);
    ok("⑨ 灵感面无到期钮", !dueBtn());
    document.querySelector("[data-mode=tasks]").click();
    await sleep(250);

    } // if (arrived)

    // 判据 ⑩ 要在**清场之后的一次真刷新**上看 ⇒ 把这一趟的账带过去,第三趟收口。
    return { needReload: true, phase: "cleanup-done", stepsSoFar: out.steps.length };
  } finally {
    // 清场:任务一律 archive_task → purge_task(⛔ 别用 delete_note,存储层守护只许硬删
    // 「inbox 且未归档」,归档后必被拒而 catch 会把拒吞掉,回收站会攒尸体)。
    for (const id of Object.values(seed)) {
      try {
        await inv("archive_task", { id });
        await inv("purge_task", { id });
      } catch {
        /* 已经没了就算了,下一条 */
      }
    }
    localStorage.removeItem(KEY);
    localStorage.setItem(RESULTS_KEY, JSON.stringify(out.steps));
  }
})();
