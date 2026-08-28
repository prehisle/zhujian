import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "../specs/support.js";

// 按需探针:看板卡上的**标签选择器**用的是与优先级同一个 `.choice` 类,而那边的字是
// 用户自己起的标签名、可以任意长。510 决定不给 `.choice` 加 nowrap 时,顺手量一眼
// 那半今天是什么样(⚠ 这条与 510 的改动无关,量的是**既有**行为)。
//
// ⛔⛔ **别拿 `Range.getClientRects().length` 当行数**(510 那版这么写的,本探针实测证伪):
// 修好之后这枚 pill 只有一行(高 46→22),而 rect 个数照旧是 **2** —— 两个 rect 的 `y` 与高
// **完全相同**(实测 `y=330.8 / h=16`,宽分别 288 与 96),它们落在**同一行**上。
// ⇒ 行数的诚实判据是**不同的 y 有几个**,不是 rect 有几个。原始 rect 与 `scrollW/clientW`
//   一并印出来当字据,别把这条结论删成一句话。
// ⚠ 同一把尺还用在 `e2e/probes/pri-fold.e2e.js` 与 **`e2e/specs/task-time.e2e.js`(真断言)**上
//   —— 那几枚钮的字短、不触发分段,今天恰好都是 1 个 rect ⇒ 那两处**今天是绿的**,
//   但那是运气不是判据。⛔ 别顺手去改它们(单轮单件事),账已记在 backlog。
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
      // 两个读数都留着:`lines` 是诚实的(数不同的 y),`rectCount` 是 510 那把错尺,
      // 摆在一起才看得见「同一行两个 rect」这件事。
      const rectsOf = (elm) => {
        const rg = document.createRange();
        rg.selectNodeContents(elm);
        return [...rg.getClientRects()];
      };
      const lines = (elm) => new Set(rectsOf(elm).map((r) => Math.round(r.y))).size;
      const n1 = (v) => Math.round(v * 10) / 10;
      const hit = [...box.querySelectorAll(".choice")].find((b) => b.textContent.includes(long.slice(0, 8)));
      const cs = hit ? getComputedStyle(hit) : null;
      return {
        cardW: card.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        longPill: hit ? { w: n1(hit.getBoundingClientRect().width), h: n1(hit.getBoundingClientRect().height), lines: lines(hit), rectCount: rectsOf(hit).length, whiteSpace: cs.whiteSpace, overflow: cs.overflow, textOverflow: cs.textOverflow, maxWidth: cs.maxWidth } : null,
        rects: hit ? rectsOf(hit).map((r) => ({ w: n1(r.width), h: n1(r.height), x: n1(r.x), y: n1(r.y) })) : null,
        clip: hit ? { scrollW: hit.scrollWidth, clientW: hit.clientWidth } : null,
      };
    }, T, LONG);
    console.log("TAGPICK " + JSON.stringify(r, null, 1));
    await browser.saveScreenshot("e2e/probes/out-tagpick-950.png");
    await browser.setWindowSize(1100, 700);
    expect(r.longPill).not.toBe(null);
  });
});
