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
