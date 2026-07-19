import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// ㊵ 盲区补测:视图级全局单键(registerViewKeys)+ 悬停卡片按 `/` 弹 ⋯ 菜单 + 侧栏拖窗修复。
// 这些都是 ㊵ 纯前端轮次新增、当时未跑 e2e 的部分。键义单一真相源见 src/hotkey-menu.ts:
//   灵感 N=聚焦记灵感框;看板 N=新建任务 / R=回收站切换;标签 N=新建标签 / M=合并标签。

// Dispatch a real single-character keydown. The view keys listen on `document`; with no
// selector we dispatch there so e.target === document (not an INPUT/TEXTAREA) — exactly like
// a real keypress with no field focused. Pass a selector to dispatch ON a field instead, to
// exercise the "focus in a field → let the keystroke through" guard.
function pressKey(key, selector) {
  return browser.execute(
    (k, sel) => {
      const target = sel ? document.querySelector(sel) : document;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    },
    key,
    selector ?? null,
  );
}

describe("㊵ 视图级单键 / `/` 开菜单 / 侧栏拖窗", () => {
  it("灵感:按 N → 聚焦顶部「记下灵感」输入框", async () => {
    await goNotebook("inbox");
    // The compose bar is always present on the 想法 tab regardless of how many ideas exist,
    // so this test needs no clean inbox. Nothing is focused on it to begin with.
    const before = await browser.execute(() => (document.activeElement?.className ?? ""));
    expect(before).not.toContain("compose-input");
    await pressKey("n");
    const after = await browser.execute(() => (document.activeElement?.className ?? ""));
    expect(after).toContain("compose-input");
  });

  it("看板:按 N → 打开「新建任务」compose(初始是收起的)", async () => {
    await goNotebook("board");
    const hiddenBefore = await browser.execute(() => document.querySelector("#compose").hidden);
    expect(hiddenBefore).toBe(true);
    await pressKey("n");
    const openAfter = await browser.execute(() => !document.querySelector("#compose").hidden);
    expect(openAfter).toBe(true);
  });

  it("看板:按 R → 切到回收站,再按 R → 切回看板", async () => {
    await goNotebook("board");
    expect(await $("#trash-toggle").getText()).toContain("回收站");
    await pressKey("r");
    expect(await $("#trash-toggle").getText()).toContain("看板"); // "← 看板 …" while in 回收站
    await pressKey("r");
    expect(await $("#trash-toggle").getText()).toContain("回收站");
  });

  it("看板:焦点在输入框时,单键让位(R 不触发回收站切换)", async () => {
    await goNotebook("board");
    await pressKey("n"); // open compose
    await browser.execute(() => document.querySelector("#compose-input").focus());
    await pressKey("r", "#compose-input"); // e.target is the textarea → guard skips R
    expect(await $("#trash-toggle").getText()).toContain("回收站"); // still board, not toggled
  });

  it("标签:按 N → 展开「新建标签」表单", async () => {
    await goNotebook("topics");
    expect(await browser.execute(() => document.querySelector("#newform").hidden)).toBe(true);
    await pressKey("n");
    expect(await browser.execute(() => !document.querySelector("#newform").hidden)).toBe(true);
  });

  it("标签:按 M → 进入合并态", async () => {
    // Merge mode self-cancels with nothing to merge (topics.ts renderList), so seed a
    // couple of tags first — otherwise M flips merging on then renderList flips it back off.
    await invoke("create_topic", { title: "E2E-合并甲" });
    await invoke("create_topic", { title: "E2E-合并乙" });
    await goNotebook("topics");
    expect(await browser.execute(() => document.querySelector(".v-topics").classList.contains("merging"))).toBe(false);
    await pressKey("m");
    const merging = await browser.execute(() =>
      document.querySelector(".v-topics").classList.contains("merging"),
    );
    expect(merging).toBe(true);
  });

  it("灵感:悬停卡片按 `/` → 弹出该卡的 ⋯ 速查菜单", async () => {
    await invoke("capture_note", { content: "E2E-斜杠-菜单" });
    await goNotebook("inbox"); // mount/refresh so the freshly-captured card renders
    const card = await $(".note*=E2E-斜杠-菜单");
    await card.waitForExist({ timeout: 5000 });
    // Hover sets the shortcut target (activeRow); `/` then pops that card's ⋯ menu.
    await browser.execute(() => {
      const c = [...document.querySelectorAll(".note")].find((n) => n.textContent.includes("E2E-斜杠-菜单"));
      c.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    });
    const menu = await $(".hk-menu");
    await menu.waitForExist({ timeout: 5000 });
    expect(await menu.isExisting()).toBe(true);
  });

  it("灵感:↓/↑ 键盘选卡(↓ 从头进入、↑ 折返,恒只有一张选中)", async () => {
    await invoke("capture_note", { content: "E2E-键选-甲" });
    await invoke("capture_note", { content: "E2E-键选-乙" });
    await goNotebook("inbox");
    await $(".note*=E2E-键选-乙").waitForExist({ timeout: 5000 });
    // 不依赖列表里还有谁:断「选中的是第 1/第 2 张卡」这一结构事实。
    const nth = () =>
      browser.execute(() => {
        const notes = [...document.querySelectorAll(".note")];
        return { at: notes.findIndex((n) => n.classList.contains("is-active")),
                 count: notes.filter((n) => n.classList.contains("is-active")).length };
      });
    await pressKey("ArrowDown");
    expect(await nth()).toEqual({ at: 0, count: 1 });
    await pressKey("ArrowDown");
    expect(await nth()).toEqual({ at: 1, count: 1 });
    await pressKey("ArrowUp");
    expect(await nth()).toEqual({ at: 0, count: 1 });
  });

  it("↑/↓:焦点在输入框时让位(选中不动)", async () => {
    await goNotebook("inbox");
    await pressKey("n"); // 聚焦「记下灵感」框
    await pressKey("ArrowDown", ".compose-input"); // e.target 是 textarea → 让位
    const active = await browser.execute(() => document.querySelectorAll(".note.is-active").length);
    expect(active).toBe(0);
  });

  it("侧栏:整条不再是拖窗区,只有 .brand 行是(修空白单击闪烁/双击最大化)", async () => {
    await goNotebook("inbox");
    const r = await browser.execute(() => ({
      aside: document.querySelector("aside.sidebar").hasAttribute("data-tauri-drag-region"),
      brand: document.querySelector(".sidebar .brand").hasAttribute("data-tauri-drag-region"),
    }));
    expect(r.aside).toBe(false); // the whole sidebar is NOT a drag handle anymore
    expect(r.brand).toBe(true); // only the brand/logo row drags the window
  });
});
