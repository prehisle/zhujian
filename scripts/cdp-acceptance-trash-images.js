// @cdp-run single
// 用户面 149 手机回收站「已删配图」验收(docs/image-trash-plan.md §7 / §10 验收清单的安卓那格)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-trash-images.js
// 自播种、自清场:建一条带标记的灵感挂两张图、删图2 → 开回收站面看那一节 → 点行出面板 → 还原回原号 →
// 再删 → 彻底删除(底部确认条第二拍) → 新图拿图3(编号不复用) → 点图开查看器必须是只读(藏掉「删除」)。
// 收尾把这条灵感删进回收站再彻底删除,并核「用户库零残留」(回收站里无标记、已删配图里无这条)。
// ⚠ 前置:首启隐私告知已点掉;app 在前台;任何面开着都行(本资产先把回收站面收起再开,列表只在开面那刻拉)。
// ⚠ 只证 JS 半截:点击是合成 click,`elementFromPoint` 那一格另判(本资产判了「行」中心点命中行自己)。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const I = window.__TAURI__.core.invoke;
  const space = (await I("list_spaces")).find((s) => s.current)?.id;
  if (!space) return { error: "取不到当前空间" };
  const inv = (c, a) => I(c, { spaceId: space, ...(a || {}) });
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const res = {};
  const fail = [];
  const check = (k, v, detail) => {
    res[k] = detail === undefined ? !!v : { ok: !!v, detail };
    if (!v) fail.push(k);
  };
  const waitFor = async (fn, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  };
  const pane = document.getElementById("trash-pane");
  const navBtn = document.querySelector('#bottombar [data-pane="trash"]');
  const reopen = async () => {
    if (!pane.hidden) navBtn.click();
    await sleep(300);
    navBtn.click();
    await waitFor(() => !pane.hidden);
  };
  const row = (imgId) => document.querySelector(`[data-trash-img="${imgId}"]`);
  const seqs = async (itemId) => (await inv("list_item_images", { itemId })).map((m) => m.seq);
  const marker = `ZJ149-CDP-${Date.now()}`;
  const id = await inv("capture_idea", { content: `${marker} 见图2` });
  try {
    await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    const m2 = await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    await inv("delete_item_image", { imageId: m2.id });
    check("删后图条只剩图1", JSON.stringify(await seqs(id)) === "[1]");
    const counts = await inv("pane_counts");
    check("pane_counts.trash 带上已删图", counts.trash >= 1, counts.trash);

    await reopen();
    const r = await waitFor(() => row(m2.id));
    check("回收站里出现那一行", !!r);
    if (!r) return { pass: false, fail, res };
    const group = r.closest(".trash-img-group");
    check("组头是宿主正文首行", group?.querySelector(".trash-img-owner")?.textContent.includes(marker));
    check("行文案带图2", r.querySelector(".trash-img-label")?.textContent.includes("2"));
    const thumbFilled = await waitFor(() => r.querySelector(".thumb img")?.getAttribute("src"));
    check("缩略图按 id 取得到", !!thumbFilled);
    r.scrollIntoView({ block: "center" });
    await sleep(400);
    const lb = r.querySelector(".trash-img-label").getBoundingClientRect();
    const hit = document.elementFromPoint(lb.left + lb.width / 2, lb.top + lb.height / 2);
    check("行中心点命中行自己", r.contains(hit));

    // 点图 = 只读查看器(那枚「删除」藏掉:它已经在回收站里了)。
    r.querySelector(".thumb").click();
    const viewer = document.getElementById("viewer");
    const opened = await waitFor(() => !viewer.hidden);
    check("点图开查看器", !!opened);
    check("查看器是只读", viewer.classList.contains("readonly"));
    // 未放大时单击即关(viewer.ts 头注)。⛔ 别用 history.back():从回收站开的查看器不压历史层,
    // 退一步退的是回收站面本身。
    viewer.click();
    await waitFor(() => viewer.hidden, 3000);
    check("查看器收起", viewer.hidden);

    // 点行出面板 → 还原。
    row(m2.id).querySelector(".trash-img-label").click();
    const restoreBtn = await waitFor(() => row(m2.id)?.querySelector('[data-trash-img-act="restore"]'));
    check("点行出面板(还原钮)", !!restoreBtn);
    restoreBtn?.click();
    await waitFor(() => !row(m2.id));
    check("还原后行离场", !row(m2.id));
    check("还原回原编号", JSON.stringify(await seqs(id)) === "[1,2]");

    // 再删 → 彻底删除(底部确认条第二拍同一拍内连点)。
    await inv("delete_item_image", { imageId: m2.id });
    await reopen();
    const r2 = await waitFor(() => row(m2.id));
    r2?.querySelector(".trash-img-label").click();
    const purgeBtn = await waitFor(() => row(m2.id)?.querySelector('[data-trash-img-act="purge"]'));
    purgeBtn?.click();
    const bar = document.getElementById("confirmbar");
    const asked = await waitFor(() => !bar.hidden);
    check("彻底删除问第二拍", !!asked, document.getElementById("confirmbar-q").textContent);
    document.getElementById("confirmbar-yes").click();
    await waitFor(() => !row(m2.id));
    const removed = await inv("list_removed_images", { scope: "all" });
    check("彻底删除后不在已删配图里", !removed.some((g) => g.images.some((im) => im.id === m2.id)));
    const m3 = await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    check("编号不复用(新图 = 图3)", m3.seq === 3, m3.seq);
  } finally {
    try {
      await inv("archive_note", { id });
      await inv("purge_note", { id });
    } catch (e) {
      res.cleanupError = String(e);
    }
    if (!pane.hidden) navBtn.click();
  }
  const trash = await inv("list_trash");
  const removedAfter = await inv("list_removed_images", { scope: "all" });
  check(
    "用户库零残留",
    !trash.some((t) => t.content.includes(marker)) && !removedAfter.some((g) => g.item_id === id),
  );
  return { pass: fail.length === 0, fail, res };
})();
