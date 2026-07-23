import { $, $$, expect } from "@wdio/globals";
import { browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// ㊳ 两个交互需求的 e2e 覆盖(㊷ 已补 viewkeys,这里补剩下两个):
//   ③ 双击卡片 = 编辑(和单键 E 同一入口,回收站卡冻结不响应);
//   ④ 灵感视图按天时间轴(.timeline > .tl-group[.tl-date] 分组,后端已按时间倒序)。

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

describe("灵感 · 双击卡片 = 编辑", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("双击想法卡 → 打开编辑器 → 保存改后库里 content 更新、原文进历史", async () => {
    const id = await invoke("capture_note", { content: "E2E-双击-原文" });

    await goNotebook("inbox");
    const card = await $(`.note*=E2E-双击-原文`);
    await card.waitForExist({ timeout: 10000 });

    // 双击卡片正文(.note-text)= 默认操作「编辑」,无需先开 ⋯ 菜单。
    const text = await card.$(".note-text");
    await text.doubleClick();

    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });
    expect(await card.getAttribute("class")).toContain("editing");

    await setField(area, "E2E-双击-改后");
    // Enter 保存(取消/保存按钮已移除,Esc/Enter 代之)。
    await browser.execute((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, area);

    await expect(card.$(".note-text")).toHaveText(expect.stringContaining("E2E-双击-改后"));

    const inbox = await invoke("list_inbox");
    expect(inbox.find((n) => n.id === id).content).toBe("E2E-双击-改后");
    const revs = await invoke("list_note_history", { id });
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("E2E-双击-原文");
  });
});

describe("灵感 · 编辑态显示标签(只读)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("已打标签的灵感进编辑态 → 标签 chip 只读展示,Esc 退出回读态", async () => {
    const id = await invoke("capture_note", { content: "E2E-编辑态标签-灵感" });
    await invoke("file_note_to_topic", { id, newTitle: "E2E-编辑态标签" });

    await goNotebook("inbox");
    const card = await $(`.note*=E2E-编辑态标签-灵感`);
    await card.waitForExist({ timeout: 10000 });
    await card.$(".note-text").doubleClick();
    await card.$(".edit-area").waitForExist({ timeout: 5000 });

    // 编辑态标签是独立的只读展示(tagView,无 ✕/＋,增删走 ⋯ 菜单 L);读态 chip 则带 ✕ 可删,
    // 故读态文本落在 .tag-label 子里(.tag 本身还含 ✕)。编辑态 tagView 仍是纯 .tag 文本。
    const tag = await card.$(".tags .tag");
    await tag.waitForExist({ timeout: 5000 });
    await expect(tag).toHaveText("E2E-编辑态标签");

    // Esc 取消(监听在文档级)→ 回读态,标签 chip 仍在。
    await browser.execute((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }, await card.$(".edit-area"));
    await card.$(".note-text").waitForExist({ timeout: 5000 });
    await expect(card.$(".tags .tag-label")).toHaveText("E2E-编辑态标签");
  });
});

describe("灵感 · 按天时间轴分组", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("当天捕获的多条想法 → 归到同一个「今天」日期标头下", async () => {
    await invoke("capture_note", { content: "E2E-时间轴-甲" });
    await invoke("capture_note", { content: "E2E-时间轴-乙" });

    await goNotebook("inbox");
    await $(".timeline").waitForExist({ timeout: 10000 });

    // 同一天 → 恰好一个 .tl-group,标头文案「今天」。
    const groups = await $$(".timeline .tl-group");
    expect(groups).toHaveLength(1);
    await expect($(".timeline .tl-group .tl-date")).toHaveText("今天");

    // 两条想法都挂在这个分组下(读整组文本,避开 $$ 在本版本的迭代怪癖)。
    const groupText = await $(".timeline .tl-group").getText();
    expect(groupText).toContain("E2E-时间轴-甲");
    expect(groupText).toContain("E2E-时间轴-乙");
    const notes = await $(".timeline .tl-group").$$(".note");
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });
});
