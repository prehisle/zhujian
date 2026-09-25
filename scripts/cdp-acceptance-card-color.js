// @cdp-run single
// 用户面 110:手机卡片颜色标记(0040 `items.color`)真的画出来了 —— 时间轴(任务面)/ 回收站 / 归档册三处,亮暗两档。
//
// 判据判到**视觉本体**(computed `background-image` 与字色),⛔ 不只判 class:
//   ⭐ 这一条要防的头号回归是「写回 color-mix()」—— Chrome ≤110 上含 var() 的 color-mix 在计算期失败(IACVT)
//   ⇒ 属性归 unset,class 在、变量在、屏上一点颜色都没有(mobile.md 643)。只有读 computed 值才照得出。
// 格:①有色卡 = `.tinted` + 单色渐变,颜色三元组与库里 hex 逐位一致、alpha 等于 `--card-tint-a` 的生效值;
//     ②无色卡 = 没 class、`background-image: none`;③染色卡里小字换成补偿色(footer 字色 = `--ink-soft-on-tint`),
//     无色卡仍是 `--ink-soft`,且合成后的小字对比度不低于无色卡原值(防改浓度没重算补偿);④暗色档同样三格(alpha 与补偿值跟着翻面);⑤回收站 / 归档册里的有色卡同判 ①。
//
// ⚠ **前置要人先摆局**:手机端没有设色命令(本轮只做渲染),有色卡只能来自同步或台架里直接写库
//   (progress-log 用户面 110 那一条的台架做法)。库里一张有色卡都没有 ⇒ 自报 `{error}` = NOT-RUN,⛔ 不记成过。
//   同理:有色行没渲染在 DOM 里(筛选挡住了)也自报没跑。
// ⚠ 诚实边界:「一眼分不分得开 / 喧不喧宾夺主」这一半页内判不了,走截图(同号条目的浓度五档)。
// 本资产不写库、不改设置:暗色档只临时改 `<html data-theme>`,跑完放回原值。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const I = window.__TAURI_INTERNALS__.invoke;
  const root = document.documentElement;
  const space = (await I("list_spaces")).find((s) => s.current)?.id;
  if (!space) return { error: "没有当前空间" };
  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // 令牌的**生效色**:挂一个探针元素读 computed color(令牌值可能是 #hex,computed 统一成 rgb())
  const tokenColor = (name) => {
    const p = document.createElement("span");
    p.style.color = `var(${name})`;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  };
  const lum = (c) => {
    const l = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const contrast = (x, y) => {
    const [p, q] = [lum(x), lum(y)].sort((m, n) => n - m);
    return (p + 0.05) / (q + 0.05);
  };
  const alpha = () => getComputedStyle(root).getPropertyValue("--card-tint-a").trim();
  const expectImg = (hex) => {
    const [r, g, b] = rgbOf(hex);
    const a = alpha();
    return `linear-gradient(rgba(${r}, ${g}, ${b}, ${a}), rgba(${r}, ${g}, ${b}, ${a}))`;
  };
  // 一张卡按库里的 color 判 ①② (+③ 若有 footer)
  const judgeCard = (label, card, color) => {
    const img = getComputedStyle(card).backgroundImage;
    if (color) {
      ok(`${label} 有色卡挂 .tinted`, card.classList.contains("tinted"));
      ok(`${label} 有色卡真画出来了(${img.slice(0, 60)})`, img === expectImg(color));
    } else {
      ok(`${label} 无色卡不挂 .tinted、不画底`, !card.classList.contains("tinted") && img === "none");
    }
    const f = card.querySelector("footer");
    if (f) {
      const want = tokenColor(color ? "--ink-soft-on-tint" : "--ink-soft");
      ok(`${label} footer 字色 = ${color ? "补偿色" : "原 --ink-soft"}(${getComputedStyle(f).color})`, getComputedStyle(f).color === want);
      // ③b 对比度真没掉:把淡底按 alpha 合成到 --raised 上,算 footer 小字的 WCAG 比值,不许低于无色卡上的原值。
      // ⭐ 这一格守的是「改了浓度 / 调色板却没重算补偿值」—— 只判「字色 = 补偿令牌」那格照样绿。
      if (color) {
        const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const raised = rgb(tokenColor("--raised"));
        const a = Number(alpha());
        const bg = rgbOf(color).map((v, i) => Math.round(v * a + raised[i] * (1 - a)));
        const base = contrast(rgb(tokenColor("--ink-soft")), raised);
        const now = contrast(rgb(getComputedStyle(f).color), bg);
        ok(`${label} footer 小字对比度 ${now.toFixed(2)} ≥ 无色卡原值 ${base.toFixed(2)}`, now >= base - 0.005);
      }
    }
  };

  const theme0 = root.dataset.theme;
  // ---- 时间轴(任务面)----
  const tl = await I("list_timeline", { spaceId: space });
  const byId = new Map(tl.map((r) => [r.id, r]));
  const modeBtn = document.querySelector('#bottombar [data-mode="tasks"]');
  if (document.body.classList.contains("pane-open")) history.back();
  await sleep(300);
  modeBtn.click();
  await sleep(600);
  const cards = () => [...document.querySelectorAll("#timeline article.card[data-id]")];
  const colored = cards().filter((c) => byId.get(c.dataset.id)?.color);
  const plain = cards().filter((c) => byId.has(c.dataset.id) && !byId.get(c.dataset.id).color);
  if (!colored.length) return { error: "时间轴上一张有色卡都没渲染 —— 先摆局(见文件头前置),这不是过" };
  if (!plain.length) return { error: "时间轴上没有无色卡当对照 —— 先摆局" };
  try {
    for (const th of ["light", "dark"]) {
      root.dataset.theme = th;
      await sleep(100);
      ok(`[${th}] 前置:--card-tint-a 有值(${alpha()})`, Number(alpha()) > 0);
      for (const c of cards()) {
        const r = byId.get(c.dataset.id);
        if (r) judgeCard(`[${th}] 时间轴 ${r.content.slice(0, 10)}`, c, r.color);
      }
    }
    // ⑤ 回收站 / 归档册(亮色档判一遍就够:画法与时间轴同一条规则,①已在两档都判过)
    root.dataset.theme = "light";
    const panes = [
      ["trash", "trash-list", "data-trash", (await I("list_trash", { spaceId: space }))],
      ["sealed", "sealed-list", "data-sealed", (await I("list_sealed_tasks", { spaceId: space }))],
    ];
    for (const [pane, listId, attr, rows] of panes) {
      const m = new Map(rows.map((r) => [r.id, r.color]));
      document.querySelector(`#bottombar [data-pane="${pane}"]`).click();
      let got = [];
      for (let i = 0; i < 30 && got.length < rows.length; i++) {
        await sleep(100);
        got = [...document.querySelectorAll(`#${listId} article.card[${attr}]`)];
      }
      if (![...m.values()].some(Boolean)) {
        ok(`${pane} 前置:面里有一张有色卡(没有 ⇒ 这一格没跑,不是过)`, false);
      } else {
        for (const c of got) judgeCard(`${pane}`, c, m.get(c.getAttribute(attr)) ?? null);
      }
      history.back();
      await sleep(400);
    }
  } finally {
    root.dataset.theme = theme0;
  }
  out.pass = out.steps.length > 0 && out.steps.every((s) => s.ok);
  return out;
})()
