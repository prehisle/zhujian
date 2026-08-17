// 操作型回执推广(backlog 13,§3.1):勾完成 / 删除 / 归档三处离场动作的回执
// 全部换成 actionBar(带「撤销」钮),本资产逐动作断言「回执形态 + 撤销真回退 +
// 点条身只收不执行」。单相(全是页内点击,无原生手势):
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-undo-receipts.js
// ⚠ 二拍确认(删除/入册)与撤销窗口(CONFIRM_REVERT_MS=6s)都在本 eval 内连点,
//   别拆成多发。断言与语言无关:回执形态以结构自证(notice+with-act、恰一枚
//   .bar-act、#confirmbar 不被挪用),动作效果以卡片 done class / 在不在轴上自证。
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
  // actionBar 在场且形态对(结构断言,语言无关)
  const barShape = () => {
    if (err.hidden) return false;
    if (!err.classList.contains("notice") || !err.classList.contains("with-act")) return false;
    const btns = err.querySelectorAll("button");
    return btns.length === 1 && btns[0].className === "bar-act";
  };
  // 开卡片操作面拿某个动作钮(卡节点跨刷新游离:每轮按 id 现查再点)
  const openAct = async (id, act) => {
    for (let i = 0; i < 3; i++) {
      const hit = cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`);
      if (hit) return hit;
      const c = cardOf(id);
      if (!c) return null;
      click(c.querySelector(".content"));
      const got = await until(() => cardOf(id)?.querySelector(`.panel [data-pact="${act}"]`), 1500);
      if (got) return got;
    }
    return null;
  };

  const marker = `【CDP验收】回执撤销 ${Date.now()}`;
  let id = null;
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
    ok("A 点撤销即收条", await until(() => err.hidden, 1500));

    // ---- A2:再勾完成 → 点条身 = 只收不撤销 ----
    cardOf(id).querySelector(".tick input").click();
    ok("A2 再勾:卡变 done", (await until(() => isDone(id))) !== null);
    if (!ok("A2 回执在场", await until(barShape, 2000))) return JSON.stringify(out);
    click(err.querySelector("span")); // 条身文本,不是钮
    ok("A2 点条身即收", await until(() => err.hidden, 1500));
    await new Promise((r) => setTimeout(r, 300));
    ok("A2 条身不执行撤销:卡仍 done", isDone(id));

    // ---- B:删除(二拍)→ 回执带撤销 → 点撤销捞回 ----
    const del = await openAct(id, "del");
    if (!ok("B 操作面有删除钮", !!del)) return JSON.stringify(out);
    click(del);
    if (!ok("B 第一拍弹确认条", await until(() => !cb.hidden, 1500))) return JSON.stringify(out);
    click(document.getElementById("confirmbar-yes"));
    ok("B 删除提交:卡离轴", (await until(() => !cardOf(id), 3000)) !== null);
    if (!ok("B 回执 actionBar 形", await until(barShape, 2000))) return JSON.stringify(out);
    ok("B 确认条已收(不被挪用)", cb.hidden);
    click(err.querySelector(".bar-act"));
    ok("B 撤销:卡回轴", (await until(() => cardOf(id), 3000)) !== null);
    ok("B 捞回仍是 done(按删除那刻分流)", isDone(id));
    ok("B 点撤销即收条", await until(() => err.hidden, 1500));

    // ---- C:归档(二拍,done 卡才有入册钮)→ 回执带撤销 → 点撤销回看板 ----
    const seal = await openAct(id, "seal");
    if (!ok("C 操作面有入册钮(done 卡)", !!seal)) return JSON.stringify(out);
    click(seal);
    if (!ok("C 第一拍弹确认条", await until(() => !cb.hidden, 1500))) return JSON.stringify(out);
    click(document.getElementById("confirmbar-yes"));
    ok("C 归档提交:卡离轴", (await until(() => !cardOf(id), 3000)) !== null);
    if (!ok("C 回执 actionBar 形", await until(barShape, 2000))) return JSON.stringify(out);
    click(err.querySelector(".bar-act"));
    ok("C 撤销:卡回轴", (await until(() => cardOf(id), 3000)) !== null);
    ok("C 回来仍是 done(unseal 语义)", isDone(id));
    ok("C 点撤销即收条", await until(() => err.hidden, 1500));
  } finally {
    // 清场:删进回收站 → 回收站彻底删(卡节点跨刷新按 id 现查;清场 del 的回执
    // 不点撤销、任它 6s 自收,不影响断言——末尾只断条目零残留)。
    if (id) {
      const del = await openAct(id, "del");
      if (del) {
        click(del);
        await until(() => !cb.hidden, 1500);
        click(document.getElementById("confirmbar-yes"));
        await until(() => !cardOf(id));
      }
      click(document.querySelector('#bottombar [data-pane="trash"]'));
      const row = await until(() => document.querySelector(`[data-trash="${id}"]`), 2500);
      if (row) {
        click(row.querySelector('[data-trash-act="purge"]'));
        await until(() => !cb.hidden, 1500);
        click(document.getElementById("confirmbar-yes"));
        await until(() => !document.querySelector(`[data-trash="${id}"]`));
      }
      click(document.querySelector('#bottombar [data-pane="trash"]'));
      await until(() => !document.body.classList.contains("pane-open"), 1500);
    }
  }
  ok("清场:探针条目零残留", !cardOf(id) && !document.querySelector(`[data-trash="${id}"]`));
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
