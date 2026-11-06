import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction, boardMenuHas, clearInbox } from "./support.js";

// 158 G3(W2「做事」规矩 Q1–Q13,用户全取 ★)桌面那一半 + A7 两端对齐。能自动化的那几条:
//  Q1 挪完 / 新建完卡落在视野外 → 回执带「去看看」,点了滚过去并闪一下;落点在视野里不挂;
//  Q2 ⋯「移到 ▸」子菜单列出所有列(本列除外)、已完成卡一步「打回「待办」」;
//  Q3 取消归档回执带「去看看」,点了回看板定位那张;
//  Q4 已完成卡不显示逾期,只留灰色截止日期;Q13 逾期一天说「逾期 1 天」;
//  Q6 勾「不再提示」那一下回执写明在设置哪里改回,设置里那枚开关改得回来;
//  Q10 每日提醒正文带「3 天内」;Q12 放大框底下那行小字;
//  Q13 排序时按住卡拖说一句、管理列说明说人话、归档页页头 / 返回钮 / 卡上日期;
//  A7 撤回为随记的「撤销」转回待办并把截止 / 优先级原样设回。
// ⚠ 引擎面(真拖、窄窗图标的肉眼样子、点通知)e2e 证不了,走 desktop-verify。

const P = "E2E158G3-";
const taskByTitle = async (title) => (await invoke("list_tasks")).find((t) => t.title === title) ?? null;
const toastText = () => browser.execute(() => document.querySelector(".undo-toast .undo-text")?.textContent ?? null);
const toastButtons = () =>
  browser.execute(() => [...document.querySelectorAll(".undo-toast button")].map((b) => b.textContent));
const clickToast = (label) =>
  browser.execute((l) => [...document.querySelectorAll(".undo-toast button")].find((b) => b.textContent === l).click(), label);
const cardEl = (title) => `[...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(${JSON.stringify(title)}))`;

async function waitToast(want) {
  let seen = null;
  await browser.waitUntil(async () => (seen = await toastText()) === want, {
    timeout: 6000,
    timeoutMsg: `没等到回执「${want}」,实得 ${JSON.stringify(seen)}`,
  });
}

/** 卡在不在它那一列的可视区里(与产品里的 cardOffscreen 同一判据,独立再写一份,别 import 被测物)。 */
const inView = (title) =>
  browser.execute((sel) => {
    const c = eval(sel);
    const body = c?.closest(".col-body");
    if (!c || !body) return "absent";
    const r = c.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return r.top >= b.top - 2 && r.bottom <= b.bottom + 2;
  }, cardEl(title));

function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function cleanupTitles() {
  for (const t of await invoke("list_tasks")) if (t.title.startsWith(P)) await invoke("archive_task", { id: t.id });
  for (const t of await invoke("list_sealed_tasks")) {
    if (t.title.startsWith(P)) {
      await invoke("unseal_task", { id: t.id });
      await invoke("archive_task", { id: t.id });
    }
  }
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(P)) await invoke("purge_task", { id: t.id });
}

describe("158 G3 · 看板规矩 Q1–Q13(桌面)+ A7 对齐", () => {
  before(async () => {
    await cleanupTitles();
    await browser.execute(() => localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed"));
    await browser.execute(() => localStorage.setItem("zhujian.board-sort", "manual"));
    await goNotebook("board");
  });

  after(async () => {
    await browser.execute(() => {
      document.querySelector(".undo-toast")?.remove();
      localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed");
      localStorage.setItem("zhujian.board-sort", "manual");
    });
    await cleanupTitles();
  });

  it("Q2:⋯「移到 ▸」列出所有列(本列除外),一步挪到不相邻的列;已完成卡有「打回「待办」」", async () => {
    const T = `${P}Q2-远挪`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    // 子菜单里有哪几列:点开「移到」读一遍,再点「‹ 移到」回主菜单
    const sub = await browser.execute((sel) => {
      if (document.querySelector(".hk-menu")) document.body.click();
      eval(sel).querySelector(".hk-btn").click();
      const parent = [...document.querySelectorAll(".hk-menu .hk-item")].find((i) => i.querySelector(".hk-label").textContent === "移到");
      if (!parent) return null;
      const arrow = parent.querySelector(".hk-sub")?.textContent;
      parent.click();
      const labels = [...document.querySelectorAll(".hk-menu .hk-item:not(.hk-back) .hk-label")].map((s) => s.textContent);
      const back = document.querySelector(".hk-menu .hk-back .hk-label")?.textContent;
      document.querySelector(".hk-menu .hk-back").click();
      const again = !![...document.querySelectorAll(".hk-menu .hk-label")].find((s) => s.textContent === "移到");
      document.body.click();
      return { arrow, labels, back, again };
    }, cardEl(T));
    const live = (await invoke("list_board_columns")).filter((c) => c.kind === "task" && !c.deleted);
    expect(sub).not.toBe(null);
    expect(sub.arrow).toBe("▸");
    expect(sub.back).toBe("‹ 移到");
    expect(sub.again).toBe(true);
    expect(sub.labels).not.toContain("待办"); // 本列除外
    expect(sub.labels).toContain("已完成");
    expect(sub.labels.length).toBe(live.length - 1);
    // 菜单不再摊着「移到「进行中」」那种只到邻列的行(`]` `[` 仍是单键,不占行)
    expect(await boardMenuHas(T, "移到「进行中」")).toBe(false);

    // 待办 → 已完成(隔两列)一步到
    await boardAction(T, ["移到", "已完成"]);
    await browser.waitUntil(async () => (await taskByTitle(T)).status === "done", { timeout: 6000, timeoutMsg: "子菜单没把卡挪到已完成" });
    await waitToast("已移到「已完成」");
    // 已完成卡:直达「打回「待办」」
    await $(".col.done").$(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "打回「待办」");
    await browser.waitUntil(async () => (await taskByTitle(T)).status === "todo", { timeout: 6000, timeoutMsg: "打回待办没生效" });
    await waitToast("已移到「待办」");
    expect((await toastButtons())[0]).toBe("撤销");
  });

  it("Q1:挪进长列落在列尾(视野外)→ 回执带「去看看」,点了滚进视野并闪一下", async () => {
    // 待办列塞满一屏多:新卡排列首,于是「挪过去的卡落列尾」必在视野外
    for (let i = 0; i < 24; i++) await invoke("create_task", { title: `${P}Q1-垫${String(i).padStart(2, "0")}` });
    const T = `${P}Q1-被挪`;
    const id = await invoke("create_task", { title: T });
    await invoke("update_task_status", { id, to: "doing" });
    await goNotebook("board");
    await $(".col.doing").$(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await browser.execute(() => {
      document.querySelector('.col[data-col="todo"] .col-body').scrollTop = 0;
    });
    await boardAction(T, ["移到", "待办"]);
    await browser.waitUntil(async () => (await taskByTitle(T)).status === "todo", { timeout: 6000 });
    await waitToast("已移到「待办」");
    expect(await toastButtons()).toEqual(["撤销", "去看看"]);
    expect(await inView(T)).toBe(false); // 落点不变:列尾、视野外
    await clickToast("去看看");
    await browser.waitUntil(async () => (await inView(T)) === true, { timeout: 4000, timeoutMsg: "点「去看看」卡没滚进视野" });
    expect(await browser.execute((sel) => eval(sel).classList.contains("just-born"), cardEl(T))).toBe(true);

    // 落点在视野里时不挂「去看看」:把它挪回进行中(短列)
    await boardAction(T, ["移到", "进行中"]);
    await waitToast("已移到「进行中」");
    expect(await toastButtons()).toEqual(["撤销"]);
  });

  it("Q1:列滚到底时新建 → 新卡排列首(视野外)、列不回顶,回执「已记下」带「去看看」", async () => {
    await goNotebook("board");
    await $(`.tcard*=${P}Q1-垫00`).waitForExist({ timeout: 8000 });
    const bottom = await browser.execute(() => {
      const b = document.querySelector('.col[data-col="todo"] .col-body');
      b.scrollTop = b.scrollHeight;
      return b.scrollTop;
    });
    expect(bottom).toBeGreaterThan(0);
    const T = `${P}Q1-滚到底时建的`;
    await $("#add-task").click();
    await $("#compose-input").waitForDisplayed({ timeout: 5000 });
    await browser.execute((v) => {
      const i = document.querySelector("#compose-input");
      i.value = v;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#compose-add").click();
    }, T);
    await waitToast("已记下");
    expect(await toastButtons()).toEqual(["去看看"]);
    const st = await browser.execute(() => document.querySelector('.col[data-col="todo"] .col-body').scrollTop);
    expect(st).toBeGreaterThan(0); // 列没被拉回顶
    expect(await inView(T)).toBe(false);
    await clickToast("去看看");
    await browser.waitUntil(async () => (await inView(T)) === true, { timeout: 4000, timeoutMsg: "点「去看看」新卡没滚进视野" });
    await browser.execute(() => document.querySelector("#compose-close").click());
  });

  it("Q4 + Q13:已完成卡只留灰色截止日期、不说逾期;没做完的逾期一天说「逾期 1 天」", async () => {
    const D = `${P}Q4-做完了`;
    const L = `${P}Q4-逾期一天`;
    const did = await invoke("create_task", { title: D });
    await invoke("set_task_due", { id: did, dueOn: ymd(-3) });
    await invoke("update_task_status", { id: did, to: "done" });
    const lid = await invoke("create_task", { title: L });
    await invoke("set_task_due", { id: lid, dueOn: ymd(-1) });
    await goNotebook("board");
    await $(".col.done").$(`.tcard*=${D}`).waitForExist({ timeout: 8000 });
    const chip = (title) =>
      browser.execute((sel) => {
        const c = eval(sel).querySelector(".chip.due");
        return { text: c.textContent, cls: [...c.classList].filter((x) => ["done", "overdue", "today", "future"].includes(x)) };
      }, cardEl(title));
    const [, m, d] = ymd(-3).split("-").map(Number);
    expect(await chip(D)).toEqual({ text: `截止 ${m}月${d}日`, cls: ["done"] });
    expect(await chip(L)).toEqual({ text: "逾期 1 天", cls: ["overdue"] });
  });

  it("Q3:取消归档回执带「去看看」,点了回看板定位到那张", async () => {
    const T = `${P}Q3-取消归档`;
    const id = await invoke("create_task", { title: T });
    await invoke("update_task_status", { id, to: "done" });
    await invoke("seal_task", { id });
    await goNotebook("board");
    await $("#seal-toggle").click();
    await $(".sealed-view").$(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "取消归档");
    await waitToast("已取消归档,回到「已完成」");
    await clickToast("去看看");
    await $(".col.done").$(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await browser.waitUntil(() => browser.execute((sel) => eval(sel)?.classList.contains("just-located"), cardEl(T)), {
      timeout: 5000,
      timeoutMsg: "回看板后那张卡没被定位高亮",
    });
    expect(await browser.execute(() => document.querySelector(".sealed-view"))).toBe(null);
  });

  it("Q13:归档页页头写「归档」、返回钮不挂数字、卡上写完成日期", async () => {
    const T = `${P}Q13-归档页`;
    const id = await invoke("create_task", { title: T });
    await invoke("update_task_status", { id, to: "done" });
    await invoke("seal_task", { id });
    await goNotebook("board");
    expect(await $(".v-board header h1").getText()).toBe("任务看板");
    await $("#seal-toggle").click();
    await $(".sealed-view").$(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    const s = await browser.execute((sel) => ({
      h1: document.querySelector(".v-board header h1").textContent,
      backText: document.querySelector("#seal-toggle").innerText.replace(/\s+/g, " ").trim(),
      countShown: getComputedStyle(document.querySelector("#seal-n")).display !== "none",
      date: eval(sel).querySelector(".done-at")?.textContent,
    }), cardEl(T));
    expect(s.h1).toBe("归档");
    expect(s.countShown).toBe(false);
    expect(s.backText).not.toMatch(/\d/);
    expect(s.date).toMatch(/^完成于 今天 \d{2}:\d{2}$/); // 165 / W5 Q14:写到时刻(今天「今天 15:18」)
    await $("#seal-toggle").click();
    await browser.waitUntil(async () => (await $(".v-board header h1").getText()) === "任务看板", { timeout: 5000 });
  });

  it("Q6:勾「不再提示」删的那一下,回执写明在设置哪里改回;设置里「删任务前确认」开回来就又问", async () => {
    const A = `${P}Q6-甲`;
    const B = `${P}Q6-乙`;
    await invoke("create_task", { title: B });
    await invoke("create_task", { title: A });
    await goNotebook("board");
    await $(`.tcard*=${A}`).waitForExist({ timeout: 8000 });
    await boardAction(A, "删除");
    await browser.execute((sel) => {
      const card = eval(sel);
      card.querySelector(".dont-ask input[type=checkbox]").checked = true;
      card.querySelector(".act.primary").click();
    }, cardEl(A));
    await waitToast("已移入回收站。以后删任务不再问,要改回:设置 → 通用 →「删任务前确认」");
    // 设置 → 通用:那枚开关此刻在「关」
    await browser.execute(() => document.getElementById("settings-entry").click());
    await $("#delete-confirm-off").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector("#delete-confirm-off").classList.contains("on"))).toBe(true);
    await browser.execute(() => document.querySelector("#delete-confirm-on").click());
    expect(await browser.execute(() => localStorage.getItem("ysNotebook.taskArchiveConfirmDismissed"))).toBe(null);
    await browser.execute(() => {
      document.querySelector(".settings-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    // 再删一张:又问了
    await boardAction(B, "删除");
    await browser.waitUntil(() => browser.execute((sel) => !!eval(sel)?.querySelector(".confirm-q"), cardEl(B)), {
      timeout: 5000,
      timeoutMsg: "开关拨回「开」后删任务没再问",
    });
    await browser.keys(["Escape"]);
  });

  it("Q10:每日提醒正文与看板汇总钮同一句(带「3 天内」);只在有逾期 / 今天时才响", async () => {
    const L = `${P}Q10-逾期`;
    const S = `${P}Q10-后天`;
    const lid = await invoke("create_task", { title: L });
    await invoke("set_task_due", { id: lid, dueOn: ymd(-2) });
    const sid = await invoke("create_task", { title: S });
    await invoke("set_task_due", { id: sid, dueOn: ymd(2) });
    await goNotebook("board");
    await $("#due-soon").waitForDisplayed({ timeout: 8000 });
    const btnLabel = await browser.execute(() => document.querySelector("#due-soon-lbl").textContent);
    expect(btnLabel).toMatch(/ · 3 天内 \d+$/);
    const body = await browser.execute(
      () =>
        new Promise((resolve) => {
          localStorage.removeItem("zhujian.due-remind.last");
          document.addEventListener("zhujian:due-remind-done", (e) => resolve(e.detail.body), { once: true });
          document.dispatchEvent(new CustomEvent("zhujian:due-remind-check", { detail: { now: "23:59" } }));
        }),
    );
    expect(body).toBe(btnLabel); // 单空间:不带空间名前缀,逐字同钮
  });

  it("Q12:放大编辑框底下一行「Ctrl+Enter 保存 · Esc 不要了」", async () => {
    const T = `${P}Q12-放大`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "编辑");
    await $(".tcard .edit-zoom").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".tcard .edit-zoom").click());
    await $(".ze-panel").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".ze-panel .ze-hint")?.textContent)).toBe("Ctrl+Enter 保存 · Esc 不要了");
    await browser.keys(["Escape"]);
    await $(".ze-panel").waitForExist({ timeout: 5000, reverse: true });
  });

  it("Q13:排序「最新在前」时按住卡一拖 → 指针边上说「排序时不能拖」", async () => {
    const T = `${P}Q13-排序拖`;
    await invoke("create_task", { title: T });
    await browser.execute(() => localStorage.setItem("zhujian.board-sort", "newest"));
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    const said = await browser.execute((sel) => {
      document.querySelectorAll(".copy-toast").forEach((n) => n.remove());
      const c = eval(sel);
      const r = c.querySelector(".ttitle").getBoundingClientRect();
      const x = r.left + 10;
      const y = r.top + 5;
      c.querySelector(".ttitle").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x + 30, clientY: y + 20 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x + 30, clientY: y + 20 }));
      return [...document.querySelectorAll(".copy-toast")].map((n) => n.textContent);
    }, cardEl(T));
    expect(said).toEqual(["按创建时间排序时不能拖 —— 把「顺序」切回「手动」就能拖"]);
    // 手动档下同一手势不说话(那时卡可拖)
    await browser.execute(() => localStorage.setItem("zhujian.board-sort", "manual"));
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    const quiet = await browser.execute((sel) => {
      document.querySelectorAll(".copy-toast").forEach((n) => n.remove());
      const t = eval(sel).querySelector(".ttitle");
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 5 }));
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 40, clientY: r.top + 25 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return document.querySelectorAll(".copy-toast").length;
    }, cardEl(T));
    expect(quiet).toBe(0);
  });

  it("Q13:管理列面板的说明说人话(不再写「挂着产品语义」)", async () => {
    await goNotebook("board");
    await $("#manage-cols").waitForDisplayed({ timeout: 8000 });
    await $("#manage-cols").click();
    await $(".bcm-panel .bcm-hint").waitForExist({ timeout: 8000 });
    const hint = await browser.execute(() => document.querySelector(".bcm-panel .bcm-hint").textContent);
    expect(hint).not.toContain("产品语义");
    expect(hint).toContain("新任务落下的那一列");
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("A7:撤回为随记的「撤销」→ 转回待办,截止与优先级原样设回", async () => {
    await clearInbox();
    const T = `${P}A7-撤回再撤销`;
    const id = await invoke("create_task", { title: T });
    await invoke("set_task_due", { id, dueOn: "2026-12-01" });
    await invoke("set_task_priority", { id, priority: 3 });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "撤回为随记");
    await browser.execute((sel) => eval(sel).querySelector(".act.primary").click(), cardEl(T));
    await waitToast("已撤回为随记");
    await browser.waitUntil(async () => (await taskByTitle(T)) === null, { timeout: 6000 });
    await clickToast("撤销");
    await browser.waitUntil(async () => (await taskByTitle(T))?.priority === 3, {
      timeout: 8000,
      timeoutMsg: "撤销没把卡转回待办 / 没设回优先级",
    });
    const back = await taskByTitle(T);
    expect({ status: back.status, due: back.due_on, pri: back.priority }).toEqual({ status: "todo", due: "2026-12-01", pri: 3 });
    await clearInbox();
  });
});
