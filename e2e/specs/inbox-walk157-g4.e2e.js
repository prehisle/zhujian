import { $, expect } from "@wdio/globals";
import { browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// 157 G4(W1 走查用户拍的规矩)桌面随记页那几条:
//  P13 长随记在时间轴上也折(8 行,同看板 704);短的不长钮;展开 / 收起来回翻;
//  P8 已在随记页再点侧栏「随记」= 回顶(不重挂,滚动位真归零);
//  P10 筛着一枚标签时卡上那枚胶囊照常显示(218 起被藏,用户读成「被摘了」)。

const LONG = "E2EW4-长随记\n" + Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
const SHORT = "E2EW4-短随记";
const TAG = "E2EW4-标签";

describe("157 G4 · 随记页的折叠 / 回顶 / 筛选时胶囊", () => {
  let tagId;
  const card = (marker) => $(`.note*=${marker}`);

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    tagId = await invoke("create_topic", { title: TAG });
    for (let i = 0; i < 12; i++) await invoke("capture_note", { content: `E2EW4-垫底 ${i}` });
    const s = await invoke("capture_note", { content: SHORT });
    await invoke("file_note_to_topic", { id: s, topicId: tagId, newTitle: null });
    await invoke("capture_note", { content: LONG });
    await goNotebook("inbox");
    await (await card("E2EW4-长随记")).waitForExist({ timeout: 8000 });
  });

  after(async () => {
    await browser.execute(() => {
      const p = [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((x) => x.textContent.startsWith("所有"));
      p?.click();
    });
    await clearInbox();
    await invoke("delete_topic", { id: tagId });
  });

  it("P13:长随记夹住并长「展开」钮,短的不长;点开 / 再收起来回翻", async () => {
    const st = () =>
      browser.execute(() => {
        const n = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes("E2EW4-长随记"));
        const p = n.querySelector(".note-text");
        const b = n.querySelector(".fold-toggle");
        return { clamped: p.classList.contains("clamped"), h: p.clientHeight, sh: p.scrollHeight, btn: b?.getAttribute("aria-expanded") ?? null };
      });
    const s0 = await st();
    expect(s0.clamped).toBe(true);
    expect(s0.btn).toBe("false");
    expect(s0.sh).toBeGreaterThan(s0.h + 11);
    const shortBtn = await browser.execute(
      () => !![...document.querySelectorAll(".note")].find((x) => x.textContent.includes("E2EW4-短随记"))?.querySelector(".fold-toggle"),
    );
    expect(shortBtn).toBe(false);
    await browser.execute(() =>
      [...document.querySelectorAll(".note")].find((x) => x.textContent.includes("E2EW4-长随记")).querySelector(".fold-toggle").click(),
    );
    const s1 = await st();
    expect(s1.clamped).toBe(false);
    expect(s1.btn).toBe("true");
    await browser.execute(() =>
      [...document.querySelectorAll(".note")].find((x) => x.textContent.includes("E2EW4-长随记")).querySelector(".fold-toggle").click(),
    );
    expect((await st()).clamped).toBe(true);
  });

  it("P8:已在随记页再点侧栏「随记」= 回顶,不重挂", async () => {
    const top = await browser.execute(() => {
      const l = document.querySelector("#list");
      l.scrollTop = 400;
      window.__w4mark = document.querySelector(".v-inbox"); // 重挂会换掉这个节点
      return l.scrollTop;
    });
    expect(top).toBeGreaterThan(0);
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
    await browser.waitUntil(() => browser.execute(() => document.querySelector("#list").scrollTop === 0), {
      timeout: 3000,
      timeoutMsg: "再点「随记」没回顶",
    });
    expect(await browser.execute(() => window.__w4mark === document.querySelector(".v-inbox"))).toBe(true);
  });

  it("P10:筛着一枚标签时,卡上那枚胶囊照常显示", async () => {
    await browser.execute((t) => {
      [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((x) => x.textContent.includes(t)).click();
    }, TAG);
    await browser.waitUntil(async () => !(await (await card("E2EW4-长随记")).isExisting()), { timeout: 5000 });
    const tags = await browser.execute(
      () => [...[...document.querySelectorAll(".note")].find((x) => x.textContent.includes("E2EW4-短随记")).querySelectorAll(".tag")].map((x) => x.textContent),
    );
    expect(tags.some((x) => x.includes("E2EW4-标签"))).toBe(true);
  });

  it("P7:编辑态有「＋加图」钮", async () => {
    await browser.execute(() => {
      const p = [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((x) => x.textContent.startsWith("所有"));
      p?.click();
    });
    await (await card("E2EW4-长随记")).waitForExist({ timeout: 8000 }); // 筛选清掉、整列重画完
    await inboxAction("E2EW4-短随记", "编辑");
    // 编辑态正文在框的 value 里,`.note*=` 按文字认不出这张卡 ⇒ 编辑态是全局单例,直接按类找。
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
    expect(await $(".v-inbox .img-editor .add-img").getText()).toBe("＋加图");
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000, reverse: true });
  });

  it("P3:转待办回执带「去看看」,点了落到看板那张卡", async () => {
    await inboxAction("E2EW4-短随记", "转待办");
    const go = await $(".undo-toast .undo-go");
    await go.waitForExist({ timeout: 5000 });
    // ⚠ 读 textContent 不读 getText:回执条有入场淡入,全量里读早了 getText 给空串(只见过一次,单跑不出)。
    expect(await browser.execute(() => document.querySelector(".undo-toast .undo-go")?.textContent)).toBe("去看看");
    await go.waitForDisplayed({ timeout: 3000 });
    await go.click();
    await $(".v-board").waitForExist({ timeout: 5000 });
    await $(".tcard*=E2EW4-短随记").waitForExist({ timeout: 8000 });
    const t = (await invoke("list_tasks")).find((x) => x.title === "E2EW4-短随记");
    if (t) {
      await invoke("archive_task", { id: t.id });
      await invoke("purge_task", { id: t.id });
    }
    await goNotebook("inbox");
  });

  it("P5:改过的卡标「改过」、⋯ 菜单有「历史」,点开一版是「这一版 → 现在」的比对;没改过的两样都没有", async () => {
    const id = await invoke("capture_note", { content: "E2EW4-改前" });
    await invoke("edit_note", { id, content: "E2EW4-改后" });
    await invoke("capture_note", { content: "E2EW4-没改" });
    await goNotebook("inbox");
    const c = await card("E2EW4-改后");
    await c.waitForExist({ timeout: 8000 });
    expect(await c.$(".edited-mark").isExisting()).toBe(true);
    expect(await (await card("E2EW4-没改")).$(".edited-mark").isExisting()).toBe(false);
    await inboxAction("E2EW4-改后", "历史");
    const entry = await c.$(".hist-host .hist-entry");
    await entry.waitForExist({ timeout: 5000 });
    await entry.click();
    await c.$(".hist-host .diff").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => !!document.querySelector(".hist-host .diff .diff-del") && !!document.querySelector(".hist-host .diff .diff-ins"))).toBe(true);

    // codex 851 M1:在界面上第一次改完,不用别的刷新,「改过」就该出来。
    await inboxAction("E2EW4-没改", "编辑");
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
    await browser.execute(() => {
      const a = document.querySelector(".v-inbox .edit-area");
      a.value = "E2EW4-没改 现在改了";
      a.dispatchEvent(new Event("input", { bubbles: true }));
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await browser.waitUntil(async () => await (await card("E2EW4-没改 现在改了")).$(".edited-mark").isExisting(), {
      timeout: 8000,
      timeoutMsg: "界面上改完卡上没标「改过」",
    });
  });
});
