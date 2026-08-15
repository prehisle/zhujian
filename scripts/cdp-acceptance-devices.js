// 367 片⑤ 安卓设备名单验收(identity-plan §5.8/§5.9,§5.16.3 点名的「安卓 CDP 资产一支」)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-devices.js
//
// ⚠ **前置**:当前空间已配置账户**且已连上服务器**(名册是会话内事实,断线即 null)。
// 前置不满足时它**红在第一行**,不静默跳过 —— 一只只会说 OK 的资产和一只没跑的资产,
// 输出是一样的(skill `mutation-check` 的正控那条)。
//
// ⛔ **绝不真移除任何设备**:两拍确认只走到「底部确认条出现」,第二拍一律按「取消」。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const visible = (el) => !!el && el.offsetParent !== null;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });
  const devRows = () => [...document.querySelectorAll("#sync-devices .dev-row")];
  const txt = (el) => (el?.textContent ?? "").trim();

  // 开同步面(已开先关再开,回到干净态)
  if (document.body.classList.contains("pane-open")) {
    $("sync-toggle").click();
    await sleep(200);
  }
  $("sync-toggle").click();
  await sleep(400);

  const configured = visible($("sync-online"));
  check("前置:本空间已配置账户(同步面已开且在已配置态)", visible($("sync")) && configured);
  if (!configured) return { rows, pass: false, note: "未配置账户 —— 这支资产要在真账户上跑" };

  check("入口在同步面上", visible($("sync-devices-btn")), txt($("sync-devices-btn")));
  check("设备区初始折叠", $("sync-devices").hidden);

  $("sync-devices-btn").click();
  await sleep(300);
  check("点开即展开", !$("sync-devices").hidden);

  // 名册是**服务器推 + 本页主动拉**的会话内事实,给它几秒到位。
  for (let i = 0; i < 40 && devRows().length === 0; i++) await sleep(250);
  const list = devRows();
  const panelText = txt($("sync-devices"));

  if (list.length === 0) {
    // 拿不到名册 = 不给操作面。这一格照样要断言**话说对了**(§5.8 M4:不许断言
    // 「服务器版本较旧」—— 新服务器的 attach 推送同样可能丢)。
    check("名册拿不到时的话术", panelText.includes("尚未确认服务器支持"), panelText.slice(0, 80));
    check("名册拿不到时不列任何一行", list.length === 0);
    check("⚠ 本次未覆盖名单渲染与两拍确认(名册没到)", false, "要在连上服务器时重跑");
    $("sync-devices-btn").click();
    await sleep(200);
    $("sync-toggle").click();
    return { rows, pass: false, note: "名册未到,主体面未覆盖" };
  }

  // ---- 名单渲染 ----
  check("列出了设备", list.length >= 1, `${list.length} 行`);
  const badgeOf = (r) => [...r.querySelectorAll(".dev-badge")].map(txt);
  const thisCount = list.filter((r) => badgeOf(r).includes("本机")).length;
  check("恰有一行带「本机」徽章", thisCount === 1, `${thisCount} 行`);
  const adminRows = list.filter((r) => badgeOf(r).includes("管理"));
  check("「管理」徽章只落在管理设备上(≤ 总行数)", adminRows.length <= list.length,
    `${adminRows.length}/${list.length}`);

  // ---- 最短唯一前缀:各行互不相同、且都 ≥6 位 ----
  const sids = list.map((r) => txt(r.querySelector(".dev-sid")).replace(/…$/, ""));
  check("短 id 各行互不相同(唯一前缀是算出来的)",
    new Set(sids).size === sids.length, sids.join(","));
  check("短 id 都不短于 6 位", sids.every((s) => s.length >= 6), sids.join(","));

  // ---- 展开:完整 26 位 ----
  list[0].click();
  await sleep(250);
  const opened = devRows()[0];
  const fullId = txt(opened.querySelector(".dev-id"));
  check("点开给出完整 26 位设备 ID", fullId.length === 26, fullId);
  check("完整 ID 以那一行的短 id 开头", fullId.startsWith(sids[0]), `${sids[0]} / ${fullId}`);
  check("展开行带「复制完整 ID」", txt(opened).includes("复制完整 ID"));

  // ---- 操作显隐(§5.3 三句话)+ §5.9 话术 ----
  const btns = [...opened.querySelectorAll(".row button")].map(txt);
  const isThis = badgeOf(opened).includes("本机");
  const anyAdmin = adminRows.length > 0;
  if (!anyAdmin) {
    // 存量账户未回填:整条用户面 fail-closed,**含自助退出**。
    check("admins 为空 → 那句说明在", panelText.includes("本空间还没有设置管理设备"));
    check("admins 为空 → 一个操作按钮都不给",
      btns.filter((b) => b !== "复制完整 ID").length === 0, btns.join("/"));
  } else if (isThis) {
    check("本机行给「退出账户」", btns.includes("退出账户"), btns.join("/"));
    check("本机行不给「设为管理 / 取消管理」",
      !btns.includes("设为管理") && !btns.includes("取消管理"), btns.join("/"));
    // §5.9 的自助退出话术三句。
    const facts = [...opened.querySelectorAll(".dev-facts li")].map(txt);
    check("退出话术三句全在", facts.length === 3, facts.join(" | "));
    check("话术讲了「本机数据不会被删除」",
      facts.some((f) => f.includes("不会被删除")), facts.join(" | "));
  }

  // ---- 两拍确认:只走到确认条出现,第二拍按「取消」 ----
  const destructive = [...opened.querySelectorAll(".row button")].find(
    (b) => txt(b) === "移除" || txt(b) === "退出账户",
  );
  if (destructive) {
    destructive.click();
    await sleep(300);
    check("第一拍升起底部固定确认条", !$("confirmbar").hidden, txt($("confirmbar-q")));
    check("确认条问句点名了是哪一台",
      txt($("confirmbar-q")).includes(sids[0]) ||
        txt($("confirmbar-q")).includes("本机"),
      txt($("confirmbar-q")));
    $("confirmbar-no").click(); // ⛔ 绝不按「确认」
    await sleep(250);
    check("「取消」收回确认条,名单一行不动",
      $("confirmbar").hidden && devRows().length === list.length);
  } else {
    check("⚠ 本次未覆盖两拍确认(这一行没有破坏性动作)", true, btns.join("/"));
  }

  // 收尾:收起展开行 + 收起设备区 + 关同步面
  devRows()[0].querySelector(".dev-head")?.click();
  await sleep(150);
  $("sync-devices-btn").click();
  await sleep(150);
  $("sync-toggle").click();
  await sleep(200);

  return { rows, pass: rows.every((r) => r.ok), devices: list.length, admins: adminRows.length };
})();
