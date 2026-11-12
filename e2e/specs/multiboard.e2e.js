import { browser, $, expect } from "@wdio/globals";
import { boardAction, boardMenuHas, cornerMenuHas, goNotebook, inboxAction, invoke, openCompose, tryInvoke, boardMore } from "./support.js";

// 多看板第 3 段(multiboard-plan §6 / §9 格 3):桌面侧栏看板组、新建看板、列管理里的两个角色、
// 挪到看板、收容区、归档册按看板筛。
//
// ⭐ 断言口径**落库为准**(`list_boards` / `list_board_columns` / `list_tasks` 是 core 的读模型,DOM 只是投影);
// DOM 那半只断「这一面长成了用户拍的样子」(渐进式披露:单看板时侧栏不展开,用户 2026-11-11 拍)。
// ⚠ 这一支自己建的看板 / 卡 / 列在 after 里收干净,并把「在看哪块」的本机记忆清掉 —— 否则后面的 spec
// 打开看板会落在一块它们不认识的看板上。

const boards = () => invoke("list_boards");
const cols = () => invoke("list_board_columns");
const tasks = () => invoke("list_tasks");
const taskByTitle = async (title) => (await tasks()).find((t) => t.title === title);
const navItems = () =>
  browser.execute(() => [...document.querySelectorAll("#board-nav .bn-item")].map((b) => b.querySelector(".bn-name").textContent.trim()));

const READ = "多看板-书单";
const FLOW = "多看板-周报";
const CARD = "多看板-一本书";
const HELD = "多看板-收容卡";
const SEAL_A = "多看板-周报归档";
const SEAL_B = "多看板-任务归档";
const NOTE = "多看板-一条随记";

/** 收场:能删的卡都删干净、自建看板清空后删掉、自建列删掉、本机「在看哪块」清掉。 */
async function cleanup() {
  for (const n of await invoke("list_ideas")) {
    if (!n.content.startsWith("多看板-")) continue;
    await invoke("archive_note", { id: n.id });
    await invoke("purge_note", { id: n.id });
  }
  for (const t of await tasks()) {
    if (!t.title.startsWith("多看板-")) continue;
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
  for (const t of await invoke("list_sealed_tasks")) {
    if (!t.title.startsWith("多看板-")) continue;
    await invoke("unseal_task", { id: t.id });
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
  for (const b of await boards()) {
    if (b.deleted || !b.deletable) continue;
    const r = await tryInvoke("delete_board", { id: b.id });
    if (!r.ok) throw new Error(`收场删看板失败(${b.title}):${r.err}`);
  }
  for (const c of await cols()) {
    if (c.kind !== "task" || c.deleted || c.board_deleted || !c.deletable) continue;
    if (["todo", "doing", "confirming", "done"].includes(c.id)) continue;
    await invoke("delete_board_column", { id: c.id });
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
  });
}

describe("多看板 · 桌面", () => {
  before(async () => {
    await goNotebook("board");
    await cleanup();
    await goNotebook("board");
  });
  after(async () => {
    await browser.execute(() => document.querySelectorAll(".bcm-overlay").forEach((o) => o.remove()));
    await cleanup();
  });

  it("只有一块看板:随记 ⋯ 里没有「放进看板」(渐进式披露,「转待办」就是它)", async () => {
    await invoke("capture_note", { content: NOTE });
    await goNotebook("inbox");
    await browser.waitUntil(async () => browser.execute((c) => [...document.querySelectorAll(".note")].some((n) => n.textContent.includes(c)), NOTE), { timeout: 8000 });
    expect(await cornerMenuHas(".note", NOTE, "转待办")).toBe(true);
    expect(await cornerMenuHas(".note", NOTE, "放进看板")).toBe(false);
    await goNotebook("board");
  });

  it("只有一块看板:侧栏不展开;「新建看板」的入口在列管理面底部", async () => {
    expect((await boards()).filter((b) => !b.deleted).length).toBe(1);
    expect(await navItems()).toEqual([]);
    await expect($("#board-nav .bn-add")).not.toExist();
    await boardMore("manage-cols");
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    const btns = await browser.execute(() => [...document.querySelectorAll(".bcm-board .bcm-btn")].map((b) => b.textContent.trim()));
    expect(btns).toContain("+ 新建一块看板");
    // 种子看板不给「删除这块看板」(core 同拒)
    expect(btns).not.toContain("删除这块看板");
    const r = await tryInvoke("delete_board", { id: "tasks" });
    expect(r.ok).toBe(false);
  });

  it("从列管理面新建「一列,只分类」的看板 → 落库、侧栏展开、切到那块、只高亮它", async () => {
    await browser.execute(() => {
      const b = [...document.querySelectorAll(".bcm-board .bcm-btn")].find((x) => x.textContent.trim() === "+ 新建一块看板");
      b.click();
    });
    await $(".bn-new").waitForExist({ timeout: 5000 });
    await expect($(".bcm-panel:not(.bn-new)")).not.toExist(); // 列管理面先关了,不叠两层遮罩
    await browser.execute((name) => {
      document.querySelector(".bn-new input").value = name;
      document.querySelector('.bn-tpl[data-tpl="one"]').click();
      [...document.querySelectorAll(".bn-new .bcm-btn")].find((x) => x.textContent.trim() === "建好").click();
    }, READ);
    await browser.waitUntil(async () => (await boards()).some((b) => b.title === READ), { timeout: 8000 });
    const b = (await boards()).find((x) => x.title === READ);
    expect(b.done).toBe(null); // 纯分类
    expect(b.landing).not.toBe(null);
    expect(b.is_default).toBe(false); // 新建的排在最后,默认仍是最上面那块

    await browser.waitUntil(async () => (await navItems()).includes(READ), { timeout: 8000 });
    await expect($("#board-nav .bn-add")).toExist();
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1").textContent)) === READ, { timeout: 8000 });
    const st = await browser.execute(() => ({
      cols: document.querySelectorAll("#board .col").length,
      single: !!document.querySelector("#board .cols.single"),
      parentSubOn: document.querySelector('.sidebar nav button[data-view="board"]').classList.contains("sub-on"),
      activeSub: document.querySelector("#board-nav .bn-item.active .bn-name")?.textContent.trim() ?? null,
    }));
    expect(st).toEqual({ cols: 1, single: true, parentSubOn: true, activeSub: READ });
  });

  it("纯分类看板:新卡落它的那一列;卡上没有「完成 / 归档」,有「挪到看板」;列头没有「全部归档」", async () => {
    await openCompose();
    await browser.execute((v) => {
      document.querySelector("#compose-input").value = v;
    }, CARD);
    await $("#compose-add").click();
    const b = (await boards()).find((x) => x.title === READ);
    await browser.waitUntil(async () => (await taskByTitle(CARD))?.status === b.landing, { timeout: 8000 });
    await browser.waitUntil(async () => browser.execute((c) => [...document.querySelectorAll(".tcard")].some((x) => x.textContent.includes(c)), CARD), { timeout: 8000 });
    expect(await boardMenuHas(CARD, "完成")).toBe(false);
    expect(await boardMenuHas(CARD, "归档")).toBe(false);
    expect(await boardMenuHas(CARD, "挪到看板")).toBe(true);
    await expect($(".seal-all-slot")).not.toExist();
    // core 同拒:这块看板没有完成列
    const r = await tryInvoke("seal_done_tasks", { boardId: b.id });
    expect(r.ok).toBe(false);
  });

  it("⋯「挪到看板 ▸ 任务」→ 落「任务」的落点列首", async () => {
    await boardAction(CARD, ["挪到看板", "任务"]);
    await browser.waitUntil(async () => (await taskByTitle(CARD))?.status === "todo", { timeout: 8000 });
    const order = (await tasks()).filter((t) => t.status === "todo").map((t) => t.title);
    expect(order[0]).toBe(CARD);
  });

  it("随记 ⋯「放进看板 ▸ 书单」→ 落书单的落点(不是默认看板);回执点名那块;「去看看」切过去", async () => {
    const read = (await boards()).find((b) => b.title === READ);
    expect(read.is_default).toBe(false); // 证点名压过默认,而不是恰好落在默认那块
    await goNotebook("inbox");
    await browser.waitUntil(async () => browser.execute((c) => [...document.querySelectorAll(".note")].some((n) => n.textContent.includes(c)), NOTE), { timeout: 8000 });
    await inboxAction(NOTE, ["放进看板", READ]);
    await browser.waitUntil(async () => (await taskByTitle(NOTE))?.status === read.landing, { timeout: 8000 });
    expect((await invoke("list_ideas")).some((n) => n.content === NOTE)).toBe(false); // 零副本:随记那边没了
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".undo-toast .undo-text")?.textContent ?? "")) === `已放进看板「${READ}」`, { timeout: 8000 });
    // 给它截止与优先级(撤回会清掉、撤销要原样设回;「去看看」那一跳会重取看板,卡上带着这两格)
    const noteId = (await taskByTitle(NOTE)).id;
    await invoke("set_task_due", { id: noteId, dueOn: "2026-12-01" });
    await invoke("set_task_priority", { id: noteId, priority: 3 });
    await browser.execute(() => document.querySelector(".undo-toast .undo-go").click());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1")?.textContent)) === READ, { timeout: 8000 });
    await browser.waitUntil(async () => browser.execute((c) => [...document.querySelectorAll(".tcard")].some((x) => x.textContent.includes(c)), NOTE), { timeout: 8000 });
    // 在非默认看板上「撤回为随记」再撤销 ⇒ 转回**这块**的落点(⛔ 不是默认看板)
    await boardAction(NOTE, "撤回为随记");
    await browser.execute((c) => {
      const card = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(c));
      [...card.querySelectorAll("button")].find((b) => b.textContent === "撤回").click();
    }, NOTE);
    await browser.waitUntil(async () => !(await taskByTitle(NOTE)), { timeout: 8000 });
    await $(".undo-toast .undo-btn:not(.undo-go)").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector(".undo-toast .undo-btn:not(.undo-go)").click());
    await browser.waitUntil(async () => (await taskByTitle(NOTE))?.status === read.landing, { timeout: 8000 });
    await browser.waitUntil(async () => (await taskByTitle(NOTE))?.priority === 3, { timeout: 8000 });
    expect((await taskByTitle(NOTE)).due_on).toBe("2026-12-01");
    // 撤销回不了原列 ⇒ core 在写事务里拒、什么都不写,⛔ 不落到新落点还说「已撤销」(codex 实现审一、二轮 M1)。
    // 窗口要卡在「前端发撤销」与「core 写事务」之间才证得了原子性(前端预读挡不住它)⇒ 页内把 IPC 包一层:
    // 截到这一发带 expectedColumn 的 promote 时,先用真命令把落点改掉,再放行真 promote(codex 二轮给的构造)。
    // 拦在 fetch 这一层,理由与「包装里别抛」见 space-walk159-s2.e2e.js 头注。
    await browser.waitUntil(async () => browser.execute((c) => [...document.querySelectorAll(".tcard")].some((x) => x.textContent.includes(c)), NOTE), { timeout: 8000 });
    await boardAction(NOTE, "撤回为随记");
    await browser.execute((c) => {
      const card = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(c));
      [...card.querySelectorAll("button")].find((b) => b.textContent === "撤回").click();
    }, NOTE);
    await browser.waitUntil(async () => !(await taskByTitle(NOTE)), { timeout: 8000 });
    const extra = await invoke("create_board_column", { title: "多看板-第二列", boardId: read.id });
    await browser.execute(
      (board, col) => {
        const realFetch = window.fetch;
        window.__mbWindow = { realFetch, fired: false };
        window.fetch = function (input, init) {
          const url = typeof input === "string" ? input : input.url;
          const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
          if (base === undefined || window.__mbWindow.fired) return realFetch.call(window, input, init);
          const cmd = decodeURIComponent(url.slice(base.length).split("?")[0]);
          let args = null;
          try {
            if (init && typeof init.body === "string") args = JSON.parse(init.body);
          } catch {
            args = null;
          }
          if (cmd !== "promote_note_to_task" || !args || !args.expectedColumn) return realFetch.call(window, input, init);
          window.__mbWindow.fired = true;
          return window.__TAURI__.core
            .invoke("set_board_landing", { spaceId: args.spaceId, id: board, column: col })
            .then(() => realFetch.call(window, input, init), () => realFetch.call(window, input, init));
        };
      },
      read.id,
      extra,
    );
    await $(".undo-toast .undo-btn:not(.undo-go)").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector(".undo-toast .undo-btn:not(.undo-go)").click());
    const errNow = () =>
      browser.execute(() => ({
        err: document.querySelector("#op-err:not([hidden]) #op-err-msg")?.textContent ?? "",
        fired: window.__mbWindow.fired,
      }));
    try {
      await browser.waitUntil(async () => (await errNow()).err.includes("撤销不了"), { timeout: 8000 });
    } catch {
      throw new Error(`撤销没被拒(超时现场):${JSON.stringify(await errNow())};卡:${JSON.stringify(await taskByTitle(NOTE))}`);
    }
    await browser.execute(() => {
      window.fetch = window.__mbWindow.realFetch;
    });
    expect(await browser.execute(() => window.__mbWindow.fired)).toBe(true); // 窗口真插进去了
    expect((await boards()).find((b) => b.id === read.id).landing).toBe(extra); // 落点确实在写事务前被改了
    expect(await taskByTitle(NOTE)).toBe(undefined); // 没落到新落点
    expect((await invoke("list_ideas")).some((n) => n.content === NOTE)).toBe(true);
    await invoke("set_board_landing", { id: read.id, column: read.landing });
    await invoke("delete_board_column", { id: extra });
    // core 同拒:点名一块不存在的看板 ⇒ 响亮拒,⛔ 不退到默认看板
    const idea = await invoke("capture_note", { content: `${NOTE}-拒` });
    const r = await tryInvoke("promote_note_to_task", { id: idea, title: `${NOTE}-拒`, boardId: "01NOSUCHBOARD0000000000000" });
    expect(r.ok).toBe(false);
    expect((await invoke("list_ideas")).some((n) => n.id === idea)).toBe(true);
  });

  it("收容区:删掉的列里还有卡 → 侧栏冒出那一行;进去按来处分组,挪出去后那一行消失", async () => {
    const col = await invoke("create_board_column", { title: "多看板-临时列", boardId: null });
    const id = await invoke("create_task", { title: HELD });
    await invoke("update_task_status", { id, to: col });
    await invoke("archive_task", { id });
    await invoke("delete_board_column", { id: col });
    await invoke("restore_task", { id }); // 还原 = 回原列;原列已删 ⇒ 进收容区(plan §3a)
    await goNotebook("board");
    await $("#board-nav .bn-holding").waitForExist({ timeout: 8000 });
    // 原看板上不再画那枚已删的列(⛔ 别在原看板上同时留一份)
    await expect($(`.col[data-col="${col}"]`)).not.toExist();
    await browser.execute(() => document.querySelector("#board-nav .bn-holding").click());
    await $(".holding-view").waitForExist({ timeout: 8000 });
    const grp = await browser.execute(() => document.querySelector(".holding-from")?.textContent ?? "");
    expect(grp).toContain("多看板-临时列");
    expect(grp).toContain("列已删除");
    // 收容卡没有完成 / 归档,只有挪出去与删除
    expect(await boardMenuHas(HELD, "完成")).toBe(false);
    await boardAction(HELD, ["挪到看板", "任务"]);
    await browser.waitUntil(async () => (await taskByTitle(HELD))?.status === "todo", { timeout: 8000 });
    await browser.waitUntil(async () => !(await $("#board-nav .bn-holding").isExisting()), { timeout: 8000 });
  });

  it("归档册:不止一块看板有成就时,顶上按看板筛;每条带来自哪块看板的小签", async () => {
    const flow = await invoke("create_board", { title: FLOW, columns: ["待处理", "进行中", "已完成"], doneIndex: 2 });
    const fb = (await boards()).find((b) => b.id === flow);
    const a = await invoke("create_task", { title: SEAL_A, boardId: flow });
    await invoke("update_task_status", { id: a, to: fb.done });
    await invoke("seal_task", { id: a });
    const b = await invoke("create_task", { title: SEAL_B });
    await invoke("update_task_status", { id: b, to: "done" });
    await invoke("seal_task", { id: b });
    await goNotebook("board");
    await browser.execute(() => document.querySelector("#seal-toggle").click());
    await $(".sealed-view").waitForExist({ timeout: 8000 });
    const pills = await browser.execute(() => [...document.querySelectorAll(".sealed-boards .tf-pill")].map((p) => p.textContent.trim()));
    expect(pills).toEqual(expect.arrayContaining(["全部看板", "任务", FLOW]));
    const tagOf = (title) =>
      browser.execute((t) => [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t))?.querySelector(".board-tag")?.textContent ?? null, title);
    expect(await tagOf(SEAL_A)).toBe(FLOW);
    expect(await tagOf(SEAL_B)).toBe("任务");
    await browser.execute((name) => [...document.querySelectorAll(".sealed-boards .tf-pill")].find((p) => p.textContent.trim() === name).click(), FLOW);
    await browser.waitUntil(
      async () => {
        const shown = await browser.execute(() => [...document.querySelectorAll(".sealed-view .tcard")].map((c) => c.textContent));
        return shown.some((s) => s.includes(SEAL_A)) && !shown.some((s) => s.includes(SEAL_B));
      },
      { timeout: 8000 },
    );
  });

  it("列管理:换落点 / 取消完成列走 core;清空后在列管理里删掉看板 → 侧栏收回", async () => {
    const flow = (await boards()).find((b) => b.title === FLOW);
    const flowCols = (await cols()).filter((c) => c.board_id === flow.id && !c.deleted);
    // 换落点到「进行中」
    await invoke("set_board_landing", { id: flow.id, column: flowCols[1].id });
    expect((await boards()).find((b) => b.id === flow.id).landing).toBe(flowCols[1].id);
    // 完成列不能同时当落点(core 拒)
    const r = await tryInvoke("set_board_landing", { id: flow.id, column: flow.done });
    expect(r.ok).toBe(false);

    // 用侧栏切到它,在列管理里删
    await goNotebook("board");
    await browser.execute((name) => [...document.querySelectorAll("#board-nav .bn-item")].find((b) => b.querySelector(".bn-name").textContent.trim() === name).click(), FLOW);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1")?.textContent)) === FLOW, { timeout: 8000 });
    await boardMore("manage-cols");
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    const clickBtn = (label) =>
      browser.execute((l) => [...document.querySelectorAll(".bcm-board .bcm-btn")].find((x) => x.textContent.trim() === l)?.click(), label);
    await clickBtn("删除这块看板");
    await browser.pause(350); // 执行钮出现后 300ms 内不接(§3.2 防连击)
    await clickBtn("删除");
    await browser.waitUntil(async () => (await boards()).find((b) => b.id === flow.id).deleted === true, { timeout: 8000 });
    // 还剩「任务」与书单两块 ⇒ 侧栏仍展开;看板视图回到默认那块
    await browser.waitUntil(async () => !(await navItems()).includes(FLOW), { timeout: 8000 });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1")?.textContent)) === "任务", { timeout: 8000 });
  });
});
