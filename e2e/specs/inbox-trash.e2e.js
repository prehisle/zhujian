import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, seedProcessedTaskless, inboxAction } from "./support.js";

// ㉜ UNRUN: card actions (删除/还原/彻底删除) now open via the ⋯ corner menu (inboxAction);
// the trash-bar 清空回收站 stays a plain visible button. Verify on a local e2e pass.

async function showTab(id) {
  await goNotebook("inbox");
  const tab = await $(`#${id}`);
  await tab.waitForExist({ timeout: 10000 });
  await tab.click();
}

describe("灵感 · 回收站(软删 → 还原 / 彻底删除 / 清空)", () => {
  // The 想法/回收站 tab now persists across view switches (inbox.ts `active` is module
  // scope) and all specs share one app process — leaving this describe on 回收站 would
  // hide later specs' 想法-list assertions. Reset to 想法 on the way out.
  after(async () => {
    await showTab("tab-ideas");
  });

  it("带标签想法删除 → 进回收站 → 还原回想法列表 → 再删 → 彻底删除真销毁", async () => {
    const id = await seedProcessedTaskless("E2E-回收-甲");

    // Soft-delete from the 想法 list (tagged → 软删): the card leaves; the note is archived.
    await showTab("tab-ideas");
    let card = await $(".note*=E2E-回收-甲");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-回收-甲", "删除");
    await card.waitForExist({ reverse: true, timeout: 10000 });

    expect((await invoke("list_processed")).some((n) => n.id === id)).toBe(false);
    expect((await invoke("list_archived")).some((n) => n.id === id)).toBe(true);

    // Restore from 回收站: back to the 想法 list, gone from the trash.
    await showTab("tab-archived");
    card = await $(".note*=E2E-回收-甲");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-回收-甲", "还原");
    await card.waitForExist({ reverse: true, timeout: 10000 });

    expect((await invoke("list_archived")).some((n) => n.id === id)).toBe(false);
    expect((await invoke("list_processed")).some((n) => n.id === id)).toBe(true);

    // Archive again, then 彻底删除 (two-step confirm): the row is truly gone.
    await showTab("tab-ideas");
    card = await $(".note*=E2E-回收-甲");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-回收-甲", "删除");
    await card.waitForExist({ reverse: true, timeout: 10000 });

    await showTab("tab-archived");
    card = await $(".note*=E2E-回收-甲");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-回收-甲", "彻底删除");
    await (await card.$(".confirm .do")).click();
    await card.waitForExist({ reverse: true, timeout: 10000 });

    // Gone from every list — no longer anywhere in the DB.
    expect((await invoke("list_archived")).some((n) => n.id === id)).toBe(false);
    expect((await invoke("list_processed")).some((n) => n.id === id)).toBe(false);
    expect((await invoke("list_inbox")).some((n) => n.id === id)).toBe(false);
  });

  it("孤儿(已整理但标签被删光)删除 → 软删进回收站,不再报「不在收件箱」", async () => {
    // Regression (2026-07-06): 删除 used to route on the tag count, but the DB's delete
    // guard runs on stage — deleting a topic cascades the tag links away while the idea
    // stays filed, so the old routing sent this orphan to the hard-delete path and it
    // failed with 「已不在收件箱…删除行数 0」. Since 73 删除 doesn't route at all (every
    // idea soft-deletes into the 回收站); this still pins the orphan shape end-to-end:
    // no chips, yet deletable, and it lands in the trash.
    const id = await seedProcessedTaskless("E2E-孤儿-甲");
    const topics = await invoke("list_topics");
    const t = topics.find((x) => x.title === "归档-E2E-孤儿-甲");
    await invoke("delete_topic", { id: t.id });

    await showTab("tab-ideas");
    const card = await $(".note*=E2E-孤儿-甲");
    await card.waitForExist({ timeout: 10000 });
    // The card shows no chips — yet it must take the soft path, not the hard one.
    expect(await card.$$(".tags .tag")).toHaveLength(0);
    await inboxAction("E2E-孤儿-甲", "删除");
    await card.waitForExist({ reverse: true, timeout: 10000 });

    expect((await invoke("list_processed")).some((n) => n.id === id)).toBe(false);
    expect((await invoke("list_archived")).some((n) => n.id === id)).toBe(true);
  });

  it("清空回收站 → 一次抹掉所有 archived", async () => {
    // Seed two processed notes and archive both straight through the backend.
    const a = await seedProcessedTaskless("E2E-清空-甲");
    const b = await seedProcessedTaskless("E2E-清空-乙");
    await invoke("archive_note", { id: a });
    await invoke("archive_note", { id: b });
    expect((await invoke("list_archived")).length).toBeGreaterThanOrEqual(2);

    await showTab("tab-archived");
    const purge = await $("button*=清空回收站");
    await purge.waitForExist({ timeout: 10000 });
    await purge.click();
    // Confirms with "彻底删除全部 N 条".
    await (await $("button*=彻底删除全部")).click();

    expect(await invoke("list_archived")).toHaveLength(0);
  });
});
