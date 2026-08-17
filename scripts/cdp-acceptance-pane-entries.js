// 首用入口分层(408-A1/A2):底栏「回收站/归档册」按数据显形 + 空库空态引导副行。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-pane-entries.js
// 断言是**谓词式**的(库里有没有存量回收站/归档数据都能跑):
//   钮该显 ⟺ 该面非空 ∨ 该面正开着。种探针把两面从「非空」推着走一圈:
//   删除→trash 钮显;开面清到空→钮保显(activePane 保护);关面→按剩余数据显隐。
// A2 只在随记面真是空库时断(有数据就如实记 skip,不算失败)。
(async () => {
  const out = { pass: false, steps: [], skipped: [] };
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
  const btnOf = (pane) => document.querySelector(`#bottombar [data-pane="${pane}"]`);
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const paneOpen = () => document.body.classList.contains("pane-open");
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
  // 二拍:点动作钮 → 确认条 → yes,全在一发内连点
  const twoTap = async (btn) => {
    click(btn);
    if (!(await until(() => !cb.hidden, 1500))) return false;
    click(document.getElementById("confirmbar-yes"));
    return true;
  };

  const marker = `【CDP验收】pane显形 ${Date.now()}`;
  let id = null;
  try {
    // ---- 0:切任务面,记初态 ----
    const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasksBtn);
    if (!ok("切到任务面", await until(() => tasksBtn.classList.contains("active"), 2000)))
      return JSON.stringify(out);
    out.initial = { trashHidden: btnOf("trash").hidden, sealedHidden: btnOf("sealed").hidden };

    // ---- 1:种探针任务 → 删除 → trash 钮必显 ----
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
    const del = await openAct(id, "del");
    if (!ok("操作面有删除钮", !!del)) return JSON.stringify(out);
    if (!ok("删除二拍成立", await twoTap(del))) return JSON.stringify(out);
    await until(() => !cardOf(id), 3000);
    ok("删除后 trash 钮显形", (await until(() => !btnOf("trash").hidden, 3000)) !== null);

    // ---- 2:开回收站,只 purge 探针(存量不动),验 activePane 保显 + 关面后谓词显隐 ----
    click(btnOf("trash"));
    if (!ok("回收站面开了", await until(() => paneOpen(), 2000))) return JSON.stringify(out);
    const probeRow = await until(() => document.querySelector(`[data-trash="${id}"]`), 2500);
    if (!ok("探针在回收站", !!probeRow)) return JSON.stringify(out);
    if (!ok("彻底删二拍成立", await twoTap(probeRow.querySelector('[data-trash-act="purge"]'))))
      return JSON.stringify(out);
    await until(() => !document.querySelector(`[data-trash="${id}"]`), 3000);
    const trashLeft = document.querySelectorAll("[data-trash]").length;
    ok("面开着时钮保显(activePane 保护)", !btnOf("trash").hidden);
    // 关面(再点同钮 toggle)→ 按剩余数据显隐
    click(btnOf("trash"));
    await until(() => !paneOpen(), 2000);
    if (trashLeft === 0)
      ok("关面后空回收站钮隐", (await until(() => btnOf("trash").hidden, 3000)) !== null);
    else ok("关面后非空回收站钮仍显", !(await until(() => btnOf("trash").hidden, 1200)));

    // ---- 3:归档一条 → sealed 钮显;取消归档 → 按剩余显隐 ----
    ta.value = marker + " 归档探针";
    click(document.getElementById("save"));
    const card2 = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes("归档探针"),
      ),
    );
    if (!ok("第二探针入轴", !!card2)) return JSON.stringify(out);
    id = card2.dataset.id;
    cardOf(id).querySelector(".tick input").click(); // 勾完成(407 回执无妨)
    await until(() => cardOf(id)?.classList.contains("done"), 3000);
    const seal = await openAct(id, "seal");
    if (!ok("操作面有入册钮", !!seal)) return JSON.stringify(out);
    if (!ok("归档二拍成立", await twoTap(seal))) return JSON.stringify(out);
    await until(() => !cardOf(id), 3000);
    ok("归档后 sealed 钮显形", (await until(() => !btnOf("sealed").hidden, 3000)) !== null);
    // 开归档册,取消归档探针(把归档册清回初态;存量归档不动)
    click(btnOf("sealed"));
    await until(() => paneOpen(), 2000);
    const unsealBtn = await until(() => document.querySelector(`[data-unseal="${id}"]`), 2500);
    if (!ok("归档册里有探针", !!unsealBtn)) return JSON.stringify(out);
    click(unsealBtn);
    await until(() => !document.querySelector(`[data-unseal="${id}"]`), 3000);
    const sealedLeft = document.querySelectorAll("[data-unseal]").length;
    ok("面开着时 sealed 钮保显", !btnOf("sealed").hidden);
    click(btnOf("sealed"));
    await until(() => !paneOpen(), 2000);
    if (sealedLeft === 0)
      ok("关面后空归档册钮隐", (await until(() => btnOf("sealed").hidden, 3000)) !== null);
    else ok("关面后非空归档册钮仍显", !(await until(() => btnOf("sealed").hidden, 1200)));

    // ---- 4(A2):随记面空库则空态带引导副行 ----
    const ideasBtn = document.querySelector('#bottombar [data-mode="ideas"]');
    click(ideasBtn);
    await until(() => ideasBtn.classList.contains("active"), 2000);
    await new Promise((r) => setTimeout(r, 300));
    const ideaCards = document.querySelectorAll("#timeline [data-id]").length;
    if (ideaCards === 0) {
      const empty = document.querySelector("#timeline .empty");
      ok("A2 空态在场", !!empty);
      ok("A2 空态带引导副行(两行形)", !!empty && empty.innerHTML.includes("<br"));
    } else {
      out.skipped.push(`A2:随记面有 ${ideaCards} 条存量,空态断言跳过`);
    }
    click(tasksBtn);
    await until(() => tasksBtn.classList.contains("active"), 2000);
  } finally {
    // 清场:第二探针此刻是 done 在任务轴,删+彻底删;关掉误留的面
    if (id && cardOf(id)) {
      const del = await openAct(id, "del");
      if (del) {
        await twoTap(del);
        await until(() => !cardOf(id));
      }
      if ((await until(() => !btnOf("trash").hidden, 3000)) !== null) {
        click(btnOf("trash"));
        await until(() => paneOpen(), 2000);
        const row = await until(() => document.querySelector(`[data-trash="${id}"]`), 2500);
        if (row) {
          await twoTap(row.querySelector('[data-trash-act="purge"]'));
          await until(() => !document.querySelector(`[data-trash="${id}"]`));
        }
        if (paneOpen()) {
          click(btnOf("trash"));
          await until(() => !paneOpen(), 2000);
        }
      }
    }
  }
  ok("清场:探针零残留", !cardOf(id) && !document.querySelector(`[data-trash="${id}"]`));
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
