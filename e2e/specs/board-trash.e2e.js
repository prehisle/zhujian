import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

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

// 51 起回收站卡上**没有常驻按钮**了(两枚离场动作搬进 ⋯ / 右键 / 单键,同 508 的归档册),
// 所以驱动改走 `boardAction`(它开 ⋯ 菜单再点那一项)。⚠ 行内**确认**那一拍仍是真按钮
// (`confirmInline` 把它渲进 `.acts`),照旧用 `card.$("button*=…")` 找。

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
    await boardAction(A, "还原");
    await browser.waitUntil(async () => !(await inTrash(A)) && (await liveStatus(A)) === "done", {
      timeout: 8000,
    });

    // Back on the board, trash it again and then permanently delete it.
    await openBoard();
    await trashByBackend(A);
    await browser.waitUntil(async () => await inTrash(A), { timeout: 8000 });
    await openTrash();

    // 彻底删除 is two-step: the first click reveals the confirm pill.
    await boardAction(A, "彻底删除");
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

  // 51:回收站是**只读视图** —— 两枚离场动作不常驻(design-rules 那条铁律,508 在归档册
  // 先走了同一条路)。三格,与 board-seal 那例同形但各锚各的:
  //   ①卡上除 ⋯ 外一个按钮都没有(⛔ 判据是「存在的 button 有几个」,不是「看不见」——
  //     `.hk-btn` 是 `opacity:0` 而非 `display:none`);
  //   ②菜单里**恰两项**且顺序/危险态钉死:还原(U)+ 彻底删除(D,`danger`)——
  //     ⭐ 顺带把「回收站里没有编辑/标签这些经营性动作」这条从注释变成断言;
  //   ③右键开出**同一枚**菜单。
  // ⚠ **`还原` 的键刻意不是 `R`**:看板的**视图级**单键 `R` 是回收站开关,两者都挂在
  //    document 上会同时触发(一个键干两件事)。灵感回收站那侧没这约束、它用的就是 `R`
  //    —— 这枚不一致是**被迫的、已签字的**,⛔ 别当漂移去「修」。
  it("51:回收站卡无常驻按钮;⋯ 菜单恰两项(U 还原 / D 彻底删除);右键同门", async () => {
    const C = "回收丙-只读视图";
    await seedDoneTask(C);
    await trashByBackend(C);
    await browser.waitUntil(async () => await inTrash(C), { timeout: 8000 });
    await goNotebook("board");
    await openTrash();
    await $(".trash-list").$(`.tcard*=${C}`).waitForExist({ timeout: 8000 });

    const r = await browser.execute((title) => {
      const card = [...document.querySelectorAll(".trash-list .tcard")].find((n) => n.textContent.includes(title));
      if (!card) throw new Error("trash card not found: " + title);
      const buttons = [...card.querySelectorAll("button")].map((b) =>
        b.classList.contains("hk-btn") ? "⋯" : b.textContent,
      );
      const rows = () =>
        [...document.querySelectorAll(".hk-menu .hk-item")].map((it) => ({
          label: it.querySelector(".hk-label").textContent,
          key: it.querySelector(".hk-key").textContent,
          danger: it.classList.contains("danger"),
        }));
      card.querySelector(".hk-btn").click(); // ⋯ 那条路
      const viaIcon = rows();
      document.body.click();
      const afterClose = rows(); // 关得掉才算数(否则下一格读的是残留)
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      const viaRightClick = rows();
      document.body.click();
      return { buttons, viaIcon, afterClose, viaRightClick };
    }, C);

    expect(r.buttons).toEqual(["⋯"]); // ①常驻按钮一个都没有
    expect(r.viaIcon).toEqual([
      { label: "还原", key: "U", danger: false },
      { label: "彻底删除", key: "D", danger: true },
    ]); // ②恰两项、键与危险态都钉死
    expect(r.afterClose).toEqual([]);
    expect(r.viaRightClick).toEqual(r.viaIcon); // ③右键 = 同一枚菜单

    // 清场:彻底删掉它(⚠ 走命令层,本例不重复驱动那条两拍路径——上一例已覆盖)。
    const row = (await invoke("list_archived_tasks")).find((x) => x.title === C);
    await invoke("purge_task", { id: row.id });
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
