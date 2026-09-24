// @cdp-run single
// 133 同步 UI 简化验收 —— 单空间藏空间概念、已配置态收「连接信息」折叠、
// 「添加设备」改名、折叠里「复制账户号」带着显示的账户号(盈利准备 C4)、**已配置态没有任何恢复码痕迹**(用户面 125 拆掉:钮 / 码 / 警示三件都不在 DOM 里);
// 未配置态(若在)一主两辅互斥折叠。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-sync-ui.js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const visible = (el) => !!el && el.offsetParent !== null;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });

  // 开同步面(已开则先关再开,回到干净态)
  if (document.body.classList.contains("pane-open")) {
    $("sync-toggle").click();
    await sleep(200);
  }
  $("sync-toggle").click();
  await sleep(400);
  check("同步面已开", visible($("sync")));

  const single = $("space-chip").hidden;
  check("单空间: 头部徽章隐藏 ⟺ 兜底「空间…」显示",
    $("space-chip").hidden === !$("sync-spaces-btn").hidden,
    `chipHidden=${$("space-chip").hidden} spacesBtnHidden=${$("sync-spaces-btn").hidden}`);
  if (single) {
    check("单空间: 同步标题不带空间名", $("sync-title").textContent === "同步",
      $("sync-title").textContent);
  } else {
    check("多空间: 同步标题带空间名", $("sync-title").textContent.startsWith("同步 · "),
      $("sync-title").textContent);
  }

  if (visible($("sync-online"))) {
    // ---- 已配置态 ----
    check("「添加设备」改名", $("sync-invite-btn").textContent === "添加设备",
      $("sync-invite-btn").textContent);
    check("连接信息初始折叠", $("sync-info").hidden);
    $("sync-conninfo-btn").click();
    await sleep(100);
    const infoText = $("sync-info").textContent;
    check("连接信息点开可见且有账户/服务器", !$("sync-info").hidden &&
      /账户|服务器/.test(infoText), infoText.slice(0, 80));
    // 盈利准备 C4:账户号要抄得走 —— 折叠里有「复制账户号」,它带的正是那一格等宽显示的账户号。
    const accShown = document.querySelector("#sync-info-kv .v.mono")?.textContent ?? "";
    check("连接信息里有「复制账户号」且带着显示的那串账户号",
      visible($("sync-account-copy")) && accShown !== "" && $("sync-account-copy").dataset.copy === accShown,
      `shown=${accShown} copy=${$("sync-account-copy")?.dataset.copy}`);
    $("sync-conninfo-btn").click();
    await sleep(100);
    check("连接信息再点收起", $("sync-info").hidden);

    // 用户面 125:恢复码整个拆掉 —— 钮 / 码块 / 警示三个节点都不该在 DOM 里,面上也不许再出现这个词。
    check("已配置态无恢复码痕迹(三个节点都不在)",
      !$("sync-recovery-btn") && !$("sync-recovery") && !$("sync-recovery-note"));
    check("同步面文字不含「恢复码」", !$("sync-online").textContent.includes("恢复码"));
  }

  // 148 起「一主两辅」只对 main 成立:非 main 未配置=创号单路(扫码/手输藏),
  // 归 cdp-acceptance-space-entry.js 验;这里守卫住,别在测试空间里点隐藏钮误判。
  const curSpace = document.querySelector("#space-list .space-row.current")?.dataset?.space
    ?? "main";
  if (visible($("sync-join")) && curSpace === "main") {
    // ---- 未配置态(main):一主两辅互斥折叠 ----
    check("主按钮「扫码连接电脑」", $("sync-scan-btn").textContent === "扫码连接电脑",
      $("sync-scan-btn").textContent);
    check("辅路初始全收起(含服务器行)",
      $("sync-manual").hidden && $("sync-create").hidden && $("sync-server-row").hidden);
    $("sync-alt-pair").click();
    await sleep(100);
    check("点手输码: 手输开+创号收+服务器行显",
      !$("sync-manual").hidden && $("sync-create").hidden && !$("sync-server-row").hidden);
    $("sync-alt-create").click();
    await sleep(100);
    check("点创号: 互斥切换(手输收+创号开)",
      $("sync-manual").hidden && !$("sync-create").hidden && !$("sync-server-row").hidden);
    $("sync-alt-create").click();
    await sleep(100);
    check("重复点当前项: 全收起", $("sync-manual").hidden && $("sync-create").hidden &&
      $("sync-server-row").hidden);
  }

  // 关面收尾
  $("sync-toggle").click();
  await sleep(200);

  const pass = rows.every((r) => r.ok);
  return { single, rows, pass };
})();
