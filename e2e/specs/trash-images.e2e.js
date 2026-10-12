import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, trashImageAction } from "./support.js";

// 用户面 149:删掉的配图进**现有回收站**(按所属条目归组),在那里还原到原编号或彻底删除;
// 清空回收站连它们一起销毁。全案 docs/image-trash-plan.md(§7 界面)。
// 删图那一下走命令层直达(编辑态 × → 保存的 UI 路径由 edit-image-delete.e2e.js 守);这里守
// 回收站这一侧的三件事:看得见、还原回原号、销毁后编号不复用。
// 阴性对照(手工三步,见 progress-log 本轮条目):把 `removedImagesSection` 整个不挂 /
// 还原改发 purge / 清空不带图,各红在下面对应的那一句。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const addPng = (itemId) => invoke("add_item_image", { itemId, mime: "image/png", dataB64: PNG });
const seqs = async (itemId) => (await invoke("list_item_images", { itemId })).map((m) => m.seq);
const removedIds = async (scope) =>
  (await invoke("list_removed_images", { scope })).flatMap((g) => g.images.map((i) => i.id));

describe("回收站 · 已删配图(还原回原号 / 彻底删除 / 清空)", () => {
  after(async () => {
    await inboxShow("ideas");
  });

  it("灵感:删图 → 回收站按条目归组 → 还原回原编号 → 再删 → 彻底删除,编号不复用", async () => {
    const owner = "E2E-回收图-甲 见图2";
    const id = await invoke("capture_note", { content: owner });
    await addPng(id);
    const m2 = await addPng(id);
    await addPng(id);
    await invoke("delete_item_image", { imageId: m2.id });
    expect(await seqs(id)).toEqual([1, 3]);

    await goNotebook("inbox");
    await inboxShow("archived");
    const group = await $(`.trash-imgs-group*=${owner}`);
    await group.waitForExist({ timeout: 10000 });
    expect(await group.$(".trash-imgs-label").getText()).toContain("图2");
    await browser.waitUntil(async () => (await group.$(".img-thumb-img").getAttribute("src"))?.startsWith("data:"), {
      timeout: 8000,
      timeoutMsg: "回收站里的缩略图没载出来(按 id 取图那条路被收窄了?)",
    });

    await trashImageAction(owner, "还原");
    await group.waitForExist({ reverse: true, timeout: 10000 });
    expect(await seqs(id)).toEqual([1, 2, 3]);
    expect(await removedIds("ideas")).not.toContain(m2.id);

    await invoke("delete_item_image", { imageId: m2.id });
    await goNotebook("inbox");
    await inboxShow("archived");
    const again = await $(`.trash-imgs-group*=${owner}`);
    await again.waitForExist({ timeout: 10000 });
    await trashImageAction(owner, "彻底删除");
    await (await again.$(".trash-imgs-row .do")).click();
    await again.waitForExist({ reverse: true, timeout: 10000 });
    expect(await removedIds("ideas")).not.toContain(m2.id);
    expect((await addPng(id)).seq).toBe(4);
    expect(await seqs(id)).toEqual([1, 3, 4]);
  });

  it("任务:回收站里只有已删图也不显空态;清空连图一起销毁,确认句报张数", async () => {
    const title = "E2E-回收图-任务乙";
    const id = await invoke("create_task", { title });
    const m = await addPng(id);
    await invoke("delete_item_image", { imageId: m.id });
    // 任务回收站可能还躺着别的 spec 留下的条目:先清干净,让「只有已删图」这一形成立。
    await invoke("purge_archived_tasks", {});
    const m2 = await addPng(id);
    await invoke("delete_item_image", { imageId: m2.id });

    await goNotebook("board");
    await $("#trash-toggle").click();
    const group = await $(`.trash-imgs-group*=${title}`);
    await group.waitForExist({ timeout: 10000 });
    expect(await $(".center").isExisting()).toBe(false);

    // 别的 spec(edit-image-delete 的保存即删)也会在任务页留下已删图 ⇒ 张数现取,不写死。
    const n = (await removedIds("tasks")).length;
    expect(n).toBeGreaterThanOrEqual(1);
    await (await $("button*=清空回收站")).click();
    const q = await $(".confirm-q");
    await q.waitForExist({ timeout: 5000 });
    expect(await q.getText()).toContain(`${n} 张配图`);
    await (await $("button*=全部删除")).click();
    await group.waitForExist({ reverse: true, timeout: 10000 });
    expect(await removedIds("tasks")).toEqual([]);
    expect(await seqs(id)).toEqual([]);
    await $("#trash-toggle").click();
  });
});
