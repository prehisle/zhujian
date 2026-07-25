// 时间轴筛选验收 · 播种(三步流程之一):建人名类两标签 FFV-张三/FFV-李四 + 无类型标签
// FFV-项目甲 + **一组父子标签 FFV-家 / FFV-家/买菜 / FFV-家/修灯**(验多选并集与父子折叠,
// 229),各挂一条灵感。ids 存 localStorage 跨 reload 存活,-cleanup 读回删净(它按 topics/
// ideas 数组通吃,加种子不用改它)。用法:evalfile 本脚本 → `location.reload()`(让 app 重读
// timeline+list_topics_full)→ evalfile cdp-acceptance-timeline-filter.js 验证 → evalfile
// -cleanup → reload 复核零残留。
(async () => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const space = await inv("foreground_space", {});
  const mk = async (title) => await inv("create_topic", { spaceId: space, title });
  const p1 = await mk("FFV-张三");
  const p2 = await mk("FFV-李四");
  const proj = await mk("FFV-项目甲");
  await inv("set_topic_kind", { spaceId: space, id: p1, kind: "人名" });
  await inv("set_topic_kind", { spaceId: space, id: p2, kind: "人名" });
  // 父子标签一组(229):父 FFV-家 与两子 FFV-家/买菜、FFV-家/修灯——`父/子` 命名且同名父
  // 存在才算子(同 filter.ts::groupPills)。三枚各挂一条灵感,否则零计数 pill 不出现。
  const home = await mk("FFV-家");
  const kid1 = await mk("FFV-家/买菜");
  const kid2 = await mk("FFV-家/修灯");
  const idea = async (content, topicId) => {
    const id = await inv("capture_idea", { spaceId: space, content });
    await inv("file_note_to_topic", { spaceId: space, id, topicId, newTitle: null });
    return id;
  };
  const a = await idea("FFV-想到张三", p1);
  const b = await idea("FFV-想到李四", p2);
  const c = await idea("FFV-想到项目", proj);
  const d = await idea("FFV-家务总览", home);
  const e = await idea("FFV-该买菜了", kid1);
  const g = await idea("FFV-灯泡坏了", kid2);
  const rec = {
    space,
    topics: [p1, p2, proj, home, kid1, kid2],
    ideas: [a, b, c, d, e, g],
    named: { p1, p2, proj, home, kid1, kid2 },
  };
  localStorage.setItem("__ffv_seed", JSON.stringify(rec));
  return JSON.stringify({ seeded: true, ...rec });
})();
