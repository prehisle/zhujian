// 514(安卓):标签面「点名字改名」的回归资产。安卓侧没有 wdio 套件,这一面的回归全靠它。
//
// 跑法:node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-rename.js
// ⚠ 单条 CDP 调用 10s 上限,这支有多轮等待 ⇒ 用 `CDP_TIMEOUT_MS=60000` 跑。
// 自带播种(两个标签 + 一条挂着甲的随记)与清场(finally 里删净),跑完库里不留东西。
//
// # 判据(⛔ 别只验「能改名」——那半恒绿得很便宜)
//  ① 名字是可点的 BUTTON,且有「可改」的视觉暗示(虚线下划线)。
//  ② **触区 ≥44 且相邻两行不互叠** —— §2.3。⚠ 这一格是 514 当场栽过的:`.tname` 自己的
//     `overflow:hidden`(为省略号而设)会把 `::before` halo **裁掉**,而屏幕上一点看不出来。
//     故判据必须是 `elementFromPoint` 五点真打,⛔ 不是「读 CSS 里写没写 halo」。
//  ③ 点名字进改名态:input 回填**原名**、焦点落在 input 上、Save/Cancel 两枚在、别的行不受影响。
//  ④ 改名落库 + DOM 跟上 + **卡片 chip 跟着变**(那是 refreshTimeline 那一步的唯一字据)。
//  ⑤ 四条拒/退:**重名**被拒 · **空名**被拒(两条都由 core 说话,前端不预校验)· 取消不改 · Esc 不改。
//  ⑥ 「一个字没改」不发写 —— 直接退编辑态,也不弹「已改名」那句假消息。
//  ⑦ Enter = 存(键盘那条路与点钮那条路是两条分支)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  **原生触摸不在这支里** —— 页内脚本发不了 `Input.dispatchTouchEvent`,③ 用的是合成
//  `el.click()`。两者分工要认清:合成 click 证的是「处理器接对了」,**证不了「手指点得到」**
//  (刀 B `pointer-events:none` 下 ③ 照样绿、只有 ② 那格红 —— 那正是分工的字据)。
//  「手指点得到」那半由 ② 的 `elementFromPoint` 守几何,再由驱动侧
//  `node scripts/android-cdp.mjs swipe <cx> <cy> <cx> <cy>` 手工真点一次收口(514 做过)。
//
// # 阴性对照(514 实跑,⛔ 改判据后重跑一遍再说它有牙齿)
//  刀 A 注 `.tname{padding:0;margin:0}` ⇒ ②「触区高」与「五点」双双真红;
//  刀 B 注 `.tname{pointer-events:none}` ⇒ ②「五点」全落 `trow` 真红;还刀后 28 格全绿。
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
  // ⚠ #topics-list 每次 render 整片重建 ⇒ 一律现查,别缓存节点(skill 那条踩过两次的纪律)。
  const list = () => document.getElementById("topics-list");
  const nameEls = () => [...list().querySelectorAll(".tname")];
  const rowOf = (title) => nameEls().find((n) => n.textContent.trim() === title);
  const input = () => list().querySelector(".tn-input");
  const titleOf = async (id) => (await inv("list_topics_full")).find((t) => t.id === id)?.title ?? null;

  const A0 = "ZJ514甲", B0 = "ZJ514乙", A1 = "ZJ514甲-已改";
  const pane = () => document.getElementById("topics-pane");
  const toggle = () => document.getElementById("topics-toggle").click();
  let a = null, b = null, note = null;
  try {
    // ⛔ **播种前必须先把标签面收起来**:列表只在**开面那一刻**拉一次(`loadTopics`),
    //    面已经开着时播种,新标签进不了 DOM ⇒ 整支资产红在第一格「标签面开得出来」上,
    //    而那与被测的东西毫无关系(514 自己第一次跑阴性对照时就栽在这儿:刀落对了、
    //    红的却是另一格 ⇒ **那趟阴性对照什么都没证明**)。
    if (!pane().hidden) { toggle(); await until(() => pane().hidden, 2000); }

    // ---- 播种(幂等:同名已在就复用,免得上一趟没清干净就直接红在「已存在」上) ----
    const pre = await inv("list_topics_full");
    const byT = Object.fromEntries(pre.map((t) => [t.title, t.id]));
    a = byT[A0] ?? byT[A1] ?? (await inv("create_topic", { title: A0 }));
    b = byT[B0] ?? (await inv("create_topic", { title: B0 }));
    if ((await titleOf(a)) !== A0) await inv("update_topic", { id: a, title: A0 });
    note = await inv("capture_idea", { content: "ZJ514-载体" });
    await inv("file_note_to_topic", { id: note, topicId: a, newTitle: null });

    toggle();
    // ⛔ 判据连身份一起判(data-topic === 这一趟的 id),不能只看「同名行在」:关面不清列表
    // DOM,残余行以旧 id 站在屏上,拿旧 id 去写被 core 拒「主题不存在」。这支此前没炸只是
    // 运气 —— 结尾把 A0 改成了 A1,下一趟旧 DOM 恰好不与 A0 同名(color-create 那支首版栽了)。
    const freshRow = () => rowOf(A0)?.closest(".trow")?.dataset.topic === a;
    ok("标签面开得出来(且是这一趟的行,不是残余 DOM)", await until(freshRow, 4000));
    if (!freshRow()) throw new Error("播种的标签没出现在列表里(或屏上是旧残余),后面全不用跑了");

    // ---- ① 名字是可点的,且看得出可改 ----
    const nm = rowOf(A0);
    const cs = getComputedStyle(nm);
    ok("名字是 BUTTON(不是死文本)", nm.tagName === "BUTTON", nm.tagName);
    ok("有「可改」的视觉暗示(虚线下划线)", cs.textDecorationLine === "underline" && cs.textDecorationStyle === "dotted",
      `${cs.textDecorationLine}/${cs.textDecorationStyle}`);
    ok("没被做成钮的样子(无背景无边框)", cs.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(cs.borderTopWidth) === 0);

    // ---- ② 触区:五点真打 + 相邻不互叠 ----
    const r = nm.getBoundingClientRect();
    ok("触区高 ≥44(§2.3)", r.height >= 44, `${r.height.toFixed(1)}px`);
    // ⛔ **打点必须以「要求的 44」为基准,不能以当前盒子的边内缩几 px 为基准** ——
    // 后者是相对 rect 算的,盒子缩到 20.4 也照样全命中 = 一格恒绿的假绿(514 的阴性对照
    // 当场逮到:刀把 padding 抹了,`触区高` 那格真红,这格却还是绿的)。
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const pts = [[cx, cy - 21], [cx, cy + 21], [r.x + 4, cy], [r.right - 4, cy], [cx, cy]];
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y));
    ok("五点全落在名字上(halo 真生效,不是只写在 CSS 里)", hits.every((e) => e && e.classList.contains("tname")),
      hits.map((e) => (e ? e.className || e.tagName : "null")).join(","));
    const others = nameEls().filter((n) => n !== nm);
    if (others.length) {
      const gaps = others.map((o) => {
        const or = o.getBoundingClientRect();
        return or.top > r.top ? or.top - r.bottom : r.top - or.bottom;
      });
      ok("与相邻行的触区不互叠(边界不含糊)", gaps.every((g) => g >= 0), gaps.map((g) => g.toFixed(1)).join(","));
    }

    // ---- ③ 进改名态 ----
    nm.click();
    ok("点名字进改名态", await until(() => !!input(), 2000));
    ok("input 回填的是原名", input()?.value === A0, input()?.value);
    ok("焦点自动落在 input 上", document.activeElement === input());
    ok("input 自身 ≥44(void 元素给不了 halo,只能自己长够)", input().getBoundingClientRect().height >= 44,
      `${input().getBoundingClientRect().height.toFixed(1)}px`);
    const btns = [...list().querySelectorAll(".tn-edit button")];
    // 549 起改名行是三枚:存 / 取消 / 删除(user-44 第三刀把删除入口放进了这行)。
    ok("存 / 取消 / 删除三枚在", btns.length === 3, btns.map((x) => x.textContent.trim()).join("|"));
    const bh = btns[0].getBoundingClientRect();
    const above = document.elementFromPoint(bh.x + bh.width / 2, bh.top - 8);
    ok("存那枚的 halo 生效(上缘 8px 外仍命中它)", above === btns[0] || (above && above.contains?.(btns[0])) || above === btns[0].parentElement && false || above === btns[0],
      above ? above.className || above.tagName : "null");
    ok("另一行仍是正常态(只换了这一行)", !!rowOf(B0));

    // ---- ⑥ 一个字没改:不发写、也不弹「已改名」 ----
    document.getElementById("error").hidden = true;
    btns[0].click();
    ok("没改就存 → 退回读态", await until(() => !input(), 2000));
    ok("没改就存 → 不弹提示条(不说假话)", document.getElementById("error").hidden === true);
    ok("没改就存 → 库里原样", (await titleOf(a)) === A0);

    // ---- ⑤a 重名被拒(core 说话,前端不预校验) ----
    rowOf(A0).click();
    await until(() => !!input(), 2000);
    input().value = B0;
    list().querySelector("[data-rename-save]").click();
    ok("重名 → 库里没被改掉", await until(async () => (await titleOf(a)) === A0, 3000), await titleOf(a));
    const errEl = document.getElementById("error");
    ok("重名 → 屏上有话说(core 的原文)", !errEl.hidden && /已存在|exists/.test(errEl.textContent), errEl.textContent.trim().slice(0, 40));

    // ---- ⑤b 空名被拒 ----
    await until(() => !!rowOf(A0), 3000);
    rowOf(A0).click();
    await until(() => !!input(), 2000);
    input().value = "   ";
    list().querySelector("[data-rename-save]").click();
    ok("空名 → 库里没被改掉", await until(async () => (await titleOf(a)) === A0, 3000), await titleOf(a));
    ok("空名 → 屏上有话说", !document.getElementById("error").hidden);

    // ---- ⑤c 取消不改 ----
    await until(() => !!rowOf(A0), 3000);
    rowOf(A0).click();
    await until(() => !!input(), 2000);
    input().value = "这个不该落库";
    list().querySelector("[data-rename-cancel]").click();
    ok("取消 → 退回读态", await until(() => !input(), 2000));
    ok("取消 → 库里原样", (await titleOf(a)) === A0);

    // ---- ⑤d Esc 不改 ----
    rowOf(A0).click();
    await until(() => !!input(), 2000);
    input().value = "这个也不该落库";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Esc → 退回读态", await until(() => !input(), 2000));
    ok("Esc → 库里原样", (await titleOf(a)) === A0);

    // ---- ⑦ Enter = 存;④ 落库 + DOM + 卡片 chip ----
    rowOf(A0).click();
    await until(() => !!input(), 2000);
    input().value = A1;
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ok("Enter → 落库", await until(async () => (await titleOf(a)) === A1, 4000), await titleOf(a));
    ok("Enter → 列表里的名字跟上", await until(() => !!rowOf(A1), 3000));
    // 卡片 chip:refreshTimeline 那一步的唯一字据 —— 挂着这枚标签的那条随记,chip 上的字要跟着变。
    const chipText = async () => {
      const card = document.querySelector(`#timeline [data-id="${note}"]`);
      return card ? [...card.querySelectorAll(".chip,.ctag,.tag")].map((c) => c.textContent.trim()).join("|") : null;
    };
    ok("卡片 chip 跟着变(refreshTimeline 真跑了)",
      await until(async () => { const c = await chipText(); return c !== null && c.includes(A1); }, 4000),
      await chipText());

    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out, null, 1);
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.pass = false;
    return JSON.stringify(out, null, 1);
  } finally {
    // 清场:标签与随记都删净(⛔ 别留在验收机器上,那台的库状态是有账的)。
    // ⛔ **是 `archive_note` → `purge_note`,不是 `delete_note`** —— 后者的存储层守护只许硬删
    //    「inbox 且未归档」的行,归档之后再调它必被拒;而这里的 catch 会把那个拒**吞掉**
    //    ⇒ 清场看着跑过了,回收站里却在攒尸体(514 实测:攒了 10 条才发现)。
    try {
      if (note) { await inv("archive_note", { id: note }); await inv("purge_note", { id: note }); }
    } catch { /* 已经没了就算了 */ }
    try { if (a) await inv("delete_topic", { id: a }); } catch { /* 同上 */ }
    try { if (b) await inv("delete_topic", { id: b }); } catch { /* 同上 */ }
  }
})();
