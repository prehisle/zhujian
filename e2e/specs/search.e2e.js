import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// ㉜ 单实体:search 现走 search_items,命中可以是灵感(inbox/processed=filed)、
// 任务(task)、或回收站(archived),且连历史一起搜。下面三态对应 badge.inbox /
// badge.task / badge.archived。Seed one matching item in a chosen state. `task`
// promotes it to a todo (now a board task — status "task", leaves 灵感); `archive`
// files it (filed) then soft-deletes it (archived). Returns the item id.
async function seedHit(content, { task = false, archive = false } = {}) {
  const id = await invoke("capture_note", { content });
  if (task) {
    await invoke("promote_note_to_task", { id, title: content });
  } else if (archive) {
    await invoke("file_note_to_topic", { id, newTitle: `归档-${content}` });
    await invoke("archive_note", { id });
  }
  return id;
}

// Set the search box and run the query immediately. Setting value via execute
// avoids CJK IME jitter; dispatching Enter runs the search synchronously (the
// page's keydown handler reads the just-set value), sidestepping the debounce
// window where a stray focus keystroke could otherwise mutate the query.
async function typeQuery(q) {
  await browser.execute((val) => {
    const input = document.getElementById("q");
    input.value = val;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, q);
}

describe("搜索(按内容跨状态查找想法)", () => {
  beforeEach(async () => {
    await clearInbox(); // keep the inbox clean so seeded statuses are unambiguous
  });

  it("一个关键词同时命中收件箱/已整理/回收站的想法,匹配处高亮", async () => {
    const TOK = "E2E搜索莓";
    await seedHit(`${TOK} 还在收件箱`); // inbox
    await seedHit(`${TOK} 已转待办`, { task: true }); // 任务 (board, status "task")
    await seedHit(`${TOK} 在回收站里`, { archive: true }); // archived
    await seedHit("E2E完全无关的内容"); // never matches

    await goNotebook("search");
    await typeQuery(TOK);

    // Wait until results actually render (a hit card appears), so the count
    // assertion below doesn't race the idle→results transition.
    await (await $(".hit")).waitForExist({ timeout: 10000 });

    // Three hits across the three statuses; the non-matching note is absent.
    await expect(await $$(".hit")).toBeElementsArrayOfSize(3);
    // Read the count via textContent (WebDriver getText can report "" for this
    // element depending on render state; textContent is the reliable signal).
    const countText = await browser.execute(() => document.querySelector(".count")?.textContent ?? "");
    expect(countText).toBe("3 条匹配");

    // Each status badge is present (the item lives in a different place in each case):
    // 未归类灵感 / 任务看板 / 回收站.
    await expect(await $(".badge.inbox")).toExist();
    await expect(await $(".badge.task")).toExist();
    await expect(await $(".badge.archived")).toExist();

    // The matched substring is highlighted (a <mark> built from the query).
    await expect(await $(".hit-text mark")).toHaveText(TOK);

    // The unrelated note never shows up.
    await expect(await $(".hit-text*=完全无关")).not.toExist();
  });

  it("无匹配时给空状态,清空后回到初始提示", async () => {
    await goNotebook("search");
    await typeQuery("E2E绝不存在的词xyz");

    const big = await $(".big*=没有匹配");
    await big.waitForExist({ timeout: 10000 });

    // Clearing the box returns to the idle prompt.
    await $("#clear").click();
    await expect(await $(".big*=在所有条目里查找")).toExist();
    await expect(await $(".hit")).not.toExist();
  });
});
