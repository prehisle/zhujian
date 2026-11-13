import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, boardAction, boardMenuHas } from "./support.js";

// 撤回为灵感 + 删除二次确认 GUI coverage:
//   1. 撤回为灵感 — any 待办 task can retreat to 灵感 (灵感 = a not-yet-clarified task).
//      ㉜ 单实体: this flips the SAME item's stage back to 灵感 (no copy, no source-idea
//      restore/seed fork) — untagged → 未归类, still-tagged → 已归类. So after a revert
//      the item is no longer a task (list_tasks no longer has it) but is in list_inbox.
//      进行中/已完成 tasks have no such button.
//   2. 删卡片不再先问(F 组 F4 / R3)— 删除直接进回收站 + 带「撤销」的回执(此前是行内确认 +「不再提示」勾选)。

// Click an inline-confirm pill (e.g. 撤回) on the card carrying `title` by exact text.
// (The card's primary actions moved into the ⋯ menu — use boardAction for those; this
// helper is only for the confirm-stage pills that still render in `.acts`.)
async function clickConfirmButton(title, label) {
  await browser.execute(
    (t, l) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      [...card.querySelectorAll("button")].find((b) => b.textContent === l).click();
    },
    title,
    label,
  );
}

async function taskExists(title) {
  return (await invoke("list_tasks")).some((t) => t.title === title);
}
async function inTrash(title) {
  return (await invoke("list_archived_tasks")).some((x) => x.title === title);
}

describe("任务看板 · 撤回为灵感", () => {
  const IDEA = "撤回甲-本来只是个想法";

  before(async () => {
    await clearInbox();
    // Capture an idea, then 转待办 it — now it is a task sourced from exactly 1 note.
    const noteId = await invoke("capture_note", { content: IDEA });
    await invoke("promote_note_to_task", { id: noteId, title: IDEA });
    await goNotebook("board");
  });

  // Whether the card carrying `title` offers 撤回为灵感 in its ⋯ menu.
  const cardHasRevert = (title) => boardMenuHas(title, "撤回为随记");

  it("待办带「撤回为灵感」→ 撤回 → 同一条翻回未归类灵感(不再是任务)", async () => {
    await (await $(".col.todo").$(`.tcard*=${IDEA}`)).waitForExist({ timeout: 8000 });
    expect(await cardHasRevert(IDEA)).toBe(true);

    // 撤回为灵感 (⋯ menu) → inline confirm → 撤回.
    await boardAction(IDEA, "撤回为随记");
    await clickConfirmButton(IDEA, "撤回");

    // Closed loop: the item is no longer a task (left the board), back in 未归类 (inbox).
    await browser.waitUntil(async () => !(await taskExists(IDEA)), { timeout: 8000 });
    const inbox = await invoke("list_inbox");
    expect(inbox.some((n) => n.content === IDEA)).toBe(true);
    await expect($(`.tcard*=${IDEA}`)).not.toExist();
  });

  it("手工建的待办也能撤回 → 同一条翻回未归类灵感", async () => {
    const MANUAL = "撤回乙-手工建的待办";
    await invoke("create_task", { title: MANUAL });
    await goNotebook("board");
    await (await $(".col.todo").$(`.tcard*=${MANUAL}`)).waitForExist({ timeout: 8000 });
    expect(await cardHasRevert(MANUAL)).toBe(true);

    await boardAction(MANUAL, "撤回为随记");
    await clickConfirmButton(MANUAL, "撤回");

    // ㉜: the SAME item flipped back to 未归类 (no separate task to delete, no new idea seeded).
    await browser.waitUntil(async () => !(await taskExists(MANUAL)), { timeout: 8000 });
    const inbox = await invoke("list_inbox");
    expect(inbox.some((n) => n.content === MANUAL)).toBe(true);
    await expect($(`.tcard*=${MANUAL}`)).not.toExist();
  });

  it("进行中的任务不显示「撤回为灵感」", async () => {
    const DOING = "撤回丙-进行中的任务";
    const id = await invoke("create_task", { title: DOING });
    await invoke("update_task_status", { id, to: "doing" });
    await goNotebook("board");
    await (await $(".col.doing").$(`.tcard*=${DOING}`)).waitForExist({ timeout: 8000 });
    expect(await cardHasRevert(DOING)).toBe(false);
  });
});

describe("任务看板 · 删卡片不再先问(F 组 F4 / R3)", () => {
  const T1 = "删确认-甲";
  const T2 = "删确认-乙";

  before(async () => {
    await invoke("create_task", { title: T2 });
    await invoke("create_task", { title: T1 }); // T1 lands at the front of 待办
    await goNotebook("board");
  });

  after(async () => {
    await browser.execute(() => {
      document.querySelector(".undo-toast")?.remove();
      localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed");
    });
  });

  it("点删除 → 不问、直接进回收站,回执「已移入回收站」带「撤销」;点撤销 → 回到待办", async () => {
    await (await $(".col.todo").$(`.tcard*=${T1}`)).waitForExist({ timeout: 8000 });
    await boardAction(T1, "删除");
    await browser.waitUntil(async () => await inTrash(T1), { timeout: 8000, timeoutMsg: "点了删除没直接进回收站(还在等确认?)" });
    // 没有确认条、没有「不再提示」
    expect(await browser.execute(() => document.querySelectorAll(".tcard .confirm-q, .dont-ask").length)).toBe(0);
    await $(".undo-toast").waitForExist({ timeout: 5000 });
    const toast = await browser.execute(() => ({
      text: document.querySelector(".undo-toast .undo-text").textContent,
      btns: [...document.querySelectorAll(".undo-toast button")].map((b) => b.textContent),
    }));
    expect(toast).toEqual({ text: "已移入回收站", btns: ["撤销"] });
    await browser.execute(() => document.querySelector(".undo-toast .undo-btn").click());
    await browser.waitUntil(async () => await taskExists(T1), { timeout: 8000, timeoutMsg: "撤销没把卡还回来" });
    await (await $(".col.todo").$(`.tcard*=${T1}`)).waitForExist({ timeout: 8000 });
  });

  it("旧机器上留着的「不再提示」偏好(开 / 关)都不再有任何作用:删就是直接删", async () => {
    await (await $(".col.todo").$(`.tcard*=${T2}`)).waitForExist({ timeout: 8000 });
    // 旧键两种取值各走一遍:没有(= 旧的「要问」)与 "1"(= 旧的「不问」)
    await browser.execute(() => localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed"));
    await boardAction(T2, "删除");
    await browser.waitUntil(async () => await inTrash(T2), { timeout: 8000 });
    await expect($(".tcard .confirm-q")).not.toExist();
    await browser.execute(() => localStorage.setItem("ysNotebook.taskArchiveConfirmDismissed", "1"));
    await boardAction(T1, "删除");
    await browser.waitUntil(async () => await inTrash(T1), { timeout: 8000 });
    // 回执不再提「以后不问 / 在设置里改回」
    expect(await browser.execute(() => document.querySelector(".undo-toast .undo-text").textContent)).toBe("已移入回收站");
  });
});
