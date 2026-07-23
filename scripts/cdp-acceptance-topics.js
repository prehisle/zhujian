// 190 安卓标签管理面:开面 + 点类型入口(设/清 kind)+ 读顺序(供拖排序步骤前后对比)。
// 纯 DOM 断言即端到端:render 的数据来自 loadTopics 的后端查询(listTopicsFull),徽标/
// 顺序变了 = 后端真落库(set_topic_kind / reorder_topic)。拖排序需真触摸(touch-action
// 分区),走 android-cdp.mjs swipe 单独串——本脚本读出初始顺序 + 手柄坐标供那一步用。
// evalfile 跑,pass=true 才算过;库里 <1 个标签时类型验收 skip(算过)。
(async () => {
  const out = { pass: false, steps: [], order: [], handle: null };
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

  // ① 开标签面(header「标签」),面接管视图 + 列表出现(幂等:已开则不再 toggle)
  if (document.getElementById("topics-pane").hidden) {
    click(document.getElementById("topics-toggle"));
  }
  const pane = await until(() => {
    const p = document.getElementById("topics-pane");
    return p && !p.hidden ? p : null;
  });
  if (!ok("标签面打开", !!pane)) return JSON.stringify(out);
  ok("面接管视图(pane-open)", document.body.classList.contains("pane-open"));
  // 等真正渲染完:.trow 出现(常态),或真空态文案(「还没有标签」)——**不能等到「读取中…」
  // 占位就返回**(冷启动 loadTopics 未完成时它先渲染,rows=0 会误 skip)。
  const box = document.getElementById("topics-list");
  await until(() => box.querySelector(".trow") || box.textContent.includes("还没有标签"), 6000);
  if (!ok("列表渲染完成", box.querySelector(".trow") || box.textContent.includes("还没有标签")))
    return JSON.stringify(out);

  const rows = () => [...document.querySelectorAll("#topics-list .trow")];
  out.order = rows().map((r) => r.dataset.topic);

  // 库里没有标签:类型验收无对象,skip(算过);拖排序也无从谈起。
  if (rows().length === 0) {
    ok("库无标签→类型验收 skip", true);
    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out);
  }

  // 手柄坐标(供拖排序步骤:swipe 从第一行手柄拖到最后一行下方)
  const firstHandle = rows()[0].querySelector(".thandle").getBoundingClientRect();
  const lastRow = rows()[rows().length - 1].getBoundingClientRect();
  out.handle = {
    fromX: Math.round(firstHandle.left + firstHandle.width / 2),
    fromY: Math.round(firstHandle.top + firstHandle.height / 2),
    toY: Math.round(lastRow.bottom + 12),
    n: rows().length,
  };

  // ② 类型设置:第一行 → 点类型入口展开 input → 填「人名」→ 存 → 徽标出现且文字对
  const row0 = rows()[0];
  const id0 = row0.dataset.topic;
  click(row0.querySelector("[data-kind-edit]"));
  const input = await until(() => document.querySelector(`.trow[data-topic="${id0}"] .tk-input`));
  if (!ok("点类型展开输入框", !!input)) return JSON.stringify(out);
  input.value = "人名";
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-save]`));
  const badge = await until(() => {
    const b = document.querySelector(`.trow[data-topic="${id0}"] .tk-badge`);
    return b && b.textContent.trim() === "人名" ? b : null;
  });
  ok("设类型后徽标显「人名」(后端落库)", !!badge);

  // ③ 类型清除:点徽标展开 → 清 → 回到「+ 类型」
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-edit]`));
  await until(() => document.querySelector(`.trow[data-topic="${id0}"] .tk-input`));
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-clear]`));
  const cleared = await until(() => {
    const add = document.querySelector(`.trow[data-topic="${id0}"] .tk-add`);
    const badgeGone = !document.querySelector(`.trow[data-topic="${id0}"] .tk-badge`);
    return add && badgeGone ? add : null;
  });
  ok("清类型后回「+ 类型」(后端清库)", !!cleared);

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
