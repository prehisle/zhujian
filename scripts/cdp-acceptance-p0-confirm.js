// @cdp-run single
// 144 P0 #4:两拍确认改底部固定确认条(#confirmbar)——第一拍不再原位换长文案
// (按钮几何恒定),第二拍恒落 fixed 条;取消/收面即废旧确认(token)。
// 真数据全流程:建临时灵感 → 面板「删除」第一拍弹条+原按钮几何不变 → 取消不删 →
// 再删确认入回收站 → 回收站「彻底删除」两拍真销毁 → 全程零残留。
// 跑法 `node scripts/cdp-run.mjs p0-confirm`(⛔ 别裸 evalfile:退出码恒 0);
// CDP 单调用 10s 上限,等待全用轮询不用死睡。
// ⚠ 91 改了两处形,别改回去:①回收站两枚离场钮**不常驻**(51 起点卡片才出面板)⇒ 取钮走
//   `openTrashAct`;②**清场进 finally** —— 从前中途一红就把探针条目留在库里,而红是常态。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const cb = document.getElementById("confirmbar");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const trashRow = (id) => document.querySelector(`[data-trash="${id}"]`);
  const trashBtn = () => document.querySelector('#bottombar [data-pane="trash"]');
  const trashOpen = () => !document.getElementById("trash-pane").hidden;
  // 回收站面是 toggle:要开就开、要收就收,⛔ 别盲点(盲点一次 = 该开的时候把它收了)。
  const setTrash = async (want) => {
    if (trashOpen() === want) return true;
    click(trashBtn());
    return (await until(() => trashOpen() === want, 1500)) !== null;
  };
  // ⭐ 51 起回收站的「还原 / 彻底删除」两枚**不常驻**:点卡片才出面板(panes.ts 的 trashOpenId)。
  //    ⇒ 取钮前先点卡片正文;`renderTrash()` 整段重画 ⇒ 行节点跨点击游离,一律按 id 现查。
  const openTrashAct = async (id, act) => {
    for (let i = 0; i < 3; i++) {
      const hit = trashRow(id)?.querySelector(`[data-trash-act="${act}"]`);
      if (hit) return hit;
      const body = trashRow(id)?.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => trashRow(id)?.querySelector(`[data-trash-act="${act}"]`), 1500);
      if (got) return got;
    }
    return null;
  };
  // 卡片操作面同理(面板可能本来就开着:先看钮在不在,别盲点正文把它收了)。
  const openCardAct = async (id, act) => {
    for (let i = 0; i < 3; i++) {
      const hit = cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`);
      if (hit) return hit;
      const body = cardOf(id)?.querySelector(".content");
      if (!body) return null;
      click(body);
      const got = await until(() => cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`), 1500);
      if (got) return got;
    }
    return null;
  };
  const marker = `【CDP验收144】两拍确认临时条目 ${Date.now()}`;
  let id = null;
  let residueSeen = null;

  try {
    // ① 建临时灵感
    const ta = document.getElementById("text");
    ta.value = marker;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("建临时条目入时间轴", !!card)) throw new Error("abort");
    id = card.dataset.id;

    // ② 开卡片面板,拿「删除」按钮
    const del = await openCardAct(id, "del");
    if (!ok("面板展开有「删除」", !!del)) throw new Error("abort");
    const g0 = del.getBoundingClientRect();

    // ③ 第一拍:弹确认条,原按钮几何恒定(不再原位换长文案)
    click(del);
    await until(() => !cb.hidden, 1000);
    const g1 = del.getBoundingClientRect();
    ok("第一拍弹底部确认条", !cb.hidden);
    ok("确认条话术带「回收站」", document.getElementById("confirmbar-q").textContent.includes("回收站"));
    ok("原「删除」按钮几何不变", g1.left === g0.left && g1.top === g0.top && g1.width === g0.width);

    // ④ 取消:条收起、条目不删
    click(document.getElementById("confirmbar-no"));
    await until(() => cb.hidden, 1000);
    ok("取消收条且条目仍在", cb.hidden && !!cardOf(id));

    // ⑤ 重发第一拍 → 第二拍确认 → 条目离开时间轴(进回收站)
    const del2 = await openCardAct(id, "del");
    if (!ok("重发第一拍取得删除钮", !!del2)) throw new Error("abort");
    click(del2);
    await until(() => !cb.hidden, 1000);
    click(document.getElementById("confirmbar-yes"));
    const gone = await until(() => !cardOf(id));
    ok("确认删除后条目离开时间轴", !!gone);

    // ⑥ 回收站:「彻底删除」两拍真销毁(顺带验 panes 侧接入)
    if (!ok("开回收站面", await setTrash(true))) throw new Error("abort");
    const row = await until(() => trashRow(id));
    if (!ok("回收站见该条", !!row)) throw new Error("abort");
    const purge = await openTrashAct(id, "purge");
    if (!ok("点卡片出面板、有「彻底删除」", !!purge)) throw new Error("abort");
    click(purge);
    await until(() => !cb.hidden, 1000);
    ok("彻底删除第一拍弹条且话术带「无法找回」", !cb.hidden && document.getElementById("confirmbar-q").textContent.includes("无法找回"));
    click(document.getElementById("confirmbar-yes"));
    const purged = await until(() => !trashRow(id));
    ok("确认后回收站行消失(真销毁)", !!purged);
    ok("流程收尾确认条已收", cb.hidden);
  } catch (e) {
    // 中途 abort / 意外异常如实记账,清场与终审照常跑(早退 return 会先冻结返回串)。
    out.runError = String(e);
  } finally {
    // 清场(无论中途成败):挂着的确认条先撤 → 时间轴上还在就删 → 回收站里还在就彻底删。
    try {
      if (!cb.hidden) click(document.getElementById("confirmbar-no"));
      if (id) {
        if (cardOf(id)) {
          const del = await openCardAct(id, "del");
          if (del) {
            click(del);
            await until(() => !cb.hidden, 1500);
            click(document.getElementById("confirmbar-yes"));
            await until(() => !cardOf(id), 2000);
          }
        }
        await setTrash(true);
        const purge = await openTrashAct(id, "purge");
        if (purge) {
          click(purge);
          await until(() => !cb.hidden, 1500);
          click(document.getElementById("confirmbar-yes"));
          await until(() => !trashRow(id), 2000);
        }
        // ⚠ 趁面还开着量 —— 收了面之后 `[data-trash]` 本来就不在 DOM 里,那时再问恒「干净」。
        residueSeen = !!trashRow(id);
        await setTrash(false);
      }
      // ⑦ 收面回时间轴,不留验收现场
      ok("收面回时间轴", !document.body.classList.contains("pane-open"));
    } catch (e) {
      out.cleanupError = String(e);
    }
  }

  out.residueSeen = residueSeen;
  ok("清场:探针条目零残留", !!id && !cardOf(id) && residueSeen === false);
  out.pass = out.steps.every((s) => s.ok) && !out.runError && !out.cleanupError;
  return JSON.stringify(out);
})();
