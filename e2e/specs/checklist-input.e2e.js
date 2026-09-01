import { $, expect, browser } from "@wdio/globals";
import { invoke, tryInvoke, goNotebook, clearInbox, openCompose, boardAction } from "./support.js";

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

    await browser.keys("E2ECKI-one");
    await browser.keys(["Control", "l"]);
    // ⭐ 承重:Ctrl+L 真到了、execCommand 真落了笔。
    expect(await input.getValue()).toBe("- [ ] E2ECKI-one");

    await browser.keys(["Shift", "Enter"]);
    // ⭐ 承重:Shift+Enter 没被「Enter = 记下」那条抢走(抢走了这条就已经入库、框也空了)。
    expect(await input.getValue()).toBe("- [ ] E2ECKI-one\n- [ ] ");

    await browser.keys("two");
    await browser.keys(["Shift", "Enter"]);
    expect(await input.getValue()).toBe("- [ ] E2ECKI-one\n- [ ] two\n- [ ] ");

    // ⭐ 承重:空项上再按一次 = 退出清单 —— 那一行整个抹平,**不插新行**。
    await browser.keys(["Shift", "Enter"]);
    expect(await input.getValue()).toBe("- [ ] E2ECKI-one\n- [ ] two\n");

    // 收尾那个换行删掉再提交(留着它库里就多一行空白,与本例要验的事无关)。
    await browser.keys("Backspace");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.content.includes("E2ECKI-one")), {
      timeout: 8000,
      timeoutMsg: "Enter 记下之后库里没出现这条",
    });
    expect(await ideaBody("E2ECKI-one")).toBe("- [ ] E2ECKI-one\n- [ ] two");
  });

  it("⭐ Ctrl+Z 撤得回来 —— 快速输入没把用户手打的字连撤销栈一起吃掉", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.click();
    await clearField();

    await browser.keys("abc");
    await browser.keys(["Control", "l"]);
    expect(await input.getValue()).toBe("- [ ] abc");

    await browser.keys(["Control", "z"]);
    // ⛔ 这里要的是 "abc" 而**不是空串**:`ta.value = …` 那种写法会把整个撤销栈清掉,
    // 一记 Ctrl+Z 就把用户自己打的三个字母也吞了。
    expect(await input.getValue()).toBe("abc");

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
    expect(await area.getValue()).toBe("- [ ] E2ECKI-one\n- [ ] two\n- [ ] ");

    await browser.keys("three");
    await browser.keys("Enter"); // 裸 Enter 才是保存
    await browser.waitUntil(async () => (await ideaBody("E2ECKI-one")).includes("three"), {
      timeout: 8000,
      timeoutMsg: "编辑态 Enter 保存后库里没跟上",
    });
    expect(await ideaBody("E2ECKI-one")).toBe("- [ ] E2ECKI-one\n- [ ] two\n- [ ] three");
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
    expect(await input.getValue()).toBe("- [ ] E2ECKI-task");

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

    await browser.keys("E2ECKI-bc");
    await browser.keys(["Control", "l"]);
    expect(await input.getValue()).toBe("- [ ] E2ECKI-bc");
    await browser.keys(["Shift", "Enter"]);
    expect(await input.getValue()).toBe("- [ ] E2ECKI-bc\n- [ ] ");

    await clearField(); // 只验手势,不入库(建条任务还要再清一次场)
  });
});
