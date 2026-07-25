// 时间轴筛选(灵感/看板两面,与桌面同源三维:kind→topics→text)真机验收 · 验证。
// ①-③ 按类型筛选(190/192);④-⑩ 标签多选走「或」+ 父子折叠(229,追齐桌面 219/221)。
// 三步流程之中:假设已 evalfile cdp-acceptance-timeline-filter-seed.js 播种
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

  // ---- 229:标签多选走「或」+ 父子折叠(安卓追齐桌面 219/221)----
  const seed = JSON.parse(localStorage.getItem("__ffv_seed") || "null");
  if (!ok("读到播种 ids(seed.named)", !!seed?.named)) return JSON.stringify(out);
  const { home, kid1, kid2 } = seed.named;
  const byId = (id) => document.querySelector(`#filter-topics .fpill[data-topic-id="${id}"]`);
  const findAll = () => topicPills().find((p) => p.textContent.includes("所有"));
  const findNone = () => topicPills().find((p) => p.textContent.includes("无标签"));

  // ④ 多选并集:张三 + 李四 同时选中 → 两条都在、项目那条不在;两枚 pill 同时高亮。
  click(findTopic("FFV-张三"));
  click(findTopic("FFV-李四"));
  ok("多选:张三+李四两条都在", shows("FFV-想到张三") && shows("FFV-想到李四"));
  ok("多选:项目那条被排除", !shows("FFV-想到项目"));
  ok(
    "多选:两枚 pill 同时高亮",
    findTopic("FFV-张三")?.classList.contains("active") &&
      findTopic("FFV-李四")?.classList.contains("active"),
  );
  ok("多选:「所有」不高亮", !findAll()?.classList.contains("active"));
  // 再点张三 = 切出选集(只剩李四)。
  click(findTopic("FFV-张三"));
  ok("再点张三:切出选集,只剩李四", shows("FFV-想到李四") && !shows("FFV-想到张三"));

  // ⑤ 「无标签」与具体标签互斥(一个条目不可能既无标签又挂着某标签)。
  click(findNone());
  ok("选无标签:李四 pill 不再高亮", !findTopic("FFV-李四")?.classList.contains("active"));
  ok("选无标签:无标签 pill 高亮", findNone()?.classList.contains("active"));
  click(findTopic("FFV-李四"));
  ok("再选李四:无标签 pill 取消高亮", !findNone()?.classList.contains("active"));
  click(findAll());
  ok("点「所有」:清空选集、恢复全量", findAll()?.classList.contains("active") && shows("FFV-想到项目"));

  // ⑥ 父子折叠:父 FFV-家 出 pill 并带箭头;两子默认收起(在 DOM 里但 .hidden)。
  const parentPill = byId(home);
  if (!ok("父标签 FFV-家 出 pill", !!parentPill)) return JSON.stringify(out);
  const caret = parentPill.querySelector(".fcaret");
  ok("父 pill 带折叠箭头", !!caret);
  ok("默认收起:箭头是 ▸", caret?.textContent === "▸");
  ok(
    "默认收起:两子 pill 存在但 .hidden",
    byId(kid1)?.classList.contains("hidden") && byId(kid2)?.classList.contains("hidden"),
  );
  ok("子 pill 挂 .child + data-parent=父 id", byId(kid1)?.classList.contains("child") && byId(kid1)?.dataset.parent === home);
  ok("子 pill 只显后缀(买菜,不是全名)", byId(kid1)?.textContent.includes("买菜") && !byId(kid1)?.textContent.includes("FFV-家/"));

  // ⑦ 点箭头展开 → 子 pill 露出、箭头翻 ▾;**且不重投影**(展开不是筛选:列表内容不变)。
  const beforeExpand = cardTexts().length;
  click(caret);
  ok("点箭头:两子 pill 露出", !byId(kid1)?.classList.contains("hidden") && !byId(kid2)?.classList.contains("hidden"));
  ok("点箭头:箭头翻 ▾", parentPill.querySelector(".fcaret")?.textContent === "▾");
  ok("点箭头:列表条数不变(展开不是筛选)", cardTexts().length === beforeExpand);
  ok("点箭头:没顺带把父标签筛上(父 pill 未高亮)", !byId(home)?.classList.contains("active"));

  // ⑧ 展开态下点子标签「买菜」→ 只剩那条;收起父标签后,选中的子 pill 仍可见(活筛不藏)。
  click(byId(kid1));
  ok("点子标签买菜:只剩那条", shows("FFV-该买菜了") && !shows("FFV-灯泡坏了") && !shows("FFV-家务总览"));
  const caret2 = byId(home)?.querySelector(".fcaret");
  click(caret2);
  ok("收起父标签:选中的买菜仍可见", !byId(kid1)?.classList.contains("hidden"));
  ok("收起父标签:没选中的修灯藏起来", byId(kid2)?.classList.contains("hidden"));

  // ⑨ 箭头命中盒按手指给足(桌面那枚 1px padding 的小箭头在触屏点不中):≥26×28,
  //    且不外溢父 pill(否则抢邻座 pill 的点击)。
  const cbox = byId(home)?.querySelector(".fcaret")?.getBoundingClientRect();
  const pbox = byId(home)?.getBoundingClientRect();
  ok("箭头命中盒 ≥26×28", cbox && cbox.width >= 26 && cbox.height >= 28, cbox && { w: +cbox.width.toFixed(1), h: +cbox.height.toFixed(1) });
  ok("箭头不外溢父 pill", cbox && pbox && cbox.right <= pbox.right + 0.5 && cbox.top >= pbox.top - 0.5 && cbox.bottom <= pbox.bottom + 0.5);

  // ⑩ 收场:清回「所有」,别把筛选留在用户脸上。
  click(findAll());
  ok("收场:回到不筛", findAll()?.classList.contains("active") && shows("FFV-想到项目"));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
