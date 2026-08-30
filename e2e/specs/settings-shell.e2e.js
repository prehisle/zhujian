import { $, expect, browser } from "@wdio/globals";
import { goNotebook } from "./support.js";

// 设置面板的「壳」三格(2026-08-31 用户当面点名的那轮):
// ①切分类面板几何一格不动(此前 `max-height` 只是上限、实高随内容 ⇒ 切类跳变);
// ②标题行有看得见的 ✕(此前只能 Esc / 点面板外 —— 没有任何可见入口);
// ③「说明」折叠默认收起、点开全文(「收纳不删」:backup-plan §9 那几段边界仍逐字在)。
//
// ⚠ 只测壳的形,不碰备份的行为面(那些在 backup.e2e.js / zz-backup-auto.e2e.js)。

async function openPanel() {
  await goNotebook("inbox");
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
}

async function closeByOverlay() {
  await browser.execute(() => {
    document.querySelector(".settings-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await browser.waitUntil(async () => !(await $(".settings-overlay").isExisting()), {
    timeout: 5000,
    timeoutMsg: "点面板外该关掉设置面板",
  });
}

describe("设置面板壳:定高 · ✕ · 说明折叠", () => {
  it("切三类,面板几何一格不动(高度差全由右栏滚动吸收)", async () => {
    await openPanel();
    const rectNow = () =>
      browser.execute(() => {
        const r = document.querySelector(".settings-panel").getBoundingClientRect();
        return { top: r.top, height: r.height, width: r.width };
      });
    const base = await rectNow();
    // 定高必须真的比内容说了算:高度是钉死的数(560 或矮窗上的 100vh-48),不是 0。
    expect(base.height).toBeGreaterThan(300);
    for (const cat of ["hotkeys", "backup", "general"]) {
      await browser.execute((c) => document.querySelector(`.settings-cat[data-cat="${c}"]`).click(), cat);
      expect(await rectNow()).toEqual(base);
    }
    await closeByOverlay();
  });

  it("标题行的 ✕ 看得见、点了真关面板", async () => {
    await openPanel();
    const close = await $(".settings-close");
    expect(await close.isDisplayed()).toBe(true);
    await browser.execute(() => document.querySelector(".settings-close").click());
    await browser.waitUntil(async () => !(await $(".settings-overlay").isExisting()), {
      timeout: 5000,
      timeoutMsg: "点 ✕ 该关掉设置面板",
    });
  });

  it("「说明」折叠默认收起;点开后 §9 那几段边界逐字还在", async () => {
    await openPanel();
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="backup"]').click());
    const notes = await $(".settings-pane[data-cat='backup'] .settings-notes");
    await notes.waitForExist({ timeout: 5000 });
    // 默认收起:段落在 DOM(收纳不删)但不可见。
    const para = await $(".settings-pane[data-cat='backup'] .settings-notes .settings-sub");
    expect(await para.isExisting()).toBe(true);
    expect(await para.isDisplayed()).toBe(false);
    // 点 summary 摊开:三段全可见,且 §9 那两段边界的关键词逐字在(⛔ 这三格是「收纳
    // 不删」的网 —— 谁哪天把段落真删了,这里先红)。
    await browser.execute(() =>
      document.querySelector(".settings-pane[data-cat='backup'] .settings-notes summary").click(),
    );
    await browser.waitUntil(async () => para.isDisplayed(), { timeout: 3000 });
    const texts = await browser.execute(() =>
      [...document.querySelectorAll(".settings-pane[data-cat='backup'] .settings-notes .settings-sub")].map((n) =>
        n.textContent.trim(),
      ),
    );
    expect(texts.some((x) => x.includes("保管权交到你手上"))).toBe(true);
    expect(texts.some((x) => x.includes("同步身份与账户密钥"))).toBe(true);
    expect(texts.some((x) => x.includes("卸载朱简不会删掉备份钥"))).toBe(true);
    await closeByOverlay();
  });
});
