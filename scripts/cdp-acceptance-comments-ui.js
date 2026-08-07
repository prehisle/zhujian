// 314 条目留言 安卓 **UI 层**真机验收(第③笔):
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-comments-ui.js
//
// 覆盖六件(桌面 e2e 那两例的手机对应物 + 手机独有的三件):
//   ① N=0 不显徽章、写入口在卡片操作面板的「留言」上(没有它第一条留言无从写起);
//   ② 开层 → 写一条 → 徽章 `💬 1` → 点徽章重开(徽章是第二个入口);
//   ③ 两拍销毁走底部固定确认条,第一拍不删、第二拍才删,徽章跟着退回不显;
//   ④ 点徽章**不连带开合卡片操作面板**(cardpanel 不抢这一格);
//   ⑤ 返回键关层的 popstate 那一半(history.back();**原生 keyevent 4 那一半在驱动侧发**,
//      见文件尾——页内断言证不了 WryActivity 的账,146 栽过);
//   ⑥ 宿主真没了(archive+purge)即关层,且**经一次真刷新**触发,与远端 op 落地同一条路。
// 末尾 finally 清场:临时条目 purge(留言随 FK CASCADE 走),层收掉。
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const $ = (id) => document.getElementById(id);
  const sheetOpen = () => document.body.classList.contains("cm-open");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const badgeOf = (id) => cardOf(id)?.querySelector(".cm-badge");

  const spaces = await invoke("list_spaces");
  const space = spaces.find((s) => s.current)?.id;
  if (!check("有前台空间", !!space, space ?? "")) return { pass: false, rows };

  let itemId = null;
  try {
    // 建宿主并让它真进时间轴:走「记下」按钮(它自带一次 refresh,与用户路径同一条)。
    const marker = `【CDP验收314-UI】留言宿主 ${Date.now()}`;
    $("text").value = marker;
    click($("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!check("建临时条目入时间轴", !!card)) return { pass: false, rows };
    itemId = card.dataset.id;

    // ---- ① N=0 不显徽章;写入口在操作面板 ------------------------------------
    check("零留言时卡上无徽章", !badgeOf(itemId));
    click(cardOf(itemId).querySelector(".content")); // 开卡片操作面板(节点现查,见下面那条纪律)
    const entry = await until(() => cardOf(itemId)?.querySelector('.panel [data-pact="comment"]'));
    if (!check("操作面板有「留言」入口", !!entry)) return { pass: false, rows };
    click(entry);
    if (!check("层开了", await until(() => sheetOpen(), 2000))) return { pass: false, rows };
    check("空态文案在", await until(() => $("cm-list").textContent.includes("还没有留言"), 3000));
    check("加载更多入口收着(只有一页)", $("cm-more").hidden);

    // ---- ② 写一条 → 徽章出现 → 点徽章能重开 ----------------------------------
    $("cm-input").value = "手机写的第一句";
    click($("cm-send"));
    const wrote = await until(() => $("cm-list").querySelectorAll(".cm-item").length === 1, 5000);
    check("写下后列表出现一条", !!wrote);
    check("正文原样", $("cm-list").querySelector(".cm-text")?.textContent === "手机写的第一句");
    check("输入框已清空", $("cm-input").value === "");
    // 自己说的话不落款(authorLabel 对本机返回 null)——这一格与卡片署名同口径。
    check("本机写的不显作者", !$("cm-list").querySelector(".cm-author"));
    // 徽章由整轴重拉带出来(写命令 → deps.refresh → loadCommentCounts → renderCard)。
    const badge1 = await until(() => badgeOf(itemId), 5000);
    check("卡上徽章出现且计数为 1", !!badge1 && badge1.textContent.trim() === "💬 1", badge1?.textContent ?? "");

    // 关层(✕),再从徽章开一次:徽章是第二个入口。
    click($("cm-close"));
    check("✕ 收层", await until(() => !sheetOpen(), 2000));
    const panelBefore = !!document.querySelector("#timeline .panel");
    click(badgeOf(itemId));
    check("点徽章重开层", await until(() => sheetOpen(), 2000));
    check("列表仍是那一条", await until(() => $("cm-list").querySelectorAll(".cm-item").length === 1, 3000));
    // ---- ④ 点徽章不连带开合操作面板 ------------------------------------------
    check(
      "点徽章没顺手开合卡片操作面板",
      !!document.querySelector("#timeline .panel") === panelBefore,
      `before=${panelBefore}`,
    );

    // ---- ③ 两拍销毁(底部固定确认条) ----------------------------------------
    const cb = $("confirmbar");
    click($("cm-list").querySelector(".cm-del"));
    check("第一拍弹底部确认条", await until(() => !cb.hidden, 2000));
    check("话术明写不进回收站", $("confirmbar-q").textContent.includes("不进回收站"));
    check("第一拍没删", $("cm-list").querySelectorAll(".cm-item").length === 1);
    click($("confirmbar-no"));
    await until(() => cb.hidden, 1500);
    check("取消后留言还在", $("cm-list").querySelectorAll(".cm-item").length === 1);
    click($("cm-list").querySelector(".cm-del"));
    await until(() => !cb.hidden, 2000);
    click($("confirmbar-yes"));
    check("第二拍真销毁(行消失)", await until(() => $("cm-list").querySelectorAll(".cm-item").length === 0, 5000));
    check("删空后回空态", $("cm-list").textContent.includes("还没有留言"));
    check("徽章随之消失(N=0 不显)", await until(() => !badgeOf(itemId), 5000));

    // ---- ⑤ 返回键关层的 popstate 那一半 --------------------------------------
    // 层这时还开着:发一记 history.back()(硬件返回键最终走的就是这条 popstate 路)。
    check("销毁流程后层仍开着", sheetOpen());
    history.back();
    check("popstate 关掉留言层", await until(() => !sheetOpen(), 2000));
    // 账本要平:层关掉之后再按一次返回不该还有守门条目(否则用户会遇到「按一下没反应」)。
    check("关层后 body 无残留 cm-open", !document.body.classList.contains("cm-open"));

    // ---- ⑥ 宿主真没了即关层(经一次真刷新) ----------------------------------
    // 徽章已随 N=0 消失,只能走操作面板。两条纪律:
    //  - **卡片节点每次现查**(`cardOf`):`#timeline` 每刷一轮就整片重建,开头那个
    //    `card` 变量早已游离——点游离节点的按钮不冒泡到 `#timeline`,一声不响什么都不发生
    //    (本脚本首版就栽在这儿,现象是「entry2 找得到、点了没反应」);
    //  - 面板此刻**可能本来就开着**(cardPanel.restore 跨重画接回),再点一次正文是**收**
    //    面板 —— 先看按钮在不在,别盲点。
    let entry2 = cardOf(itemId)?.querySelector('.panel [data-pact="comment"]');
    if (!entry2) {
      click(cardOf(itemId).querySelector(".content"));
      entry2 = await until(() => cardOf(itemId)?.querySelector('.panel [data-pact="comment"]'), 3000);
    }
    if (entry2) click(entry2);
    check("再次开层", await until(() => sheetOpen(), 2000), `entry2=${!!entry2}`);
    await invoke("archive_note", { spaceId: space, id: itemId });
    await invoke("purge_note", { spaceId: space, id: itemId });
    itemId = null; // 已销毁,finally 不用再清
    // 走 app 自己的刷新路(与 sync-changed 落地同一条):条目不在这一发的时间轴里 → 收层。
    window.dispatchEvent(new Event("focus")); // 不一定有人听:下面用真刷新兜
    await invoke("list_timeline", { spaceId: space }); // 先让后端确实没有它了
    click(document.querySelector('#bottombar [data-mode="tasks"]'));
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
    $("text").value = `【CDP验收314-UI】触发刷新 ${Date.now()}`;
    click($("save")); // 「记下」必然带一次整轴重拉
    const closed = await until(() => !sheetOpen(), 6000);
    check("宿主没了之后层自动收起", !!closed);
    // 把刚才为触发刷新建的那条也清掉。
    const trig = [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
      c.querySelector(".content")?.textContent.includes("触发刷新"),
    );
    if (trig) {
      await invoke("archive_note", { spaceId: space, id: trig.dataset.id }).catch(() => {});
      await invoke("purge_note", { spaceId: space, id: trig.dataset.id }).catch(() => {});
    }
  } finally {
    if (itemId) {
      await invoke("archive_note", { spaceId: space, id: itemId }).catch(() => {});
      await invoke("purge_note", { spaceId: space, id: itemId }).catch(() => {});
    }
    if (sheetOpen()) click($("cm-close"));
    $("text").value = "";
  }

  return { pass: rows.every((r) => r.ok), rows };
})();
// ⚠ 页内证不到的那一半(必须在驱动侧发,146 铁律):
//   adb -s <serial> shell input keyevent 4   # 层开着时按硬件返回 → 层该关、app 不该退
//   adb -s <serial> shell input keyevent 4   # 层已关时再按 → 该退回桌面(账本已平)
//   判据:`dumpsys window | grep mCurrentFocus` 第一次仍是本 app、第二次不是。
