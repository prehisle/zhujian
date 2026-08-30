// user-44 第四刀(安卓):标签面「合并」(一对一两击式)的回归资产。
// 安卓侧没有 wdio 套件,这件的回归全靠它(与 514 rename / 548 color-create / 549 delete 同族)。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-merge.js
// 自带播种(甲=源 挂 2、乙=目标 挂 1[与甲重叠一条]、丙=旁观 0 挂载)与清场(finally 删净)。
//
// # 判据(⛔ 别只验「能并」——集合并语义与两击的每条退路才是会烂的地方)
//  ① 面头「合并」钮在(≥2 枚才显)。
//  ② 进合并态:提示行(选源文案)+ 取消钮在;列表 = 简行(**无手柄/色钮/类型钮的结构字据**
//     —— 视觉即语义,能点的就是整行);「+ 新建标签」与「合并」钮自己都藏了。
//  ③ 简行触区:整行高 ≥44、五点真打(elementFromPoint)。
//  ④ 第一击选源:.msrc 高亮上行、提示变(带源名)。
//  ⑤ 点自己 = 撤源(高亮消、提示回选源文案)。
//  ⑥ 第二击:合并态**收**(零残留,同删除第一拍纪律)+ 底部确认条弹出、话术带两名与 n、
//     第二拍钮是「并入」。
//  ⑦ 取消 → 库里两枚原样。
//  ⑧ 第二拍 → **集合并落库**:源没了;目标的挂载 = 恰 {载体1,载体2} 无重复
//     (载体1 本来两边都挂 —— 重叠那条只摘源不再加,这一格是 merge 语义的独苗字据)。
//  ⑨ chip 跟上(refreshTimeline 字据):载体2 的 chip 甲→乙;载体1 恰一枚乙(不双挂)。
//  ⑩ 条目本身都在。⑪ 旁观丙不受影响(id 判)。
//  ⑫ 编辑态互斥:改名态开着时点「合并」→ 改名收、合并态开。
//  ⑬ Esc 退合并态。
//  ⑭ 0 挂载的源走简版话术(不带 项/item),并入照常落库。
//  ⑮ 只剩 1 枚时「合并」钮藏(按数据显形那半的字据)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  合成 click 证的是「处理器接对了」,证不了「手指点得到」—— ③ 守几何,驱动侧 swipe 真点
//  一次收口。「确认条挂着时切空间 ⇒ 旧确认作废」页内不造(同 delete 那支),靠 doMerge 的
//  space 复核代码审。「合并态中远端重载不拆态」要远端事件,靠 topicsInteracting() 代码审。
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
  const bar = () => document.getElementById("confirmbar");
  const barQ = () => document.getElementById("confirmbar-q").textContent;
  const err = () => document.getElementById("error");
  const mergeBtn = () => document.getElementById("topics-merge");
  const newBtn = () => document.getElementById("topics-new");
  const hintTxt = () => list().querySelector(".mhint-txt")?.textContent ?? "";
  const mrowOf = (id) => [...list().querySelectorAll(".mrow")].find((r) => r.dataset.topic === id);
  const topicIn = async (id) => (await inv("list_topics_full")).some((t) => t.id === id);
  const notesOf = async (id) => (await inv("list_topics_full")).find((t) => t.id === id)?.notes ?? null;
  const chipsOf = (noteId) => {
    const card = document.querySelector(`#timeline [data-id="${noteId}"]`);
    return card ? [...card.querySelectorAll(".chip")].map((c) => c.textContent.trim()) : null;
  };

  const A0 = "ZJ44并甲", B0 = "ZJ44并乙", C0 = "ZJ44并丙"; // ⚠ 名里别带「项/item」—— ⑭ 靠排除词判简版
  const pane = () => document.getElementById("topics-pane");
  const toggle = () => document.getElementById("topics-toggle").click();
  let a = null, b = null, c = null, note1 = null, note2 = null;
  try {
    // ⛔ 播种前先把标签面收起来(列表只在开面那一刻拉一次;514 的坑,照抄纪律)。
    if (!pane().hidden) { toggle(); await until(() => pane().hidden, 2000); }

    // ---- 播种(幂等:同名已在就复用;载体1 挂甲+乙 = 重叠,载体2 只挂甲) ----
    const pre = await inv("list_topics_full");
    const byT = Object.fromEntries(pre.map((t) => [t.title, t.id]));
    a = byT[A0] ?? (await inv("create_topic", { title: A0 }));
    b = byT[B0] ?? (await inv("create_topic", { title: B0 }));
    c = byT[C0] ?? (await inv("create_topic", { title: C0 }));
    note1 = await inv("capture_idea", { content: "ZJ44并-载体1" });
    note2 = await inv("capture_idea", { content: "ZJ44并-载体2" });
    await inv("file_note_to_topic", { id: note1, topicId: a, newTitle: null });
    // 挂第二枚也走 file_note_to_topic(core 注释:already-filed idea just gains another tag)
    await inv("file_note_to_topic", { id: note1, topicId: b, newTitle: null });
    await inv("file_note_to_topic", { id: note2, topicId: a, newTitle: null });

    toggle();
    // ⛔ 连身份判(data-topic === 这一趟的 id),别只匹配文本(548 的残余 DOM 坑)。
    const rowOf = (title) =>
      [...list().querySelectorAll(".tname")].find((n) => n.textContent.trim() === title);
    const fresh = (title, id) => rowOf(title)?.closest(".trow")?.dataset.topic === id;
    ok("标签面开得出来(且是这一趟的行,不是残余 DOM)",
      await until(() => fresh(A0, a) && fresh(B0, b) && fresh(C0, c), 4000));
    if (!fresh(A0, a)) throw new Error("播种的标签没出现在列表里(或屏上是旧残余),后面全不用跑了");
    // 播种自检:载体1 真挂上了两枚(挂第二枚的命令名要是猜错,⑧ 的重叠格就是空测)
    const n1 = await notesOf(b);
    ok("播种自检:乙挂着载体1(重叠场景真造出来了)", Array.isArray(n1) && n1.some((x) => x.id === note1),
      JSON.stringify(n1?.map?.((x) => x.id)));

    // ---- ① 面头「合并」钮 ----
    ok("① 「合并」钮在且可见(≥2 枚)", !!mergeBtn() && !mergeBtn().hidden);

    // ---- ② 进合并态:提示行 + 简行结构 + 两枚面头钮藏 ----
    mergeBtn().click();
    ok("② 进态:提示行在(选源文案)", await until(() => !!list().querySelector(".mhint"), 2000), hintTxt());
    ok("② 取消钮在", !!list().querySelector("[data-merge-cancel]"));
    ok("② 列表 = 简行(无手柄/色钮/类型钮的结构字据)",
      list().querySelectorAll(".mrow").length === 3 &&
      !list().querySelector(".thandle") && !list().querySelector(".tcolor") &&
      !list().querySelector(".tk-badge") && !list().querySelector(".tk-add"));
    ok("② 「+ 新建标签」藏了", newBtn().hidden);
    ok("② 「合并」钮自己也藏了(取消是唯一出口)", mergeBtn().hidden);

    // ---- ③ 简行触区:整行高 ≥44 + 五点真打 ----
    const r = mrowOf(a).getBoundingClientRect();
    ok("③ 简行高 ≥44", r.height >= 44, `${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const pts = [[cx, cy], [cx, r.y + 3], [cx, r.bottom - 3], [r.x + 3, cy], [r.right - 3, cy]];
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y));
    ok("③ 五点全落在简行上", hits.every((e) => e && e.closest?.(".mrow")),
      hits.map((e) => (e ? e.className || e.tagName : "null")).join(","));

    // ---- ④ 第一击选源 ----
    mrowOf(a).click();
    // ⛔ 只判 class 是恒绿形(样式规则整条删掉它照绿,刀1 第一趟就是这么漏的)——
    // 「高亮」的本体是 outline,连 computed 一起判。
    const srcLit = () => {
      const row = mrowOf(a);
      if (!row || !row.classList.contains("msrc")) return false;
      const cs = getComputedStyle(row);
      // ⚠ 阈值 1.5 不是 2:这台 WebView 把声明的 2px 算成 computed 1.77778px(缩放舍入,
      // 干净树实测),⛔ 别拿 CSS 声明值当 computed 值写阈值;与刀1 的 none/0px 仍分得开。
      return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1.5;
    };
    ok("④ 源行高亮(.msrc 且 outline 真画出来)", await until(srcLit, 2000),
      (() => { const cs = mrowOf(a) && getComputedStyle(mrowOf(a)); return cs && `${cs.outlineStyle}/${cs.outlineWidth}`; })());
    ok("④ 提示变(带源名)", new RegExp(A0).test(hintTxt()), hintTxt());

    // ---- ⑤ 点自己 = 撤源 ----
    mrowOf(a).click();
    ok("⑤ 撤源:高亮消", await until(() => !list().querySelector(".msrc"), 2000));
    ok("⑤ 提示回选源文案", !new RegExp(A0).test(hintTxt()), hintTxt());

    // ---- ⑥ 第二击 → 收态 + 确认条 ----
    mrowOf(a).click();
    await until(() => mrowOf(a)?.classList.contains("msrc") === true, 2000);
    mrowOf(b).click();
    ok("⑥ 合并态收(零残留)", await until(() => !list().querySelector(".mhint") && !list().querySelector(".mrow"), 2000));
    ok("⑥ 确认条弹出", await until(() => !bar().hidden, 2000));
    ok("⑥ 话术带两名与 n=2", new RegExp(A0).test(barQ()) && new RegExp(B0).test(barQ()) && /2 项|2 item/.test(barQ()), barQ());
    ok("⑥ 第二拍钮是「并入」", /并入|Merge/.test(document.getElementById("confirmbar-yes").textContent));

    // ---- ⑦ 取消 → 库里原样 ----
    document.getElementById("confirmbar-no").click();
    await until(() => bar().hidden, 2000);
    ok("⑦ 取消 → 两枚都在", (await topicIn(a)) && (await topicIn(b)));

    // ---- ⑧ 第二拍 → 集合并落库 ----
    err().hidden = true; // 清提示条,防串味
    mergeBtn().click();
    await until(() => !!list().querySelector(".mhint"), 2000);
    mrowOf(a).click();
    await until(() => mrowOf(a)?.classList.contains("msrc") === true, 2000);
    mrowOf(b).click();
    await until(() => !bar().hidden, 2000);
    document.getElementById("confirmbar-yes").click();
    ok("⑧ 源没了", await until(async () => !(await topicIn(a)), 4000));
    const nb = await notesOf(b);
    ok("⑧ 目标挂载 = 恰 {载体1,载体2} 无重复(集合并)",
      Array.isArray(nb) && nb.length === 2 &&
      nb.some((x) => x.id === note1) && nb.some((x) => x.id === note2),
      JSON.stringify(nb?.map?.((x) => x.id)));
    ok("⑧ 提示条说「已合并」", await until(() => !err().hidden && /已合并|Merged/.test(err().textContent), 3000),
      err().textContent.trim().slice(0, 30));

    // ---- ⑨ chip 跟上 ----
    ok("⑨ 载体2 的 chip 甲→乙", await until(() => {
      const ch = chipsOf(note2);
      return ch !== null && ch.includes(B0) && !ch.includes(A0);
    }, 4000), JSON.stringify(chipsOf(note2)));
    ok("⑨ 载体1 恰一枚乙(不双挂)", (() => {
      const ch = chipsOf(note1);
      return ch !== null && ch.filter((x) => x === B0).length === 1 && !ch.includes(A0);
    })(), JSON.stringify(chipsOf(note1)));

    // ---- ⑩/⑪ 条目都在、旁观不受影响 ----
    const tl = await inv("list_timeline");
    ok("⑩ 两条载体后端都在", tl.some((x) => x.id === note1) && tl.some((x) => x.id === note2));
    ok("⑪ 旁观丙不受影响(id 判)", await until(() => fresh(C0, c), 3000));

    // ---- ⑫ 互斥:改名态开着时点「合并」→ 改名收、合并态开 ----
    rowOf(B0).click();
    await until(() => !!list().querySelector(".tn-input"), 2000);
    mergeBtn().click();
    ok("⑫ 改名收、合并态开(编辑态单开)",
      await until(() => !list().querySelector(".tn-input") && !!list().querySelector(".mhint"), 2000));

    // ---- ⑬ Esc 退合并态 ----
    list().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("⑬ Esc → 退回读态", await until(() => !list().querySelector(".mhint") && !!rowOf(B0), 2000));

    // ---- ⑭ 0 挂载的源:简版话术 + 真并 ----
    mergeBtn().click();
    await until(() => !!list().querySelector(".mhint"), 2000);
    mrowOf(c).click();
    await until(() => mrowOf(c)?.classList.contains("msrc") === true, 2000);
    mrowOf(b).click();
    await until(() => !bar().hidden, 2000);
    ok("⑭ 0 挂载 → 简版话术(不带 项/item)",
      new RegExp(C0).test(barQ()) && new RegExp(B0).test(barQ()) && !/项|item/.test(barQ()), barQ());
    document.getElementById("confirmbar-yes").click();
    ok("⑭ 丙也真并掉了", await until(async () => !(await topicIn(c)), 4000));

    // ---- ⑮ 只剩乙一枚:「合并」钮藏 ----
    ok("⑮ <2 枚 → 「合并」钮藏(按数据显形)", await until(() => mergeBtn().hidden, 3000));

    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out, null, 1);
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.pass = false;
    return JSON.stringify(out, null, 1);
  } finally {
    // 清场(⛔ archive → purge,不是 delete_note —— 514 攒过 10 条尸体的教训)。
    for (const n of [note1, note2]) {
      try { if (n) { await inv("archive_note", { id: n }); await inv("purge_note", { id: n }); } } catch { /* 已经没了就算了 */ }
    }
    for (const id of [a, c, b]) {
      try { if (id) await inv("delete_topic", { id }); } catch { /* 正常:⑧/⑭ 已并掉 */ }
    }
  }
})();
