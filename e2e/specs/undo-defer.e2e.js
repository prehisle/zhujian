import { $, $$, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, inboxAction, boardAction } from "./support.js";

// 716 桌面止血三件里能在 e2e 里钉住的两件(第三件「出码页关掉再开码还在」要一个真账户,
// 走 ohos-c4-join 台架 + CDP,见 progress-log 716):
//   ① 撤销回执:单键 / ⋯ 菜单的 删除 / 转待办(随记)、删除 / 移列 / 归档(看板)做完屏上有一条
//      「已…· 撤销」,点「撤销」库里真回去 —— 且移列撤销回到**原位**不是列尾;
//   ② 编辑中不重画:编辑框开着时 sync-changed(远端落地)那一发整轮延后,框与半打的字都在,
//      别的设备新来的卡**不出现**(这是阴性对照 —— 证明的是「延后」而不只是「框没关」);
//      Enter 保存之后那张卡才冒出来。
// 判据一律回库读(list_* / status),DOM 只当触发与可见性的证据。

async function setField(elem, value) {
  await browser.execute(
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    elem,
    value,
  );
}
async function pressEnter(elem) {
  await browser.execute((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, elem);
}
async function clickUndo(expectText) {
  const toast = await $(".undo-toast");
  await toast.waitForExist({ timeout: 8000 });
  expect(await toast.getText()).toContain(expectText);
  await (await toast.$(".undo-btn")).click();
  await toast.waitForExist({ reverse: true, timeout: 3000 });
}
const emitSyncChanged = () =>
  browser.execute(() => window.__TAURI__.event.emit("sync-changed", { space: "main" }));
async function inInbox(id) {
  return (await invoke("list_inbox")).some((n) => n.id === id);
}
async function inArchived(id) {
  return (await invoke("list_archived")).some((n) => n.id === id);
}
async function taskStatus(id) {
  const t = (await invoke("list_tasks")).find((x) => x.id === id);
  return t ? t.status : null;
}
const todoOrder = () =>
  browser.execute(() => [...document.querySelectorAll(".col.todo .tcard")].map((c) => c.dataset.taskId));

describe("716 · 撤销回执(随记)", () => {
  before(async () => {
    await goNotebook("inbox");
  });

  it("删除 → 「已移入回收站 · 撤销」→ 点撤销,卡回列表、库里回到 inbox", async () => {
    const id = await invoke("capture_note", { content: "E2E-撤销-删除甲" });
    await goNotebook("inbox");
    const card = await $(".note*=E2E-撤销-删除甲");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-撤销-删除甲", "删除");
    await card.waitForExist({ reverse: true, timeout: 10000 });
    await browser.waitUntil(async () => inArchived(id), { timeout: 8000, timeoutMsg: "删除后库里应在回收站" });

    await clickUndo("已移入回收站");
    await $(".note*=E2E-撤销-删除甲").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await inInbox(id)) && !(await inArchived(id)), {
      timeout: 8000,
      timeoutMsg: "撤销后库里应回到 inbox、离开回收站",
    });
  });

  it("转待办 → 「已转为待办 · 撤销」→ 点撤销,库里回到 inbox、不再是任务", async () => {
    const id = await invoke("capture_note", { content: "E2E-撤销-转待办乙" });
    await goNotebook("inbox");
    const card = await $(".note*=E2E-撤销-转待办乙");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-撤销-转待办乙", "待办");
    await card.waitForExist({ reverse: true, timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(id)) === "todo", { timeout: 8000, timeoutMsg: "转待办后应在 todo" });

    await clickUndo("已转为待办");
    await $(".note*=E2E-撤销-转待办乙").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await inInbox(id)) && (await taskStatus(id)) === null, {
      timeout: 8000,
      timeoutMsg: "撤销后库里应回到 inbox、不在任务里",
    });
  });

  it("连做两件,屏上至多一条撤销回执(新条顶掉旧条)", async () => {
    await invoke("capture_note", { content: "E2E-撤销-顶掉丙1" });
    await invoke("capture_note", { content: "E2E-撤销-顶掉丙2" });
    await goNotebook("inbox");
    await $(".note*=E2E-撤销-顶掉丙2").waitForExist({ timeout: 10000 });
    await inboxAction("E2E-撤销-顶掉丙1", "删除");
    await $(".undo-toast").waitForExist({ timeout: 8000 });
    await inboxAction("E2E-撤销-顶掉丙2", "删除");
    await browser.waitUntil(async () => (await $$(".undo-toast")).length === 1, {
      timeout: 5000,
      timeoutMsg: "两次删除之后应只剩一条撤销回执",
    });
  });
});

describe("716 · 撤销回执(看板)", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("删除 → 撤销回到待办", async () => {
    const id = await invoke("create_task", { title: "E2E-撤销-看板删丁" });
    await goNotebook("board");
    const card = await $(".tcard*=E2E-撤销-看板删丁");
    await card.waitForExist({ timeout: 10000 });
    await boardAction("E2E-撤销-看板删丁", "删除");
    // 首次删除带行内确认(之后勾了「不再提示」就直删);两种形都认。
    const confirm = await card.$(".acts button.primary");
    if (await confirm.isExisting()) await confirm.click();
    await card.waitForExist({ reverse: true, timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(id)) === null, { timeout: 8000, timeoutMsg: "删除后不该还在活跃任务里" });

    await clickUndo("已移入回收站");
    await $(".col.todo").$(".tcard*=E2E-撤销-看板删丁").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(id)) === "todo", { timeout: 8000, timeoutMsg: "撤销后应回到 todo" });
  });

  it("移到「进行中」→ 撤销回到待办**原位**(不是列尾)", async () => {
    const ids = [];
    for (const n of ["戊1", "戊2", "戊3"]) ids.push(await invoke("create_task", { title: `E2E-撤销-移列${n}` }));
    await goNotebook("board");
    await $(".tcard*=E2E-撤销-移列戊3").waitForExist({ timeout: 10000 });
    const before = await todoOrder();
    // 挑一张不在列首也不在列尾的:撤销若只是「回源列列尾」,这张会挪位。
    const midIdx = before.findIndex((x) => ids.includes(x) && x !== before[before.length - 1] && x !== before[0]);
    expect(midIdx).toBeGreaterThan(0);
    const mid = before[midIdx];
    const title = (await invoke("list_tasks")).find((x) => x.id === mid).title;

    await boardAction(title, "移到「进行中」");
    await $(".col.doing").$(`.tcard*=${title}`).waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(mid)) === "doing", { timeout: 8000, timeoutMsg: "移列后应在 doing" });

    await clickUndo("已移到「进行中」");
    await $(".col.todo").$(`.tcard*=${title}`).waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(mid)) === "todo", { timeout: 8000, timeoutMsg: "撤销后应回到 todo" });
    await browser.waitUntil(async () => (await todoOrder()).join(" ") === before.join(" "), {
      timeout: 8000,
      timeoutMsg: `撤销后待办列序应逐位还原:期望 ${before.join(" ")},实得 ${(await todoOrder()).join(" ")}`,
    });
  });

  it("归档 → 撤销回到已完成", async () => {
    const id = await invoke("create_task", { title: "E2E-撤销-归档己" });
    await invoke("update_task_status", { id, to: "done" });
    await goNotebook("board");
    const card = await $(".col.done").$(".tcard*=E2E-撤销-归档己");
    await card.waitForExist({ timeout: 10000 });
    await boardAction("E2E-撤销-归档己", "归档");
    await card.waitForExist({ reverse: true, timeout: 10000 });
    await browser.waitUntil(async () => (await invoke("list_sealed_tasks")).some((x) => x.id === id), {
      timeout: 8000,
      timeoutMsg: "归档后应在归档册",
    });

    await clickUndo("已归档");
    await $(".col.done").$(".tcard*=E2E-撤销-归档己").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await taskStatus(id)) === "done", { timeout: 8000, timeoutMsg: "撤销后应回到 done" });
  });
});

describe("716 · 编辑中不重画(远端落地延后到编辑收场)", () => {
  it("随记:编辑框开着时 sync-changed 不关框、新卡不出现;Enter 保存后新卡才冒出来", async () => {
    const id = await invoke("capture_note", { content: "E2E-延后-随记庚原文" });
    await goNotebook("inbox");
    const card = await $(".note*=E2E-延后-随记庚原文");
    await card.waitForExist({ timeout: 10000 });
    await inboxAction("E2E-延后-随记庚原文", "编辑");
    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });
    await setField(area, "E2E-延后-随记庚改后");

    // 「别的设备」写了一条 + 远端落地事件(sync.ts 去抖 300ms 后走视图的 refresh(true))。
    await invoke("capture_note", { content: "E2E-延后-随记辛远端" });
    await emitSyncChanged();
    await browser.pause(900);
    expect(await area.isExisting()).toBe(true);
    expect(await area.getValue()).toBe("E2E-延后-随记庚改后");
    expect(await $(".note*=E2E-延后-随记辛远端").isExisting()).toBe(false); // 阴性对照:真延后了

    await pressEnter(area);
    await $(".note*=E2E-延后-随记辛远端").waitForExist({ timeout: 10000 }); // 收场那一发补刷
    await browser.waitUntil(
      async () => (await invoke("list_inbox")).find((n) => n.id === id)?.content === "E2E-延后-随记庚改后",
      { timeout: 8000, timeoutMsg: "Enter 后库里应是改后的正文" },
    );
  });

  it("看板:编辑框开着时 sync-changed 不关框、新卡不出现;Enter 保存后新卡才冒出来", async () => {
    const id = await invoke("create_task", { title: "E2E-延后-看板壬原题" });
    await goNotebook("board");
    const card = await $(".tcard*=E2E-延后-看板壬原题");
    await card.waitForExist({ timeout: 10000 });
    await boardAction("E2E-延后-看板壬原题", "编辑");
    const input = await $(".tcard .edit-input");
    await input.waitForExist({ timeout: 5000 });
    await setField(input, "E2E-延后-看板壬改后");

    await invoke("create_task", { title: "E2E-延后-看板癸远端" });
    await emitSyncChanged();
    await browser.pause(900);
    expect(await input.isExisting()).toBe(true);
    expect(await input.getValue()).toBe("E2E-延后-看板壬改后");
    expect(await $(".tcard*=E2E-延后-看板癸远端").isExisting()).toBe(false); // 阴性对照

    await pressEnter(input);
    await $(".tcard*=E2E-延后-看板癸远端").waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await invoke("list_tasks")).find((x) => x.id === id)?.title === "E2E-延后-看板壬改后", {
      timeout: 8000,
      timeoutMsg: "Enter 后库里应是改后的标题",
    });
  });
});
