import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction } from "./support.js";

// 60(0018 born_stage):灵感流转统计——头部一行「本周捕获 N · 转待办 X%」。
// 纯派生数、只算不存:捕获一条涨分母,转待办涨分子;直接建的任务不进灵感统计。
// 命令层核对精确数字,UI 只断那行淡字的格式(数值真相在命令层)。
describe("灵感 · 流转统计(born_stage)", () => {
  const ALL = { weekStart: "0000-01-01T00:00:00Z" }; // 累计口径(周界线推到远古)

  it("捕获涨分母、转待办涨分子;直接建的任务不掺和;UI 统计行现身", async () => {
    await goNotebook("inbox");
    const before = await invoke("idea_stats", ALL); // 同一轮里别的 spec 可能已留数据,做相对断言

    // 捕获:生而为灵感 → 分母 +1,分子不动。
    const id = await invoke("capture_note", { content: "E2E-统计-灵感甲" });
    const captured = await invoke("idea_stats", ALL);
    expect(captured.born_inbox).toBe(before.born_inbox + 1);
    expect(captured.converted).toBe(before.converted);

    // 看板直接建的任务:生而为任务,不进灵感统计(分母分子都不动)。
    await invoke("create_task", { title: "E2E-统计-直建任务" });
    const afterTask = await invoke("idea_stats", ALL);
    expect(afterTask.born_inbox).toBe(captured.born_inbox);
    expect(afterTask.converted).toBe(captured.converted);

    // 转待办:翻 stage,出生态不动 → 分子 +1。
    await invoke("promote_note_to_task", { id, title: "E2E-统计-灵感甲" });
    const promoted = await invoke("idea_stats", ALL);
    expect(promoted.converted).toBe(before.converted + 1);
    expect(promoted.born_inbox).toBe(before.born_inbox + 1);

    // 周界线生效:weekStart 在未来 → 本周 0,累计口径不变。
    const future = await invoke("idea_stats", { weekStart: "9999-01-01T00:00:00Z" });
    expect(future.captured_week).toBe(0);
    expect(future.born_inbox).toBe(promoted.born_inbox);

    // UI:灵感视图头部的淡字统计行(分母>0 时带比例)。
    // ⚠ 走 `inboxShow("ideas")` 而不是裸 `goNotebook`:626 起这行统计在**回收站那半是收起来的**
    // (它说的是想法那半),而 `active` 跨视图存活 ⇒ 上一只 spec 停在回收站的话这里会读到空串。
    await inboxShow("ideas");
    const stats = await $("#idea-stats");
    await stats.waitForExist({ timeout: 5000 });
    // W4 Q11 / WD-38:「本周捕获 · 转待办」换白话(用户拍定的词表)。
    // 904 I:本周记的里有已转成卡片的(上面刚转了一条)⇒ 后面多半句「另有 M 条已转成卡片」。
    expect(await stats.getText()).toMatch(/^本周记了 \d+ 条,另有 \d+ 条已转成卡片$/);
  });

  // 904 I(用户拍板):页头「本周记了 N 条,另有 M 条已转成卡片」。N = 此刻还在随记页上、本周记的(A42);
  // M = 本周记的里现在已是卡片的(core 的 converted_week)。转一条 ⇒ N −1、M +1;撤回 ⇒ 都回去。M = 0 时只说前半句。
  // 库是整轮累计的 ⇒ M 的起点取命令层的真数,做相对断言;句子逐字断。
  // 阴性对照:① inbox.ts 里把 cardedWeek 恒取 0 → 红在「转了之后页头没出新句」;② core 那个 FILTER 的两半各拔一次,
  //   由 repo.rs 的单测 idea_stats_converted_week_… 管(这里量不出「上周记的」)。
  it("转一条本周记的随记:页头出「另有 M 条已转成卡片」;撤销后回到转之前那一句", async () => {
    const NOTE = "E2E-统计-本周转卡片";
    const weekStart = await browser.execute(() => {
      const now = new Date();
      const dow = (now.getDay() + 6) % 7; // 周一 = 0(同 tasktime.ts::startOfWeek)
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).toISOString();
    });
    const sentence = (n, m) => (m > 0 ? `本周记了 ${n} 条,另有 ${m} 条已转成卡片` : `本周记了 ${n} 条`);
    const header = () => browser.execute(() => document.getElementById("idea-stats").textContent);
    const waitHeader = (want, msg) =>
      browser.waitUntil(async () => (await header()) === want, { timeout: 8000, timeoutMsg: msg }).catch(async (e) => {
        throw new Error(`${msg}\n  要:${want}\n  现场:${await header()}\n  ${e.message}`);
      });

    const id = await invoke("capture_note", { content: NOTE });
    await inboxShow("ideas");
    const m0 = (await invoke("idea_stats", { weekStart })).converted_week;
    await browser.waitUntil(async () => /^本周记了 \d+ 条/.test(await header()), { timeout: 8000, timeoutMsg: "页头没有「本周记了 N 条」" });
    const n0 = Number(/^本周记了 (\d+) 条/.exec(await header())[1]);
    expect(n0).toBeGreaterThan(0);
    expect(await header()).toBe(sentence(n0, m0));

    await inboxAction(NOTE, "转待办");
    await waitHeader(sentence(n0 - 1, m0 + 1), "转了之后页头没出新句");
    expect((await invoke("idea_stats", { weekStart })).converted_week).toBe(m0 + 1);

    await browser.execute(() => document.querySelector(".undo-toast .undo-btn:not(.undo-go)").click());
    await waitHeader(sentence(n0, m0), "撤销之后页头没回到转之前那一句");
    expect((await invoke("idea_stats", { weekStart })).converted_week).toBe(m0);

    await invoke("archive_note", { id });
    await invoke("purge_note", { id });
  });
});
