import { $, expect, browser } from "@wdio/globals";
import { invoke, tryInvoke, goNotebook, clearInbox, openCompose, boardAction, typeText } from "./support.js";

// 待办清单的**快速输入**(562,用户 561 那轮当场问的「`- [ ] ` 这种能比较快速的输入吗?」):
// Shift+Enter 续出下一项、Ctrl+L 起一条 / 摘掉。
//
// 纯逻辑(续行 / 起一条 / 最小改写区间)由 check-filter-parity 的 80 格两端同压 —— 这支
// spec 一格都不重复那些,只钉**单测证明不了的那半**:
//   ① 那两记键真的从 WebView2 走到了我们的处理器(Ctrl+L 没被别的 Ctrl 组合吃掉、
//      Shift+Enter 没被五个入口那道「Enter = 提交」的文档级监听抢走);
//   ② 落笔走的 `document.execCommand` 在这个引擎上**真的改得动 textarea**;
//   ③ ⭐ 撤销栈还在 —— 选 execCommand 而不是 `ta.value = …` 的全部理由就是这一格,
//      而它在纯逻辑里根本不可观测(纯逻辑答的是「新正文该长什么样」)。
// ⚠ 键必须走 `browser.keys` 真发:合成 KeyboardEvent 既不经引擎的快捷键分派,也不会让
// execCommand 落在正确的焦点上 —— 那样测的是我们自己的假设,不是这台机器上的事实。
// ⚠⚠ **562 那趟 Linux CI 逮到的两处引擎差异**(gate/win-desk/fdc5535,`e2e(Linux / WebKitGTK)`
// 红两例)—— 两处都不是产品结论,是**真键盘在两个引擎上的行为不同**,同 450 那次
// (XIM 把合成键按 keycode 重译、大写 ASCII 全变小写)与 396 那次(`getText` 读回空串)一族:
//   ① **`Ctrl+Z` 在 WebKitWebDriver 上不触发原生 undo**:实得 `- [ ] abc`(= 那一记根本没生效),
//      而 Windows/WebView2 上实得 `abc`。⇒ 那一例按引擎跳过,理由与代价见它自己头上那段。
//   ② **裸 `Enter` 发不到文档级监听**:同一支里 Shift+Enter(挂在**元素**上)在 Linux 上是过的,
//      紧接着那记裸 Enter(要冒泡到 **document** 才提交)却没让 `edit_note` 落库。⇒ 那一步
//      **不是本轮要验的东西**(「Enter = 保存」是 561 之前就有的行为,`inbox-interactions.e2e.js`
//      用合成事件钉着),改成只断输入框里的字,别拿它当续行那一格的判据。
// ⛔ 别把这两条读成「Linux 上功能坏了」——那需要在真 Linux 桌面上按一次键才知道,而这台没有;
//    已立成 backlog 的账。⛔ 也别为了让它绿而把 Windows 那半一起改掉。
const IS_LINUX = process.platform === "linux";

describe("待办清单 · 快速输入", () => {
  let taskId;

  // ⚠ 认条目一律用 `includes` 不用 `startsWith` —— 本 spec 造出来的正文**第一行就是**
  // `- [ ] …`,标题被挤到第 7 个字符起(第一版栽在这儿:手势那几格全绿、找条目找不着)。
  const ideaBody = async (mark) => {
    const it = (await invoke("list_ideas")).find((i) => i.content.includes(mark));
    expect(it).toBeDefined();
    return it.content;
  };
  // 真键盘清空当前输入框(⛔ 别用 execute 设 value:那本身就会清掉撤销栈,
  // 第三例要验的正是撤销栈)。
  // ⚠⚠ **打完字别立刻读 value —— 要等它变成那个值**。563 真栽:我把一处原本带 waitUntil 的
  // 断言改成了立即 `expect(await el.getValue()).toBe(…)`,于是 Linux/WebKitGTK 上**最后一个键
  // 还没落地就被读走** ⇒ 期望 `- [ ] three` 实得 `- [ ] thre`(少最后一个 e),整趟 CI 红。
  // ⛔ 别把它读成产品缺陷,也 ⛔ 别只修红的那一处 —— 同一支里每一句「打完字读 value」都是同一个
  // 失败模式,在 Windows 上过只是因为那台快。语义与立即断言**完全相同**(等到期望值、超时才红),
  // 只是给慢引擎一点时间;超时消息里带上实得,红了一眼看得出差在哪。
  const expectValue = async (el, want) => {
    await browser.waitUntil(async () => (await el.getValue()) === want, {
      timeout: 8000,
      timeoutMsg: `期望 ${JSON.stringify(want)},实得 ${JSON.stringify(await el.getValue())}`,
    });
  };
  const clearField = async () => {
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
  };

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  after(async () => {
    await clearInbox();
    if (taskId) {
      await tryInvoke("archive_task", { id: taskId });
      await tryInvoke("purge_task", { id: taskId });
    }
  });

  it("灵感 compose:Ctrl+L 起一条 → Shift+Enter 续出下一项 → 空项上再按一次退出清单", async () => {
    await goNotebook("inbox");
    const input = await $(".v-inbox .compose-input");
    await input.waitForDisplayed({ timeout: 8000 });
    await input.click();
    await clearField();

    await typeText("E2ECKI-one");
    await browser.keys(["Control", "l"]);
    // ⭐ 承重:Ctrl+L 真到了、execCommand 真落了笔。
    await expectValue(input, "- [ ] E2ECKI-one");

    await browser.keys(["Shift", "Enter"]);
    // ⭐ 承重:Shift+Enter 没被「Enter = 记下」那条抢走(抢走了这条就已经入库、框也空了)。
    await expectValue(input, "- [ ] E2ECKI-one\n- [ ] ");

    await typeText("two");
    await browser.keys(["Shift", "Enter"]);
    await expectValue(input, "- [ ] E2ECKI-one\n- [ ] two\n- [ ] ");

    // ⭐ 承重:空项上再按一次 = 退出清单 —— 那一行整个抹平,**不插新行**。
    await browser.keys(["Shift", "Enter"]);
    await expectValue(input, "- [ ] E2ECKI-one\n- [ ] two\n");

    // 收尾那个换行删掉再提交(留着它库里就多一行空白,与本例要验的事无关)。
    await browser.keys("Backspace");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.content.includes("E2ECKI-one")), {
      timeout: 8000,
      timeoutMsg: "Enter 记下之后库里没出现这条",
    });
    expect(await ideaBody("E2ECKI-one")).toBe("- [ ] E2ECKI-one\n- [ ] two");
  });

  // ⚠ **Linux 上跳过 —— 571 起理由变了,别再照旧读**:此前写的是「测不出 execCommand 有没有
  // 保住撤销栈」(562 那趟 CI 实得 `- [ ] abc`),像是我们这边的嫌疑。**571 用真键盘量过了**
  // (`e2e/probes/linux-real-keys.sh`,xdotool/XTEST 不经 WebDriver):控制组「只打 `abcdef`、
  // 全程不碰 execCommand,再 Ctrl+Z」实得**仍是 `abcdef`** ⇒ **这一端整个应用的文本框都没有撤销**。
  // ⇒ 跳过不是「测不了」,是**那一端没有这个能力**;⛔ 别再往「execCommand 把撤销栈弄没了」
  // 这个方向查。账已另立成 backlog 用户面 67(带触发门 = Linux 桌面正式对外发)。
  it("⭐ Ctrl+Z 撤得回来 —— 快速输入没把用户手打的字连撤销栈一起吃掉", async function () {
    if (IS_LINUX) this.skip();
    const input = await $(".v-inbox .compose-input");
    await input.click();
    await clearField();

    await typeText("abc");
    await browser.keys(["Control", "l"]);
    await expectValue(input, "- [ ] abc");

    await browser.keys(["Control", "z"]);
    // ⛔ 这里要的是 "abc" 而**不是空串**:`ta.value = …` 那种写法会把整个撤销栈清掉,
    // 一记 Ctrl+Z 就把用户自己打的三个字母也吞了。
    await expectValue(input, "abc");

    await clearField(); // 别给后面的例子留草稿
  });

  it("灵感卡编辑态:文档级那条「Enter = 保存」不抢 Shift+Enter,续行照常", async () => {
    await goNotebook("inbox");
    const card = await $(".note*=E2ECKI-one");
    await card.waitForExist({ timeout: 10000 });
    await (await card.$(".note-text")).doubleClick();
    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });

    await area.click();
    await browser.keys(["Control", "End"]); // 光标落到正文末尾(末行是 `- [ ] two`)
    await browser.keys(["Shift", "Enter"]);
    await expectValue(area, "- [ ] E2ECKI-one\n- [ ] two\n- [ ] ");

    await typeText("three");
    // ⚠ 承重的是**上面那记 Shift+Enter 没被文档级「Enter = 保存」抢走**,断言就停在框里那份字上。
    // ⛔ 别在这里再补一记裸 Enter 去验保存:那记在 WebKitWebDriver 上发不到文档级监听
    // (562 那趟 Linux CI 实证),而「Enter = 保存」本就由 `inbox-interactions.e2e.js` 用合成
    // 事件钉着 —— 拿一件别处已有网的事,去当这一格的判据,只会把引擎差异记成产品缺陷。
    //
    // ⚠⚠ **这一句曾在 Linux/WebKitGTK 上连红五趟**(de398d8 / 676b5a7 / 88fa43c / 9-01 夜跑 /
    // ba76adc),实得恒 `- [ ] thre`。571 在真 Linux 桌面上量出了根:**不是产品缺陷,也不是
    // 读得太早** —— 是 `browser.keys("three")` 那一形把相邻的两记 `e` 塌成了一记(wdio 把整串
    // **先全部 keyDown 再全部 keyUp** ⇒ 重复字符 = repeat,而 WebKitWebDriver 对 repeat 不插字)。
    // ⇒ 改走 `typeText`(逐字符 down+up)后两端同绿。⛔ 563 的「读得太早」与 566 的「压着等下一个
    // 键事件」两个论都已被推翻,别再照着修;逐格读数在 `e2e/probes/webkit-keys-dup.e2e.js`。
    const WANT_THREE = "- [ ] E2ECKI-one\n- [ ] two\n- [ ] three";
    await expectValue(area, WANT_THREE);
    await browser.keys("Escape"); // 收编辑态,别把草稿留给后面的例子
  });

  it("看板卡 inline rename:Ctrl+L 把标题变成待办项,走的是另一条写回命令", async () => {
    taskId = await invoke("create_task", { title: "E2ECKI-task" });
    await goNotebook("board");
    const card = await $(".tcard*=E2ECKI-task");
    await card.waitForExist({ timeout: 10000 });

    await boardAction("E2ECKI-task", "编辑");
    const input = await $(".edit-input");
    await input.waitForDisplayed({ timeout: 5000 });
    await input.click();
    await browser.keys(["Control", "End"]);
    await browser.keys(["Control", "l"]);
    await expectValue(input, "- [ ] E2ECKI-task");

    await browser.keys("Enter"); // rename_task
    await browser.waitUntil(
      async () => (await invoke("list_tasks")).some((t) => t.title === "- [ ] E2ECKI-task"),
      { timeout: 8000, timeoutMsg: "看板 inline rename 之后库里标题没变" },
    );
  });

  it("看板 compose:同一套手势,第五个入口也接上了", async () => {
    await goNotebook("board");
    await openCompose();
    const input = await $("#compose-input");
    await input.click();
    await clearField();

    await typeText("E2ECKI-bc");
    await browser.keys(["Control", "l"]);
    await expectValue(input, "- [ ] E2ECKI-bc");
    await browser.keys(["Shift", "Enter"]);
    await expectValue(input, "- [ ] E2ECKI-bc\n- [ ] ");

    await clearField(); // 只验手势,不入库(建条任务还要再清一次场)
  });
});
