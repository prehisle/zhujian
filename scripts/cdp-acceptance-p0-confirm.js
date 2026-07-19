// 144 P0 #4:两拍确认改底部固定确认条(#confirmbar)——第一拍不再原位换长文案
// (按钮几何恒定),第二拍恒落 fixed 条;取消/收面即废旧确认(token)。
// 真数据全流程:建临时灵感 → 面板「删除」第一拍弹条+原按钮几何不变 → 取消不删 →
// 再删确认入回收站 → 回收站「彻底删除」两拍真销毁 → 全程零残留。
// evalfile 跑,pass=true 才算过;CDP 单调用 10s 上限,等待全用轮询不用死睡。
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
  const marker = `【CDP验收144】两拍确认临时条目 ${Date.now()}`;

  // ① 建临时灵感
  const ta = document.getElementById("text");
  ta.value = marker;
  click(document.getElementById("save"));
  const card = await until(() =>
    [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
      c.querySelector(".content")?.textContent.includes(marker),
    ),
  );
  if (!ok("建临时条目入时间轴", !!card)) return JSON.stringify(out);
  const id = card.dataset.id;

  // ② 开卡片面板,拿「删除」按钮
  click(card.querySelector(".content"));
  const del = await until(() => card.querySelector('.panel [data-pact="del"]'));
  if (!ok("面板展开有「删除」", !!del)) return JSON.stringify(out);
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
  ok("取消收条且条目仍在", cb.hidden && !!document.querySelector(`#timeline [data-id="${id}"]`));

  // ⑤ 重发第一拍 → 第二拍确认 → 条目离开时间轴(进回收站)
  click(card.querySelector('.panel [data-pact="del"]'));
  await until(() => !cb.hidden, 1000);
  click(document.getElementById("confirmbar-yes"));
  const gone = await until(() => !document.querySelector(`#timeline [data-id="${id}"]`));
  ok("确认删除后条目离开时间轴", !!gone);

  // ⑥ 回收站:「彻底删除」两拍真销毁(顺带验 panes 侧接入)
  click(document.querySelector('#bottombar [data-pane="trash"]'));
  const row = await until(() => document.querySelector(`[data-trash="${id}"]`));
  if (!ok("回收站见该条", !!row)) return JSON.stringify(out);
  click(row.querySelector('[data-trash-act="purge"]'));
  await until(() => !cb.hidden, 1000);
  ok("彻底删除第一拍弹条且话术带「无法找回」", !cb.hidden && document.getElementById("confirmbar-q").textContent.includes("无法找回"));
  click(document.getElementById("confirmbar-yes"));
  const purged = await until(() => !document.querySelector(`[data-trash="${id}"]`));
  ok("确认后回收站行消失(真销毁)", !!purged);
  ok("流程收尾确认条已收", cb.hidden);

  // ⑦ 收面回时间轴,不留验收现场
  click(document.querySelector('#bottombar [data-pane="trash"]'));
  await until(() => !document.body.classList.contains("pane-open"), 1000);

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
