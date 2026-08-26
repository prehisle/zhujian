import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, tryInvoke, boardAction } from "./support.js";

// ㊴ 配图(item images). Two layers:
//  1) command layer through the real IPC bridge — add/list/get/delete, asserting the 「图N」
//     编号 climbs monotonically and is NEVER reused after a delete (high-water counter), and
//     get_item_image returns a ready data: URL.
//  2) UI — a 灵感 card renders its thumbnail strip (「图N」 badge) and linkifies a 正文「图N」
//     into a clickable chip.
// Paste / file-pick are UI glue over the same add_item_image command (verified at the command
// layer here); driving a real clipboard/file-upload through tauri-driver is flaky, so those
// entry points stay manually verified.

// A valid 1×1 PNG, base64 (no data: prefix) — content isn't validated, only that it's a
// non-empty image/png blob.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const addPng = (itemId) => invoke("add_item_image", { itemId, mime: "image/png", dataB64: PNG });

describe("配图 · 命令层(编号永不复用 + data URL)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("加图编号单调 → 取 data URL → 删尾图后编号不复用、列表留洞", async () => {
    const id = await invoke("capture_note", { content: "E2E-配图-命令" });

    const m1 = await addPng(id);
    const m2 = await addPng(id);
    const m3 = await addPng(id);
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);

    // list: 编号 ascending.
    let list = await invoke("list_item_images", { itemId: id });
    expect(list.map((x) => x.seq)).toEqual([1, 2, 3]);

    // get: a ready-to-render data: URL.
    const url = await invoke("get_item_image", { imageId: m1.id });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);

    // delete the TOP image, then add again → 编号 must be 4, never the freed 3.
    await invoke("delete_item_image", { imageId: m3.id });
    const m4 = await addPng(id);
    expect(m4.seq).toBe(4);

    // remaining list shows the hole (图1、图2、图4), never renumbered.
    list = await invoke("list_item_images", { itemId: id });
    expect(list.map((x) => x.seq)).toEqual([1, 2, 4]);
  });

  // 缩略图派生表(0032 / image-perf-plan §3):未命中回退全尺寸 → 回存 → 命中只吐几 KB。
  // 走真 IPC 桥。规格 token 不出 core(前端不碰),故这里只验命中/未命中与两道入口闸。
  it("缩略图:未命中回退全尺寸 → 回存 → 命中吐 jpeg;形态/长度不对一律响亮拒", async () => {
    const id = await invoke("capture_note", { content: "E2E-缩略图" });
    const m = await addPng(id);

    // 未命中:thumb=false,url 就是今天的全尺寸(首次不比现在慢)。
    const miss = await invoke("get_item_thumb", { imageId: m.id });
    expect(miss.thumb).toBe(false);
    expect(miss.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(miss.spec).toBe(undefined); // 规格 token 不出 core,前端拿不到也不需要

    // 回存(put 只验魔数不解码,故这里用最短的合法 JPEG 前缀 FF D8 FF E0 00 10)。
    const JPEG = "/9j/4AAQ";
    await invoke("put_item_thumb", { imageId: m.id, dataB64: JPEG });

    // 命中:thumb=true,MIME 换成 jpeg,字节就是刚存进去那几个。
    const hit = await invoke("get_item_thumb", { imageId: m.id });
    expect(hit.thumb).toBe(true);
    expect(hit.url).toBe(`data:image/jpeg;base64,${JPEG}`);

    // 两道闸走真桥也要咬人:字节不是 JPEG / base64 超长(解码前就该拒),都响亮拒。
    // ⚠ 走 `tryInvoke`(把失败当**值**收)而不是 `rejects.toThrow`:396 分诊 —— 让页内脚本
    // 以 rejected promise 收场,WebKitWebDriver 序列化不了那个结果,回的是
    // `Could not parse script result`,断言拿不到真正的错误串(Windows 的 msedgedriver 收得了
    // ⇒ 同一句在两端结论不同,是驱动差异不是产品缺陷)。`tryInvoke` 本就是为这种断言备的。
    const badMagic = await tryInvoke("put_item_thumb", { imageId: m.id, dataB64: PNG });
    expect(badMagic.ok).toBe(false);
    expect(badMagic.err).toMatch(/不是 JPEG/);
    const tooLong = await tryInvoke("put_item_thumb", {
      imageId: m.id,
      dataB64: "/9j/4AAQ".padEnd(200000, "A"),
    });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.err).toMatch(/过长/);
    // 拒了就是拒了:原来那行分毫未动。
    const still = await invoke("get_item_thumb", { imageId: m.id });
    expect(still.url).toBe(`data:image/jpeg;base64,${JPEG}`);
  });
});

describe("配图 · 灵感卡(缩略图 + 正文「图N」可点链接)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("挂一张图 → 卡片显「图1」缩略图 + 正文「图1」渲成 .img-ref chip", async () => {
    // The content already references 图1, so once the image (seq 1) exists it linkifies.
    const id = await invoke("capture_note", { content: "E2E-配图-灵感 见 图1" });
    await addPng(id);

    // Re-render the view so the card loads its images.
    await goNotebook("inbox");
    const card = await $(".note*=E2E-配图-灵感");
    await card.waitForExist({ timeout: 10000 });

    // Thumbnail strip carries a 「图1」 badge.
    const badge = await card.$(".img-badge");
    await badge.waitForExist({ timeout: 10000 });
    await expect(badge).toHaveText("图1");

    // 小图真的渲出来了(0032 起这条走的是 get_item_thumb;只断 badge 会让取图整条断掉
    // 也照样绿——badge 是纯文字,不碰字节)。
    const thumb = await card.$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () => ((await thumb.getAttribute("src")) || "").startsWith("data:image/"),
      { timeout: 10000, timeoutMsg: "缩略图 src 一直没落上 data: URL" },
    );

    // 正文「图1」 became a clickable chip (the image exists, so it's linkified).
    const ref = await card.$(".img-ref");
    await ref.waitForExist({ timeout: 10000 });
    await expect(ref).toHaveText("图1");
  });
});

// 504:有图卡片重画不再「先空后有」。用户报「PC 端把有图的任务卡移到其他状态时会闪烁」。
// 根因:图条初始 `.empty`(display:none),每次重画都要等 `list_item_images` 那发 IPC 回来
// 才显形 ⇒ 一屏有图的卡集体矮 80px 再长回来。修法=元数据层也做乐观呈现(item-images.ts
// 的 metaCache),重画时同步先画、IPC 回来只对账。
//
// 观测面:MutationObserver 在**微任务检查点**跑,而 IPC 至少要一个宏任务周期 ⇒ 「图条插进
// DOM 那一刻带不带 .empty」能干净地把两种时序分开。⛔ 别改成「等一会儿再看图在不在」——
// 那样改回旧实现也照样绿(IPC 早回来了),这条测就成了空测。
describe("配图 · 重画不闪(504)", () => {
  const TITLE = "E2E-504-有图卡";

  const armObserver = () =>
    browser.execute(() => {
      window.__504 = [];
      const obs = new MutationObserver((recs) => {
        for (const r of recs)
          for (const n of r.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            const strips = n.matches?.(".img-strip") ? [n] : [...(n.querySelectorAll?.(".img-strip") ?? [])];
            for (const s of strips) window.__504.push({ empty: s.classList.contains("empty"), thumbs: s.children.length });
          }
      });
      obs.observe(document.querySelector("#view"), { childList: true, subtree: true });
      window.__504stop = () => obs.disconnect();
    });
  const readObserver = () =>
    browser.execute(() => {
      window.__504stop?.();
      return window.__504;
    });

  before(async () => {
    await goNotebook("board");
    for (const t of await invoke("list_tasks")) await invoke("archive_task", { id: t.id });
    await invoke("purge_archived_tasks", {});
    const id = await invoke("create_task", { title: TITLE });
    await addPng(id);
    await addPng(id);
  });

  it("阴性对照:首次渲染(缓存空)——图条确实是先空后有", async () => {
    // 整页重来 = 模块态连同 metaCache 一起清掉,这正是改动前每次重画的时序。
    // ⭐ 没有这一格,下一格证明不了判据有区分力(恒绿的断言看起来和真绿一模一样)。
    await goNotebook("board");
    await armObserver();
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
    await $(".v-inbox").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
    await $(".v-board").waitForExist({ timeout: 5000 });
    await browser.pause(600);
    const seen = await readObserver();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.empty)).toBe(true);
  });

  it("移到另一列:图条插进 DOM 那一刻就已经带着两张图", async () => {
    await browser.pause(400); // 让首屏那发 IPC 落定(metaCache 填上)
    await armObserver();
    await boardAction(TITLE, "移到「进行中」");
    await browser.pause(600);
    const seen = await readObserver();
    expect(seen.length).toBeGreaterThan(0); // 真的重画了(否则这条什么也没测)
    expect(seen.every((s) => !s.empty && s.thumbs === 2)).toBe(true);
  });
});
