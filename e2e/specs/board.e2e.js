import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

// The backend status of a task by title — the real closed loop we assert against
// (the DOM is driven by drags; the DB is the source of truth).
async function statusOf(title) {
  const all = await invoke("list_tasks");
  const t = all.find((x) => x.title === title);
  return t ? t.status : null;
}
async function inTrash(title) {
  return (await invoke("list_archived_tasks")).some((x) => x.title === title);
}
async function inSealed(title) {
  return (await invoke("list_sealed_tasks")).some((x) => x.title === title);
}

// Assert the card carrying `title` currently renders inside the named column.
function cardInColumn(status, title) {
  return $(`.col.${status}`).$(`.tcard*=${title}`);
}

// Synthetic HTML5 drag: dispatch dragstart on the card carrying `title`, then
// dragover+drop on the target. The board reads the dragged task from its own
// closure (set on dragstart), so this drives the exact same code path as a real
// pointer drag without depending on WebDriver's flaky native DnD. (Same escape
// hatch used elsewhere for opacity:0 reveals.)
async function dragCardTo(title, targetSel) {
  await browser.execute(
    (t, sel) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) =>
        c.textContent.includes(t),
      );
      const target = document.querySelector(sel);
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    title,
    targetSel,
  );
}

describe("任务看板 · 手工建任务与拖动流转", () => {
  // Distinctive title so assertions are order-independent of other specs.
  const A = "看板甲-写周报";

  before(async () => {
    await goNotebook("board");
  });

  it("新建任务 → 落在待办,拖动走过 进行中 → 已完成", async () => {
    // 新建任务 via the compose bar (born 'todo', no source note).
    await $("#add-task").waitForClickable({ timeout: 8000 });
    await $("#add-task").click();
    const input = await $("#compose-input");
    await input.waitForDisplayed({ timeout: 5000 });
    await browser.execute((v) => {
      document.querySelector("#compose-input").value = v;
    }, A);
    await $("#compose-add").click();

    await browser.waitUntil(async () => (await statusOf(A)) === "todo", { timeout: 8000 });
    await expect(await cardInColumn("todo", A)).toExist();

    // Drag 待办 → 进行中.
    await dragCardTo(A, ".col.doing .col-body");
    await browser.waitUntil(async () => (await statusOf(A)) === "doing", { timeout: 8000 });
    await expect(await cardInColumn("doing", A)).toExist();

    // Drag 进行中 → 已完成.
    await dragCardTo(A, ".col.done .col-body");
    await browser.waitUntil(async () => (await statusOf(A)) === "done", { timeout: 8000 });
    await expect(await cardInColumn("done", A)).toExist();
  });

  it("把已完成的任务拖到归档区 → 入成就册(归档),不进回收站", async () => {
    // A is 'done' from the previous test. The drop strip is REAL 归档 now (成就册,
    // sealed_at axis) — not the 回收站 (that's the ⋯ menu's 删除).
    expect(await statusOf(A)).toBe("done");

    await dragCardTo(A, ".archive-zone");
    await browser.waitUntil(async () => (await inSealed(A)) && (await statusOf(A)) === null, {
      timeout: 8000,
    });
    // Gone from the active board; and NOT in the trash (归档 ≠ 删除).
    await expect($(`.tcard*=${A}`)).not.toExist();
    expect(await inTrash(A)).toBe(false);
  });

  it("编辑任务标题 → 行内改名、落库", async () => {
    const orig = "看板乙-原标题";
    const renamed = "看板乙-改过的标题";

    // Seed a fresh todo through the backend, then remount the board to render it
    // (avoids depending on the compose bar's open/closed state from earlier tests).
    await invoke("create_task", { title: orig });
    await browser.waitUntil(async () => (await statusOf(orig)) === "todo", { timeout: 8000 });
    await goNotebook("board");
    await (await cardInColumn("todo", orig)).waitForExist({ timeout: 8000 });

    // Open 编辑 from the card's ⋯ menu, type a new title, Enter 保存(取消/保存按钮已移除)。
    await boardAction(orig, "编辑");
    await $(".edit-input").waitForDisplayed({ timeout: 5000 });
    await browser.execute((v) => {
      const input = document.querySelector(".edit-input");
      input.value = v;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, renamed);

    // The DB is the source of truth: the row is renamed in place (same task).
    await browser.waitUntil(async () => (await statusOf(renamed)) === "todo", { timeout: 8000 });
    expect(await statusOf(orig)).toBe(null);
    await expect(await cardInColumn("todo", renamed)).toExist();
  });
});

describe("任务看板 · 拖动排序", () => {
  // The order of MY titles within a column (list_tasks is already position-ordered,
  // so filtering preserves board order); ignores other specs' leftover tasks.
  async function columnOrder(status, titles) {
    const all = await invoke("list_tasks");
    return all.filter((t) => t.status === status && titles.includes(t.title)).map((t) => t.title);
  }

  // Synthetic drag of `title`, dropped just above `targetTitle`'s midpoint (so it
  // inserts BEFORE it) onto that card's column body — drives the board's own
  // dragAfterElement(clientY) path. If `targetTitle` is null, drops at clientY=0
  // (the column front).
  async function dragBefore(title, targetTitle, colSelector) {
    await browser.execute(
      (t, tt, csel) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
        const body = tt
          ? [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(tt)).closest(".col-body")
          : document.querySelector(csel);
        const y = tt
          ? [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(tt)).getBoundingClientRect().top + 2
          : 0;
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        body.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      },
      title,
      targetTitle,
      colSelector,
    );
  }

  const R1 = "排序-甲";
  const R2 = "排序-乙";
  const R3 = "排序-丙";

  it("同列拖动重排 → 顺序落库(把丙拖到甲之前)", async () => {
    // create_task inserts at the FRONT of 待办, so seed in reverse to land the
    // board order 甲, 乙, 丙 (positions 0,1,2), then render.
    await invoke("create_task", { title: R3 });
    await invoke("create_task", { title: R2 });
    await invoke("create_task", { title: R1 });
    await goNotebook("board");
    await (await cardInColumn("todo", R3)).waitForExist({ timeout: 8000 });

    // Their relative order starts 甲,乙,丙.
    expect(await columnOrder("todo", [R1, R2, R3])).toEqual([R1, R2, R3]);

    // Drag 丙 to the front of 待办 → 丙,甲,乙.
    await dragBefore(R3, R1, ".col.todo .col-body");
    await browser.waitUntil(
      async () => JSON.stringify(await columnOrder("todo", [R1, R2, R3])) === JSON.stringify([R3, R1, R2]),
      { timeout: 8000 },
    );
  });

  const C1 = "插入-待办X";
  const D1 = "插入-进行A";
  const D2 = "插入-进行B";

  it("跨列拖动 → 改状态并插入到落点位置(插到 A 与 B 之间)", async () => {
    // 进行中 has A,B; 待办 has X. Drag X into 进行中, dropped before B → A,X,B.
    const x = await invoke("create_task", { title: C1 });
    const a = await invoke("create_task", { title: D1 });
    const b = await invoke("create_task", { title: D2 });
    await invoke("update_task_status", { id: a, to: "doing" });
    await invoke("update_task_status", { id: b, to: "doing" });
    await goNotebook("board");
    await (await cardInColumn("doing", D2)).waitForExist({ timeout: 8000 });
    expect(await columnOrder("doing", [D1, D2])).toEqual([D1, D2]);

    // Drop X just above B's midpoint → inserts between A and B, status → doing.
    await dragBefore(C1, D2, null);
    await browser.waitUntil(async () => (await statusOf(C1)) === "doing", { timeout: 8000 });
    await browser.waitUntil(
      async () => JSON.stringify(await columnOrder("doing", [D1, C1, D2])) === JSON.stringify([D1, C1, D2]),
      { timeout: 8000 },
    );
    void x;
  });
});

describe("任务看板 · 按主题筛选", () => {
  const TOPIC = "看板主题-工作";
  const TAGGED = "看板戊-带主题";
  const UNTAGGED = "看板己-无主题";

  // Click the filter pill whose text contains `label`.
  async function clickPill(label) {
    await browser.execute((l) => {
      [...document.querySelectorAll(".tf-pill")].find((p) => p.textContent.includes(l)).click();
    }, label);
  }
  const exists = (title) => $(`.tcard*=${title}`).isExisting();

  before(async () => {
    // Seed a topic + one tagged and one untagged task straight through the backend.
    const topicId = await invoke("create_topic", { title: TOPIC });
    await invoke("create_task", { title: TAGGED, topicId });
    await invoke("create_task", { title: UNTAGGED });
    await goNotebook("board");
  });

  // The 标签 filter now persists across view switches (board.ts topicFilter is module
  // scope), and all specs share one app process — so leaving this describe on a topic
  // filter would hide later specs' board cards. Reset to 所有 on the way out.
  after(async () => {
    await clickPill("所有");
  });

  it("所有 / 无主题 / 主题 三种筛选各自只显对应任务", async () => {
    // 所有: both tagged and untagged are on the board.
    await clickPill("所有");
    await browser.waitUntil(async () => (await exists(TAGGED)) && (await exists(UNTAGGED)), {
      timeout: 8000,
    });

    // Filter to the topic: only the tagged task remains.
    await clickPill(TOPIC);
    await browser.waitUntil(async () => (await exists(TAGGED)) && !(await exists(UNTAGGED)), {
      timeout: 8000,
    });

    // Filter to 无标签: the tagged task drops out, the untagged one shows.
    await clickPill("无标签");
    await browser.waitUntil(async () => !(await exists(TAGGED)) && (await exists(UNTAGGED)), {
      timeout: 8000,
    });

    // Back to 所有.
    await clickPill("所有");
    await browser.waitUntil(async () => (await exists(TAGGED)) && (await exists(UNTAGGED)), {
      timeout: 8000,
    });
  });

  it("筛选态下也能拖动 → 跨列改状态(走 reorder_task_visible)", async () => {
    // Filter to the topic so only the tagged task is on screen.
    await clickPill(TOPIC);
    await browser.waitUntil(async () => (await exists(TAGGED)) && !(await exists(UNTAGGED)), {
      timeout: 8000,
    });

    // Drag the tagged 待办 into 进行中 WHILE filtered (the column DOM is a subset).
    await dragCardTo(TAGGED, ".col.doing .col-body");
    await browser.waitUntil(async () => (await statusOf(TAGGED)) === "doing", { timeout: 8000 });
    await expect(await cardInColumn("doing", TAGGED)).toExist();
  });
});

describe("任务看板 · 删除任意活跃任务 → 回收站 → 还原回原列", () => {
  const T = "删除戊-进行中的活";

  // Click the 删除 pill on the card carrying `title`, then click through the inline
  // confirm (进度㉖ added a 移入回收站? confirm with a 不再提示 opt-out). If a prior
  // spec set the opt-out there is no confirm — the card's gone — so the second step
  // is a no-op. Robust either way.
  async function clickDelete(title) {
    // 删除 lives in the card's ⋯ menu now; the inline confirm (移入回收站?) is unchanged.
    await boardAction(title, "删除");
    await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      if (!card) return; // already archived (opt-out) — nothing to confirm
      const yes = [...card.querySelectorAll("button.act.primary")].find((b) => b.textContent === "删除");
      if (yes) yes.click();
    }, title);
  }

  before(async () => {
    const id = await invoke("create_task", { title: T });
    await invoke("update_task_status", { id, to: "doing" });
    await goNotebook("board");
    await (await cardInColumn("doing", T)).waitForExist({ timeout: 8000 });
  });

  it("点删除 → 进回收站、状态冻结在原列;还原 → 回到原列", async () => {
    await clickDelete(T);
    // Soft-deleted: gone from the active board, now in the 回收站.
    await browser.waitUntil(async () => await inTrash(T), { timeout: 8000 });
    expect(await statusOf(T)).toBe(null);
    await expect($(`.tcard*=${T}`)).not.toExist(); // gone from the active board

    // Status is FROZEN at 'doing' while archived (not forced to done).
    const arch = (await invoke("list_archived_tasks")).find((x) => x.title === T);
    expect(arch.status).toBe("doing");

    // Restore → back onto the board in its ORIGINAL column (进行中).
    await invoke("restore_task", { id: arch.id });
    await browser.waitUntil(async () => (await statusOf(T)) === "doing", { timeout: 8000 });
    await goNotebook("board");
    await expect(await cardInColumn("doing", T)).toExist();
  });
});

describe("任务看板 · 待确认列(可选验收)", () => {
  const T = "待确认-等对方回执";

  before(async () => {
    await invoke("create_task", { title: T }); // born 'todo'
    await goNotebook("board");
    await (await cardInColumn("todo", T)).waitForExist({ timeout: 8000 });
  });

  it("进行中 → 待确认 → 已完成:可选验收去处", async () => {
    // 待办 → 进行中.
    await dragCardTo(T, ".col.doing .col-body");
    await browser.waitUntil(async () => (await statusOf(T)) === "doing", { timeout: 8000 });

    // 进行中 → 待确认 (the new fourth column — work done, awaiting confirmation).
    await dragCardTo(T, ".col.confirming .col-body");
    await browser.waitUntil(async () => (await statusOf(T)) === "confirming", { timeout: 8000 });
    await expect(await cardInColumn("confirming", T)).toExist();

    // 待确认 → 已完成 (confirmed).
    await dragCardTo(T, ".col.done .col-body");
    await browser.waitUntil(async () => (await statusOf(T)) === "done", { timeout: 8000 });
    await expect(await cardInColumn("done", T)).toExist();
  });

  it("待确认 → 打回进行中:四态自由双向流转", async () => {
    // It's 'done' from the previous test. Pull it back to 待确认 (done→confirming is
    // legal: free movement), then kick it back to 进行中 for rework.
    await dragCardTo(T, ".col.confirming .col-body");
    await browser.waitUntil(async () => (await statusOf(T)) === "confirming", { timeout: 8000 });

    await dragCardTo(T, ".col.doing .col-body");
    await browser.waitUntil(async () => (await statusOf(T)) === "doing", { timeout: 8000 });
    await expect(await cardInColumn("doing", T)).toExist();
  });
});

describe("任务看板 · 文本过滤", () => {
  const MATCH = "文过-给猫买粮";
  const OTHER = "文过-修屋顶";

  const exists = (title) => $(`.tcard*=${title}`).isExisting();

  // Type into the filter box like a user: set value + fire input (the box filters
  // on every keystroke through load(); the input lives OUTSIDE renderTopicFilter's
  // replaceChildren, so it survives every repaint).
  async function setFilter(text) {
    await browser.execute((v) => {
      const box = document.querySelector("#board-filter");
      box.value = v;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
  }

  before(async () => {
    await invoke("create_task", { title: MATCH });
    await invoke("create_task", { title: OTHER });
    await goNotebook("board");
    await (await cardInColumn("todo", MATCH)).waitForExist({ timeout: 8000 });
  });

  // textFilter is module scope (survives view switches) and all specs share one app
  // process — leaving a filter behind would hide later specs' board cards. Clear on
  // the way out (same rationale as the topic-filter describe's 所有 reset).
  after(async () => {
    await setFilter("");
  });

  it("输入过滤词 → 只显匹配卡;清空 → 全部回来", async () => {
    await setFilter("买粮");
    await browser.waitUntil(async () => (await exists(MATCH)) && !(await exists(OTHER)), {
      timeout: 8000,
    });

    await setFilter("");
    await browser.waitUntil(async () => (await exists(MATCH)) && (await exists(OTHER)), {
      timeout: 8000,
    });
  });

  it("过滤态下拖动 → 跨列改状态(走 reorder_task_visible)", async () => {
    await setFilter("买粮");
    await browser.waitUntil(async () => (await exists(MATCH)) && !(await exists(OTHER)), {
      timeout: 8000,
    });

    // The column DOM is only the text-matching subset — the drop must route through
    // the visible-merge path, same as a topic-filtered drag.
    await dragCardTo(MATCH, ".col.doing .col-body");
    await browser.waitUntil(async () => (await statusOf(MATCH)) === "doing", { timeout: 8000 });
    await expect(await cardInColumn("doing", MATCH)).toExist();
  });

  it("筛空 → 显示「没有匹配」空态,不冒充空看板", async () => {
    await setFilter("绝无此词xyzq");
    await browser.waitUntil(
      async () => (await $(".center .big").getText()).includes("没有匹配"),
      { timeout: 8000 },
    );
  });

  it("过滤着新建任务 → 过滤自动清空,新卡可见", async () => {
    const NEW = "文过-新来的活";
    await setFilter("买粮");
    await browser.waitUntil(async () => !(await exists(OTHER)), { timeout: 8000 });

    // Create through the compose bar: the new card wouldn't match 「买粮」, so
    // submit clears the text filter rather than filtering the newborn to invisible.
    await $("#add-task").waitForClickable({ timeout: 8000 });
    await $("#add-task").click();
    await $("#compose-input").waitForDisplayed({ timeout: 5000 });
    await browser.execute((v) => {
      document.querySelector("#compose-input").value = v;
    }, NEW);
    await $("#compose-add").click();

    await browser.waitUntil(
      async () => (await exists(NEW)) && (await exists(OTHER)),
      { timeout: 8000 },
    );
    expect(await browser.execute(() => document.querySelector("#board-filter").value)).toBe("");
  });
});

describe("任务看板 · 乐观移位即时更新列头计数(163 可优化项①)", () => {
  // 卡片乐观移位(松手即挪)后,列头「N」徽章过去要等 reorder 的 load() 才刷新,留一拍
  // 延迟(卡已挪走、数字没动)。此测把 drop 与计数读取放进同一次 execute:drop 处理器同步
  // 跑完 bumpColCount 后才轮到 reorder 的 await invoke,故此刻读到的必是乐观值、load() 尚未
  // 回来——delta 即证徽章在手势帧就动了。天然阴性对照:去掉 bumpColCount 则 delta=0、测转红。
  const M = "计数-即时更新的活";

  before(async () => {
    await invoke("create_task", { title: M });
    await goNotebook("board");
    await (await cardInColumn("todo", M)).waitForExist({ timeout: 8000 });
  });

  it("跨列 drop:目标列 +1、源列 −1 在同一帧生效(不等 load)", async () => {
    const snap = await browser.execute(
      (t, fromSel, toSel) => {
        const read = (sel) => Number(document.querySelector(sel + " .col-count").textContent);
        const before = { from: read(fromSel), to: read(toSel) };
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
        const target = document.querySelector(toSel + " .col-body");
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        // reorder() 里 load() 是 await 的异步,此刻还没跑;读到的纯是乐观 bump。
        const after = { from: read(fromSel), to: read(toSel) };
        card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return { before, after };
      },
      M,
      ".col.todo",
      ".col.doing",
    );

    expect(snap.after.to - snap.before.to).toBe(1); // 目标列(进行中)同帧 +1
    expect(snap.before.from - snap.after.from).toBe(1); // 源列(待办)同帧 −1

    // 结算态也对:load() 校正后与后端一致(端到端闭环)。
    await browser.waitUntil(async () => (await statusOf(M)) === "doing", { timeout: 8000 });
    await expect(await cardInColumn("doing", M)).toExist();
  });
});
