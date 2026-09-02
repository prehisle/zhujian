// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)。
//
// 干什么:给 backlog 用户面 64 那条「连红五趟、实得 `thre`」取一次**决定性**读数。
//
// 猜想(读 wdio 9.28 源码得来,不是感觉):`browser.keys("字串")` 的动作序列是
// **先把每个字符全部 keyDown、pause(10)、再全部 keyUp**(`node_modules/webdriverio/build/index.js`
// 那支 `async function keys(value)`)—— 也就是说打 `three` 时,两记 `e` 是**同一枚键按下两次
// 中间不松手**。W3C 把「已按下的键再 keyDown」定义成 repeat,而两个引擎对它的处置可以不同。
// ⇒ 若猜想成立,丢的**不是「最后一记」而是「重复那一记」**,那就解释了 566 补的 End 为什么催不出来
// (那个字符压根没生成),也解释了为什么全仓只有这一句红:
// `three` 是整套 e2e 里**唯一**带相邻重复字母的字串。
//
// 怎么判:①裸 textarea(与产品代码零关系)②产品的 compose 输入框,各打一串带 / 不带相邻重复的
// 字串,读实得;③再用「逐字符 down+up」(= 真键盘的模型)打同一个 `three` 看它对不对。
// 三格合起来能同时答「是不是引擎/驱动的事」与「该怎么修」。
//
// 怎么跑(Linux;先另起 `npm run dev`):
//   YS_E2E_FAST=1 npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/webkit-keys-dup.e2e.js
import { browser, $ } from "@wdio/globals";
import { goNotebook, clearInbox } from "../specs/support.js";

// 带 / 不带相邻重复,以及重复出现在头 / 中 / 尾三种位置。
const CASES = ["thre", "three", "aa", "aba", "book", "aab", "abb", "aaa"];
const TAG = "[探针64]";

async function mkBare() {
  await browser.execute(() => {
    let ta = document.getElementById("__probe64");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.id = "__probe64";
      ta.style.position = "fixed";
      ta.style.left = "0";
      ta.style.top = "0";
      ta.style.zIndex = "99999";
      document.body.appendChild(ta);
    }
    ta.value = "";
    ta.focus();
  });
}

async function bareRead() {
  return browser.execute(() => document.getElementById("__probe64").value);
}

describe("用户面 64 · browser.keys 丢的是「最后一记」还是「重复那一记」", () => {
  after(async () => {
    await browser.execute(() => document.getElementById("__probe64")?.remove());
    await clearInbox();
  });

  it("裸 textarea:八个字串各打一遍,读实得(与产品代码零关系)", async () => {
    await goNotebook("inbox");
    await mkBare();
    const bad = [];
    for (const want of CASES) {
      await mkBare();
      await browser.keys(want);
      await browser.pause(400); // 给慢引擎时间;⛔ 这一格不是「等到期望值」,要的就是实得
      const got = await bareRead();
      const ok = got === want;
      if (!ok) bad.push(`${want}→${got}`);
      console.log(`${TAG} 裸 keys(${JSON.stringify(want)}) ⇒ ${JSON.stringify(got)} ${ok ? "✅" : "❌"}`);
    }
    console.log(`${TAG} 裸 textarea 小结:${bad.length ? "掉字的有 " + bad.join(" / ") : "八个字串全对"}`);
  });

  it("逐字符 down+up(= 真键盘的模型)打同一个 three", async () => {
    await mkBare();
    for (const ch of "three") await browser.keys(ch);
    await browser.pause(400);
    const got = await bareRead();
    console.log(`${TAG} 逐字符 three ⇒ ${JSON.stringify(got)} ${got === "three" ? "✅" : "❌"}`);
  });


  it("单条动作链 down+up 逐字符(省往返的那一形)", async () => {
    for (const want of ["three", "aaa", "book", "E2E-一二", "aabb"]) {
      await mkBare();
      const a = browser.action("key");
      for (const ch of want) a.down(ch).up(ch);
      await a.perform();
      await browser.pause(400);
      const got = await bareRead();
      console.log(`${TAG} 动作链 ${JSON.stringify(want)} ⇒ ${JSON.stringify(got)} ${got === want ? "✅" : "❌"}`);
    }
  });


  it("对照:setValue(走 Element Send Keys 那条端点,不是 Actions)会不会也吞", async () => {
    await goNotebook("inbox");
    const input = await $(".v-inbox .compose-input");
    await input.waitForDisplayed({ timeout: 8000 });
    for (const want of ["three", "aaa", "book"]) {
      await input.setValue(want);
      await browser.pause(300);
      const got = await input.getValue();
      console.log(`${TAG} setValue ${JSON.stringify(want)} ⇒ ${JSON.stringify(got)} ${got === want ? "✅" : "❌"}`);
    }
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
  });

  it("产品的 compose 输入框:同一组字串再走一遍", async () => {
    await goNotebook("inbox");
    const input = await $(".v-inbox .compose-input");
    await input.waitForDisplayed({ timeout: 8000 });
    for (const want of ["three", "book", "aa"]) {
      await input.click();
      await browser.keys(["Control", "a"]);
      await browser.keys("Backspace");
      await browser.keys(want);
      await browser.pause(400);
      const got = await input.getValue();
      console.log(`${TAG} compose keys(${JSON.stringify(want)}) ⇒ ${JSON.stringify(got)} ${got === want ? "✅" : "❌"}`);
    }
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
  });
});
