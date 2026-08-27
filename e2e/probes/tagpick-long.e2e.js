import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "../specs/support.js";

// 按需探针:看板卡上的**标签选择器**用的是与优先级同一个 `.choice` 类,而那边的字是
// 用户自己起的标签名、可以任意长。510 决定不给 `.choice` 加 nowrap 时,顺手量一眼
// 那半今天是什么样(⚠ 这条与 510 的改动无关,量的是**既有**行为)。
describe("探针 · 看板标签选择器遇到长标签名", () => {
  const T = "长标签探针-缴水电费";
  const LONG = "这是一个特别长的标签名字用来看它会不会把卡片撑破";

  before(async () => {
    await invoke("create_topic", { title: LONG }).catch(() => {});
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
  });

  it("窄窗打开标签选择器:候选 pill 排了几行 + 卡片有没有被撑破", async () => {
    await browser.setWindowSize(950, 700);
    await browser.pause(250);
    await boardAction(T, "标签");
    await $(`.tcard*=${T}`).$(".topic-choices").waitForExist({ timeout: 5000 });
    await browser.pause(200);

    const r = await browser.execute((title, long) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
      const box = card.querySelector(".topic-choices");
      const body = card.closest(".col-body") ?? card.parentElement;
      const lines = (elm) => {
        const rg = document.createRange();
        rg.selectNodeContents(elm);
        return rg.getClientRects().length;
      };
      const n1 = (v) => Math.round(v * 10) / 10;
      const hit = [...box.querySelectorAll(".choice")].find((b) => b.textContent.includes(long.slice(0, 8)));
      const cs = hit ? getComputedStyle(hit) : null;
      return {
        cardW: card.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        longPill: hit ? { w: n1(hit.getBoundingClientRect().width), h: n1(hit.getBoundingClientRect().height), lines: lines(hit), whiteSpace: cs.whiteSpace, overflow: cs.overflow, textOverflow: cs.textOverflow, maxWidth: cs.maxWidth } : null,
      };
    }, T, LONG);
    console.log("TAGPICK " + JSON.stringify(r, null, 1));
    await browser.saveScreenshot("e2e/probes/out-tagpick-950.png");
    await browser.setWindowSize(1100, 700);
    expect(r.longPill).not.toBe(null);
  });
});
