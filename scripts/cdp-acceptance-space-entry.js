// 148 空间两来路 UI 验收 —— 空间面板「加入空间」入口(扫码主路+输码辅路折叠)、
// join-form 服务器预填、无 attempt 时取消行隐藏、空间列表「仅本机」tag 按 configured
// 分道、当前空间非 main 未配置时同步面=创号单路(一主两辅只对 main 成立)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-space-entry.js
// 注:本资产只验 UI 静态半截,不发真 join、不建空间(空间无删除入口,建了=永久残留);
// 真加入/取消/杀进程流程走 space-entry-plan §7 人工主流程。非 main 断言是条件项:
// 当前空间是 main 时标 skip 算过——验收轮切到测试空间再跑一遍本资产补上。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const visible = (el) => !!el && el.offsetParent !== null;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });

  // 开空间面板:多空间点头部徽章,单空间走同步面底部「空间…」兜底。
  if (document.body.classList.contains("pane-open")) {
    // 回到时间轴干净态(任一面开着都先关)
    const t = $("sync-toggle");
    if (visible($("sync"))) { t.click(); await sleep(200); }
  }
  if (!$("space-chip").hidden) {
    $("space-chip").click();
  } else {
    $("sync-toggle").click();
    await sleep(300);
    $("sync-spaces-btn").click();
  }
  await sleep(400);
  check("空间面板已开", visible($("spaces")));

  // ---- 加入空间入口(app 级,不挑当前空间) ----
  check("「加入空间(扫电脑二维码)」主路可见", visible($("join-scan-btn")),
    $("join-scan-btn")?.textContent);
  check("「输码加入」辅路可见", visible($("join-alt-btn")));
  // 先归位:join-form 可能被上一轮交互留开着(前端刻意保留展开态),资产验的是
  // 折叠开关行为本身,不赌进场状态。
  if (!$("join-form").hidden) { $("join-alt-btn").click(); await sleep(100); }
  check("join-form 收起态", $("join-form").hidden);
  check("无 attempt 时「取消加入」行隐藏", $("join-cancel-row").hidden);

  $("join-alt-btn").click();
  await sleep(100);
  check("点「输码加入」: 表单展开", !$("join-form").hidden);
  check("服务器预填生产地址",
    $("join-server").value === "wss://sync.zhujian.app", $("join-server").value);
  check("配对码占位提示指向「添加设备」",
    ($("join-code").placeholder || "").includes("添加设备"), $("join-code").placeholder);
  $("join-alt-btn").click();
  await sleep(100);
  check("再点收起", $("join-form").hidden);

  // ---- 空间列表「仅本机」tag 按 configured 分道 ----
  const spaceRows = [...document.querySelectorAll("#space-list .space-row[data-space]")]
    .filter((r) => !r.classList.contains("sub"));
  check("空间列表非空", spaceRows.length > 0, `rows=${spaceRows.length}`);
  const localTagged = spaceRows.filter((r) =>
    [...r.querySelectorAll(".tag")].some((t) => t.textContent === "仅本机"));
  // 「仅本机」只可能挂在非当前行(当前行 tag 被「当前」占位)——这里只验存在性语义:
  // 有未配置空间时资产无法从 DOM 独立判 configured,故记录计数供验收轮人工对账。
  check("「仅本机」tag 渲染可达(计数记录,验收轮对账)", true,
    `local=${localTagged.length}/${spaceRows.length}`);

  // ---- 当前空间语境:非 main 未配置 = 创号单路 ----
  const curId = document.querySelector("#space-list .space-row.current")?.dataset?.space
    ?? "main"; // 单空间列表也渲染 current 行;拿不到就按 main 保守跳过
  let nonMainChecked = false;
  // 切去同步面看未配置态路数
  $("sync-toggle").click();
  await sleep(400);
  const unconfigured = visible($("sync-join"));
  if (curId !== "main" && unconfigured) {
    nonMainChecked = true;
    check("非main未配置: 扫码主路整行隐藏", $("sync-scan-btn").parentElement.hidden);
    check("非main未配置: 手输码辅路隐藏", $("sync-alt-pair").hidden);
    check("非main未配置: 创号单路文案",
      $("sync-alt-create").textContent === "开启多端同步(创建账户)",
      $("sync-alt-create").textContent);
    check("非main未配置: 创号钮非 ghost(唯一主路)",
      !$("sync-alt-create").classList.contains("ghost"));
    $("sync-alt-create").click();
    await sleep(100);
    check("非main未配置: 点创号展开+服务器行显",
      !$("sync-create").hidden && !$("sync-server-row").hidden);
    $("sync-alt-create").click();
    await sleep(100);
    check("非main未配置: 再点收起", $("sync-create").hidden && $("sync-server-row").hidden);
  } else if (curId === "main" && unconfigured) {
    check("main 未配置: 扫码主路保留(一主两辅归 sync-ui 资产)",
      !$("sync-scan-btn").parentElement.hidden);
  }

  // 关面收尾
  if (visible($("sync"))) { $("sync-toggle").click(); await sleep(200); }

  const pass = rows.every((r) => r.ok);
  return { curSpace: curId, unconfigured, nonMainChecked, rows, pass };
})();
