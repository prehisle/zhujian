import { $, expect } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

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
    await goNotebook("inbox");
    const stats = await $("#idea-stats");
    await stats.waitForExist({ timeout: 5000 });
    expect(/^本周捕获 \d+ · 转待办 \d+%$/.test(await stats.getText())).toBe(true);
  });
});
