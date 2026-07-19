import { $, $$, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// 73: 删除=进回收站——the inbox hard-delete UI path (two-step confirm) is gone. 删除 is
// a soft delete (recoverable, so NO confirm) for every idea; destruction only happens
// inside the 回收站 (彻底删除, covered by inbox-trash.e2e.js).

describe("收件箱 · 手工删除", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("播种 → 渲染 → 删除零确认软删进回收站 → 还原回想法列表", async () => {
    // 1) Seed three notes via real capture_note IPC.
    await invoke("capture_note", { content: "E2E-保留-A" });
    await invoke("capture_note", { content: "E2E-删除-B" });
    await invoke("capture_note", { content: "E2E-保留-C" });
    expect(await invoke("list_inbox")).toHaveLength(3);

    // 2) Render the real Inbox page in the live WebView.
    await goNotebook("inbox");
    await $(".note").waitForExist({ timeout: 10000 });
    await expect($$(".note")).toBeElementsArrayOfSize(3);

    // 3) 删除 on the 'E2E-删除-B' card: no inline confirm appears — the card leaves at
    //    once (soft, recoverable — same feel as a tagged idea's 删除).
    const card = await $(".note*=E2E-删除-B");
    await expect(card).toExist();
    await inboxAction("E2E-删除-B", "删除");
    await card.waitForExist({ reverse: true, timeout: 10000 });
    await expect($$(".note")).toBeElementsArrayOfSize(2);

    // 4) It left the live inbox but SURVIVES in the 回收站 (not hard-deleted).
    const inbox = await invoke("list_inbox");
    expect(inbox).toHaveLength(2);
    const contents = inbox.map((n) => n.content);
    expect(contents).not.toContain("E2E-删除-B");
    expect(contents).toContain("E2E-保留-A");
    expect(contents).toContain("E2E-保留-C");
    const trashed = (await invoke("list_archived")).find((n) => n.content === "E2E-删除-B");
    expect(trashed).toBeDefined();

    // 5) 还原: back to the live inbox (frozen stage was kept as 未归类).
    await invoke("restore_note", { id: trashed.id });
    expect((await invoke("list_inbox")).map((n) => n.content)).toContain("E2E-删除-B");
    expect((await invoke("list_archived")).some((n) => n.id === trashed.id)).toBe(false);
  });

  it("删空后显示空状态", async () => {
    await clearInbox(); // remove all three survivors
    await goNotebook("inbox");

    await $(".center .big").waitForExist({ timeout: 10000 });
    expect(await $(".center .big").getText()).toContain("还没有灵感");
    await expect($$(".note")).toBeElementsArrayOfSize(0);
  });
});
