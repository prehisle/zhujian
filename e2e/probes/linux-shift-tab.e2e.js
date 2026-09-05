// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)。
//
// 干什么:给 backlog 测试与工装 78 第一例(`checklist-input.e2e.js` 那格「Shift+Tab 退回一级」
// 在 WebKitGTK 上连红两趟,期望 `- [ ] E2ECKI-tab` 实得 `  - [ ] E2ECKI-tab`)取一次
// **决定性**读数:分清「**那一记根本没到页面**」(= 驱动/引擎那一层的事,同 396 在
// `zz-verify-focustrap` 上量到的「Shift+Tab 被驱动在 GTK 层吃掉」)与「**到了、但我们的处理器
// 没退回**」(= 真产品缺陷)。
//
// ⚠ 这支只答得了「**经 WebDriver 发**是什么样」—— 拿驱动去验驱动是循环论证的那一半,
//   由 `e2e/probes/linux-real-keys.sh`(xdotool/XTEST,不经 WebDriver)另外答。两支合起来才是结论。
//
// 怎么判(四格,前两格是阳性对照):
//   ① 裸 textarea + Tab      —— 证明观察器本身有效、这一记看得见
//   ② 产品输入框 + Tab       —— 600 那条路在这个引擎上真的通(它本来就是绿的)
//   ③ 产品输入框 + Shift+Tab —— **正题**:页面收到了什么
//   ④ 裸 textarea + Shift+Tab —— 与产品代码零关系,排掉「是我们某处把它吃了」
//
// 观察器**只看不干预**(不 preventDefault、不改值),挂在 document 捕获相 —— 元素上的处理器
// 若真收到了,捕获相一定先看得见。
//
// ⭐ **602 实跑的答案(留档,免得下一个人重跑一遍)**:
//   ① 裸 ta + Tab        → key=Tab          code=Tab kc=9
//   ② 产品框 + Tab       → key=Tab          code=Tab kc=9   值 "  - [ ] E2ECKI-tab"  ✅ 缩进了
//   ③ 产品框 + Shift+Tab → key=Shift ; key=Unidentified code=Tab kc=9 +shift          值没变
//   ④ 裸 ta + Shift+Tab  → key=Shift ; key=Unidentified code=Tab kc=9 +shift
// ⇒ **那一记到得了页面**,`code` / `keyCode` / `shiftKey` 全在,只有 `e.key` 被 WebKitGTK 报成
//   `Unidentified`;④ 与产品代码零关系而同形 ⇒ ⛔ 别往「我们某处把它吃了」查。
// ⇒ 配上真键盘那支(同形)⇒ **不是驱动差异,是我们判 `e.key === "Tab"` 判得太窄**。
//   ⛔ **396 那句「被驱动在 GTK 层吃掉、一条 keydown 都收不到」不成立**(它那个观察器多半只认
//   `key === "Tab"`,而 `seen: []` 与「真没收到」同形 —— 533 那条「别把两种情况压成一个读数」)。
//
// 怎么跑(Linux;先另起 `npm run dev`):
//   YS_E2E_FAST=1 npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/linux-shift-tab.e2e.js
import { browser, $ } from "@wdio/globals";
import { goNotebook, clearInbox, typeText } from "../specs/support.js";

const TAG = "[探针78]";

// 装观察器 + 清空记录。恒等幂:重复调只清记录。
async function arm() {
  await browser.execute(() => {
    window.__probe78 = [];
    if (!window.__probe78Armed) {
      document.addEventListener(
        "keydown",
        (e) => {
          window.__probe78.push({
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            which: e.which,
            location: e.location,
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            target: e.target && e.target.className ? String(e.target.className) : String(e.target && e.target.tagName),
          });
        },
        true,
      );
      window.__probe78Armed = true;
    }
  });
}

const seen = () =>
  browser.execute(() =>
    window.__probe78.map(
      (r) => `key=${r.key} code=${r.code} keyCode=${r.keyCode} loc=${r.location}${r.shift ? " +shift" : ""} @${r.target}`,
    ),
  );

// 裸 textarea:与产品代码零关系(不接 wireChecklistInput)。
async function mkBare() {
  await browser.execute(() => {
    let ta = document.getElementById("__probe78ta");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.id = "__probe78ta";
      ta.style.cssText = "position:fixed;left:8px;top:8px;z-index:99999;width:320px;height:80px";
      document.body.appendChild(ta);
    }
    ta.value = "";
    ta.focus();
  });
}

describe("探针 78 · Shift+Tab 在 WebKitGTK 上到底到没到页面", () => {
  it("四格读数", async () => {
    await goNotebook("inbox");
    await clearInbox();

    // ① 裸 textarea + Tab
    await mkBare();
    await arm();
    await browser.keys("Tab");
    const bareTab = await seen();

    // ④ 裸 textarea + Shift+Tab(与 ① 同一个框,免得焦点跑掉之后读的是别的格)
    await mkBare();
    await arm();
    await browser.keys(["Shift", "Tab"]);
    const bareShiftTab = await seen();

    await browser.execute(() => document.getElementById("__probe78ta")?.remove());

    // ② / ③ 产品输入框
    const input = await $(".v-inbox .compose-input");
    await input.waitForDisplayed({ timeout: 8000 });
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
    await typeText("E2ECKI-tab");
    await browser.keys(["Control", "l"]);
    await browser.waitUntil(async () => (await input.getValue()) === "- [ ] E2ECKI-tab", {
      timeout: 8000,
      timeoutMsg: `Ctrl+L 那格就没成:实得 ${JSON.stringify(await input.getValue())}`,
    });

    await arm();
    await browser.keys("Tab");
    const appTab = await seen();
    const afterTab = await input.getValue();

    await arm();
    await browser.keys(["Shift", "Tab"]);
    const appShiftTab = await seen();
    const afterShiftTab = await input.getValue();

    // 焦点还在不在框里(Tab 被放行的话人已经不在框里了)
    const focus = await browser.execute(() => String(document.activeElement?.className || document.activeElement?.tagName));

    console.log(`${TAG} ① 裸 ta + Tab        → seen=${JSON.stringify(bareTab)}`);
    console.log(`${TAG} ④ 裸 ta + Shift+Tab  → seen=${JSON.stringify(bareShiftTab)}`);
    console.log(`${TAG} ② 产品框 + Tab       → seen=${JSON.stringify(appTab)}  值=${JSON.stringify(afterTab)}`);
    console.log(`${TAG} ③ 产品框 + Shift+Tab → seen=${JSON.stringify(appShiftTab)}  值=${JSON.stringify(afterShiftTab)}`);
    console.log(`${TAG} 收尾 activeElement=${focus}`);
  });
});
