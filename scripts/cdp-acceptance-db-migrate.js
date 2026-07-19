// 151 安卓恢复前滚迁移验收 —— 启动闸放行 + 逐空间库版本对账(地面真相=PRAGMA)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-db-migrate.js
// 断言:gate=ready(封锁页没出现)、每个空间 user_version=EXPECT_UV、journal_mode=wal、
// device_id ULID 形态、items 计数非负(数据在,不判具体值——锚点对账另做)。
// 会逐空间 activate 再查(手机 max_live=1,db_info 只对前台空间可用),查完切回原空间
// 并 reload 让 UI 与后端前台重新对齐。EXPECT_UV 随 core SCHEMA_VERSION 升版更新。
(async () => {
  const EXPECT_UV = 29;
  const invoke = window.__TAURI__.core.invoke;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });

  const gate = document.getElementById("gate");
  const gateReady = !!gate && gate.hidden;
  let gateDetail = "";
  if (!gateReady) {
    for (const p of ["upgrade", "retry", "repair", "reset"]) {
      const pane = document.getElementById(`gate-${p}`);
      if (pane && !pane.hidden) {
        gateDetail = `${p}: ${document.getElementById(`gate-msg-${p}`)?.textContent ?? ""}`;
      }
    }
  }
  check("启动闸放行(无封锁页)", gateReady, gateDetail);
  if (!gateReady) return { pass: false, rows };

  const spaces = await invoke("list_spaces");
  check("空间清单非空", spaces.length > 0, `n=${spaces.length}`);
  const original = spaces.find((s) => s.current)?.id;
  check("有前台空间", !!original, original);

  for (const s of spaces) {
    try {
      if (s.id !== original) await invoke("activate_space", { spaceId: s.id });
      const info = await invoke("db_info", { spaceId: s.id });
      const tag = s.name ?? s.id.slice(-6);
      check(`[${tag}] user_version=${EXPECT_UV}`, info.user_version === EXPECT_UV,
        `uv=${info.user_version}`);
      check(`[${tag}] journal_mode=wal`, info.journal_mode === "wal", info.journal_mode);
      check(`[${tag}] device_id ULID`, /^[0-9A-HJKMNP-TV-Z]{26}$/.test(info.device_id),
        info.device_id);
      check(`[${tag}] items 可读`, Number.isInteger(info.items) && info.items >= 0,
        `items=${info.items}`);
    } catch (e) {
      check(`[${s.name ?? s.id}] db_info`, false, String(e));
    }
  }
  if (original) await invoke("activate_space", { spaceId: original }).catch(() => {});
  setTimeout(() => location.reload(), 500);
  return { pass: rows.every((r) => r.ok), rows };
})();
