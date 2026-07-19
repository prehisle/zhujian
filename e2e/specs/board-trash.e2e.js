import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// A task's whereabouts straight from the backend (the real closed loop). Returns
// "active" / "archived" / null, plus a status helper.
async function liveStatus(title) {
  const t = (await invoke("list_tasks")).find((x) => x.title === title);
  return t ? t.status : null;
}
async function inTrash(title) {
  const t = (await invoke("list_archived_tasks")).find((x) => x.title === title);
  return !!t;
}

// Seed a 'done' task via real IPC (no AI): create it (born 'todo') then move it
// straight to done (todo→done is a legal user-state move).
async function seedDoneTask(title) {
  const id = await invoke("create_task", { title });
  await invoke("update_task_status", { id, to: "done" });
  return id;
}

// Click a labelled pill on the card carrying `title` (re-found each call — every
// mutation reloads the board/trash). Scroll into view first; columns/list scroll.
async function clickAct(title, label) {
  const card = await $(`.tcard*=${title}`);
  await card.waitForExist({ timeout: 8000 });
  const btn = await card.$(`button*=${label}`);
  await btn.scrollIntoView();
  await btn.waitForClickable({ timeout: 5000 });
  await btn.click();
}

// 55 起,拖到底部条是「归档(成就册)」不再进回收站(那条路在 board-seal.e2e.js 覆盖);
// 回收站入口是 ⋯ 菜单的 删除(UI 路径 board.e2e.js 已覆盖)。这里走命令层直达软删,
// 聚焦回收站自身的 还原/彻底删除/清空 闭环。
async function trashByBackend(title) {
  const id = (await invoke("list_tasks")).find((t) => t.title === title).id;
  await invoke("archive_task", { id });
}

async function openTrash() {
  await $("#trash-toggle").click();
  await browser.waitUntil(async () => (await $("main.trash").isExisting()) || (await $(".center").isExisting()), {
    timeout: 8000,
  });
}
async function openBoard() {
  // Toggle says "← 看板" while in trash view.
  await $("#trash-toggle").click();
  await $(".col.done").waitForExist({ timeout: 8000 });
}

describe("任务看板 · 回收站(软删除)", () => {
  const A = "回收甲-季度复盘";
  const B = "回收乙-清旧档案";

  before(async () => {
    await goNotebook("board");
  });

  it("已完成 → 删除 → 回收站 → 还原 → 再删除 → 彻底删除,逐步真改库", async () => {
    await seedDoneTask(A);
    await trashByBackend(A); // soft-delete into the 回收站
    await browser.waitUntil(async () => (await inTrash(A)) && (await liveStatus(A)) === null, {
      timeout: 8000,
    });
    await goNotebook("board"); // render from the new truth
    // Gone from the board view (whether or not other tasks remain to render columns).
    await expect($(`.tcard*=${A}`)).not.toExist();

    // Open the 回收站: the trashed card shows, still carrying its provenance.
    await openTrash();
    await expect($(".trash-list").$(`.tcard*=${A}`)).toExist();

    // 还原 brings it back onto the board (to 已完成).
    await clickAct(A, "还原");
    await browser.waitUntil(async () => !(await inTrash(A)) && (await liveStatus(A)) === "done", {
      timeout: 8000,
    });

    // Back on the board, trash it again and then permanently delete it.
    await openBoard();
    await trashByBackend(A);
    await browser.waitUntil(async () => await inTrash(A), { timeout: 8000 });
    await openTrash();

    // 彻底删除 is two-step: the first click reveals the confirm pill.
    await clickAct(A, "彻底删除");
    const card = await $(`.tcard*=${A}`);
    const confirm = await card.$("button*=彻底删除");
    await confirm.waitForClickable({ timeout: 5000 });
    await confirm.click();

    // Truly gone: absent from both lists.
    await browser.waitUntil(async () => !(await inTrash(A)) && (await liveStatus(A)) === null, {
      timeout: 8000,
    });
    await expect($(`.tcard*=${A}`)).not.toExist();
  });

  it("清空回收站 → 二次确认 → 真清库", async () => {
    await seedDoneTask(B);
    const id = (await invoke("list_tasks")).find((t) => t.title === B).id;
    await invoke("archive_task", { id }); // straight into the 回收站
    expect(await inTrash(B)).toBe(true);

    await goNotebook("board");
    await openTrash();
    await expect($(".trash-list").$(`.tcard*=${B}`)).toExist();

    // 清空回收站 is two-step (in the trash bar): reveal, then confirm.
    const clearBtn = await $("button*=清空回收站");
    await clearBtn.click();
    const confirm = await $("button*=全部删除");
    await confirm.waitForClickable({ timeout: 5000 });
    await confirm.click();

    // The trash is empty (and so is the backend's archived list).
    await browser.waitUntil(async () => (await invoke("list_archived_tasks")).length === 0, {
      timeout: 8000,
    });
    expect(await inTrash(B)).toBe(false);
  });
});
