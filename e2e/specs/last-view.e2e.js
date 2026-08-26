import { browser, $ } from "@wdio/globals";
import { BASE, goNotebook, goShow } from "./support.js";

// 57: the notebook lands on the view it last showed (localStorage
// "zhujian.last-view"), surviving a page (re)load — the same read path a real
// app restart takes. An unknown stored name must land on inbox, not crash the
// shell. Reloads below go through browser.url WITHOUT clicking any sidebar
// button, so the assertion really exercises the landing logic.
describe("上次视图恢复", () => {
  it("重新载入后落在上次的视图", async () => {
    await goNotebook("board");
    await browser.url(`${BASE}/notebook.html`);
    await $(".v-board").waitForExist({ timeout: 5000 });
  });

  it("存的视图名非法时落回灵感", async () => {
    await goShow("/notebook.html");
    await browser.execute(() => localStorage.setItem("zhujian.last-view", "nope"));
    await browser.url(`${BASE}/notebook.html`);
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
    expect(open.title).toBe("任务"); // 图标态下靠它说明「这是什么」

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
