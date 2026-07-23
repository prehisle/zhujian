// 时间轴「按类型筛选」验收 · 播种(三步流程之一):建人名类两标签 FFV-张三/FFV-李四 +
// 无类型标签 FFV-项目甲,各挂一条灵感。ids 存 localStorage 跨 reload 存活,-cleanup 读回
// 删净。用法:evalfile 本脚本 → `location.reload()`(让 app 重读 timeline+list_topics_full)
// → evalfile cdp-acceptance-timeline-filter.js 验证 → evalfile -cleanup → reload 复核零残留。
(async () => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const space = await inv("foreground_space", {});
  const mk = async (title) => await inv("create_topic", { spaceId: space, title });
  const p1 = await mk("FFV-张三");
  const p2 = await mk("FFV-李四");
  const proj = await mk("FFV-项目甲");
  await inv("set_topic_kind", { spaceId: space, id: p1, kind: "人名" });
  await inv("set_topic_kind", { spaceId: space, id: p2, kind: "人名" });
  const idea = async (content, topicId) => {
    const id = await inv("capture_idea", { spaceId: space, content });
    await inv("file_note_to_topic", { spaceId: space, id, topicId, newTitle: null });
    return id;
  };
  const a = await idea("FFV-想到张三", p1);
  const b = await idea("FFV-想到李四", p2);
  const c = await idea("FFV-想到项目", proj);
  const rec = { space, topics: [p1, p2, proj], ideas: [a, b, c] };
  localStorage.setItem("__ffv_seed", JSON.stringify(rec));
  return JSON.stringify({ seeded: true, ...rec });
})();
