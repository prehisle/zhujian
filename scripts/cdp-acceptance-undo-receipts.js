// @cdp-run single
// 操作型回执推广(backlog 13,§3.1):勾完成 / 删除 / 归档三处离场动作的回执
// 全部换成 actionBar(带「撤销」钮),本资产逐动作断言「回执形态 + 撤销真回退 +
// 点条身只收不执行」。单相(全是页内点击,无原生手势):
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-undo-receipts.js
// ⚠ 撤销窗口(CONFIRM_REVERT_MS=6s)与清场那记彻底删除的二拍都在本 eval 内连点,
//   别拆成多发。断言大多与语言无关:回执形态以结构自证(notice+with-act、恰一枚
//   .bar-act、#confirmbar 不被挪用),动作效果以卡片 done class / 在不在轴上自证;
//   只有 B 段「回执就是删随记那一句」认中文原文(跑手默认中文档)。
// 三处都是一点即成、不先问(勾 / 归档 158 起,删卡片 902 用户拍 R3 起)。
// 阴性对照(R3,行为刀 ⇒ 改前的包上跑):B「不弹确认条」那格红、卡不离轴。
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
  const err = document.getElementById("error");
  const cb = document.getElementById("confirmbar");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const isDone = (id) => !!cardOf(id)?.classList.contains("done");
  const trashRow = (id) => document.querySelector(`[data-trash="${id}"]`);
  const trashOpen = () => !document.getElementById("trash-pane").hidden;
  // 165 M1 Q6 起点【撤销】不再是「收条」,而是同一根条换成「已撤销」回执(ui.ts::showUndone):回执形、没有动作钮。
  // 结构自证,与语言无关(同上面那几条)。
  const undoneShown = () =>
    !err.hidden && err.classList.contains("notice") && !err.classList.contains("with-act") && !err.querySelector(".bar-act");
  // 回收站面是 toggle:要开就开、要收就收,⛔ 别盲点(盲点一次 = 该开的时候把它收了)。
  const setTrash = async (want) => {
    if (trashOpen() === want) return true;
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    return (await until(() => trashOpen() === want, 1500)) !== null;
  };
  // ⭐ 51 起回收站的「还原 / 彻底删除」两枚**不常驻**:点卡片才出面板(panes.ts 的 trashOpenId)。
  //    ⇒ 取钮前先点卡片正文;renderTrash() 整段重画 ⇒ 行节点跨点击游离,一律按 id 现查。
  //    ⛔ 这正是 91 那条账:从前直接 `click(row.querySelector('[data-trash-act="purge"]'))`
  //       恒 null ⇒ 整支崩在清场路上,而探针条目已经躺进库里了。
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
  // actionBar 在场且形态对(结构断言,语言无关)
  const barShape = () => {
    if (err.hidden) return false;
    if (!err.classList.contains("notice") || !err.classList.contains("with-act")) return false;
    const btns = err.querySelectorAll("button");
    // 第一枚是撤销;158 G3 / Q1 起卡挪到屏外时另挂一枚「去看看」(同形 bar-act)
    return (btns.length === 1 || btns.length === 2) && [...btns].every((b) => b.className === "bar-act");
  };
  // 开卡片操作面拿某个动作钮(卡节点跨刷新游离:每轮按 id 现查再点)
  // 706 起操作面主面只剩四枚(编辑 / 标签 / 留言·转待办 / 更多…),低频那几件
  // (历史 · 移动 · 撤回 · 归档 · 删除)收在「更多…」子面里。⇒ 先把面板弄回**主面**
  // (判据 = `more` 这枚在不在),主面上没有的再钻一层。⛔ 别写成「恒先点 more」——
  // 主面那四枚在更多面里找不着。
  const inPanel = (id, act) => cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`) ?? null;
  const openAct = async (id, act) => {
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

  const marker = `【CDP验收】回执撤销 ${Date.now()}`;
  let id = null;
  let residueSeen = null;
  try {
    // ---- 种探针任务 ----
    const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasksBtn);
    if (!ok("切到任务面", await until(() => tasksBtn.classList.contains("active"), 2000)))
      return JSON.stringify(out);
    const ta = document.getElementById("text");
    ta.value = marker;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("探针任务入时间轴", !!card)) return JSON.stringify(out);
    id = card.dataset.id;
    ok("出生非 done", !isDone(id));

    // ---- A:勾完成 → 回执带撤销 → 点撤销回原态 ----
    cardOf(id).querySelector(".tick input").click(); // 原生激活:翻 checked + 发 change
    ok("A 勾完成:卡变 done", (await until(() => isDone(id))) !== null);
    if (!ok("A 回执 actionBar 形", await until(barShape, 2000))) return JSON.stringify(out);
    ok("A confirmbar 不被挪用", cb.hidden);
    click(err.querySelector(".bar-act"));
    ok("A 撤销:卡回非 done", (await until(() => cardOf(id) && !isDone(id))) !== null);
    ok("A 点撤销后条换成「已撤销」回执(Q6)", await until(undoneShown, 1500));

    // ---- A2:再勾完成 → 点条身 = 只收不撤销 ----
    cardOf(id).querySelector(".tick input").click();
    ok("A2 再勾:卡变 done", (await until(() => isDone(id))) !== null);
    if (!ok("A2 回执在场", await until(barShape, 2000))) return JSON.stringify(out);
    click(err.querySelector("span")); // 条身文本,不是钮
    ok("A2 点条身即收", await until(() => err.hidden, 1500));
    await new Promise((r) => setTimeout(r, 300));
    ok("A2 条身不执行撤销:卡仍 done", isDone(id));

    // ---- B:删除卡片(902 用户拍 R3 起一点即删、不再先问,同删随记)→ 回执带撤销 → 点撤销捞回 ----
    const del = await openAct(id, "del");
    if (!ok("B 操作面有删除钮", !!del)) return JSON.stringify(out);
    click(del);
    ok("B 不弹确认条(一点即删)", cb.hidden);
    ok("B 删除提交:卡离轴", (await until(() => !cardOf(id), 3000)) !== null);
    if (!ok("B 回执 actionBar 形", await until(barShape, 2000))) return JSON.stringify(out);
    ok("B 回执就是删随记那一句、钮是「撤销」", err.querySelector("span")?.textContent === "已移入回收站" && err.querySelector(".bar-act")?.textContent === "撤销");
    ok("B 确认条全程没出场", cb.hidden);
    ok("B 卡真进了回收站(后端)", (await window.__TAURI_INTERNALS__.invoke("list_trash", { spaceId: await window.__TAURI_INTERNALS__.invoke("foreground_space") })).some((r) => r.id === id));
    click(err.querySelector(".bar-act"));
    ok("B 撤销:卡回轴", (await until(() => cardOf(id), 3000)) !== null);
    ok("B 捞回仍是 done(按删除那刻分流)", isDone(id));
    ok("B 点撤销后条换成「已撤销」回执(Q6)", await until(undoneShown, 1500));
    ok("B 撤销后回收站里没有它了(后端)", !(await window.__TAURI_INTERNALS__.invoke("list_trash", { spaceId: await window.__TAURI_INTERNALS__.invoke("foreground_space") })).some((r) => r.id === id));

    // ---- C:归档(158 G3 / Q3 起一点即归,done 卡才有入册钮)→ 回执带撤销 → 点撤销回看板 ----
    const seal = await openAct(id, "seal");
    if (!ok("C 操作面有入册钮(done 卡)", !!seal)) return JSON.stringify(out);
    click(seal);
    ok("C 不弹确认条(一点即归)", cb.hidden);
    ok("C 归档提交:卡离轴", (await until(() => !cardOf(id), 3000)) !== null);
    if (!ok("C 回执 actionBar 形", await until(barShape, 2000))) return JSON.stringify(out);
    click(err.querySelector(".bar-act"));
    ok("C 撤销:卡回轴", (await until(() => cardOf(id), 3000)) !== null);
    ok("C 回来仍是 done(unseal 语义)", isDone(id));
    ok("C 点撤销后条换成「已撤销」回执(Q6)", await until(undoneShown, 1500));
  } finally {
    // 清场:删进回收站 → 回收站彻底删(卡节点跨刷新按 id 现查;清场 del 的回执
    // 不点撤销、任它 6s 自收,不影响断言——末尾只断条目零残留)。
    if (id) {
      const del = await openAct(id, "del");
      if (del) {
        click(del);
        await until(() => !cardOf(id));
      }
      await setTrash(true);
      await until(() => trashRow(id), 2500);
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
  }
  out.residueSeen = residueSeen;
  ok("清场:探针条目零残留", !!id && !cardOf(id) && residueSeen === false);
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
