import { browser, $ } from "@wdio/globals";
import { BASE, goNotebook, goShow } from "./support.js";

// 57 起主窗记着上次那一页(localStorage "zhujian.last-view")。165 / W5 Q8 ★① 起分两种:
//   · **冷启动**(进程起来第一次载入 = 导航类型 "navigate")一律回随记 —— 指南「打开朱简……光标在『随手记一笔』框里」,
//     手机冷启动本来就回随记;此前回到上次停的那页(长文 / 标签那几页没有记一笔框);
//   · **页面重载**(改语言重载、截图台写 last-view 再 reload = 导航类型 "reload")回到重载前那一页。
// `browser.url` 是一次新的导航(= 冷启动那一形);`location.reload()` 是重载。两条都不点侧栏按钮,真走落地那段判据。
describe("冷启动落在哪一页", () => {
  it("冷启动(新导航)一律回随记,哪怕上次停在看板", async () => {
    await goNotebook("board");
    await browser.url(`${BASE}/notebook.html`);
    await $(".v-inbox").waitForExist({ timeout: 5000 });
  });

  it("页面重载回到重载前那一页", async () => {
    await goNotebook("board");
    await browser.execute(() => setTimeout(() => location.reload(), 0));
    await browser.waitUntil(async () => browser.execute(() => performance.getEntriesByType("navigation")[0]?.type === "reload"), {
      timeout: 10000,
      timeoutMsg: "页面没重载",
    });
    await $(".v-board").waitForExist({ timeout: 5000 });
  });

  it("存的视图名非法时重载也落回随记", async () => {
    await goShow("/notebook.html");
    await browser.execute(() => localStorage.setItem("zhujian.last-view", "nope"));
    await browser.execute(() => setTimeout(() => location.reload(), 0));
    await browser.waitUntil(async () => browser.execute(() => performance.getEntriesByType("navigation")[0]?.type === "reload"), {
      timeout: 10000,
      timeoutMsg: "页面没重载",
    });
    await $(".v-inbox").waitForExist({ timeout: 5000 });
  });
});

// 501:侧栏折叠(Ctrl+B / 左上角 «)此前把 nav 整个 display:none —— 折叠等于「关掉侧栏」,
// 四个视图一个也点不到。改成只藏文字、留图标。这一例钉的就是「折叠 ≠ 关掉」。
describe("侧栏折叠成图标条", () => {
  const state = () =>
    browser.execute(() => {
      const btn = document.querySelector('.sidebar nav button[data-view="board"]');
      const box = btn.getBoundingClientRect();
      const lbl = btn.querySelector(".nav-lbl");
      const ico = btn.querySelector(".nav-ico svg");
      return {
        collapsed: document.body.classList.contains("sb-collapsed"),
        navClickable: box.width > 0 && box.height >= 24, // §2.3 热区底线
        lblShown: lbl.getClientRects().length > 0,
        icoShown: ico.getClientRects().length > 0,
        title: btn.title,
      };
    });
  const toggle = () => browser.execute(() => document.querySelector("#sidebar-toggle").click());

  it("折叠后 nav 仍在、仍可点,只是文字换成了图标", async () => {
    await goNotebook("board");
    const open = await state();
    expect(open.collapsed).toBe(false);
    expect(open).toMatchObject({ navClickable: true, lblShown: true, icoShown: true });
    expect(open.title).toBe("看板 (Ctrl+2)"); // 图标态下靠它说明「这是什么」;898 B3 起带上切视图的键

    await toggle();
    await browser.pause(300); // 宽度有 0.18s 过渡
    const shut = await state();
    expect(shut.collapsed).toBe(true);
    expect(shut.navClickable).toBe(true); // ⛔ 这一格是本例的全部意义
    expect(shut.lblShown).toBe(false);
    expect(shut.icoShown).toBe(true);

    await toggle(); // 复位,别把折叠态泄漏给后面的 spec
    await browser.pause(300);
    expect((await state()).collapsed).toBe(false);
  });
});
