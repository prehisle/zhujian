import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

// Feature 3: a board card carries SEVERAL tags (M:N). Add one via the ＋ picker, drop one
// via a chip's ✕; the filter bar treats a card as belonging to EACH of its tags.
describe("任务看板 · 多标签", () => {
  const A = "E2E-多签-甲";
  const B = "E2E-多签-乙";
  const TASK = "E2E-多签任务";
  let idA, idB;

  // Backend truth: the sorted tag ids on TASK.
  const tagIds = async () => {
    const tasks = await invoke("list_tasks");
    const t = tasks.find((x) => x.title === TASK);
    return t.topics.map((tp) => tp.id).sort();
  };

  before(async () => {
    idA = await invoke("create_topic", { title: A });
    idB = await invoke("create_topic", { title: B });
    await invoke("create_task", { title: TASK, topicId: idA }); // born with tag A
    await goNotebook("board");
  });

  it("加第二个标签 → 两个标签共存(不是替换)", async () => {
    const card = await $(`.tcard*=${TASK}`);
    await card.waitForExist({ timeout: 10000 });
    // Starts with one tag chip (A) + the ＋ add button.
    await expect(card.$(".chip.topic.set")).toExist();

    // ㊺: the on-card ＋ add chip is gone — adding a tag opens the picker from the ⋯ menu's
    // 标签. Then pick B from the choices (programmatic click, matching the suite's style).
    await boardAction(TASK, "标签");
    await card.$(`.choice=${B}`).waitForExist({ timeout: 5000 });
    await browser.execute(
      (title, b) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
        [...card.querySelectorAll(".choice")].find((ch) => ch.textContent.includes(b)).click();
      },
      TASK,
      B,
    );

    // Both tags now on the card (backend) and two chips (DOM, scoped to this card).
    await browser.waitUntil(async () => (await tagIds()).length === 2, { timeout: 8000 });
    expect(await tagIds()).toEqual([idA, idB].sort());
    const reCard = await $(`.tcard*=${TASK}`);
    await expect(await reCard.$$(".chip.topic.set")).toBeElementsArrayOfSize(2);
  });

  it("多标签筛选 → 同一任务在它挂的每个标签下都出现", async () => {
    const exists = () => $(`.tcard*=${TASK}`).isExisting();
    const clickPill = (label) =>
      browser.execute((l) => {
        [...document.querySelectorAll(".tf-pill")].find((p) => p.textContent.includes(l)).click();
      }, label);

    // Tagged with BOTH — it shows under A and under B.
    await clickPill(A);
    await browser.waitUntil(async () => await exists(), { timeout: 8000 });
    await clickPill(B);
    await browser.waitUntil(async () => await exists(), { timeout: 8000 });
    await clickPill("所有");
    await browser.waitUntil(async () => await exists(), { timeout: 8000 });
  });

  it("点标签 ✕ → 去掉一个,另一个保留", async () => {
    // Click the ✕ on the chip whose text is A (programmatic: it is a tiny inline button).
    await browser.execute(
      (title, a) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
        const chip = [...card.querySelectorAll(".chip.topic.set")].find((ch) => ch.textContent.includes(a));
        chip.querySelector(".chip-x").click();
      },
      TASK,
      A,
    );
    await browser.waitUntil(async () => (await tagIds()).length === 1, { timeout: 8000 });
    expect(await tagIds()).toEqual([idB]);
    const card = await $(`.tcard*=${TASK}`);
    await expect(await card.$$(".chip.topic.set")).toBeElementsArrayOfSize(1);
  });

  it("编辑态显示标签(只读):chip 无 ✕,Esc 退出回读态", async () => {
    // 前一例后 TASK 只剩标签 B。开编辑后卡片被 load() 重渲、正文换成 textarea
    // (标题不再是 textContent),故不能再用 `.tcard*=TASK` 找卡,直接找 .edit-form。
    await boardAction(TASK, "编辑");
    const form = await $(".edit-form");
    await form.waitForExist({ timeout: 5000 });

    // ㊿:编辑态复用 .chip.topic.set 只读展示标签——无 ✕(读态才有),增删仍走 ⋯ 菜单 L。
    await expect(await form.$$(".chip.topic.set")).toBeElementsArrayOfSize(1);
    await expect(form.$(".chip.topic.set")).toHaveText(B);
    expect(await form.$(".chip.topic.set .chip-x").isExisting()).toBe(false);

    // Esc 取消(监听在文档级)→ 编辑态拆除、卡片回读态。
    await browser.execute((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }, await form.$(".edit-input"));
    await browser.waitUntil(async () => !(await $(".edit-form").isExisting()), { timeout: 8000 });
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 8000 });
  });
});
