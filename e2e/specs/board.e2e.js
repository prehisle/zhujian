import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction, cornerMenuHas, openCompose, boardPickTopicPill } from "./support.js";

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
    await openCompose();
    const input = await $("#compose-input");
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

  // ---- 长列里挪到另一头 ------------------------------------------------------
  // 用户实报:列长到出滚动条时,「把最下面那张拖到最上面」做不到 —— 拖到列顶边缘,列
  // 一动不动(原生 HTML5 DnD 不替我们滚内层滚动容器)。两条修法各一组例。
  const S1 = "长列-甲";
  const S2 = "长列-乙";
  const S3 = "长列-丙";

  it("拖到列的上边缘 → 列自动向上滚(边缘自动滚动)", async () => {
    await invoke("create_task", { title: S3 });
    await invoke("create_task", { title: S2 });
    await invoke("create_task", { title: S1 });
    await goNotebook("board");
    await (await cardInColumn("todo", S3)).waitForExist({ timeout: 8000 });

    // 「可滚」是前提不是被测对象:与其塞几十张卡把列撑长,直接把列体压矮 —— 要验的
    // 是「容器可滚时拖到边缘会不会滚」,它怎么变可滚无关。inline style 随下一次重画消失。
    const before = await browser.execute(() => {
      const body = document.querySelector(".col.todo .col-body");
      body.style.maxHeight = "100px";
      body.scrollTop = 9999; // 先滚到底,才有「向上滚」可言
      return body.scrollTop;
    });
    expect(before).toBeGreaterThan(0); // 前置断言:这一格真的可滚(否则下面测的是空气)

    // 一次 dragstart + 一次 dragover(clientY 落在列体顶边 4px 处 = EDGE 带内),此后
    // 指针不动 —— rAF 循环自己续帧,这正是真实拖拽里「按住不动等它滚」的形。
    await browser.execute(() => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes("长列-丙"));
      const body = document.querySelector(".col.todo .col-body");
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const y = body.getBoundingClientRect().top + 4;
      body.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    });
    try {
      await browser.waitUntil(
        async () => (await browser.execute(() => document.querySelector(".col.todo .col-body").scrollTop)) < before,
        { timeout: 4000, timeoutMsg: "拖到上边缘后列没有自动向上滚" },
      );
    } finally {
      // 收手势必须无条件执行:本例断言失败时若把手势留在半途(卡上挂着 .dragging、
      // 列体还压着 100px、rAF 还在转),下面两例会跟着变红 —— 那是**假红**,查起来
      // 会指向错的地方(阴性对照第一刀当场演过这一幕)。
      await browser.execute(() => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes("长列-丙"));
        card?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: new DataTransfer() }));
        const body = document.querySelector(".col.todo .col-body");
        if (body) body.style.maxHeight = "";
      });
    }
  });

  it("⋯ 菜单「移到列首」→ 卡落到整列最前,顺序落库", async () => {
    await goNotebook("board");
    await (await cardInColumn("todo", S3)).waitForExist({ timeout: 8000 });
    expect(await columnOrder("todo", [S1, S2, S3])).toEqual([S1, S2, S3]);
    await boardAction(S3, "移到列首");
    await browser.waitUntil(
      async () => JSON.stringify(await columnOrder("todo", [S1, S2, S3])) === JSON.stringify([S3, S1, S2]),
      { timeout: 8000, timeoutMsg: "「移到列首」没有把丙挪到列首" },
    );
  });

  it("⋯ 菜单「移到列尾」→ 卡落到整列最后", async () => {
    await goNotebook("board");
    await (await cardInColumn("todo", S3)).waitForExist({ timeout: 8000 });
    await boardAction(S3, "移到列尾");
    await browser.waitUntil(
      async () => JSON.stringify(await columnOrder("todo", [S1, S2, S3])) === JSON.stringify([S1, S2, S3]),
      { timeout: 8000, timeoutMsg: "「移到列尾」没有把丙挪到列尾" },
    );
  });
});

// 500:列内排序轴(手动 / 最新在前 / 最早在前)。排序是**前端**做的(created_at 已随
// list_tasks 带出),故断言读 DOM 顺序而不是 list_tasks —— 读后者等于在测后端那条没动过
// 的路。⛔ 排序档存 localStorage 且跨 spec 存活,after() 必须复位,否则本文件后面靠拖拽
// 的例会因为「拖不动了」全红。
describe("任务看板 · 列内排序轴", () => {
  const O1 = "排序轴-先建";
  const O2 = "排序轴-后建";

  // 某列 DOM 里我这两张卡的先后(忽略别的 spec 留下的卡)。
  async function domOrder(status, titles) {
    return browser.execute(
      (s, ts) =>
        [...document.querySelectorAll(`.col[data-col="${s}"] .col-body .tcard`)]
          .map((c) => ts.find((t) => c.textContent.includes(t)))
          .filter(Boolean),
      status,
      titles,
    );
  }
  const pickSort = async (label) => {
    // 循环钮:最多点三下必然轮到目标档(三档一圈)。
    for (let i = 0; i < 3; i += 1) {
      const cur = await $("#board-sort-lbl").getText();
      if (cur === label) return;
      await browser.execute(() => document.querySelector("#board-sort").click());
      await browser.pause(120);
    }
    throw new Error(`排序钮转了一圈也没到「${label}」`);
  };
  const draggableOf = (title) =>
    browser.execute(
      (t) => [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t)).draggable,
      title,
    );

  before(async () => {
    await invoke("create_task", { title: O1 });
    await browser.pause(1100); // created_at 是秒级以上的时刻串:两张卡必须落在不同刻
    await invoke("create_task", { title: O2 });
    await goNotebook("board");
    await (await cardInColumn("todo", O2)).waitForExist({ timeout: 8000 });
  });

  after(async () => {
    await pickSort("顺序:手动"); // ⛔ 别把排序态泄漏给后面靠拖拽的例
  });

  it("默认「手动」:新建的落列首(position 序),卡片可拖", async () => {
    await pickSort("顺序:手动");
    expect(await domOrder("todo", [O1, O2])).toEqual([O2, O1]); // create_task 插列首
    expect(await draggableOf(O1)).toBe(true);
  });

  it("切「最早在前」→ 先建的排前面;且拖动被停用", async () => {
    await pickSort("顺序:最早在前");
    await browser.waitUntil(async () => JSON.stringify(await domOrder("todo", [O1, O2])) === JSON.stringify([O1, O2]), {
      timeout: 8000,
      timeoutMsg: "切到「最早在前」后顺序没变",
    });
    expect(await draggableOf(O1)).toBe(false);
    // 时间序下 ⋯ 菜单里不该再有「移到列首」(它写 position,按了屏上不会动)
    expect(await cornerMenuHas(".tcard", O1, "移到列首")).toBe(false);
  });

  it("切「最新在前」→ 反过来;切回「手动」→ position 序与拖动都回来", async () => {
    await pickSort("顺序:最新在前");
    await browser.waitUntil(async () => JSON.stringify(await domOrder("todo", [O1, O2])) === JSON.stringify([O2, O1]), {
      timeout: 8000,
      timeoutMsg: "切到「最新在前」后顺序没变",
    });
    await pickSort("顺序:手动");
    await browser.waitUntil(async () => (await draggableOf(O1)) === true, {
      timeout: 8000,
      timeoutMsg: "切回手动后卡片仍不可拖",
    });
    expect(await cornerMenuHas(".tcard", O1, "移到列首")).toBe(true);
  });
});

describe("任务看板 · 按主题筛选", () => {
  const TOPIC = "看板主题-工作";
  const TAGGED = "看板戊-带主题";
  const UNTAGGED = "看板己-无主题";

  // 点标签轴上文字含 `label` 的那枚 pill。⛔ 走共享件,别在这里裸取 `.tf-pill`
  // ——一条筛选行里它不唯一(理由与判例见 support.js 的 pickTopicPill 头注)。
  const clickPill = boardPickTopicPill;
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
    await openCompose();
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

// 504:卡片右键 = 开同一枚 ⋯ 菜单。用户要「右键菜单」,做法是给已有的菜单加第二个开门方式
// (菜单与单键本就共读一份 actions ⇒ 右键不可能比 ⋯ 少一项或多一项),而不是新造一个菜单。
// ⚠ 合成 contextmenu 证明不了原生菜单真被抑制(preventDefault 拦的是自己派发的事件),
// 那半只有真鼠标能验;这里守的是「开不开、开在哪、什么时候必须让位」。
describe("看板 · 卡片右键开 ⋯ 菜单(504)", () => {
  const R = "E2E-504-右键卡";

  const rightClick = (sel, dx, dy) =>
    browser.execute(
      (s, x, y) => {
        const el = document.querySelector(s);
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y }),
        );
      },
      sel,
      dx,
      dy,
    );

  before(async () => {
    await goNotebook("board");
    for (const t of await invoke("list_tasks")) await invoke("archive_task", { id: t.id });
    await invoke("purge_archived_tasks", {});
    await invoke("create_task", { title: R });
    await goNotebook("board");
    // ⭐ 特意把窗开高:菜单**放不下时会被硬钳回视口内**(那是设计,见 hotkey-menu.ts 的
    // clamp),而全量套件里前面的 spec 留下的标签会把筛选行撑成两行、把卡片往下推 ⇒ 同一
    // 段断言单跑绿、全量红(实测差 33px)。要验「贴光标」就得先保证它放得下 —— 700 高时
    // 十项菜单(≈390px)从卡片位置展开正好越界。⛔ 别把断言放宽成「差 40px 以内」:
    // 那样真的定位错了也照样绿。
    await browser.setWindowSize(1100, 900);
    await $(`.tcard*=${R}`).waitForExist({ timeout: 10000 });
  });

  after(async () => {
    await browser.setWindowSize(1100, 700); // 还原 support.js 的驱动窗口口径
  });

  // 收干净再进下一格。⛔ 别用 `.hk-menu.remove()`:那只摘 DOM,控制器里的 `menuEl` 还指着
  // 那个死节点 ⇒ 下次 `openMenu` 见它非空直接 return,菜单再也开不出来(第一版就这么白得
  // 一格假红)。点 body 走的是它自己的 onDocClick → closeMenu,内部状态才真被清。
  afterEach(async () => {
    await browser.execute(() => document.body.click());
    await browser.pause(200);
  });

  it("右键卡片 → 菜单弹在光标处,项就是 ⋯ 那一份", async () => {
    await rightClick(".tcard", 30, 20);
    await $(".hk-menu").waitForExist({ timeout: 5000 });
    // ⚠ 量位置前必须等 hk-rise 跑完(0.14s,from{translateY(6px)}):动画中读 rect 会读到
    // 途中的偏移,白得一个「差 3px」的假红。
    await browser.pause(300);
    const info = await browser.execute(() => {
      const m = document.querySelector(".hk-menu");
      const card = document.querySelector(".tcard").getBoundingClientRect();
      const r = m.getBoundingClientRect();
      return {
        n: m.querySelectorAll(".hk-label").length,
        dx: Math.abs(r.left - (card.left + 30)),
        dy: Math.abs(r.top - (card.top + 20)),
        onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      };
    });
    expect(info.n).toBeGreaterThan(3);
    expect(info.onScreen).toBe(true);
    expect(info.dx).toBeLessThan(3);
    expect(info.dy).toBeLessThan(3);
  });

  it("让位①:编辑态输入框上右键不接管(留给原生粘贴——配图那条路正是粘贴)", async () => {
    await boardAction(R, "编辑");
    await $(".edit-form").waitForExist({ timeout: 5000 });
    await rightClick(".tcard .edit-input", 10, 10);
    await browser.pause(300);
    expect(await browser.execute(() => !!document.querySelector(".hk-menu"))).toBe(false);
    await browser.keys(["Escape"]);
    await browser.pause(300);
  });

  it("让位②:卡内有选区时不接管(留给原生复制)", async () => {
    const opened = await browser.execute(() => {
      const card = document.querySelector(".tcard");
      const range = document.createRange();
      range.selectNodeContents(card.querySelector(".ttitle") ?? card);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const r = card.getBoundingClientRect();
      card.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 20 }),
      );
      const hit = !!document.querySelector(".hk-menu");
      sel.removeAllRanges();
      return hit;
    });
    expect(opened).toBe(false);
  });
});

// 505:卡片**以外**的右键也归应用管。504 只接管了卡片那一处,挪开一寸(列空白 / 看板背景 /
// 侧栏)弹的仍是 WebView2 那份「返回 · 刷新 · 另存为 · 打印 · 检查」——而那个「刷新」在桌面
// 应用里点下去是重载整个 app。v1 只做「不弹浏览器那份」,⛔ 不新造动作表。
//
// ⚠ **判据是 `defaultPrevented`,不是「原生菜单没出现」** —— 合成事件上的 preventDefault
// 只证明**我们这一侧的决定**;浏览器认不认那半合成事件永远证明不了,那格在探针
// `e2e/probes/context-menu-native.e2e.js` 里(真 OS 鼠标)。这里守的正是决定本身。
// ⭐ **阴性对照是自带的**:接管那几格要求 `true`、让位那几格要求 `false`,两边互为对照 ——
// 监听没挂上时接管格必红,判据写死成「一律接管」时让位格必红。
describe("右键 · 卡片以外也归应用管(505)", () => {
  const R = "E2E-505-右键";

  // 在 `sel` 这个元素上合成一次右键,读回三件:元素在不在、事件被没被接管、⋯ 菜单开没开。
  const ctx = (sel) =>
    browser.execute((s) => {
      const el = document.querySelector(s);
      if (!el) return { found: false, prevented: null, menu: null };
      const r = el.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 4,
        clientY: r.top + 4,
      });
      el.dispatchEvent(ev);
      return { found: true, prevented: ev.defaultPrevented, menu: !!document.querySelector(".hk-menu") };
    }, sel);

  before(async () => {
    await goNotebook("board");
    for (const t of await invoke("list_tasks")) await invoke("archive_task", { id: t.id });
    await invoke("purge_archived_tasks", {});
    await invoke("create_task", { title: R });
    await goNotebook("board");
    await $(`.tcard*=${R}`).waitForExist({ timeout: 10000 });
  });

  // 选区会跨格残留(让位判据正读它),菜单同理 —— 每格收干净。⛔ 别用 `.hk-menu.remove()`,
  // 理由同上一个 describe(那只摘 DOM,控制器内部还指着死节点)。
  afterEach(async () => {
    await browser.execute(() => {
      getSelection()?.removeAllRanges();
      document.body.click();
    });
    await browser.pause(150);
  });

  it("接管:列空白 / 看板背景 / 侧栏三处都不再弹浏览器菜单", async () => {
    for (const sel of [".col-body", "#board", ".sidebar"]) {
      // 把 sel 折进期望里 —— 红的时候一眼看得出是哪一处,不必回头数循环轮次。
      expect({ sel, ...(await ctx(sel)) }).toEqual({ sel, found: true, prevented: true, menu: false });
    }
  });

  it("让位:正文输入框上的右键留给原生粘贴(配图那条路正是粘贴)", async () => {
    await openCompose();
    expect(await ctx("#compose-input")).toEqual({ found: true, prevented: false, menu: false });
  });

  it("卡片那条路照旧是 504 的:菜单开出来,事件也确实被接管", async () => {
    expect(await ctx(".tcard")).toEqual({ found: true, prevented: true, menu: true });
  });

  // ⭐ **这一格是 505 真正的风险面**:卡片子树整个交给 504 那条路判,文档级见 `.hk-host`
  // 就撒手。写漏这一条的后果不是「多弹个菜单」,是**用户什么菜单都拿不到** —— 卡片刚
  // 让位,文档级紧接着把同一次右键吞掉,比 505 之前还差。
  //
  // ⚠ **判据挑的是「行内编辑态」不是「卡内有选区」,而这是被阴性对照逼出来的**:第一版写的
  // 是选区那格,把 `.hk-host` 那半摘掉它**照样绿** —— 因为文档级自己的选区判据(两个方向
  // 都算「点在选区上」)把同一次右键又接住了。⇒ 那一格证明不了 `.hk-host` 在干活。
  // 四条卡片让位判据里,只有 `suspended()` 这一条在文档级**没有任何对位判据**兜着
  // (输入框那条 `NATIVE_MENU_KEEP` 兜着、链接与图片同理、选区那条如上),它才是刀口。
  it("⭐ 卡片让位之后文档级不许接着吞:行内编辑态在卡身上右键 → 两级都让位", async () => {
    await boardAction(R, "编辑");
    await $(".tcard .edit-form").waitForExist({ timeout: 5000 });
    // 落点是卡片本身(不是那个 input)⇒ 让位的理由只可能来自 `suspended()` 这一条。
    const r = await ctx(".tcard");
    await browser.keys(["Escape"]);
    await browser.pause(300);
    expect(r).toEqual({ found: true, prevented: false, menu: false });
  });

  // 卡片以外也要有选区那条让位,否则「选中列名 → 右键复制」就没了。
  // ⚠ **选区刻意建在文本节点内部(`setStart/setEnd`),不是 `selectNodeContents`** —— 后者的
  // `commonAncestorContainer` 是**元素**,走不到 `rightClickOnSelection` 里那一步「文本节点
  // 要先抬到元素父级」;而用户拖着选一段字,拿到的正是文本节点内部的 range。
  // ⇒ 用 `selectNodeContents` 写这一格,把那行抬升删掉它照样绿(阴性对照当场证伪过)。
  it("让位:卡片以外选中的文字上右键,留给原生复制", async () => {
    const r = await browser.execute(() => {
      const head = document.querySelector(".col-name");
      const tn = head.firstChild;
      const range = document.createRange();
      range.setStart(tn, 0);
      range.setEnd(tn, Math.min(2, tn.length));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const rc = head.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rc.left + 2,
        clientY: rc.top + 2,
      });
      head.dispatchEvent(ev);
      return {
        // 两件前置一并断死,否则这一格可能是空过的(恒 false 也叫「让位」):
        // 选区真建起来了、且它的 commonAncestorContainer 真是文本节点(3)。
        collapsed: sel.isCollapsed,
        ancType: sel.getRangeAt(0).commonAncestorContainer.nodeType,
        prevented: ev.defaultPrevented,
      };
    });
    expect(r).toEqual({ collapsed: false, ancType: 3, prevented: false });
  });
});
