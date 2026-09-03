// 「筛着标签记录 → 那几枚标签自动挂上」的安卓回归资产(用户 2026-08-31 拍板:相关的
// 标签都打上;并点名手机要跟上桌面这条行为)。桌面那半由 e2e 三支盯着
// (inbox-autotag / board-multitag / board-kind-filter),安卓没有 wdio 套件,回归全靠它。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-autotag.js
//   **幂等两趟形**:第一趟自己播种并回 {needReload:true} —— 播完必须
//   `node scripts/android-cdp.mjs eval 'location.reload()'` 再跑第二趟才验
//   (前端只在启动/切面/同步事件时重查 list_topics_full,不 reload 新标签进不了 pill 行;
//   ⚠ 0 条的标签 pill 本来就藏着,故播种连载体条目一起造)。第二趟末尾 finally 清净。
//
// # 判据(⛔ 承重的是「两枚都挂上」与「筛选没被清掉」两格,别只验前者)
//  ① 灵感面点甲+乙(安卓点按即切换 = 天然多选)→ 记一条 → 库里那条**恰挂两枚**
//     (此前多选下一枚也不挂、改成清筛选)。
//  ② 记完两枚 pill **仍 active**、新卡在列表里 —— 挂上了就不必清筛选那半。
//  ③ 任务面点甲 → 记一条任务 → 挂上(走的是**另一条命令** add_task_topic,与灵感面
//     的 file_note_to_topic 分家,两条都要真跑过)。
//  ④ 只筛类型(没钻到具体标签)→ 记一条 → 类型轴**让位**回「全部类型」且新卡看得见:
//     新记录生而无标签 = 不挂该类型任一标签,不让位它就当场隐身(「记了却没出现」)。
//  ⑤ 只筛「无标签」→ 记一条 → **筛选留着**(新记录天然在那一档里,清掉是多余的;
//     这一格与桌面判据对齐,此前安卓跟着一起清了)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  合成 click 证的是「处理器接对了」,证不了手指点得到 —— 触区那半由 filter 那支资产
//  与 §2.3 的桌面门禁各守一角。挂标签失败的提示文案(main.tagsNotAttached)造不出稳定
//  的失败(要让 add_task_topic 在两条之间真失败),只有 i18n 门禁保证键在、占位符没错。
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

  // ---- 前置:界面语言 ------------------------------------------------------
  // ⚠ **本资产靠中文文案认 pill**(「全部类型」「所有」「无标签」三枚,④⑤ 承重),而界面语言
  // 默认跟系统走(android/src/i18n.ts 的 resolve(navigator.language))。英文档的机器上那三枚
  // 恒 null ⇒ ④ 当场红、⑤ 的前提红并把它下面整段跳过(**22 格安静地缩成 17 格**),
  // 而红的理由与被测行为无关(559 实撞:MuMu 上 zhujian.lang 未设就是这个形)。
  // ⇒ 先把这一格单独分出来:是语言不对就说是语言不对(别拿资产的红当产品的红)。
  // ⛔ **别改成「自己偷偷切中文」** —— 那会把「这一趟验的是哪一档」藏起来,且收尾还原漏一次
  //   就污染下一轮(558/559 两轮都在人肉做这件事)。
  // ⭐ 判据读 <html lang>(initLang() 启动时落生效档,android/src/main.ts:2214),
  //   **不探测英文文案**(timeline-filter 那支抄的是 "All kinds"):与文案脱钩 ⇒ 哪天英文串改了,
  //   这句前置不会跟着静默失效。读不出值(空)同样当「没跑」= fail-closed。
  // ⛔ 拦在播种之前:英文档下连种子都不造,不污染库、不留 localStorage 半截种子。
  const htmlLang = document.documentElement.lang;
  if (htmlLang !== "zh") {
    ok("前置:界面语言是中文(本资产的 pill 全按中文文案认)", false, {
      htmlLang: htmlLang || "(空)",
      how: '本资产没跑。localStorage.setItem("zhujian.lang","zh") + reload 后再跑;验完 removeItem 设回 auto',
    });
    out.pass = false;
    return out;
  }

  const KEY = "zj.autotag.seed";
  const A = "ZJAT-甲", B = "ZJAT-乙", K = "ZJAT-老张"; // K 打 kind「人名」
  const KIND = "人名";

  // ---- 播种(第一趟)------------------------------------------------------
  let seed = null;
  try {
    seed = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    seed = null;
  }
  if (seed === null) {
    const a = await inv("create_topic", { title: A });
    const b = await inv("create_topic", { title: B });
    const k = await inv("create_topic", { title: K });
    await inv("set_topic_kind", { id: k, kind: KIND });
    // 载体:每枚标签各挂一条,pill 才会出现在筛选行(0 条的藏着);任务面另要一条任务。
    const ca = await inv("capture_idea", { content: "ZJAT-载体甲" });
    await inv("file_note_to_topic", { id: ca, topicId: a, newTitle: null });
    const cb = await inv("capture_idea", { content: "ZJAT-载体乙" });
    await inv("file_note_to_topic", { id: cb, topicId: b, newTitle: null });
    const ck = await inv("capture_idea", { content: "ZJAT-载体张" });
    await inv("file_note_to_topic", { id: ck, topicId: k, newTitle: null });
    const ct = await inv("create_task", { title: "ZJAT-载体任务", dueOn: null, priority: null, topicId: a });
    seed = { a, b, k, ideas: [ca, cb, ck], tasks: [ct], born: [] };
    localStorage.setItem(KEY, JSON.stringify(seed));
    return { needReload: true, seeded: seed };
  }

  // ---- 页面把手 ----------------------------------------------------------
  const pills = () => [...document.querySelectorAll("#filterbar .fpill")];
  const pillByTopic = (id) => pills().find((p) => p.dataset.topicId === id);
  const pillByText = (t) => pills().find((p) => (p.textContent || "").trim().startsWith(t));
  const isOn = (p) => !!p && p.classList.contains("active");
  const modeBtn = (m) => document.querySelector(`[data-mode="${m}"]`);
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const ta = () => document.getElementById("text");

  // 「所有」= 标签轴的重置档;「全部类型」= 类型轴的。两枚都靠文字认(同 timeline-filter)。
  const resetAxes = async () => {
    const kAll = pillByText("全部类型");
    if (kAll && !isOn(kAll)) kAll.click();
    await sleep(120);
    const tAll = pillByText("所有");
    if (tAll && !isOn(tAll)) tAll.click();
    await sleep(120);
  };

  // 记一条:开捕获层 → 填字 → #save → 等库里真出现(⛔ 别拿「输入框清空了」当判据,
  // 那是保存链的中途;要的是这条真落了库)。返回新条目 id。
  const capture = async (text, mode) => {
    const before = (await inv("list_timeline")).map((x) => x.id);
    document.getElementById("capture-fab").click();
    await until(() => !!ta() && ta().offsetParent !== null, 3000);
    const box = ta();
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => !document.getElementById("save").disabled, 3000);
    document.getElementById("save").click();
    let born = null;
    await until(async () => {
      const now = await inv("list_timeline");
      const fresh = now.find((x) => !before.includes(x.id) && x.content === text);
      if (fresh) born = fresh.id;
      return !!born;
    }, 8000);
    if (born) seed.born.push(born);
    localStorage.setItem(KEY, JSON.stringify(seed));
    await sleep(400); // 让 refresh + settleFilterAfterSave 的重渲落定
    return born;
  };
  const topicsOf = async (id) => {
    const it = (await inv("list_timeline")).find((x) => x.id === id);
    return (it?.topics ?? []).map((t) => t.title).sort();
  };

  try {
    // ---- ① + ② 灵感面多标签 --------------------------------------------
    if (!isOn(modeBtn("ideas"))) modeBtn("ideas").click();
    await sleep(200);
    await resetAxes();
    const pa = pillByTopic(seed.a), pb = pillByTopic(seed.b);
    ok("前提:甲/乙两枚 pill 都在筛选行上", !!pa && !!pb, { a: !!pa, b: !!pb });
    if (!pa || !pb) return out;
    pa.click();
    await sleep(150);
    pillByTopic(seed.b).click(); // pill 行每次重渲重建 ⇒ 现查
    await sleep(200);
    ok("前提:安卓点按即切换 ⇒ 两枚同时选中", isOn(pillByTopic(seed.a)) && isOn(pillByTopic(seed.b)));

    const n1 = await capture("ZJAT-多标签记的", "ideas");
    ok("① 多标签筛选下记灵感 → 真落库", !!n1);
    if (n1) {
      ok("① 承重:两枚标签都挂上了", JSON.stringify(await topicsOf(n1)) === JSON.stringify([A, B].sort()), {
        got: await topicsOf(n1),
      });
      ok("② 承重:筛选没被清掉(两枚 pill 仍选中)", isOn(pillByTopic(seed.a)) && isOn(pillByTopic(seed.b)));
      ok("② 新卡留在视野里", !!cardOf(n1));
    }

    // ---- ③ 任务面(另一条命令 add_task_topic)----------------------------
    modeBtn("tasks").click();
    await sleep(300);
    await resetAxes();
    const pta = pillByTopic(seed.a);
    ok("前提:任务面甲 pill 在(载体任务撑着它)", !!pta);
    if (pta) {
      pta.click();
      await sleep(200);
      const n2 = await capture("ZJAT-任务面记的", "tasks");
      ok("③ 任务面筛着标签记 → 真落库", !!n2);
      if (n2) {
        ok("③ 承重:标签挂上了(走 add_task_topic 那条)", JSON.stringify(await topicsOf(n2)) === JSON.stringify([A]), {
          got: await topicsOf(n2),
        });
        ok("③ 筛选没被清掉", isOn(pillByTopic(seed.a)));
      }
    }

    // ---- ④ 只筛类型 → 让位 ----------------------------------------------
    modeBtn("ideas").click();
    await sleep(300);
    await resetAxes();
    const pk = pillByText(KIND);
    ok("前提:类型轴上有「人名」", !!pk);
    if (pk) {
      pk.click();
      await sleep(250);
      ok("前提:类型选中了", isOn(pillByText(KIND)));
      const n3 = await capture("ZJAT-只筛类型时记的", "ideas");
      ok("④ 只筛类型时记灵感 → 真落库", !!n3);
      if (n3) {
        ok("④ 承重:类型轴让位回「全部类型」", isOn(pillByText("全部类型")), {
          kindStillOn: isOn(pillByText(KIND)),
        });
        ok("④ 新卡看得见(不让位它会当场隐身)", !!cardOf(n3));
        ok("④ 类型不是标签 ⇒ 没什么可挂", (await topicsOf(n3)).length === 0);
      }
    }

    // ---- ⑤ 只筛「无标签」→ 筛选留着 --------------------------------------
    await resetAxes();
    const pn = pillByText("无标签");
    ok("前提:「无标签」pill 在", !!pn);
    if (pn) {
      pn.click();
      await sleep(200);
      ok("前提:「无标签」选中了", isOn(pillByText("无标签")));
      const n4 = await capture("ZJAT-无标签档记的", "ideas");
      ok("⑤ 「无标签」筛选下记灵感 → 真落库", !!n4);
      if (n4) {
        ok("⑤ 生而无标签", (await topicsOf(n4)).length === 0);
        ok("⑤ 承重:筛选留着(新记录天然在这一档里,清掉是多余的)", isOn(pillByText("无标签")));
        ok("⑤ 新卡看得见", !!cardOf(n4));
      }
    }

    out.pass = out.steps.every((s) => s.ok);
    return out;
  } finally {
    // 清场:先条目后标签(⛔ archive→purge,不是 delete_note —— 存储层守护只许硬删
    // 「inbox 且未归档」,归档后必被拒而 catch 把拒吞掉,回收站会攒尸体)。
    const tasksSet = new Set(seed.tasks);
    for (const id of [...seed.born, ...seed.ideas, ...seed.tasks]) {
      try {
        if (tasksSet.has(id)) {
          await inv("archive_task", { id });
          await inv("purge_task", { id });
        } else {
          await inv("archive_note", { id });
          await inv("purge_note", { id });
        }
      } catch {
        /* 已经没了就算了,下一条 */
      }
    }
    // born 里可能有任务(③ 那条),按 stage 兜一次
    for (const id of seed.born) {
      try {
        await inv("archive_task", { id });
        await inv("purge_task", { id });
      } catch {
        /* 不是任务就算了 */
      }
    }
    for (const id of [seed.a, seed.b, seed.k]) {
      try {
        await inv("delete_topic", { id });
      } catch {
        /* 同上 */
      }
    }
    localStorage.removeItem(KEY);
  }
})();
