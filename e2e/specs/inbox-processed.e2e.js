import { $, expect } from "@wdio/globals";
import { browser } from "@wdio/globals";
import { invoke, goNotebook, seedProcessedTaskless, inboxAction } from "./support.js";

// 标签只是元数据:已归类与未归类合并成单个「想法」列表(默认 tab),不再有独立「已整理」
// tab。打了标签的想法就长出 chip、留在同一列表;转待办仍把它移去看板(单实体去重)。

// The merged 想法 list is the default mounted tab — a tagged idea shows there directly.
async function showIdeas() {
  await goNotebook("inbox");
}

describe("灵感 · 想法列表(打标签的想法就地长 chip + 管理)", () => {
  it("打标签的想法出现在「想法」列表,带标签 chip,删除是软删(可还原)", async () => {
    await seedProcessedTaskless("E2E-已整理-甲");

    await showIdeas();
    const card = await $(".note*=E2E-已整理-甲");
    await card.waitForExist({ timeout: 10000 });

    // It carries its topic as a provenance chip (seed files it under 归档-…).
    await expect(card.$(".tag*=归档-E2E-已整理-甲")).toExist();

    // 删除 is offered (via the ⋯ menu) as a soft-delete into the 回收站, not a hard
    // delete (the full archive/restore/purge flow is in inbox-trash.e2e.js). Assert the
    // menu offers it.
    const hasDelete = await browser.execute((c) => {
      const card = [...document.querySelectorAll(".note")].find((n) => n.textContent.includes(c));
      card.querySelector(".hk-btn").click();
      // menu is portaled to <body> (one open at a time) — read it globally, not under the card.
      return [...document.querySelectorAll(".hk-menu .hk-item")].some(
        (b) => b.querySelector(".hk-label") && b.querySelector(".hk-label").textContent === "删除",
      );
    }, "E2E-已整理-甲");
    expect(hasDelete).toBe(true);
  });

  it("在「想法」列表上转待办 → 同一条离开灵感、成为看板任务(单实体去重)", async () => {
    const noteId = await seedProcessedTaskless("E2E-已整理-乙");

    await showIdeas();
    const card = await $(".note*=E2E-已整理-乙");
    await card.waitForExist({ timeout: 10000 });

    // 转待办 一步到位:点「待办」直接翻 stage(零副本、无确认框),标题即原文。
    await inboxAction("E2E-已整理-乙", "待办");

    // ㉜: the SAME item flips to a board task and leaves 已归类 (no second record).
    await card.waitForExist({ reverse: true, timeout: 10000 });
    const tasks = await invoke("list_tasks");
    const t = tasks.find((x) => x.title === "E2E-已整理-乙");
    expect(t).toBeDefined();
    expect(t.status).toBe("todo");

    // It is no longer in the 已归类 set — a task is not an idea-stage item anymore.
    const processed = await invoke("list_processed");
    expect(processed.some((n) => n.id === noteId)).toBe(false);
  });
});
