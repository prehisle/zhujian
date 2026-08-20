// 按需探针(默认套件扫不到,要 `--spec` 点名)—— 455 立,backlog「测试与工装 19」的取证。
//
// 量的是一件事:**`browser.url()` 一回来,notebook 的壳启动完了没有?**
//   notebook 的启动序是 `src/notebook.ts` 末尾那条异步 IIFE(`await initCurrentSpace()` →
//   `await initSync()` → `navigate(上次视图)`),而侧栏那四枚按钮是 **notebook.html 里的
//   静态 HTML** ⇒ 「按钮存在」这条判据证明不了「点得动」。早于那句 navigate 点下去,自己
//   那次 navigate 会被它当场覆盖(`navigate` 头一句就是 `viewRoot.replaceChildren()`)。
//
// 跑法(Windows,先另起终端 `npm run dev`):
//   YS_E2E_FAST=1 npx wdio run e2e/wdio.conf.js --specFileRetries=0 --spec e2e/probes/boot-race.e2e.js
//
// ⚠ 它**不是回归网**:三格读数会随机器负载变。它回答的是「那个窗口今天有多宽」,
//   以及「照 455 之前那样点会怎样」。
import { browser, $ } from "@wdio/globals";
import { BASE, goNotebook } from "../specs/support.js";

const ROUNDS = 8;

describe("探针 · notebook 壳启动序与侧栏点击的竞态", () => {
  it("量:url() 回来那一刻壳booted 没有 / 还差多少毫秒", async () => {
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
      await browser.url(`${BASE}/notebook.html`);
      // 页内自己盯:第一条驱动命令跑起来的那一刻有没有视图;没有就 1ms 轮询到有为止。
      const r = await browser.executeAsync((done) => {
        const t0 = performance.now();
        if (document.querySelector("#view > .view")) {
          done({ bootedOnArrival: true, extraMs: 0 });
          return;
        }
        const iv = setInterval(() => {
          if (document.querySelector("#view > .view")) {
            clearInterval(iv);
            done({ bootedOnArrival: false, extraMs: Math.round(performance.now() - t0) });
          }
        }, 1);
      });
      rows.push(r);
    }
    console.log("[探针] 每趟:", JSON.stringify(rows));
    const late = rows.filter((r) => !r.bootedOnArrival);
    console.log(
      `[探针] url() 回来时**还没**启动完的趟数:${late.length}/${ROUNDS};` +
        `还差(ms):${JSON.stringify(late.map((r) => r.extraMs))}`,
    );
  });

  it("量:goNotebook 的其余前奏(show/focus + setWindowSize + waitForExist)要多少毫秒", async () => {
    const costs = [];
    for (let i = 0; i < ROUNDS; i++) {
      await browser.url(`${BASE}/notebook.html`);
      const t0 = Date.now();
      await browser.execute(async () => {
        const w = window.__TAURI__.window.getCurrentWindow();
        await w.show();
        await w.setFocus();
      });
      await browser.setWindowSize(1000, 700);
      await $('.sidebar nav button[data-view="topics"]').waitForExist({ timeout: 5000 });
      costs.push(Date.now() - t0);
    }
    console.log(`[探针] 前奏耗时(ms):${JSON.stringify(costs)}`);
  });

  // ⛔ **两条看着最像的推断,这只探针当场证伪,别再走一遍**(455):
  //   ①「点早了 = 监听还没挂上、这一下是空的」—— **不成立**:`browser.url()` 是等到 `load`
  //     才回来的,而 `<script type="module">` 在 `DOMContentLoaded` 之前就执行完了 ⇒ 监听一定在。
  //     字据 = 下面「点完立刻」那一列 8/8 全是 `v-topics`。
  //   ②「启动序末尾那句 `navigate(上次视图)` 会把我这次点出来的视图覆盖掉」—— **也不成立**:
  //     `navigate()` 里 `localStorage.setItem(LAST_VIEW_KEY, name)` 写在**前**,而启动序那句
  //     `getItem` 在它自己那几个 await **之后**才读 ⇒ 它读到的正是我刚写的那个名字,于是
  //     它落回**同一个视图**。字据 = 把启动序人为拖慢 800ms(`notebook.ts` 里一发 KNIFE),
  //     「一秒半之后」那一列照样 8/8 是 `v-topics`。
  // ⇒ 真正被量到的后果不是「换了视图」,是**同一个视图被挂了两次**(我点一次、启动序再挂
  //   一次)。第二次挂会把第一次那棵 DOM 整个换掉 ⇒ 紧跟在 `goNotebook` 后面取到的元素句柄
  //   会变陈旧,第一次挂发出的异步刷新则落在一个死 mount 上。455 那道「先等壳挂上任意视图」
  //   的判据消灭的就是这一格。
  it("量:照 455 之前那样点(只等按钮存在)—— 视图被挂了几次", async () => {
    await browser.url(`${BASE}/notebook.html`);
    await browser.execute(() => localStorage.setItem("zhujian.last-view", "board"));

    const seen = [];
    for (let i = 0; i < ROUNDS; i++) {
      await browser.url(`${BASE}/notebook.html`);
      const trigger = '.sidebar nav button[data-view="topics"]';
      await $(trigger).waitForExist({ timeout: 5000 });
      await browser.execute((sel) => document.querySelector(sel).click(), trigger);
      // 在这一刻这棵视图上盖个戳:1.5 秒后戳还在 = 只挂过一次;戳没了 = 被重挂了。
      const right = await browser.execute(() => {
        const v = document.querySelector("#view > .view");
        if (v) v.dataset.probeMark = "1";
        return v?.className ?? "(空)";
      });
      await browser.pause(1500); // 让启动序那句 navigate 有充分时间落地
      const later = await browser.execute(() => {
        const v = document.querySelector("#view > .view");
        return { cls: v?.className ?? "(空)", 戳还在: v?.dataset.probeMark === "1" };
      });
      seen.push({ 点完立刻: right, 一秒半之后: later.cls, 还是同一棵: later.戳还在 });
    }
    console.log("[探针] 只等按钮存在就点:", JSON.stringify(seen, null, 1));
    console.log(
      `[探针] 换了视图的趟数:${seen.filter((s) => !s.一秒半之后.includes("v-topics")).length}/${ROUNDS};` +
        `**被重挂**的趟数:${seen.filter((s) => !s.还是同一棵).length}/${ROUNDS}`,
    );
  });

  it("量:455 的判据(先等壳挂上任意视图再点)—— 视图被挂了几次", async () => {
    await browser.url(`${BASE}/notebook.html`);
    await browser.execute(() => localStorage.setItem("zhujian.last-view", "board"));

    const seen = [];
    for (let i = 0; i < ROUNDS; i++) {
      await goNotebook("topics"); // 455 之后的那一只
      const cls = await browser.execute(() => {
        const v = document.querySelector("#view > .view");
        if (v) v.dataset.probeMark = "1";
        return v?.className ?? "(空)";
      });
      await browser.pause(1500);
      const later = await browser.execute(() => {
        const v = document.querySelector("#view > .view");
        return { cls: v?.className ?? "(空)", 戳还在: v?.dataset.probeMark === "1" };
      });
      seen.push({ 点完立刻: cls, 一秒半之后: later.cls, 还是同一棵: later.戳还在 });
    }
    console.log("[探针] 先等壳启动完再点:", JSON.stringify(seen, null, 1));
    console.log(`[探针] **被重挂**的趟数:${seen.filter((s) => !s.还是同一棵).length}/${ROUNDS}`);
  });
});
