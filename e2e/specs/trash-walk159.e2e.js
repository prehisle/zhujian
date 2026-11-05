import { $, $$, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction, boardAction } from "./support.js";

// W3 走查修复(backlog 用户面 159)桌面第一波 · 回收站 / 搜索 / 看板那几条:
//   A6  侧栏主导航回主视图;回收站与时间轴各记各的滚动位(WD-04)
//   A7  彻底删除写明无法恢复与连带几张配图;还原 / 彻底删除 / 清空都给回执,还原说去了哪、带「去看看」(WD-06 / 11)
//   A9 + A19  清空回收站:原钮置灰、确认区另起、执行钮全宽且不落在原钮上;两个回收站一个样(WD-10 / 23)
//   A16 回收站 / 搜索结果里长条折八行、清单画成方框、长文不露「#」(WD-21 / 30)
//   A20 说明文字补上长文 / 看板回收站只说任务(WD-24 / 25)
//   A21 归档页头说清「累计」含看板「已完成」列里没归档的(WD-26)
//   Q12 看板回收站悬停卡按 R = 还原(视图键让位)(WD-36);空看板也画列 +「管理列」(WD-40)
// 回执是转瞬即逝的浮条 ⇒ 页内挂一台 MutationObserver 记下每一条(armRecorder),断言读记录,不赌时机。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const addPng = (itemId) => invoke("add_item_image", { itemId, mime: "image/png", dataB64: PNG });
const longText = (head, n = 20) => [head, ...Array.from({ length: n }, (_, i) => `第 ${i + 1} 行:凑一段足够长的正文`)].join("\n");

async function armRecorder() {
  await browser.execute(() => {
    window.__toasts = [];
    window.__toastObs?.disconnect();
    window.__toastObs = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes)
          if (n instanceof HTMLElement && (n.classList.contains("copy-toast") || n.classList.contains("undo-toast")))
            window.__toasts.push(n.textContent);
    });
    window.__toastObs.observe(document.body, { childList: true });
  });
}
async function waitToast(part) {
  await browser.waitUntil(async () => (await browser.execute(() => window.__toasts.slice())).some((x) => x.includes(part)), {
    timeout: 8000,
    timeoutMsg: `没等到含「${part}」的回执;记到的:${JSON.stringify(await browser.execute(() => window.__toasts))}`,
  });
}
const clickGoSee = () =>
  browser.execute(() => {
    const b = document.querySelector(".undo-toast .undo-go");
    if (!b) throw new Error("回执上没有「去看看」");
    b.click();
  });
/** 等到带 `.just-located`(跳转定位那圈常亮)且含这段字的那张卡出现。 */
async function waitLocated(sel, text) {
  await browser.waitUntil(
    async () => browser.execute((s, t) => [...document.querySelectorAll(`${s}.just-located`)].some((c) => c.textContent.includes(t)), sel, text),
    { timeout: 10000, timeoutMsg: `「去看看」没把「${text}」定位出来` },
  );
}
const nav = (view) => browser.execute((v) => document.querySelector(`button[data-view="${v}"]`).click(), view);
const listTop = () => browser.execute(() => document.querySelector(".v-inbox #list").scrollTop);

// 清空确认区的几何与结构(两个回收站同一个读法)。
const purgeProbe = () =>
  browser.execute(() => {
    const btn = document.querySelector("button.purge-open");
    const panel = document.querySelector(".purge-panel");
    const yes = panel.querySelector(".purge-yes");
    const b = btn.getBoundingClientRect();
    const y = yes.getBoundingClientRect();
    const cs = getComputedStyle(panel);
    const inner = panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    return {
      disabled: btn.disabled,
      panelShown: !panel.hidden && panel.offsetHeight > 0,
      overlap: !(y.right <= b.left || y.left >= b.right || y.bottom <= b.top || y.top >= b.bottom),
      underIsTrigger: document.elementFromPoint(cx, cy) === btn,
      yesFull: y.width >= inner - 1,
      q: panel.querySelector(".purge-q").textContent,
      shape: [...panel.querySelectorAll("*")].map((e) => e.className).join("|"),
    };
  });

describe("W3 159 · 回收站 / 搜索 / 看板(桌面第一波)", () => {
  after(async () => {
    await inboxShow("ideas");
  });

  it("A6:回收站里点侧栏「任务」再点「随记」= 回时间轴;回收站与时间轴各记各的滚动位", async () => {
    for (let i = 0; i < 40; i++) await invoke("capture_note", { content: `W159-A6 流水 ${i}\n第二行\n第三行` });
    for (let i = 0; i < 25; i++) {
      const id = await invoke("capture_note", { content: `W159-A6 废 ${i}\n第二行\n第三行` });
      await invoke("archive_note", { id });
    }
    await inboxShow("ideas");
    await $(".note*=W159-A6 流水 0").waitForExist({ timeout: 10000 });
    const s1 = await browser.execute(() => {
      const l = document.querySelector(".v-inbox #list");
      l.scrollTop = 1500;
      return l.scrollTop;
    });
    expect(s1).toBeGreaterThan(500);

    // 进回收站:从顶上看(此前沿用时间轴的 1500)
    await $("#inbox-trash-toggle").click();
    await $(".note*=W159-A6 废 0").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await listTop()) === 0, {
      timeout: 5000,
      timeoutMsg: `进回收站没从顶上看:scrollTop=${await listTop()}`,
    });
    await browser.execute(() => {
      document.querySelector(".v-inbox #list").scrollTop = 400;
    });

    // 侧栏「任务」→ 侧栏「随记」:回时间轴(此前落回回收站),且还原的是时间轴自己的位置
    await nav("board");
    await $(".v-board").waitForExist({ timeout: 10000 });
    await nav("inbox");
    await $(".note*=W159-A6 流水 0").waitForExist({ timeout: 10000 });
    expect(await $(".v-inbox header h1").getText()).toBe("随记");
    expect(await $(".note.archived").isExisting()).toBe(false);
    await browser.waitUntil(async () => Math.abs((await listTop()) - s1) <= 2, {
      timeout: 5000,
      timeoutMsg: `回时间轴没还原到它自己的位置:want≈${s1} got=${await listTop()}`,
    });

    // 「← 随记」那条路同理:回收站滚到 300 再回来,时间轴仍是 s1(此前共用 = 300)
    await $("#inbox-trash-toggle").click();
    await $(".note*=W159-A6 废 0").waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      document.querySelector(".v-inbox #list").scrollTop = 300;
    });
    await $("#inbox-trash-toggle").click();
    await $(".note:not(.archived)").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => Math.abs((await listTop()) - s1) <= 2, {
      timeout: 5000,
      timeoutMsg: `「← 随记」回来没还原时间轴的位置:want≈${s1} got=${await listTop()}`,
    });

    for (const n of await invoke("list_archived")) if (n.content.startsWith("W159-A6")) await invoke("purge_note", { id: n.id });
  });

  it("A7:随记回收站 —— 彻底删除写明无法恢复与配图张数、做完说一声;还原说去了哪,「去看看」落到那一条", async () => {
    const A = "W159-A7 还原的随记";
    const a = await invoke("capture_note", { content: A });
    await invoke("archive_note", { id: a });
    const B = "W159-A7 销毁的随记";
    const b = await invoke("capture_note", { content: B });
    await addPng(b);
    await addPng(b);
    await invoke("archive_note", { id: b });

    await inboxShow("archived");
    await armRecorder();
    const cardB = await $(`.note*=${B}`);
    await cardB.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await cardB.$$(".img-thumb")).length === 2, { timeout: 8000 });
    await inboxAction(B, "彻底删除");
    const q = await cardB.$(".confirm-q");
    await q.waitForExist({ timeout: 5000 });
    expect(await q.getText()).toBe("彻底删除这条和它的 2 张配图?无法恢复");
    await (await cardB.$(".confirm .do")).click();
    await cardB.waitForExist({ reverse: true, timeout: 10000 });
    await waitToast("已彻底删除");

    await inboxAction(A, "还原");
    await waitToast("已还原到随记");
    // textContent 而非 getText():浮条入场那几帧 opacity 还没到 1,getText 读不可见元素得空串(实测抖过一次)
    expect(await browser.execute(() => document.querySelector(".undo-toast .undo-go")?.textContent ?? "")).toBe("去看看");
    await clickGoSee();
    await waitLocated(".note", A);
    expect(await $(".v-inbox header h1").getText()).toBe("随记");
  });

  it("A7 + A16:回收站里的长文不露「#」、长条折八行;还原长文说「已还原到「长文」」,「去看看」去长文页", async () => {
    const d = await invoke("capture_doc", { content: "# W159-A16 删掉的长文\n\n第一段 **加粗** 的话\n- [ ] 待办甲" });
    await invoke("archive_note", { id: d });
    const L = "W159-A16 很长的一条";
    const l = await invoke("capture_note", { content: longText(L) });
    await invoke("archive_note", { id: l });
    // 没勾的方框落在褶子下面:时间轴上会豁免(框点不到),回收站里的框是只读的 ⇒ 照折(fold.ts hasBoxBelowFold)
    const K = "W159-A16 褶下有框";
    const k = await invoke("capture_note", { content: `${longText(K, 14)}\n- [ ] 褶子下面的框` });
    await invoke("archive_note", { id: k });

    await inboxShow("archived");
    await armRecorder();
    const doc = await $(".note*=W159-A16 删掉的长文");
    await doc.waitForExist({ timeout: 10000 });
    const docText = await doc.$(".note-text").getText();
    expect(docText.startsWith("W159-A16 删掉的长文")).toBe(true); // 没有「# 」
    expect(docText).not.toContain("**");
    expect(await doc.$$(".note-text .ckline")).toHaveLength(1); // 方框画出来,不露「- [ ]」

    const long = await $(`.note*=${L}`);
    const fold = await browser.execute((el) => {
      const p = el.querySelector(".note-text");
      return { clamped: p.classList.contains("clamped"), cut: p.scrollHeight > p.clientHeight, btn: !!el.querySelector(".fold-toggle") };
    }, long);
    expect(fold).toEqual({ clamped: true, cut: true, btn: true });
    const boxed = await browser.execute((el) => {
      const p = el.querySelector(".note-text");
      return { clamped: p.classList.contains("clamped"), cut: p.scrollHeight > p.clientHeight, btn: !!el.querySelector(".fold-toggle") };
    }, await $(`.note*=${K}`));
    expect(boxed).toEqual({ clamped: true, cut: true, btn: true });

    await inboxAction("W159-A16 删掉的长文", "还原");
    await waitToast("已还原到「长文」");
    await clickGoSee();
    await $(".v-docs").waitForExist({ timeout: 10000 });
    await invoke("archive_note", { id: d });
    await invoke("purge_note", { id: d });
    await invoke("purge_note", { id: l });
    await invoke("purge_note", { id: k });
  });

  it("A9 + A19 + A20:两个回收站的「清空」一个样 —— 原钮置灰、执行钮全宽不落在原钮上、双击第二下什么也不发生", async () => {
    const n1 = await invoke("capture_note", { content: "W159-A9 随记回收站里的一条" });
    await invoke("archive_note", { id: n1 });
    const t1 = await invoke("create_task", { title: "W159-A9 看板回收站里的一张" });
    await invoke("archive_task", { id: t1 });

    // —— 随记回收站
    await inboxShow("archived");
    await $(".note*=W159-A9 随记回收站里的一条").waitForExist({ timeout: 10000 });
    expect(await $(".v-inbox .trash-note").getText()).toContain("长文"); // A20
    const before = (await invoke("list_archived")).length;
    await $("button.purge-open").click();
    const pi = await purgeProbe();
    expect(pi.disabled).toBe(true);
    expect(pi.panelShown).toBe(true);
    expect(pi.overlap).toBe(false);
    expect(pi.underIsTrigger).toBe(true); // 双击的第二下落在置灰的原钮上
    expect(pi.yesFull).toBe(true);
    expect(pi.q).toMatch(/^彻底删除回收站里全部 \d+ 条(和 \d+ 张配图)?\?无法恢复。$/);
    await browser.execute(() => document.querySelector("button.purge-open").click()); // 第二下
    expect((await invoke("list_archived")).length).toBe(before);
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await browser.execute(() => document.querySelector("button.purge-open").disabled)), {
      timeout: 3000,
      timeoutMsg: "Esc 没收起清空确认",
    });
    expect(await $(".purge-panel").isDisplayed()).toBe(false);

    // —— 看板回收站
    await goNotebook("board");
    await $("#trash-toggle").click();
    await $(".trash-list").$(".tcard*=W159-A9 看板回收站里的一张").waitForExist({ timeout: 10000 });
    await $("button.purge-open").click();
    const pb = await purgeProbe();
    expect(pb.disabled).toBe(true);
    expect(pb.overlap).toBe(false);
    expect(pb.underIsTrigger).toBe(true);
    expect(pb.yesFull).toBe(true);
    expect(pb.q).toMatch(/^彻底删除回收站里全部 \d+ 条(和 \d+ 张配图)?\?无法恢复。$/);
    expect(pb.shape).toBe(pi.shape); // 两个回收站同一个结构、同一套类名、同一个钮序
    await armRecorder();
    await $("button.purge-yes").click();
    await waitToast("回收站已清空");
    await browser.waitUntil(async () => (await invoke("list_archived_tasks")).length === 0, { timeout: 8000 });
    // A20:看板回收站空态只说任务(与任务里删掉的图),不再写「删除的任务和配图」
    const empty = await $(".v-board .center");
    await empty.waitForExist({ timeout: 8000 });
    const emptyText = await empty.getText();
    expect(emptyText).toContain("删掉的任务会落到这里");
    expect(emptyText).not.toContain("删除的任务和配图");
    await invoke("purge_note", { id: n1 });
  });

  it("A7 + A16 + Q12:看板回收站 —— 长卡折叠、彻底删除写明配图张数、悬停按 R 还原(不收起回收站)、还原的回执「去看看」定位", async () => {
    const L = "W159-看板长卡";
    const lid = await invoke("create_task", { title: longText(L) });
    await invoke("archive_task", { id: lid });
    const P = "W159-看板带图销毁";
    const pid = await invoke("create_task", { title: P });
    await addPng(pid);
    await invoke("archive_task", { id: pid });
    const R = "W159-看板按R还原";
    const rid = await invoke("create_task", { title: R });
    await invoke("archive_task", { id: rid });
    const G = "W159-看板去看看";
    const gid = await invoke("create_task", { title: G });
    await invoke("archive_task", { id: gid });

    await goNotebook("board");
    await armRecorder();
    await $("#trash-toggle").click();
    const long = await $(".trash-list").$(`.tcard*=${L}`);
    await long.waitForExist({ timeout: 10000 });
    const fold = await browser.execute((el) => {
      const p = el.querySelector(".ttitle");
      return { clamped: p.classList.contains("clamped"), cut: p.scrollHeight > p.clientHeight, btn: !!el.querySelector(".fold-toggle") };
    }, long);
    expect(fold).toEqual({ clamped: true, cut: true, btn: true });

    const pc = await $(".trash-list").$(`.tcard*=${P}`);
    await browser.waitUntil(async () => (await pc.$$(".img-thumb")).length === 1, { timeout: 8000 });
    await boardAction(P, "彻底删除");
    const q = await pc.$(".confirm-q");
    await q.waitForExist({ timeout: 5000 });
    expect(await q.getText()).toBe("彻底删除这条和它的 1 张配图?无法恢复");
    await (await pc.$(".act.primary")).click();
    await waitToast("已彻底删除");
    await browser.waitUntil(async () => !(await invoke("list_archived_tasks")).some((x) => x.id === pid), { timeout: 8000 });

    // 悬停回收站的卡按 R:还原这张,人还在回收站
    await $(".trash-list").$(`.tcard*=${R}`).waitForExist({ timeout: 10000 });
    await browser.execute((title) => {
      const card = [...document.querySelectorAll(".trash-list .tcard")].find((c) => c.textContent.includes(title));
      card.dispatchEvent(new MouseEvent("mouseenter"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    }, R);
    await browser.waitUntil(async () => !(await invoke("list_archived_tasks")).some((x) => x.id === rid), {
      timeout: 8000,
      timeoutMsg: "悬停按 R 没有还原那张卡",
    });
    expect((await $("#trash-toggle").getAttribute("class")).split(/\s+/)).toContain("active");
    await waitToast("已还原到看板「待办」列");

    // 还原那张的「去看看」:回看板、定位到它
    await boardAction(G, "还原");
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__toasts.filter((x) => x.includes("已还原到看板")).length)) >= 2,
      { timeout: 8000 },
    );
    await clickGoSee();
    await waitLocated(".tcard", G);
    expect((await $("#trash-toggle").getAttribute("class")).split(/\s+/)).not.toContain("active");

    // 指针不在卡上:R 照旧是回收站开关
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true })));
    await browser.waitUntil(async () => (await $("#trash-toggle").getAttribute("class")).split(/\s+/).includes("active"), {
      timeout: 5000,
      timeoutMsg: "没悬停卡时 R 没打开回收站",
    });
    await invoke("archive_task", { id: rid });
    await invoke("archive_task", { id: gid });
    for (const id of [lid, rid, gid]) await invoke("purge_task", { id });
  });

  it("A21:归档页头的「累计」含看板「已完成」列里还没归档的,页上说一句", async () => {
    const sealedId = await invoke("create_task", { title: "W159-A21 归档了的" });
    await invoke("update_task_status", { id: sealedId, to: "done" });
    await invoke("seal_task", { id: sealedId });
    const doneId = await invoke("create_task", { title: "W159-A21 还在已完成列" });
    await invoke("update_task_status", { id: doneId, to: "done" });
    await goNotebook("board");
    await $("#seal-toggle").click();
    const bar = await $(".sealed-view .trash-bar .grow");
    await bar.waitForExist({ timeout: 10000 });
    const stats = await bar.getText();
    expect(stats).toMatch(/^本周完成 \d+ · 累计 \d+/);
    expect(stats).toMatch(/含看板「已完成」列里还没归档的 \d+ 张/);
    await $("#seal-toggle").click();
  });

  it("Q12(WD-40):一张卡都没有的看板也画出各列和「管理列」", async () => {
    const live = (await invoke("list_tasks")).map((x) => x.id);
    for (const id of live) await invoke("archive_task", { id });
    try {
      await goNotebook("board");
      await $(".col-empty").waitForExist({ timeout: 10000 });
      expect(await $$(".v-board .cols .col").length).toBeGreaterThanOrEqual(3);
      expect(await $(".col-empty").getText()).toContain("还没有任务");
      expect(await $("#manage-cols").isDisplayed()).toBe(true);
      expect(await $("#board-sort").isDisplayed()).toBe(false); // 没卡就没得排:顺序钮照旧藏
    } finally {
      for (const id of live) await invoke("restore_task", { id });
    }
  });

  it("A16 + A20:搜索结果 —— 清单画成方框、长条折八行(点「展开」不跳走)、长文不露「#」;空态说明提到长文", async () => {
    await goNotebook("search");
    expect(await $(".v-search .center").getText()).toContain("长文");
    const C = "W159搜清单";
    await invoke("capture_note", { content: [`${C} 第一行`, "- [ ] 甲项", "- [x] 乙项", ...Array.from({ length: 20 }, (_, i) => `凑行 ${i}`)].join("\n") });
    const D = "W159搜长文";
    const did = await invoke("capture_doc", { content: `# ${D} 的题目\n\n正文一段` });

    const search = async (q) => {
      await browser.execute((v) => {
        const i = document.querySelector("#q");
        i.value = v;
        i.dispatchEvent(new Event("input", { bubbles: true }));
      }, q);
      await $(".v-search .hit").waitForExist({ timeout: 10000 });
      await browser.waitUntil(async () => (await $(".v-search .count").isExisting()) && (await $(".v-search .hit-text").getText()).includes(q), {
        timeout: 8000,
      });
    };
    await search(C);
    const r = await browser.execute(() => {
      const p = document.querySelector(".v-search .hit .hit-text");
      return {
        boxes: p.querySelectorAll(".ckline").length,
        raw: p.textContent.includes("- [ ]") || p.textContent.includes("- [x]"),
        clamped: p.classList.contains("clamped"),
        cut: p.scrollHeight > p.clientHeight,
        marked: p.querySelector("mark")?.textContent ?? "",
      };
    });
    expect(r).toEqual({ boxes: 2, raw: false, clamped: true, cut: true, marked: C });
    await browser.execute(() => document.querySelector(".v-search .hit .fold-toggle").click());
    expect(await browser.execute(() => document.querySelector(".v-search .hit-text").classList.contains("clamped"))).toBe(false);
    expect(await $(".v-search").isExisting()).toBe(true); // 「展开」没把人带去跳转

    await search(D);
    expect((await $(".v-search .hit-text").getText()).startsWith(D)).toBe(true);
    // 回收站里的长文也不露「#」(归属由 core 的 trash_kind 给)
    await invoke("archive_note", { id: did });
    await search("W159搜长文 的题目");
    await $(".v-search .badge.archived").waitForExist({ timeout: 8000 });
    expect((await $(".v-search .hit-text").getText()).startsWith(D)).toBe(true);
    await invoke("purge_note", { id: did });
  });
});
