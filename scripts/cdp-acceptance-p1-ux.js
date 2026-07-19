// 144 后续 P1 #7/#8(安卓):记下后收键盘+新卡 flash 回执;搜索结果可点分流
// (活跃条目→时间轴定位闪卡,回收站/归档册→切对应面)。真数据全流程,末尾清场。
// evalfile 跑,pass=true 才算过;CDP 单调用 10s 上限,等待全用轮询。
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
  const marker = `【CDP验收P1】搜索与回执 ${Date.now()}`;

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
  if (!ok("记下入时间轴", !!card)) return JSON.stringify(out);
  const id = card.dataset.id;
  ok("记下后输入框失焦(键盘可收)", document.activeElement !== ta);
  ok("新卡 flash 回执", card.classList.contains("flash"));

  // ② 搜索:活跃条目命中 → 点卡关面回时间轴定位(搜索入口在头部,143 换席后不在底栏)
  click(document.getElementById("search-toggle"));
  const si = document.getElementById("search-input");
  si.value = "【CDP验收P1】搜索与回执";
  click(document.getElementById("search-btn"));
  const hit = await until(() => document.querySelector(`#search-results [data-hit="${id}"]`));
  if (!ok("搜索命中带 data-hit", !!hit)) return JSON.stringify(out);
  click(hit.querySelector(".content"));
  const focused = await until(
    () =>
      !document.body.classList.contains("pane-open") &&
      document.querySelector(`#timeline [data-id="${id}"]`)?.classList.contains("flash"),
  );
  ok("点命中关面回时间轴并闪卡", !!focused);

  // ③ 删进回收站(经确认条),再搜:回收站命中 → 点卡切到回收站面
  const tlCard = document.querySelector(`#timeline [data-id="${id}"]`);
  click(tlCard.querySelector(".content"));
  const del = await until(() => tlCard.querySelector('.panel [data-pact="del"]'));
  click(del);
  await until(() => !cb.hidden, 1000);
  click(document.getElementById("confirmbar-yes"));
  await until(() => !document.querySelector(`#timeline [data-id="${id}"]`));
  click(document.getElementById("search-toggle"));
  click(document.getElementById("search-btn"));
  const hit2 = await until(() =>
    document.querySelector(`#search-results [data-hit="${id}"][data-hit-status="archived"]`),
  );
  if (!ok("删后再搜命中标回收站", !!hit2)) return JSON.stringify(out);
  click(hit2.querySelector(".content"));
  const inTrash = await until(
    () => !document.getElementById("trash-pane").hidden && document.querySelector(`[data-trash="${id}"]`),
  );
  ok("点回收站命中切到回收站面", !!inTrash);

  // ④ 清场:彻底删除临时条目,收面
  const row = document.querySelector(`[data-trash="${id}"]`);
  click(row.querySelector('[data-trash-act="purge"]'));
  await until(() => !cb.hidden, 1000);
  click(document.getElementById("confirmbar-yes"));
  await until(() => !document.querySelector(`[data-trash="${id}"]`));
  click(document.querySelector('#bottombar [data-pane="trash"]'));
  await until(() => !document.body.classList.contains("pane-open"), 1000);
  ok("清场完成", !document.querySelector(`[data-trash="${id}"]`));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
