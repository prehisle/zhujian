// 190 安卓标签面拖排序(1c):合成 PointerEvent 驱动拖手柄验「手势逻辑 + 顺序落库」。
// 把列表最后一行 B 拖到倒数第二行 A 之前 → 断言 B 排到 A 前(loadTopics 重查后端后
// 仍成立 = reorder_topic 真落库)。touch-action 不被滚动抢的原生半截另用真触摸 swipe 眼看。
// 开头强制 fresh 重载(关面再开 → openPane 触发 loadTopics),避开面开着时的陈旧快照。
(async () => {
  const out = { pass: false, steps: [], before: [], after: [] };
  const ok = (n, c) => {
    out.steps.push({ name: n, ok: !!c });
    return !!c;
  };
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const pe = (type, x, y, el) =>
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y }),
    );

  // 面已开就直接用现有稳定 DOM(避免关-开 fresh 的 loadTopics 异步重渲冲掉拖动行);
  // 仅在面关着时开一次,并等渲染稳定(行数连续两拍不变)。
  const paneEl = document.getElementById("topics-pane");
  const toggle = document.getElementById("topics-toggle");
  if (paneEl.hidden) {
    click(toggle);
    await until(() => !paneEl.hidden);
  }
  const rowsSel = () => [...document.querySelectorAll("#topics-list .trow")];
  await until(() => rowsSel().length >= 2);
  let prevN = -1;
  await until(() => {
    const n = rowsSel().length;
    if (n >= 2 && n === prevN) return true;
    prevN = n;
    return false;
  }, 3000);
  out.before = rowsSel().map((r) => r.dataset.topic);
  if (!ok("库有≥2个标签", out.before.length >= 2)) return JSON.stringify(out);

  const list = document.getElementById("topics-list");
  const A = rowsSel()[out.before.length - 2];
  const B = rowsSel()[out.before.length - 1];
  const idA = A.dataset.topic;
  const idB = B.dataset.topic;
  const handleB = B.querySelector(".thandle").getBoundingClientRect();
  const sx = handleB.left + handleB.width / 2;
  const sy = handleB.top + handleB.height / 2;
  const ty = A.getBoundingClientRect().top + 2; // A 中线之上 → 落点在 A 之前

  pe("pointerdown", sx, sy, B.querySelector(".thandle"));
  await new Promise((r) => setTimeout(r, 40));
  ok("拖起后被拖行浮起(.dragging)", !!document.querySelector("#topics-list .trow.dragging"));
  pe("pointermove", sx, ty, list);
  await new Promise((r) => setTimeout(r, 40));
  ok("拖动中出现落点线(.drop-line)", !!document.querySelector("#topics-list .drop-line"));
  pe("pointerup", sx, ty, list);

  // 落库重载后:B 排到 A 之前(indexOf B < indexOf A)
  const swapped = await until(() => {
    const now = rowsSel().map((r) => r.dataset.topic);
    const ia = now.indexOf(idA);
    const ib = now.indexOf(idB);
    return ia >= 0 && ib >= 0 && ib < ia ? now : null;
  });
  out.after = rowsSel().map((r) => r.dataset.topic);
  ok("拖后 B 排到 A 之前(reorder 落库)", !!swapped);
  ok("落点线已清(拖动收尾)", !document.querySelector("#topics-list .drop-line"));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
