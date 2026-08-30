import { $, browser, expect } from "@wdio/globals";
import { invoke, tryInvoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// 条目留言(identity-plan §4,0035)。两层,与 item-images.e2e.js 同款分工:
//  1) 命令层走真 IPC —— 写/读/删/计数、**keyset 分页两页**、后端四道拒(空正文 / 宿主
//     不存在 / 非规范宿主 id / 200 KiB)原样传上来;
//  2) UI 层 —— ⋯ 菜单「留言」开浮层(N=0 时它是唯一入口)、写一条 → 徽章 `💬 1` 出现 →
//     点徽章重开 → 两拍销毁 → 徽章消失;宿主离开视图时浮层自己关掉。
//
// **e2e 造不出 `born_device = NULL` 的留言**(唯一来源是跨空间搬迁,而 e2e 恒单空间),
// 故「作者未知」那一格只有 core 的行为测覆盖,这里如实不测。
// **e2e 同样造不出 `unread = true`**(0038):未读 = 留言 id 高过本机已读水位,而单机
// e2e 的每条留言都出自 add_item_comment —— 它同事务自推水位(自己写的必然自己读过),
// 推上去就 MAX 单调退不回来。⇒ 「远端留言点亮红点 → 开层即消」那条全链只有 core 的
// 行为测覆盖(unread_lifecycle_lights_marks_and_never_regresses);这里验得到的三半是
// ①聚合的返回形(n/unread)与「本机写的恒不亮」、②mark 命令的幂等与拒、③`.unread`
// 那枚朱砂点的 CSS 真渲染(手动挂 class 量 ::after)。「unread:true 时 class 真挂上」
// 那一行分支两端 e2e 都够不着,由真机双设备顺手看一眼(backlog 记诚实边界)。

describe("留言 · 命令层(分页 + 计数 + 四道拒)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("写 → 读 → 删:最近优先,删掉的不再出现,计数跟着走", async () => {
    const id = await invoke("capture_note", { content: "E2E-留言-命令" });
    const c1 = await invoke("add_item_comment", { itemId: id, content: "第一句" });
    const c2 = await invoke("add_item_comment", { itemId: id, content: "第二句" });
    expect(typeof c1).toBe("string");

    const page = await invoke("list_item_comments", { itemId: id, cursor: null });
    // 最近优先(created_at DESC, id DESC);两条都在一页里,没有下一页。
    expect(page.rows.map((r) => r.content)).toEqual(["第二句", "第一句"]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).not.toBe(null);
    // 署名:本机写的,born_device 必是本机 device_id(fail-closed,绝不为 null)。
    const me = await invoke("device_identity");
    expect(page.rows[0].born_device).toBe(me.this_device);

    // 0038 起聚合是 {n, unread}:本机写的**恒不亮**(add 同事务自推水位)。
    const counts = await invoke("item_comment_counts");
    expect(counts[id]).toEqual({ n: 2, unread: false });

    await invoke("delete_item_comment", { id: c2 });
    const after = await invoke("list_item_comments", { itemId: id, cursor: null });
    expect(after.rows.map((r) => r.content)).toEqual(["第一句"]);
    // 幂等:同一条再删一次不报错(另一端删了并同步过来是正常并发,不是错误)。
    await invoke("delete_item_comment", { id: c2 });
    const counts2 = await invoke("item_comment_counts");
    expect(counts2[id]).toEqual({ n: 1, unread: false });
  });

  it("已读水位(0038):mark 幂等、非规范 seen_id 拒、纯本地不改计数", async () => {
    const id = await invoke("capture_note", { content: "E2E-留言-水位" });
    const cid = await invoke("add_item_comment", { itemId: id, content: "看过了" });
    // 幂等:同一个水位推两次都成功(MAX 单调,重复是 no-op)。
    await invoke("mark_item_comments_seen", { itemId: id, seenId: cid });
    await invoke("mark_item_comments_seen", { itemId: id, seenId: cid });
    // 条目不在 = 幂等 no-op(并发里对端刚删了宿主,不是错误)。
    await invoke("mark_item_comments_seen", { itemId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", seenId: cid });
    // 非规范 seen_id 响亮拒(值域 = 留言 id 的形)。
    const bad = await tryInvoke("mark_item_comments_seen", { itemId: id, seenId: "not-a-ulid" });
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain("不是规范留言 id");
    const counts = await invoke("item_comment_counts");
    expect(counts[id]).toEqual({ n: 1, unread: false });
  });

  it("分页:51 条 → 第一页 50 条带 has_more,拿 cursor 取回剩下那条且不重不漏", async () => {
    const id = await invoke("capture_note", { content: "E2E-留言-分页" });
    for (let i = 0; i < 51; i++) {
      await invoke("add_item_comment", { itemId: id, content: `第${i}条` });
    }
    const p1 = await invoke("list_item_comments", { itemId: id, cursor: null });
    expect(p1.rows.length).toBe(50);
    expect(p1.has_more).toBe(true);
    // cursor 原样回传(Rust 元组 → JSON 数组),前端不解释它的内部结构。
    expect(Array.isArray(p1.next_cursor)).toBe(true);
    const p2 = await invoke("list_item_comments", { itemId: id, cursor: p1.next_cursor });
    expect(p2.rows.length).toBe(1);
    expect(p2.has_more).toBe(false);
    // 不重不漏:两页并起来恰是 51 条互不相同的 id。
    const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    expect(ids.size).toBe(51);
  });

  it("四道拒原样传上来:空正文 / 宿主不存在 / 宿主 id 非规范 / 正文超 200 KiB", async () => {
    const id = await invoke("capture_note", { content: "E2E-留言-拒" });
    const empty = await tryInvoke("add_item_comment", { itemId: id, content: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.err).toContain("不能为空");

    const gone = await tryInvoke("add_item_comment", {
      itemId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      content: "给不存在的条目",
    });
    expect(gone.ok).toBe(false);
    expect(gone.err).toContain("条目不存在");

    // 非规范 id 当场拒(codex 实现审一轮 M1:本地能写、别端必拒 = 自己被持久隔离)。
    const bad = await tryInvoke("add_item_comment", { itemId: "not-a-ulid", content: "脏 id" });
    expect(bad.ok).toBe(false);

    const huge = await tryInvoke("add_item_comment", { itemId: id, content: "字".repeat(200_001) });
    expect(huge.ok).toBe(false);
  });
});

describe("留言 · UI(徽章 → 浮层 → 两拍销毁)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("⋯ 菜单开浮层 → 写一条 → 徽章 💬 1 → 点徽章重开 → 两拍销毁 → 徽章消失", async () => {
    await invoke("capture_note", { content: "E2E-留言-UI" });
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
    await $(".note").waitForExist({ timeout: 5000 });

    // N=0:卡片上没有徽章,入口只在 ⋯ 菜单里。
    expect(await $(".cm-badge").isExisting()).toBe(false);
    await inboxAction("E2E-留言-UI", "留言");
    await $(".cm-panel").waitForExist({ timeout: 5000 });
    expect(await $(".cm-empty").getText()).toContain("还没有留言");

    await $(".cm-input").setValue("UI 写下的第一句");
    await $(".cm-send").click();
    await $(".cm-item").waitForExist({ timeout: 5000 });
    expect(await $(".cm-text").getText()).toBe("UI 写下的第一句");

    // 关掉浮层 → 卡片徽章跟着出现(onChanged → 视图重取计数)。
    await browser.keys("Escape");
    await $(".cm-badge").waitForExist({ timeout: 5000 });
    expect(await $(".cm-badge").getText()).toContain("1");
    // 本机写的不亮红点(0038:add 自推水位 ⇒ unread=false ⇒ 不挂 .unread)。
    expect(await browser.execute(() => document.querySelector(".cm-badge").classList.contains("unread"))).toBe(false);
    // 朱砂点的 CSS 真渲染(文件头注释:数据侧的 true 单机造不出,视觉那半在这儿量):
    // 手动挂 class → ::after 真的画出一枚 6px 的点;摘掉即消。
    const dot = await browser.execute(() => {
      const b = document.querySelector(".cm-badge");
      b.classList.add("unread");
      const on = getComputedStyle(b, "::after");
      const painted = { w: on.width, bg: on.backgroundColor };
      b.classList.remove("unread");
      const off = getComputedStyle(b, "::after").width;
      return { painted, off };
    });
    expect(dot.painted.w).toBe("6px");
    expect(dot.painted.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(dot.off).not.toBe("6px");

    // 点徽章重开(第二个入口),两拍销毁:第一拍出确认,第二拍才真删。
    await $(".cm-badge").click();
    await $(".cm-panel").waitForExist({ timeout: 5000 });
    await $(".cm-del").click();
    await $(".cm-confirm").waitForExist({ timeout: 5000 });
    expect(await $(".cm-confirm").getText()).toContain("不进回收站");
    await $(".cm-del.danger").click();
    await $(".cm-empty").waitForExist({ timeout: 5000 });

    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await $(".cm-badge").isExisting()), {
      timeout: 5000,
      timeoutMsg: "留言删光后徽章该消失(N=0 不显示)",
    });
  });

  it("同步落地后:浮层开着时宿主离开视图 → 浮层自己关掉", async () => {
    const id = await invoke("capture_note", { content: "E2E-留言-宿主" });
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
    await $(".note").waitForExist({ timeout: 5000 });

    await inboxAction("E2E-留言-宿主", "留言");
    await $(".cm-panel").waitForExist({ timeout: 5000 });
    await $(".cm-input").setValue("宿主要走了");
    await $(".cm-send").click();
    await $(".cm-item").waitForExist({ timeout: 5000 });

    // 宿主彻底消失(走后端,不碰 UI)——模拟「另一台设备删掉了它,tombstone 同步落地」。
    // ⚠ 只软删进回收站**不算**消失:那条目还在这个空间里(回收站 tab 就能看见),留言
    // 也照 §4.4 原样保留,把浮层关掉反而是丢状态。
    await invoke("archive_note", { id });
    await invoke("purge_note", { id });
    // 真发一枚 sync-changed:sync.ts 去抖 300ms 后走视图 refresh,与远端 op 落地同一条路。
    await browser.execute(() => window.__TAURI__.event.emit("sync-changed", { space: "main" }));
    await browser.waitUntil(async () => !(await $(".cm-panel").isExisting()), {
      timeout: 8000,
      timeoutMsg: "宿主离开视图后留言浮层该关闭",
    });
  });
});
