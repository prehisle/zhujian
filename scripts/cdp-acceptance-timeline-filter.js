// 时间轴「按类型筛选」(灵感/看板两面,与桌面 190/192 同源三维:kind→topic→text)真机
// 验收 · 验证(三步流程之中):假设已 evalfile cdp-acceptance-timeline-filter-seed.js 播种
// 且随后 reload(app 重读 timeline+list_topics_full)。点类型 pill 走 onFilterPick→
// projectTimeline 同步重投影,无需再 reload。evalfile 跑,pass=true 才算过。只读+点击,
// 不删数据(删净跑 -cleanup)。
(() => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const kindPills = () => [...document.querySelectorAll("#filter-kinds .fpill")];
  const topicPills = () => [...document.querySelectorAll("#filter-topics .fpill")];
  const cardTexts = () =>
    [...document.querySelectorAll("#timeline [data-id] .content")].map((c) => c.textContent);
  const findKind = (t) => kindPills().find((p) => p.textContent.includes(t));
  const findTopic = (t) => topicPills().find((p) => p.textContent.includes(t));
  const shows = (t) => cardTexts().some((c) => c.includes(t));

  // 前置:在灵感面、类型行已出现(播种生效)。
  const mode = document.querySelector("#bottombar [data-mode].active")?.dataset.mode;
  if (!ok("在灵感面", mode === "ideas")) return JSON.stringify(out);
  if (!ok("类型行出现(全部类型 + 人名)", !!findKind("全部类型") && !!findKind("人名")))
    return JSON.stringify(out);
  ok("人名 pill 计数=2(挂人名标签的灵感数)", findKind("人名")?.textContent.includes("2"));

  // ① 选「人名」→ 列表缩到挂人名标签的灵感、项目灵感消失;标签 pill 收到人名类内
  //    (张三/李四在、无标签 pill 消失、项目标签消失)。
  click(findKind("人名"));
  ok("选人名:张三/李四在、项目消失", shows("FFV-想到张三") && shows("FFV-想到李四") && !shows("FFV-想到项目"));
  ok("选人名:标签行收到人名类(有张三/李四)", !!findTopic("FFV-张三") && !!findTopic("FFV-李四"));
  ok("选人名:无「无标签」pill", !topicPills().some((p) => p.textContent.includes("无标签")));
  ok("选人名:无项目标签 pill", !findTopic("FFV-项目甲"));
  ok("选人名:「人名」pill 高亮", findKind("人名")?.classList.contains("active"));

  // ② 类型内再钻到「张三」→ 只剩张三那条。
  click(findTopic("FFV-张三"));
  ok("钻到张三:只剩张三", shows("FFV-想到张三") && !shows("FFV-想到李四") && !shows("FFV-想到项目"));
  ok("张三 pill 高亮", findTopic("FFV-张三")?.classList.contains("active"));

  // ③ 回「全部类型」→ 恢复全量(项目灵感回来、无标签 pill 回来、标签轴归零)。
  click(findKind("全部类型"));
  ok("回全部类型:项目灵感回来", shows("FFV-想到项目") && shows("FFV-想到张三"));
  ok("回全部类型:无标签 pill 回来", topicPills().some((p) => p.textContent.includes("无标签")));
  ok("回全部类型:全部类型 pill 高亮", findKind("全部类型")?.classList.contains("active"));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
