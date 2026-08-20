// 按需探针(默认套件扫不到,要 `--spec` 点名)—— 456 立,backlog「测试与工装 6」的阴性对照。
//
// 证的是一件事:**`openCompose()` 的「看一眼」与「点下去」是不是同一刻。**
//   把 compose 开出来的不止调用方一个 —— `board.ts` 的 `restoreImagesOnce(…)` 回调
//   (`if (… && compose.hidden) setComposeOpen(true)`)是 IndexedDB **异步**回来才跑的。
//   而 `#add-task` 是**开关**:它若落在「读完」与「点下去」之间,那一点就把已经开着的
//   compose **关上**,现场 `element ("#compose-input") still not displayed after 5000ms`
//   ——396 立、414 判陈账销号、455 在 Linux CI 上又红一次。
//
// ⭐ **这只探针自带阴性对照,不必去改 support.js 再跑一遍**:同一个「插进来的人」、同一个
//   时刻,分别喂给**旧形**(读、点分两次往返)与**新形**(收进一次 `browser.execute`)——
//   旧形收场是**关着的**、新形两种先后都是**开着的**。⇒ 一红两绿在同一份文件里,
//   照 memory `flaky-test-three-shapes`「把窗口人为放大做一红一绿对照」,⛔ 别靠堆轮数复现。
//
// ⚠ 边界说清楚(两条,别读多了):
//   ①那个「插进来的人」是**页内定时器**,不是真的 IndexedDB 回填 —— 但它做的事逐字就是回填
//     那个回调做的事(`compose 关着才开`),差别只在**时刻由我说了算**。真回填那条路的阳性
//     对照另有一套、且是真机制:板子桶里种一张暂存图跑 `board.e2e.js`(396 §二:8 failing /
//     删掉 15 passing;456 也照这个形跑过一趟)。
//   ②⛔ **它不是「谁把 openCompose 改回旧形就会红」的那道网**,别当它是。下面后两只喂给真
//     `openCompose` 的那个事件落在它**之前 / 之后**,旧形在这两种先后下同样是绿的 —— 要让它红,
//     那个事件必须落在**一次真 WebDriver 往返的中间**,而那一刻页内观测不到、也没法按住。
//     ⇒ 守着「读与点是同一刻」的今天只有 `support.js` 那段注释 + 这只探针给出的机制字据;
//     ⛔ 别在这里加一条读源码数 `browser.execute` 个数的「结构锚」冒充它
//     (换成 `getProperty("hidden")` 一样绕过去 = 一道半瞎的闸看起来却像有人守着)。
//
// 跑法(Windows,先另起终端 `npm run dev`;Linux 同,套 `xvfb-run -a`):
//   YS_E2E_FAST=1 npx wdio run e2e/wdio.conf.js --specFileRetries=0 --spec e2e/probes/compose-open-race.e2e.js
import { browser, $ } from "@wdio/globals";
import { goNotebook, openCompose } from "../specs/support.js";

// 人为放大的窗口:旧形里「读完」到「点下去」之间那一段。真实值是一次 WebDriver 往返
// (本机个位数毫秒),放大到 400ms 才好把「插进来的人」精确塞进去。
const WINDOW_MS = 400;
// 「插进来的人」动手的时刻,落在窗口正中。
const INTERLEAVE_MS = 200;

/** 复位:把 compose 关回去(此刻没有别人在动它,直接点开关即可)。 */
async function closeCompose() {
  await browser.execute(() => {
    const c = document.querySelector("#compose");
    if (c && !c.hidden) document.querySelector("#add-task").click();
  });
  await $("#compose-input").waitForDisplayed({ reverse: true, timeout: 5000 });
}

/** 排一个「插进来的人」:`ms` 毫秒后,compose 关着就把它开出来(= 回填那个回调)。
 *  `window.__probeOpened` 记它到底动没动手 —— 少了这一格,「它没插进来」与「它插进来了
 *  但没造成后果」在断言上长得一模一样(memory `test-negative-control`:先证刀落上了)。 */
async function scheduleOpener(ms) {
  await browser.execute((delay) => {
    window.__probeOpened = false;
    setTimeout(() => {
      const c = document.querySelector("#compose");
      if (c && c.hidden) {
        document.querySelector("#add-task").click();
        window.__probeOpened = true;
      }
    }, delay);
  }, ms);
}

const isOpen = () => browser.execute(() => !document.querySelector("#compose").hidden);
const opener动过手 = () => browser.execute(() => window.__probeOpened === true);

describe("探针 · openCompose 的「看一眼」与「点下去」是不是同一刻", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("阳性对照:旧形、没有人插进来 ⇒ 收场是开着的(证明红是那个人造成的,不是旧形本身就坏)", async () => {
    await closeCompose();
    // ↓ 414 那版 openCompose 的三行,只多一句人为放大的窗口。
    const seenOpen = await $("#compose-input").isDisplayed();
    await browser.pause(WINDOW_MS);
    if (!seenOpen) await $("#add-task").click();

    expect(await isOpen()).toBe(true);
  });

  it("旧形:那个人落在窗口正中 ⇒ 我这一点把它**关上**了,收场是关着的", async () => {
    await closeCompose();
    await scheduleOpener(INTERLEAVE_MS);

    const seenOpen = await $("#compose-input").isDisplayed(); // 此刻还关着 → 判定「要点」
    await browser.pause(WINDOW_MS); // ← 窗口正中那一刻,compose 被别人开了
    if (!seenOpen) await $("#add-task").click(); // ← 这一点因此是「关上」

    expect(await opener动过手()).toBe(true); // 刀真落上了
    expect(await isOpen()).toBe(false); // ⇒ 后面那句 waitForDisplayed 只能等到 5 秒超时
  });

  it("新形:那个人落在我**之前** ⇒ 同一次 execute 里读到「已经开着」,不点,收场是开着的", async () => {
    await closeCompose();
    await scheduleOpener(INTERLEAVE_MS);
    await browser.pause(WINDOW_MS); // 让它先落地(= 旧形里窗口正中那一刻)

    await openCompose();

    expect(await opener动过手()).toBe(true);
    expect(await isOpen()).toBe(true);
  });

  it("新形:那个人落在我**之后** ⇒ 它看见 compose 已经开着、自己不动,收场还是开着的", async () => {
    await closeCompose();
    await scheduleOpener(WINDOW_MS + INTERLEAVE_MS); // 排在 openCompose 跑完之后

    await openCompose();
    await browser.pause(WINDOW_MS + INTERLEAVE_MS + 300); // 等它真的到点

    expect(await opener动过手()).toBe(false); // 它看见开着,没动手
    expect(await isOpen()).toBe(true);
  });

  after(async () => {
    await closeCompose(); // 别把开着的 compose 留给下一支
  });
});
