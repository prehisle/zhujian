// @cdp-run single
// 144 P0 #4:两拍确认改底部固定确认条(#confirmbar)——第一拍不再原位换长文案
// (按钮几何恒定),第二拍恒落 fixed 条;取消/收面即废旧确认(token)。
// 真数据全流程:建临时灵感 → 转成待办 → 面板「撤回为随记」第一拍弹条+原按钮几何不变 → 取消不撤 →
// 再点确认撤回 → 「删除」一点即删入回收站(不弹条)→ 回收站「彻底删除」两拍真销毁 → 全程零残留。
// ⚠ 902(用户拍 R3)起删卡片不再先问(同删随记)⇒ 卡片面板上的两拍换成「撤回为随记」那条来验;
//   「删除不弹确认条」的正面断言在 ⑤b。
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
  // 706 起操作面主面只剩四枚(编辑 / 标签 / 留言·转待办 / 更多…),低频那几件
  // (历史 · 移动 · 撤回 · 归档 · 删除)收在「更多…」子面里。⇒ 先把面板弄回**主面**
  // (判据 = `more` 这枚在不在),主面上没有的再钻一层。⛔ 别写成「恒先点 more」——
  // 主面那四枚在更多面里找不着。
  const inPanel = (id, act) => cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`) ?? null;
  const openCardAct = async (id, act) => {
    for (let i = 0; i < 4; i++) {
      if (!inPanel(id, "more")) {
        const c = cardOf(id);
        if (!c) return null;
        const back = inPanel(id, "back");
        if (back) click(back); // 停在某张子面上:先回主面
        else click(c.querySelector(".content")); // 面板没开:点正文开它
        await until(() => inPanel(id, "more"), 1500);
        continue;
      }
      const hit = inPanel(id, act);
      if (hit) return hit;
      click(inPanel(id, "more"));
      return await until(() => inPanel(id, act), 1500);
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
    // 157 G4 / P2 起删**随记**一点即删、902 起删卡片也是 ⇒ 先转成待办,拿「撤回为随记」那条两拍验确认条
    // (落点列里的卡才有它;刚转的卡就在默认看板的落点)。
    const promote = await openCardAct(id, "promote");
    if (!ok("转成待办", !!promote)) throw new Error("abort");
    click(promote);
    await until(() => !cardOf(id), 3000);
    click(document.querySelector('#bottombar [data-mode="tasks"]'));
    if (!ok("切到任务面看得见它", !!(await until(() => cardOf(id), 3000)))) throw new Error("abort");
    document.getElementById("error").hidden = true;

    // ② 开卡片面板,拿「撤回为随记」按钮
    const rev = await openCardAct(id, "revert");
    if (!ok("面板展开有「撤回为随记」", !!rev)) throw new Error("abort");
    const g0 = rev.getBoundingClientRect();

    // ③ 第一拍:弹确认条,原按钮几何恒定(不再原位换长文案)
    click(rev);
    await until(() => !cb.hidden, 1000);
    const g1 = rev.getBoundingClientRect();
    ok("第一拍弹底部确认条", !cb.hidden);
    ok("确认条话术带「撤回为随记」", document.getElementById("confirmbar-q").textContent.includes("撤回为随记"));
    ok("原「撤回为随记」按钮几何不变", g1.left === g0.left && g1.top === g0.top && g1.width === g0.width);

    // ④ 取消:条收起、条目不动
    click(document.getElementById("confirmbar-no"));
    await until(() => cb.hidden, 1000);
    ok("取消收条且卡片仍在看板上", cb.hidden && !!cardOf(id));

    // ⑤ 重发第一拍 → 第二拍确认 → 卡片离开任务面(回随记)
    const rev2 = await openCardAct(id, "revert");
    if (!ok("重发第一拍取得撤回钮", !!rev2)) throw new Error("abort");
    click(rev2);
    await until(() => !cb.hidden, 1000);
    click(document.getElementById("confirmbar-yes"));
    ok("确认撤回后卡片离开任务面", !!(await until(() => !cardOf(id))));
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
    if (!ok("随记面上看得见它", !!(await until(() => cardOf(id), 3000)))) throw new Error("abort");
    document.getElementById("error").hidden = true;

    // ⑤b 删除:一点即删、不弹确认条(随记 157 起、卡片 902 起),进回收站
    const del = await openCardAct(id, "del");
    if (!ok("面板展开有「删除」", !!del)) throw new Error("abort");
    click(del);
    ok("删除不弹确认条", cb.hidden);
    const gone = await until(() => !cardOf(id));
    ok("一点即删:条目离开时间轴", !!gone);

    // ⑥ 回收站:「彻底删除」两拍真销毁(顺带验 panes 侧接入)
    if (!ok("开回收站面", await setTrash(true))) throw new Error("abort");
    const row = await until(() => trashRow(id));
    if (!ok("回收站见该条", !!row)) throw new Error("abort");
    const purge = await openTrashAct(id, "purge");
    if (!ok("点卡片出面板、有「彻底删除」", !!purge)) throw new Error("abort");
    click(purge);
    await until(() => !cb.hidden, 1000);
    // 159(对齐桌面):「无法找回」→「无法恢复」
    ok("彻底删除第一拍弹条且话术带「无法恢复」", !cb.hidden && document.getElementById("confirmbar-q").textContent.includes("无法恢复"));
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
      // ⑦ 收面回时间轴,不留验收现场(随记面是下一支的起点)
      click(document.querySelector('#bottombar [data-mode="ideas"]'));
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
