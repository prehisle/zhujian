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

    // Backend already has both tags right after the pick.
    await browser.waitUntil(async () => (await tagIds()).length === 2, { timeout: 8000 });
    expect(await tagIds()).toEqual([idA, idB].sort());
    // keepOpen:选完选择器不收起(可接着连加),chip 要等收起后才画回 —— Esc 收起并让整板重载,
    // 再断言两个 chip 共存(不是替换)。
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await browser.waitUntil(async () => !(await $(`.tcard*=${TASK}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "Esc 后选择器未收起",
    });
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

// 218 需求 2:看板多标签筛选走「或」(并集)。独立播种(只甲/只乙/甲和乙/只丙/无标签),
// 才能真钉住 OR 的「判别力」——单选各只显对应、多选显并集、无标签与标签互斥。
describe("任务看板 · 多标签筛选(OR/并集)", () => {
  const A = "E2E-或-甲";
  const B = "E2E-或-乙";
  const C = "E2E-或-丙";
  const ONLY_A = "E2E-或-只甲";
  const ONLY_B = "E2E-或-只乙";
  const BOTH = "E2E-或-甲乙";
  const ONLY_C = "E2E-或-只丙";
  const NONE = "E2E-或-无标签";
  let idA, idB, idC;
  const ids = [];

  const exists = (title) => $(`.tcard*=${title}`).isExisting();
  const clickPill = (id) =>
    browser.execute((i) => document.querySelector(`.tf-pill[data-topic-id="${i}"]`).click(), id);
  // 桌面多选走 Ctrl+单击(真用户按住 Ctrl):合成一枚带 ctrlKey 的 click 派发,触发同一 onclick。
  const ctrlPill = (id) =>
    browser.execute(
      (i) =>
        document
          .querySelector(`.tf-pill[data-topic-id="${i}"]`)
          .dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true })),
      id,
    );
  const pillActive = (id) =>
    browser.execute(
      (i) => document.querySelector(`.tf-pill[data-topic-id="${i}"]`).classList.contains("active"),
      id,
    );

  before(async () => {
    idA = await invoke("create_topic", { title: A });
    idB = await invoke("create_topic", { title: B });
    idC = await invoke("create_topic", { title: C });
    ids.push(await invoke("create_task", { title: ONLY_A, topicId: idA }));
    ids.push(await invoke("create_task", { title: ONLY_B, topicId: idB }));
    const both = await invoke("create_task", { title: BOTH, topicId: idA });
    await invoke("add_task_topic", { id: both, topicId: idB });
    ids.push(both);
    ids.push(await invoke("create_task", { title: ONLY_C, topicId: idC }));
    ids.push(await invoke("create_task", { title: NONE, topicId: null }));
    await goNotebook("board");
    await $(`.tf-pill[data-topic-id="${idA}"]`).waitForExist({ timeout: 10000 });
  });

  after(async () => {
    // 复位到「所有」,别把选态泄漏给后续共享同库的 spec。
    await browser.execute(() => {
      const all = [...document.querySelectorAll(".tf-pill")].find((p) => p.textContent.includes("所有"));
      if (all) all.click();
    });
    for (const id of ids) {
      await invoke("archive_task", { id });
      await invoke("purge_task", { id });
    }
    await invoke("delete_topic", { id: idA });
    await invoke("delete_topic", { id: idB });
    await invoke("delete_topic", { id: idC });
  });

  it("单击甲、Ctrl+单击乙 → 显示带甲或乙的任务(并集),丙/无标签隐身;两枚 pill 同时高亮", async () => {
    await clickPill(idA); // 单击 = 只选甲
    await ctrlPill(idB); // Ctrl+单击 = 把乙加进选集(OR 并集)
    await browser.waitUntil(
      async () =>
        (await exists(ONLY_A)) &&
        (await exists(ONLY_B)) &&
        (await exists(BOTH)) &&
        !(await exists(ONLY_C)) &&
        !(await exists(NONE)),
      { timeout: 8000, timeoutMsg: "OR 并集结果不符" },
    );
    expect(await pillActive(idA)).toBe(true);
    expect(await pillActive(idB)).toBe(true);
  });

  it("Ctrl+单击乙 → 切出乙只剩甲;单击唯一选中的甲 → 取消回「所有」全显", async () => {
    // 承上:此刻甲、乙都选着。
    await ctrlPill(idB); // Ctrl+单击切出乙(多选内减一)
    await browser.waitUntil(
      async () => (await exists(ONLY_A)) && (await exists(BOTH)) && !(await exists(ONLY_B)),
      { timeout: 8000, timeoutMsg: "切出乙后应只剩带甲的" },
    );
    await clickPill(idA); // 单击唯一选中项 = 取消 → 选集空 = 所有
    await browser.waitUntil(
      async () => (await exists(ONLY_C)) && (await exists(NONE)) && (await exists(ONLY_B)),
      { timeout: 8000, timeoutMsg: "取消唯一选中后应回到显示所有" },
    );
  });

  it("单击 = 单选替换(非累加):点甲后点乙 → 只剩带乙的,带甲(不带乙)的隐身", async () => {
    await clickPill(idA);
    await browser.waitUntil(async () => (await exists(ONLY_A)) && !(await exists(ONLY_B)), {
      timeout: 8000,
    });
    await clickPill(idB); // 平常单击 = 替换选集(不是像旧版那样累加)
    await browser.waitUntil(
      async () => (await exists(ONLY_B)) && (await exists(BOTH)) && !(await exists(ONLY_A)),
      { timeout: 8000, timeoutMsg: "单击应替换为只选乙,而非与甲并集" },
    );
    expect(await pillActive(idA)).toBe(false);
    expect(await pillActive(idB)).toBe(true);
  });

  it("无标签与具体标签互斥:选甲后点无标签 → 只剩无标签的", async () => {
    await clickPill(idA);
    await browser.waitUntil(async () => (await exists(ONLY_A)) && !(await exists(NONE)), {
      timeout: 8000,
    });
    // 点「无标签」应清掉甲、只显无标签条目(不是与甲 OR 到一起)。
    await browser.execute(() => {
      [...document.querySelectorAll(".tf-pill")].find((p) => p.textContent.includes("无标签")).click();
    });
    await browser.waitUntil(
      async () => (await exists(NONE)) && !(await exists(ONLY_A)) && !(await exists(BOTH)),
      { timeout: 8000, timeoutMsg: "无标签未与具体标签互斥" },
    );
    expect(await pillActive(idA)).toBe(false);
  });
});
