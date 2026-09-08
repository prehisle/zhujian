// @cdp-run single
// 144 后续 P1 #7/#8(安卓):记下后收键盘+新卡 flash 回执;搜索结果可点分流
// (活跃条目→时间轴定位闪卡,回收站/归档册→切对应面)。真数据全流程,末尾清场。
// 跑法 `node scripts/cdp-run.mjs p1-ux`(⛔ 别裸 evalfile:退出码恒 0);
// CDP 单调用 10s 上限,等待全用轮询。
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
  // 回收站面是 toggle:要开就开、要收就收,⛔ 别盲点。
  const setTrash = async (want) => {
    if (trashOpen() === want) return true;
    click(trashBtn());
    return (await until(() => trashOpen() === want, 1500)) !== null;
  };
  // ⭐ 51 起回收站的两枚离场钮不常驻:点卡片才出面板;renderTrash() 整段重画 ⇒ 按 id 现查。
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
  const marker = `【CDP验收P1】搜索与回执 ${Date.now()}`;
  let id = null;
  let residueSeen = null;

  try {
    // ① 记下:成功后 textarea 失焦(收键盘的页内可断言半截)+ 新卡 flash 回执
    const ta = document.getElementById("text");
    ta.value = marker;
    ta.focus();
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("记下入时间轴", !!card)) throw new Error("abort");
    id = card.dataset.id;
    ok("记下后输入框失焦(键盘可收)", document.activeElement !== ta);
    ok("新卡 flash 回执", card.classList.contains("flash"));

    // ② 搜索:活跃条目命中 → 点卡关面回时间轴定位(搜索入口在头部,143 换席后不在底栏)
    click(document.getElementById("search-toggle"));
    const si = document.getElementById("search-input");
    si.value = "【CDP验收P1】搜索与回执";
    click(document.getElementById("search-btn"));
    const hit = await until(() => document.querySelector(`#search-results [data-hit="${id}"]`));
    if (!ok("搜索命中带 data-hit", !!hit)) throw new Error("abort");
    click(hit.querySelector(".content"));
    const focused = await until(
      () => !document.body.classList.contains("pane-open") && cardOf(id)?.classList.contains("flash"),
    );
    ok("点命中关面回时间轴并闪卡", !!focused);

    // ③ 删进回收站(经确认条),再搜:回收站命中 → 点卡切到回收站面
    const del = await openCardAct(id, "del");
    if (!ok("卡片面板有「删除」", !!del)) throw new Error("abort");
    click(del);
    await until(() => !cb.hidden, 1000);
    click(document.getElementById("confirmbar-yes"));
    await until(() => !cardOf(id));
    click(document.getElementById("search-toggle"));
    click(document.getElementById("search-btn"));
    const hit2 = await until(() =>
      document.querySelector(`#search-results [data-hit="${id}"][data-hit-status="archived"]`),
    );
    if (!ok("删后再搜命中标回收站", !!hit2)) throw new Error("abort");
    click(hit2.querySelector(".content"));
    const inTrash = await until(() => trashOpen() && trashRow(id));
    ok("点回收站命中切到回收站面", !!inTrash);
  } catch (e) {
    out.runError = String(e);
  } finally {
    // ④ 清场(无论中途成败):彻底删除临时条目,收面。
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
        // ⚠ 趁面还开着量 —— 收了面 `[data-trash]` 本来就不在 DOM 里,那时再问恒「干净」。
        residueSeen = !!trashRow(id);
        await setTrash(false);
      }
    } catch (e) {
      out.cleanupError = String(e);
    }
  }

  out.residueSeen = residueSeen;
  ok("清场完成:探针条目零残留", !!id && !cardOf(id) && residueSeen === false);
  out.pass = out.steps.every((s) => s.ok) && !out.runError && !out.cleanupError;
  return JSON.stringify(out);
})();
