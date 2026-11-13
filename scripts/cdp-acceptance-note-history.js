// @cdp-run single timeout=60000
// 用户面 87(677):**手机上能看编辑历史了** —— 卡片操作面多一枚「历史」,只读列出这条改过的旧版本
// (新的在前),⛔ 没有「恢复」(不可变性是历史级)。当初手机层的历史命令早就暴露、api.ts 的
// 包装也早在,只是没有任何界面用它 —— 搜索明说「改过的旧版本也一起搜」,搜出来点进去看到的却是今天这版。
// longform 1b(816 起):历史改走「目录分页 + 取两版」两条命令 —— 目录只有「时间 · 字数」,点开一版才取正文。
//
// 跑法:node scripts/android-cdp.mjs forward && node scripts/cdp-run.mjs note-history
//
// # 判据
//  ① 改过的随记卡,操作面「更多…」里有「历史」入口(data-pact="history")
//  ② 没改过的随记:「更多…」里**不列**「历史」(165 / W5 A45:指南「改过的才有」;此前列着、点进去只一句「还没有改过」)
//  ③ 改两次之后(第一次走编辑层 UI —— 卡上的「改过」要靠那一趟重拉才进快照;第二次 edit_note 走 IPC):历史面恰两块,**新的在前**(历史里存的是被替换掉的那一版:改成 v2
//     时存 v1、改成 v3 时存 v2 ⇒ 列表 = [v2, v1]);**没点开时 DOM 里一份正文都没有**(目录不带正文);
//     点开一块才显示那一版、逐字对上;再点另一块 = 前一块收起,同一时刻只展开一版
//  ④ 每块都有时间字与字数;**没有修改 / 恢复的动作** —— 历史面里的按钮只许是版本块头(data-rev,
//     只是「看」)与「更早的版本」(只有超过一页才出现)(只读:改回去要走编辑)
//  ⑤ 「返回」回到操作面(edit 入口又在)
//  ⑥ 任务卡同一条规矩:没改过不列「历史」(item_revisions 是 items 表级的,随记与任务同一张表)
//  ⑦ 翻页:51 版时第一页 50 块 +「更早的版本」,点了接上第 51 块、不重不漏,翻到底按钮消失
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
  const inPanel = (id, pact) =>
    panelOf(id)?.querySelector('[data-pact="' + pact + '"]') ??
    (panelOf(id) && document.getElementById("more-sheet").classList.contains("open") ? document.querySelector('#more-list [data-more-act="' + pact + '"]') : null); // 906:「更多…」是屏底菜单层 ⇒ 面里没有的那几枚到层里找(#more-list [data-more-act])
  /** 开卡片面板取某个入口(面板可能本来就开着,点正文是**收**⇒ 先看在不在)。
   *  706 起主面只剩四枚,「历史」在「更多…」后面 ⇒ 先把面板弄回主面(判据 = `more` 在不在),
   *  主面上没有的再钻一层。⛔ 别写成「恒先点 more」:主面那四枚在更多面里找不着。 */
  const actOf = async (id, pact) => {
    for (let i = 0; i < 4; i++) {
      if (!inPanel(id, "more")) {
        const body = cardOf(id)?.querySelector(".content");
        if (!body) return null;
        const back = inPanel(id, "back");
        if (back) click(back); // 停在某张子面上:先回主面
        else click(body); // 面板没开:点正文开它
        await until(() => inPanel(id, "more"), 1500);
        continue;
      }
      const hit = inPanel(id, pact);
      if (hit) return hit;
      click(inPanel(id, "more"));
      return await until(() => inPanel(id, pact), 1500);
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

    // ---- ② 没改过:「更多…」里不列「历史」(A45)----
    const none = await actOf(note, "history");
    ok("② 没改过:「更多…」里没有「历史」(A45)", none === null);
    ok("② …「更多…」确实开着(前置:别把没开成读成没有)", !!inPanel(note, "copy"));
    window.__zhujianHandleBack(); // 906:「更多…」是屏底菜单层,没有「返回」钮 ⇒ 走返回键那条入口收层
    await until(() => !document.getElementById("more-sheet").classList.contains("open"), 1500);
    if (!ok("⑤ 「返回」回到操作面(edit 入口又在)", (await until(() => panelOf(note)?.querySelector('[data-pact="edit"]'), 3000)) !== null)) return out;

    // ---- 改两次(历史里存的是被换掉的那一版):第一次走编辑层(保存后整轴重拉,卡上「改过」进快照),第二次走 IPC ----
    const v2 = v1 + " v2", v3 = v1 + " v3";
    click(inPanel(note, "edit"));
    if (!ok("编辑层开得出来(前置)", await until(() => document.getElementById("edit-sheet").classList.contains("open"), 2000))) return out;
    const et = document.getElementById("edit-text");
    et.value = v2;
    et.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("edit-save"));
    if (!ok("编辑层存成 v2(前置)", await until(() => cardOf(note)?.querySelector(".edited-mark") && cardOf(note)?.querySelector(".content")?.textContent.includes(" v2"), 5000))) return out;
    await inv("edit_note", { id: note, content: v3 });
    const cat = await inv("list_revisions", { id: note, before: null });
    const ids = cat.entries.map((r) => r.revision_id);
    const t0 = ids.length === 2 ? await inv("revision_texts", { id: note, a: { rev: ids[0] }, b: { rev: ids[1] } }) : null;
    if (!ok("后端:两版旧内容,新的在前、目录不带正文(前置)",
      cat.total === 2 && t0?.a.content === v2 && t0?.b.content === v1 && cat.entries.every((r) => !("content" in r)),
      { cat, t0 })) return out;

    // ---- ③ / ④ 历史面恰两块、顺序与正文逐字对上、有时间字、零按钮 ----
    // 面板还开着(actions 面)⇒ 直接点「历史」;enterHistory 会自己重试。
    const hist = await enterHistory(note);
    if (!ok("③ 改过之后历史面开得出来", !!hist)) return out;
    const blocks = [...hist.querySelectorAll(".rev")];
    ok("③ 恰两块", blocks.length === 2, blocks.length);
    ok("③ 没点开时 DOM 里一份正文都没有", hist.querySelectorAll(".rev p").length === 0 && !hist.textContent.includes(v1));
    ok("③ 块头按 revision_id 新的在前", blocks.map((b) => Number(b.querySelector("[data-rev]")?.dataset.rev)).join() === ids.join(),
      blocks.map((b) => b.querySelector("[data-rev]")?.dataset.rev));
    ok("④ 每块都有时间字与字数", blocks.every((b) =>
      (b.querySelector("time")?.textContent ?? "").trim().length > 0 && /\d/.test(b.querySelector(".n")?.textContent ?? "")),
      blocks.map((b) => b.textContent));
    const revBtns = [...hist.querySelectorAll("button")];
    ok("④ 没有修改 / 恢复动作:历史区的按钮只有版本块头", revBtns.length === 2 && revBtns.every((b) => b.matches("[data-rev]") && !b.dataset.pact),
      revBtns.map((b) => b.outerHTML.slice(0, 80)));
    ok("④ 一页之内没有「更早的版本」", !panelOf(note)?.querySelector('[data-pact="histmore"]'));
    // 点开第二块(v1)→ 只它展开、逐字对上;再点第一块(v2)→ 换成 v2、仍只一块展开
    // 157 G4 / P5 起点开一版画的是「这一版 → 现在」的比对(shared/diff-dom),不是旧版全文 ⇒ 从比对里拼回旧的那一侧(相等 + 删掉的行)。
    // 165 / W5 A32:比对前两版末行换行补齐(只改拿去比的那两份)⇒ 拼回来末尾多一个换行,去掉再对。
    const openOld = () => {
      const open = [...(panelOf(note)?.querySelectorAll(".rev.open") ?? [])];
      const d = open.length === 1 ? open[0].querySelector(".diff") : null;
      if (!d) return { n: open.length, old: null };
      let a = "";
      for (const k of d.children) if (k.classList.contains("diff-eq") || k.classList.contains("diff-del")) a += k.textContent;
      return { n: open.length, old: a.replace(/\n$/, "") };
    };
    click(panelOf(note).querySelector(`[data-rev="${ids[1]}"]`));
    ok("③ 点开一块才显示那一版(v1;比对的旧那一侧逐字对上)", (await until(() => openOld().old === v1)) !== null, openOld());
    click(panelOf(note).querySelector(`[data-rev="${ids[0]}"]`));
    ok("③ 换一块 = 前一块收起,只展开 v2", (await until(() => { const o = openOld(); return o.n === 1 && o.old === v2; })) !== null, openOld());
    click(inPanel(note, "back")); // 历史面自己那枚「返回」(906 前这里绕了一圈:actOf 先回主面、再进「更多…」那一面拿它的「返回」)
    ok("⑤ 「返回」回到操作面", (await until(() => panelOf(note)?.querySelector('[data-pact="edit"]'), 3000)) !== null);

    // ---- ⑦ 翻页:再改 49 次 ⇒ 51 版,一页 50 ⇒ 第一页 50 块 +「更早的版本」,点了接上第 51 块 ----
    for (let k = 4; k <= 52; k++) await inv("edit_note", { id: note, content: v1 + " v" + k });
    const paged = await enterHistory(note);
    if (!ok("⑦ 51 版时历史面开得出来", !!paged)) return out;
    ok("⑦ 第一页恰 50 块", paged.querySelectorAll(".rev").length === 50, paged.querySelectorAll(".rev").length);
    const moreBtn = panelOf(note)?.querySelector('[data-pact="histmore"]');
    if (!ok("⑦ 有「更早的版本」", !!moreBtn)) return out;
    click(moreBtn);
    ok("⑦ 点了接上最早那一块、不重不漏(51 个不同 id)",
      (await until(() => {
        const ids2 = [...(panelOf(note)?.querySelectorAll("[data-rev]") ?? [])].map((b) => b.dataset.rev);
        return ids2.length === 51 && new Set(ids2).size === 51 ? ids2 : null;
      })) !== null);
    ok("⑦ 翻到底后「更早的版本」消失", !panelOf(note)?.querySelector('[data-pact="histmore"]'));
    click(inPanel(note, "back")); // 历史面自己那枚「返回」(906 前这里绕了一圈:actOf 先回主面、再进「更多…」那一面拿它的「返回」)

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
    ok("⑥ 没改过的任务卡同样不列「历史」(A45)", (await actOf(task, "history")) === null && !!inPanel(task, "copy"));
    window.__zhujianHandleBack(); // 906:「更多…」是屏底菜单层,没有「返回」钮 ⇒ 走返回键那条入口收层
    await until(() => !document.getElementById("more-sheet").classList.contains("open"), 1500);
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
