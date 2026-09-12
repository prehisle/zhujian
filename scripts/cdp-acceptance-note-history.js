// @cdp-run single timeout=60000
// 用户面 87(677):**手机上能看编辑历史了** —— 卡片操作面多一枚「历史」,只读列出这条改过的旧版本
// (新的在前),⛔ 没有「恢复」(不可变性是历史级)。此前 `list_note_history` 手机层早就暴露、api.ts 的
// 包装也早在,只是没有任何界面用它 —— 搜索明说「改过的旧版本也一起搜」,搜出来点进去看到的却是今天这版。
//
// 跑法:node scripts/android-cdp.mjs forward && node scripts/cdp-run.mjs note-history
//
// # 判据
//  ① 随记卡的操作面上有「历史」入口(data-pact="history")
//  ② 没改过的随记:历史面是一句「还没有改过」,没有版本块、没有任何按钮(除「返回」)
//  ③ 改两次之后(edit_note 走 IPC):历史面恰两块,**新的在前**、正文逐字对上(历史里存的是被替换掉的
//     那一版:改成 v2 时存 v1、改成 v3 时存 v2 ⇒ 列表 = [v2, v1])
//  ④ 每块都有时间字;整个 .hist 里**零个 button**(只读:改回去要走编辑)
//  ⑤ 「返回」回到操作面(edit 入口又在)
//  ⑥ 任务卡同样有「历史」入口(item_revisions 是 items 表级的,随记与任务同一张表)
//
// # 这支守不到的那半
//  合成 click 证的是「处理器接对了」,证不了「手指点得到」—— 动作胶囊的触区由 hit-zone 门禁与 p1-touch 守。
//  「搜索命中旧版本 → 点进去」那条路本身没变,这里不重验。
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
  /** 开卡片面板取某个入口(面板可能本来就开着,点正文是**收**⇒ 先看在不在)。 */
  const actOf = async (id, pact) => {
    for (let i = 0; i < 3; i++) {
      const hit = panelOf(id)?.querySelector('[data-pact="' + pact + '"]');
      if (hit) return hit;
      const body = cardOf(id)?.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => panelOf(id)?.querySelector('[data-pact="' + pact + '"]'), 1500);
      if (got) return got;
    }
    return null;
  };
  /** 进历史面:enterHistory 在途会因「记下」还在飞而弃掉 ⇒ 拿 .hist 真出现当判据,重试。 */
  const enterHistory = async (id) => {
    for (let i = 0; i < 3; i++) {
      const act = await actOf(id, "history");
      if (!act) return null;
      click(act);
      const hist = await until(() => panelOf(id)?.querySelector(".hist"), 4000);
      if (hist) return hist;
    }
    return null;
  };

  let note = null, task = null;
  try {
    const ideas = document.querySelector('#bottombar [data-mode="ideas"]');
    click(ideas);
    if (!ok("切到随记面", await until(() => ideas.classList.contains("active"), 2000))) return out;
    const v1 = "【CDP验收】87 历史 v1 " + Date.now();
    document.getElementById("text").value = v1;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(v1),
      ),
    );
    if (!ok("探针随记入时间轴", !!card)) return out;
    note = card.dataset.id;

    // ---- ① / ② 没改过:入口在,历史面是一句话 ----
    const empty = await enterHistory(note);
    if (!ok("① 操作面上有「历史」入口,历史面开得出来", !!empty)) return out;
    ok("② 没改过时是一句「还没有改过」,零个版本块", empty.querySelectorAll(".rev").length === 0 && /还没有改过|Not edited/.test(empty.textContent), empty.textContent.trim());
    ok("② 历史面里没有按钮(只读)", empty.querySelectorAll("button").length === 0);
    click(await actOf(note, "back"));
    if (!ok("⑤ 「返回」回到操作面(edit 入口又在)", (await until(() => panelOf(note)?.querySelector('[data-pact="edit"]'), 3000)) !== null)) return out;

    // ---- 改两次(走 IPC,不经 UI;历史里存的是被换掉的那一版)----
    const v2 = v1 + " v2", v3 = v1 + " v3";
    await inv("edit_note", { id: note, content: v2 });
    await inv("edit_note", { id: note, content: v3 });
    const revs = await inv("list_note_history", { id: note });
    if (!ok("后端:两版旧内容,新的在前(前置)", revs.length === 2 && revs[0].content === v2 && revs[1].content === v1, revs.map((r) => r.content))) return out;

    // ---- ③ / ④ 历史面恰两块、顺序与正文逐字对上、有时间字、零按钮 ----
    // 面板还开着(actions 面)⇒ 直接点「历史」;enterHistory 会自己重试。
    const hist = await enterHistory(note);
    if (!ok("③ 改过之后历史面开得出来", !!hist)) return out;
    const blocks = [...hist.querySelectorAll(".rev")];
    ok("③ 恰两块", blocks.length === 2, blocks.length);
    ok("③ 新的在前、正文逐字对上(v2 → v1)",
      blocks[0]?.querySelector("p")?.textContent === v2 && blocks[1]?.querySelector("p")?.textContent === v1,
      blocks.map((b) => b.querySelector("p")?.textContent));
    ok("④ 每块都有时间字", blocks.every((b) => (b.querySelector("time")?.textContent ?? "").trim().length > 0),
      blocks.map((b) => b.querySelector("time")?.textContent));
    ok("④ 整个历史面零个 button(只读,没有「恢复」)", hist.querySelectorAll("button").length === 0);
    click(await actOf(note, "back"));
    ok("⑤ 「返回」回到操作面", (await until(() => panelOf(note)?.querySelector('[data-pact="edit"]'), 3000)) !== null);

    // ---- ⑥ 任务卡也有入口(同一张表)----
    const tasksTab = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasksTab);
    if (!ok("切到任务面", await until(() => tasksTab.classList.contains("active"), 2000))) return out;
    // 任务面的「记下」建的就是任务(captureTodo)—— 走 UI 建,建完自己进时间轴(IPC 建的不会推动刷新,
    // 第一趟就栽在这:来回切面也不重拉)。
    const tv = "【CDP验收】87 任务历史 " + Date.now();
    document.getElementById("text").value = tv;
    click(document.getElementById("save"));
    const tcard = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(tv),
      ),
    5000);
    if (!ok("探针任务入时间轴", !!tcard)) return out;
    task = tcard.dataset.id;
    const th = await enterHistory(task);
    ok("⑥ 任务卡同样开得出历史面(还没改过那句)", !!th && th.querySelectorAll(".rev").length === 0, th?.textContent.trim());
    click(await actOf(task, "back"));
  } catch (e) {
    out.runError = String(e?.message ?? e);
  } finally {
    // ---- 清场:随记 archive_note → purge_note;任务 archive_task → purge_task ----
    try {
      if (note) {
        await inv("archive_note", { id: note });
        await inv("purge_note", { id: note });
      }
      if (task) {
        await inv("archive_task", { id: task });
        await inv("purge_task", { id: task });
      }
      const tl = await inv("list_timeline");
      out.steps.push({
        name: "清场:探针随记与任务零残留",
        ok: !tl.some((x) => x.id === note || x.id === task),
      });
    } catch (e) {
      out.steps.push({ name: "清场:探针随记与任务零残留", ok: false, extra: String(e?.message ?? e) });
    }
  }
  out.pass = out.steps.length > 0 && out.steps.every((s) => s.ok) && !out.runError;
  return out;
})()
