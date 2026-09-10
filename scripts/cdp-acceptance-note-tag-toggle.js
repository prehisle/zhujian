// @cdp-run single timeout=60000
// 用户面 92 第一半(654):**手机端随记的标签摘得掉了** —— 卡片操作面「标签」那一排,
// 点亮的再点一次就摘掉(`remove_note_topic`),与同一排上任务那半同形。
//
// 跑法:node scripts/android-cdp.mjs forward && node scripts/cdp-run.mjs note-tag-toggle
//
// # 为什么要这支(⛔ 别当「能摘就行」的便宜验收)
// 改之前那排 pill 对随记是 `disabled` 的,旁边还挂一句「随记的标签暂只支持添加」——
// 而它给的两条理由(core 没有该原语 / 与桌面能力一致)**两条都不成立**:`remove_note_topic`
// 一直注册在手机壳里,桌面随记卡上一直有 ✕。⇒ 这支守的正是「别再把它改回禁用」:
// ② 直接判 `disabled` / `aria-disabled` 两个属性都不在,④ 判点下去后端真少一枚。
//
// # 判据
//  ① 随记卡开得出标签面,播的两枚标签都在 pill 行里(连 id 一起判,不只判文本 —— 548)
//  ③ 点未点亮的 pill = 挂上(后端 topics 真多一枚)
//  ② ⭐ **已挂**的随记 pill 不带 `disabled` / `aria-disabled`(⛔ 顺序不是笔误:老代码禁的是
//     `!task && on`,没挂上时它也不禁 ⇒ 这一格摆在 ③ 之前就是恒绿的空测)
//  ④ ⭐ 点亮的 pill 再点一次 = 摘掉(后端 topics 真少一枚)—— 核心那一格
//  ⑤ 摘掉最后一枚:后端 stage 由 `filed` 退回 `inbox`,而卡**仍在随记面**(两个 stage 都在
//     `IDEA_STAGES` 里)⇒ 用户眼里只是标签消失,卡不会跳走
//  ⑥ 那句弱提示整行没了(结构判据:tags 面恰两条 `.lane` = pill 行 + 新建行)
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  合成 click 证的是「处理器接对了」,证不了「手指点得到」—— pill 的触区由 topics 那族资产守。
//  「再点一次摘掉」在**桌面**是另一种形(选择器把已挂的藏起来),那是用户面 92 的第二半、
//  要先拍交互形,⛔ 别拿这支的判据去推桌面该长什么样。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra !== undefined ? { extra } : {}) });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(80);
    }
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // ⚠ #timeline 每刷一轮整片重建 ⇒ 一律现查,别缓存节点(316)。
  const cardOf = (id) => document.querySelector('#timeline [data-id="' + id + '"]');
  const panelOf = (id) => cardOf(id)?.querySelector(".panel") ?? null;
  const pillOf = (id, tid) => panelOf(id)?.querySelector('[data-topic="' + tid + '"]') ?? null;
  /** 开卡片面板取「标签」入口(⚠ 面板可能本来就开着,点正文是**收**⇒ 先看在不在)。 */
  const tagsAct = async (id) => {
    for (let i = 0; i < 3; i++) {
      const hit = cardOf(id)?.querySelector('.panel [data-pact="tags"]');
      if (hit) return hit;
      const body = cardOf(id)?.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => cardOf(id)?.querySelector('.panel [data-pact="tags"]'), 1500);
      if (got) return got;
    }
    return null;
  };
  /** 进标签态:`enterTags` 在途会因「记下」还在飞而整趟弃掉 ⇒ 拿 pill 真出现当判据,重试。 */
  const enterTags = async (id, ...want) => {
    for (let i = 0; i < 3; i++) {
      const act = await tagsAct(id);
      if (!act) return false;
      click(act);
      if (await until(() => want.every((tid) => pillOf(id, tid)), 4000)) return true;
    }
    return false;
  };
  const itemOf = async (id) => (await inv("list_timeline")).find((x) => x.id === id) ?? null;
  const topicIdsOf = async (id) => ((await itemOf(id))?.topics ?? []).map((t) => t.id).sort();

  const A0 = "ZJ92标甲", B0 = "ZJ92标乙";
  let a = null, b = null, note = null;
  try {
    // ---- 播种:两枚标签(幂等,同名已在就复用)+ 一条随记 ----
    const pre = await inv("list_topics_full");
    const byT = Object.fromEntries(pre.map((t) => [t.title, t.id]));
    a = byT[A0] ?? (await inv("create_topic", { title: A0 }));
    b = byT[B0] ?? (await inv("create_topic", { title: B0 }));

    const ideas = document.querySelector('#bottombar [data-mode="ideas"]');
    click(ideas);
    if (!ok("切到随记面", await until(() => ideas.classList.contains("active"), 2000))) return out;
    const marker = "【CDP验收】92 摘标签 " + Date.now();
    document.getElementById("text").value = marker;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("探针随记入时间轴", !!card)) return out;
    note = card.dataset.id;

    // ---- ① 开标签面:两枚播的种都在,连 id 一起判 ----
    if (!ok("① 标签面开得出来(且是这一趟播的两枚)", await enterTags(note, a, b))) return out;

    // ---- ③ 点未点亮的 = 挂上(甲、乙各一枚)----
    click(pillOf(note, a));
    ok("③ 点甲挂上(后端真多一枚)",
      (await until(async () => (await topicIdsOf(note)).includes(a), 5000)) !== null);
    await until(() => pillOf(note, a)?.classList.contains("on"), 3000);

    // ---- ② 随记**已挂**的 pill 不禁用 ----
    // ⛔⛔ 这一格必须在 ③ 之后量,别挪到前面去:改之前禁的是 `!task && on`,标签还没挂上时
    // 老代码也不禁 ⇒ 摆在 ③ 之前是**恒绿的空测**(654 第一版就这么写的,阴性刀当场照出来)。
    const pa = () => pillOf(note, a);
    ok("② 已挂的随记 pill 无 disabled 属性", !pa().disabled && !pa().hasAttribute("disabled"));
    ok("② 已挂的随记 pill 无 aria-disabled", !pa().hasAttribute("aria-disabled"), pa().getAttribute("aria-disabled"));

    click(pillOf(note, b));
    ok("③ 点乙挂上(后端两枚都在)",
      (await until(async () => (await topicIdsOf(note)).length === 2, 5000)) !== null);
    await until(() => pillOf(note, b)?.classList.contains("on"), 3000);

    // ---- ⑥ 弱提示那一行没了:tags 面恰两条 .lane(pill 行 + 新建行)----
    ok("⑥ 挂着标签时没有多出的提示行(恰两条 .lane)",
      panelOf(note)?.querySelectorAll(".lane").length === 2,
      panelOf(note)?.querySelectorAll(".lane").length);

    // ---- ④ 核心:点亮的再点一次 = 摘掉 ----
    if (!ok("④ 甲此刻是点亮的(摘之前的前置)", pillOf(note, a)?.classList.contains("on"))) return out;
    click(pillOf(note, a));
    const afterFirst = await until(async () => {
      const ids = await topicIdsOf(note);
      return ids.length === 1 && ids[0] === b ? ids : null;
    }, 5000);
    ok("④ 点亮的甲再点一次就摘掉(后端只剩乙)", !!afterFirst, afterFirst);
    ok("④ 甲的 pill 随之熄灭", (await until(() => !pillOf(note, a)?.classList.contains("on"), 3000)) !== null);

    // ---- ⑤ 摘掉最后一枚:stage 退回 inbox,卡不跳走 ----
    const before = await itemOf(note);
    ok("⑤ 摘之前是「已整理」(filed)", before?.stage === "filed", before?.stage);
    click(pillOf(note, b));
    const bare = await until(async () => {
      const it = await itemOf(note);
      return it && it.topics.length === 0 ? it : null;
    }, 5000);
    ok("⑤ 最后一枚也摘得掉(后端零标签)", !!bare);
    ok("⑤ stage 退回 inbox", bare?.stage === "inbox", bare?.stage);
    ok("⑤ 卡仍在随记面(没跳走)", (await until(() => !!cardOf(note), 3000)) !== null);
  } catch (e) {
    out.runError = String(e?.message ?? e);
  } finally {
    // ---- 清场:随记走 archive_note → purge_note(⛔ 归档后 delete_note 必被拒,吞掉即攒尸体)----
    try {
      if (note) {
        await inv("archive_note", { id: note });
        await inv("purge_note", { id: note });
      }
      for (const t of [a, b]) if (t) await inv("delete_topic", { id: t });
      const left = await inv("list_topics_full");
      out.steps.push({
        name: "清场:探针标签与随记零残留",
        ok: !left.some((t) => t.id === a || t.id === b) &&
          !(await inv("list_timeline")).some((x) => x.id === note),
      });
    } catch (e) {
      out.steps.push({ name: "清场:探针标签与随记零残留", ok: false, extra: String(e?.message ?? e) });
    }
  }
  out.pass = out.steps.length > 0 && out.steps.every((s) => s.ok) && !out.runError;
  return out;
})()
