import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction, boardAction } from "./support.js";

// 用户面 148:**编辑态里点图上的 × 只做标记,保存才真删;Esc 取消 = 图一张不少。**
// 病:此前一点 × 就当场 `delete_item_image` 硬删,不随取消回滚 —— 而删图不进回收站、不进编辑
// 历史,手滑就找不回(用户报「编辑随记、删除随记中的图片,图片就丢失了」)。
// 阴性对照:把 imageStrip 里 × 的点击换回当场 invoke("delete_item_image"),
// 「Esc 取消」那两例红在「取消后图还在」(只剩 1 张)。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const addPng = (itemId) => invoke("add_item_image", { itemId, mime: "image/png", dataB64: PNG });
const seqs = async (itemId) => (await invoke("list_item_images", { itemId })).map((m) => m.seq);

/** 编辑态图条里第 n 张(1 起)那枚 ×;先等图条画齐 `want` 张。 */
async function delBtn(scope, n, want) {
  await browser.waitUntil(async () => (await scope.$$(".img-editor .img-thumb")).length === want, {
    timeout: 8000,
    timeoutMsg: `编辑态图条没画齐 ${want} 张`,
  });
  return (await scope.$$(".img-editor .img-thumb"))[n - 1].$(".img-del");
}

const enterOn = (elem) =>
  browser.execute((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), elem);

describe("编辑态删图 · 随记(保存才删,取消一张不少)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("点 × → 图变淡、库里还在;Esc 取消 → 图一张不少", async () => {
    const id = await invoke("capture_note", { content: "E2E-删图-取消" });
    await addPng(id);
    await addPng(id);
    await goNotebook("inbox");
    const card = await $(".note*=E2E-删图-取消");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-删图-取消", "编辑");
    await card.$(".edit-area").waitForExist({ timeout: 5000 });

    const del = await delBtn(card, 2, 2);
    await del.click();
    expect(await del.getText()).toBe("↺");
    expect(await card.$$(".img-editor .img-thumb.del-marked")).toHaveLength(1);
    expect(await seqs(id)).toEqual([1, 2]); // 标记不碰库

    await browser.keys(["Escape"]);
    await card.$(".edit-area").waitForExist({ timeout: 5000, reverse: true });
    expect(await seqs(id)).toEqual([1, 2]);
  });

  it("点 × 再点 ↺ 撤销 → Enter → 一张没删", async () => {
    const id = await invoke("capture_note", { content: "E2E-删图-撤销" });
    await addPng(id);
    await addPng(id);
    await goNotebook("inbox");
    const card = await $(".note*=E2E-删图-撤销");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-删图-撤销", "编辑");
    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });

    const del = await delBtn(card, 1, 2);
    await del.click();
    await del.click();
    expect(await card.$$(".img-editor .img-thumb.del-marked")).toHaveLength(0);
    await enterOn(area);
    await area.waitForExist({ timeout: 5000, reverse: true });
    expect(await seqs(id)).toEqual([1, 2]);
  });

  it("点 × → Enter 保存 → 那张删了、编号留洞;正文没改也照删", async () => {
    const id = await invoke("capture_note", { content: "E2E-删图-保存" });
    await addPng(id);
    await addPng(id);
    await addPng(id);
    await goNotebook("inbox");
    const card = await $(".note*=E2E-删图-保存");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-删图-保存", "编辑");
    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });

    await (await delBtn(card, 2, 3)).click();
    await enterOn(area);
    await browser.waitUntil(async () => (await seqs(id)).join(",") === "1,3", {
      timeout: 8000,
      timeoutMsg: `保存后应只剩图1、图3,实得 ${(await seqs(id)).join(",")}`,
    });
    await area.waitForExist({ timeout: 5000, reverse: true });
    expect(await invoke("list_note_history", { id })).toHaveLength(0); // 正文没改 ⇒ 不该多一条历史版本
  });
});

describe("编辑态删图 · 看板任务", () => {
  it("点 × → Esc 不删;再进编辑点 × → Enter 删掉", async () => {
    const title = "E2E-看板删图";
    const id = await invoke("create_task", { title });
    await addPng(id);
    await addPng(id);
    await goNotebook("board");
    await $(`.tcard*=${title}`).waitForExist({ timeout: 10000 });

    // 编辑态是全局单例 ⇒ 页上恰一个 `.edit-form`,就拿它当作用域(编辑中标题在输入框的 value 里,
    // 按卡片文字找不到这张卡)。
    await boardAction(title, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    await (await delBtn(await $(".edit-form"), 1, 2)).click();
    expect(await seqs(id)).toEqual([1, 2]);
    await browser.keys(["Escape"]);
    await $(".tcard .edit-input").waitForExist({ timeout: 5000, reverse: true });
    expect(await seqs(id)).toEqual([1, 2]);

    await boardAction(title, "编辑");
    const input = await $(".tcard .edit-input");
    await input.waitForDisplayed({ timeout: 5000 });
    await (await delBtn(await $(".edit-form"), 1, 2)).click();
    await enterOn(input);
    await browser.waitUntil(async () => (await seqs(id)).join(",") === "2", {
      timeout: 8000,
      timeoutMsg: `保存后应只剩图2,实得 ${(await seqs(id)).join(",")}`,
    });

    await invoke("archive_task", { id });
    await invoke("purge_task", { id });
  });
});
