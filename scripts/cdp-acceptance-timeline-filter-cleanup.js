// 时间轴「按类型筛选」验收 · 删净(三步流程之末):删掉 -seed 播种的 3 灵感(先软删再
// 彻底删)+ 3 标签,清 localStorage 标记。读回 __ffv_seed;删不存在的静默吞(幂等)。
(async () => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const rec = JSON.parse(localStorage.getItem("__ffv_seed") || "null");
  if (!rec) return JSON.stringify({ cleaned: false, reason: "no seed record" });
  const { space, topics, ideas } = rec;
  const swallow = async (p) => { try { await p; } catch (e) { /* 幂等:已删则吞 */ } };
  for (const id of ideas) {
    await swallow(inv("archive_note", { spaceId: space, id }));
    await swallow(inv("purge_note", { spaceId: space, id }));
  }
  for (const id of topics) await swallow(inv("delete_topic", { spaceId: space, id }));
  localStorage.removeItem("__ffv_seed");
  return JSON.stringify({ cleaned: true, ideas: ideas.length, topics: topics.length });
})();
