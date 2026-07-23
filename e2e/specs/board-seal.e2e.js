import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction, boardMenuHas, tryInvoke } from "./support.js";

// 归档(成就册,sealed_at 轴)e2e:与回收站(archived_at)是两根互斥的轴。
// 归档 = 干完的活入册:可查、不可删;取消归档回「已完成」列;删除须先取消归档再走两段式。

async function statusOf(title) {
  const t = (await invoke("list_tasks")).find((x) => x.title === title);
  return t ? t.status : null;
}
async function sealedRow(title) {
  return (await invoke("list_sealed_tasks")).find((x) => x.title === title) ?? null;
}

// Seed a 'done' task via real IPC (born todo → straight to done).
async function seedDoneTask(title) {
  const id = await invoke("create_task", { title });
  await invoke("update_task_status", { id, to: "done" });
  return id;
}

// 打开归档视图(header 的 归档 toggle)。归档列表复用 trash 布局(main.trash.sealed-view),
// 空态是 .center。
async function openSealed() {
  await $("#seal-toggle").click();
  await browser.waitUntil(
    async () => (await $("main.sealed-view").isExisting()) || (await $(".center").isExisting()),
    { timeout: 8000 },
  );
}

describe("任务看板 · 归档(成就册,可查不可删)", () => {
  const A = "成就甲-上线新版";
  const B = "成就乙-写完文档";
  const TODO = "成就丙-还没干的活";

  before(async () => {
    await goNotebook("board");
  });

  it("⋯ 菜单「归档」只给已完成卡;归档后离开看板、不进回收站", async () => {
    await seedDoneTask(A);
    await invoke("create_task", { title: TODO }); // stays todo
    await goNotebook("board");
    // NB: a `*=text` selector can't follow a descendant combinator — chain the $() calls.
    await $(".col.done").$(`.tcard*=${A}`).waitForExist({ timeout: 10000 });
    // 完成时刻(0030 writer):进 done 那条边盖了 done_at,已完成卡显示「完成于」小字。
    await expect($(".col.done").$(`.tcard*=${A}`).$(".done-at")).toExist();

    // 待办卡的菜单没有「归档」;已完成卡有。
    expect(await boardMenuHas(TODO, "归档")).toBe(false);
    expect(await boardMenuHas(A, "归档")).toBe(true);

    await boardAction(A, "归档");
    await browser.waitUntil(async () => (await sealedRow(A)) && (await statusOf(A)) === null, {
      timeout: 8000,
    });
    await expect($(`.tcard*=${A}`)).not.toExist(); // off the board
    // 归档 ≠ 删除:回收站里没有它;sealed_at 已盖上(时间轴分组的依据)。
    expect((await invoke("list_archived_tasks")).some((x) => x.title === A)).toBe(false);
    expect((await sealedRow(A)).sealed_at).toBeTruthy();
    // 完成时刻随行到归档册(0030):归档册按 done_at ?? sealed_at 分组/排序。
    expect((await sealedRow(A)).done_at).toBeTruthy();
  });

  it("归档视图:时间轴分组、不可删;取消归档 → 回「已完成」列", async () => {
    await openSealed();
    const card = await $(".trash-list").$(`.tcard*=${A}`);
    await card.waitForExist({ timeout: 8000 });
    await expect($(".tl-date")).toExist(); // 按归档日分组的日期标头
    // 头部一行统计(本周完成 + 累计,纯派生、只算不存;0030 决定 A:按完成日计数)。
    // 刚 seed→done→归档的 A 完成日=今天,必在本周。
    const statsText = await (await $(".trash-bar .grow")).getText();
    expect(/^本周完成 [1-9]\d* · 累计 [1-9]\d*$/.test(statsText)).toBe(true);

    // 不可删:软删/彻底删的命令层都 fail-fast(DB 触发器是终极后盾)。
    const row = await sealedRow(A);
    expect((await tryInvoke("archive_task", { id: row.id })).ok).toBe(false);
    expect((await tryInvoke("purge_task", { id: row.id })).ok).toBe(false);
    // 冻结:归档中的成就连改名都不行。
    expect((await tryInvoke("rename_task", { id: row.id, title: "篡改" })).ok).toBe(false);

    // 取消归档(卡上唯一按钮)→ 回看板「已完成」列。
    const btn = await card.$("button*=取消归档");
    await btn.waitForClickable({ timeout: 5000 });
    await btn.click();
    await browser.waitUntil(async () => (await statusOf(A)) === "done" && !(await sealedRow(A)), {
      timeout: 8000,
    });
  });

  it("归档拖放条只在拖「已完成」卡时现身(显示条件=接收条件)", async () => {
    // A 已回到 done(上一测),TODO 还是待办。合成 dragstart/dragend(同 board.e2e.js
    // 的 dragCardTo 手法),断 #board 上 drag-done 类的有无(CSS 靠它淡入拖放条)。
    await goNotebook("board");
    await $(".col.done").$(`.tcard*=${A}`).waitForExist({ timeout: 10000 });
    const dragClass = (title) =>
      browser.execute((t) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const during = document.querySelector("#board").classList.contains("drag-done");
        card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        const after = document.querySelector("#board").classList.contains("drag-done");
        return { during, after };
      }, title);
    expect(await dragClass(A)).toEqual({ during: true, after: false });   // done 卡:现身、放手即收
    expect(await dragClass(TODO)).toEqual({ during: false, after: false }); // 待办卡:全程不现身
  });

  it("已完成列头「全部归档」两步确认 → 整列入册", async () => {
    // A 已回到 done(上一测),再补一条 → 已完成列至少两条(可能还有别的 spec 的遗留,
    // 断言只锚自己的标题)。
    await seedDoneTask(B);
    await goNotebook("board");
    await $(".col.done").$(`.tcard*=${B}`).waitForExist({ timeout: 10000 });

    // 第一步:列头「全部归档」→ slot 换成行内确认;第二步:点「归档」执行。
    const sealAll = await $(".col.done .seal-all-slot").$("button*=全部归档");
    await sealAll.waitForClickable({ timeout: 5000 });
    await sealAll.click();
    const confirm = await $(".col.done .seal-all-slot button.act.primary");
    await confirm.waitForClickable({ timeout: 5000 });
    expect(await confirm.getText()).toBe("归档");
    await confirm.click();

    await browser.waitUntil(
      async () => (await sealedRow(A)) && (await sealedRow(B)) && (await statusOf(A)) === null && (await statusOf(B)) === null,
      { timeout: 8000 },
    );
    // 待办的没被扫进去。
    expect(await statusOf(TODO)).toBe("todo");
  });

  after(async () => {
    // 收尾:自己的 todo 卡走软删+彻底删;归档的 A/B 留在册里(对别的 spec 不可见,
    // 每轮 e2e 全新库,不积累)。
    const t = (await invoke("list_tasks")).find((x) => x.title === TODO);
    if (t) {
      await invoke("archive_task", { id: t.id });
      await invoke("purge_task", { id: t.id });
    }
  });
});
