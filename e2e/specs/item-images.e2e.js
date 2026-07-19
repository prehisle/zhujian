import { $, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

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

    // 正文「图1」 became a clickable chip (the image exists, so it's linkified).
    const ref = await card.$(".img-ref");
    await ref.waitForExist({ timeout: 10000 });
    await expect(ref).toHaveText("图1");
  });
});
