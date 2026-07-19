import { $, $$, expect } from "@wdio/globals";
import { browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// inbox card actions open via the ⋯ corner menu (inboxAction); 转待办 moves the SAME item to
// the board (single-entity, no note_count). 转待办 form is a <textarea class="edit-area">
// (preserves line breaks), not the 打标签 <input class="field"> — see 2026-06-29 run.

// Set a field's value deterministically (avoids IME/keyboard flakiness for CJK).
// The consequential action (clicking 保存/转待办/归入) is a real WebDriver click;
// this only seeds the field, like revealing a hover element.
async function setField(elem, value) {
  await browser.execute(
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    elem,
    value,
  );
}

async function openCard(content) {
  await goNotebook("inbox");
  const card = await $(`.note*=${content}`);
  await card.waitForExist({ timeout: 10000 });
  return card;
}

describe("收件箱 · 编辑想法(保留历史)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("编辑原文 → 卡片更新 → 库里 content 改、历史留旧版", async () => {
    const id = await invoke("capture_note", { content: "E2E-编辑-原文" });

    const card = await openCard("E2E-编辑-原文");
    await inboxAction("E2E-编辑-原文", "编辑");

    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });
    await setField(area, "E2E-编辑-改后");

    // Enter 保存(取消/保存按钮已移除,Esc/Enter 代之)。
    await browser.execute((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, area);

    // The view restores with the new text in place.
    await expect(card.$(".note-text")).toHaveText(expect.stringContaining("E2E-编辑-改后"));

    // Backend: current content is the new text; the original is kept as history.
    const inbox = await invoke("list_inbox");
    expect(inbox.find((n) => n.id === id).content).toBe("E2E-编辑-改后");
    const revs = await invoke("list_note_history", { id });
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("E2E-编辑-原文");
  });
});

describe("收件箱 · 转待办(手动,不经 AI)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("转待办 → 同一条离开灵感去看板 → 库里成 todo 任务", async () => {
    await invoke("capture_note", { content: "E2E-待办-源" });

    const card = await openCard("E2E-待办-源");
    // 转待办 一步到位:点「待办」直接翻 stage(零副本、无确认框),标题即原文。
    await inboxAction("E2E-待办-源", "待办");

    // ㉜: the card leaves 灵感 — the SAME item flipped to a board task (no copy).
    await card.waitForExist({ reverse: true, timeout: 10000 });
    expect(await invoke("list_inbox")).toHaveLength(0);

    // A user-state 'todo' task now exists (the item, at stage 'todo'), 标题保留原文.
    const tasks = await invoke("list_tasks");
    const t = tasks.find((x) => x.title === "E2E-待办-源");
    expect(t).toBeDefined();
    expect(t.status).toBe("todo");
  });
});

describe("灵感 · 打标签(手动,不经 AI)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("新建标签归入 → 想法留在列表并长出标签 chip;再用已有标签 chip 归入第二条", async () => {
    // First note: file into a brand-new topic via the new-topic input.
    await invoke("capture_note", { content: "E2E-主题-甲" });
    const card = await openCard("E2E-主题-甲");
    await inboxAction("E2E-主题-甲", "标签");

    const newField = await card.$(".new-topic .field");
    await newField.waitForExist({ timeout: 5000 });
    await setField(newField, "E2E-新主题-X");
    await (await card.$("button*=新建并归入")).click();

    // 标签只是元数据:打标签后想法留在「想法」列表(不再离开),只是长出一个 chip。
    const taggedA = await $(".note*=E2E-主题-甲");
    await taggedA.$(".tag*=E2E-新主题-X").waitForExist({ timeout: 10000 });
    let topics = await invoke("list_topics");
    expect(topics.some((t) => t.title === "E2E-新主题-X")).toBe(true);

    // Second note: file into the now-existing topic by clicking its chip.
    await invoke("capture_note", { content: "E2E-主题-乙" });
    const card2 = await openCard("E2E-主题-乙");
    await inboxAction("E2E-主题-乙", "标签");

    const chip = await card2.$(".chip*=E2E-新主题-X");
    await chip.waitForExist({ timeout: 5000 });
    await chip.click();

    // It too stays in the list with the chip; both have left the inbox (未归类) stage.
    const taggedB = await $(".note*=E2E-主题-乙");
    await taggedB.$(".tag*=E2E-新主题-X").waitForExist({ timeout: 10000 });
    expect(await invoke("list_inbox")).toHaveLength(0);

    // No duplicate topic was created by routing into the existing one.
    topics = await invoke("list_topics");
    expect(topics.filter((t) => t.title === "E2E-新主题-X")).toHaveLength(1);
  });
});
