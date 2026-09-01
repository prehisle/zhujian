import { $, $$, expect, browser } from "@wdio/globals";
import { invoke, tryInvoke, goNotebook, clearInbox } from "./support.js";

// 正文里的待办清单(用户 2026-09-01 提):行首 `- [ ] ` / `- [x] ` 画成一枚可点的方框,
// 点一下把那一行的标记翻面、**整条正文写回**。
//
// 纯逻辑(认行 / 翻标记)由 check-filter-parity 的 23 格两端同压 —— 这支 spec 不重复那些,
// 只钉**接线**:画出来的是不是真方框、点下去有没有真落库、两条写回命令(灵感 edit_note /
// 看板 rename_task)是不是都通、只读视图那形给不给点。
//
// ⛔ 有一格刻意不测:「连点两枚时的单飞 + 尾随」—— e2e 的两次点击间隔远大于一次本地
// SQLite 写,在飞窗口造不出来,硬造只会得到一只不知道在测什么的用例(如实记账,别当漏测
// 去补)。它由两端源码里那段注释与「每发都是整条正文」这个事实守着。
describe("正文待办清单", () => {
  // 三行:一个未勾、一个已勾、一行**裸 `-`**(承重:裸的不当待办项,否则普通列表就写不出来了)。
  const BODY = "E2ECK-清单\n- [ ] 甲\n- [x] 乙\n- 丙不是待办项";
  const TASK = "E2ECK-任务清单\n- [ ] 子项";
  let taskId;

  const ideaBody = async () => {
    const ideas = await invoke("list_ideas");
    const it = ideas.find((i) => i.content.startsWith("E2ECK-清单"));
    expect(it).toBeDefined();
    return it.content;
  };
  const taskTitle = async () => {
    const t = (await invoke("list_tasks")).find((x) => x.title.startsWith("E2ECK-任务清单"));
    expect(t).toBeDefined();
    return t.title;
  };

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    await invoke("capture_note", { content: BODY });
    taskId = await invoke("create_task", { title: TASK });
    await goNotebook("inbox");
    await $(".note*=E2ECK-清单").waitForExist({ timeout: 10000 });
  });

  // ⚠ 第三例会把这条任务归档、末尾再还原回看板 —— 那一例若在中途红掉,任务就停在
  // 归档态,直发 archive_task 会当场抛(「只有活跃任务可移入回收站」)、清场半途而废,
  // 给后面的 spec 留一条脏数据。所以归档这一步走 tryInvoke:清场本就该幂等。
  after(async () => {
    await clearInbox();
    await tryInvoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });

  it("灵感卡:两行画成方框、裸 `-` 那行不画;点一下真落库,再点翻回来", async () => {
    const card = await $(".note*=E2ECK-清单");
    // 三行正文,只有两行是待办项 ⇒ 恰两枚方框(裸 `- 丙不是待办项` 不画,承重那格)。
    await browser.waitUntil(async () => (await card.$$(".ckbox")).length === 2, {
      timeout: 8000,
      timeoutMsg: "灵感卡上没画出恰两枚方框",
    });
    // 第一项未勾、第二项已勾。⚠ `.on` 挂在**外层 `.ckline`** 上(方框与文字压淡一处翻)。
    const rows = await card.$$(".ckline");
    expect(await rows[0].getAttribute("class")).not.toContain("on");
    expect(await rows[1].getAttribute("class")).toContain("on");

    await rows[0].$(".ckbox").click();
    // 承重:落库了。⛔ 别只看 DOM —— 乐观呈现下 DOM 先变,那证明不了写回这条路通。
    await browser.waitUntil(async () => (await ideaBody()).includes("- [x] 甲"), {
      timeout: 8000,
      timeoutMsg: "勾了第一项,库里正文没变成 `- [x] 甲`",
    });
    // 别的行一个字节没动(翻标记只许动方括号里那一个字符)。
    expect(await ideaBody()).toBe("E2ECK-清单\n- [x] 甲\n- [x] 乙\n- 丙不是待办项");

    // 再点一次翻回来(两个方向都通,不是只会打勾)。
    await (await card.$$(".ckline"))[0].$(".ckbox").click();
    await browser.waitUntil(async () => (await ideaBody()).includes("- [ ] 甲"), {
      timeout: 8000,
      timeoutMsg: "再点一次没翻回未勾",
    });
    expect(await ideaBody()).toBe(BODY);

    // ⭐ 用户面 63:上面勾了两下,而编辑历史**一版都不该长**(0039 那面豁免旗 + Rust 侧的
    // 文本比对判据)。三条写正文的路各有 core 行为测,这一格钉的是**整条链路** —— 真点击 →
    // 真 IPC → 库里历史真的没涨。⛔ 别以为上面那几句正文断言顺带证了它:「正文对不对」与
    // 「有没有顺手记一版历史」是两件事,后者只有这一句在看。
    // ⚠ 反向那半(真编辑照常留历史)由 `inbox-interactions.e2e.js` 那例钉着,不在这里重复。
    const idea = (await invoke("list_ideas")).find((i) => i.content.startsWith("E2ECK-清单"));
    expect(await invoke("list_note_history", { id: idea.id })).toHaveLength(0);
  });

  it("看板卡:走的是另一条写回命令(rename_task),照样落库", async () => {
    await goNotebook("board");
    const card = await $(".tcard*=E2ECK-任务清单");
    await card.waitForExist({ timeout: 10000 });
    const row = await card.$(".ckline");
    await row.waitForExist({ timeout: 8000 });
    expect(await row.getAttribute("class")).not.toContain("on");

    await row.$(".ckbox").click();
    await browser.waitUntil(async () => (await taskTitle()).includes("- [x] 子项"), {
      timeout: 8000,
      timeoutMsg: "看板卡勾了,库里正文没变",
    });
    expect(await taskTitle()).toBe("E2ECK-任务清单\n- [x] 子项");
  });

  it("回收站是只读视图:方框照显、但点不动(disabled)", async () => {
    // 上一例把任务那枚勾上了 —— 进回收站要看的正是「勾没勾照显」。
    await invoke("archive_task", { id: taskId });
    await goNotebook("board");
    await $("#trash-toggle").click();
    const card = await $(".tcard*=E2ECK-任务清单");
    await card.waitForExist({ timeout: 10000 });
    const row = await card.$(".ckline");
    await row.waitForExist({ timeout: 8000 });
    // 状态照显(上一例勾上的那一项),但方框是 disabled ⇒ 只读视图只留离场动作(design-rules)。
    expect(await row.getAttribute("class")).toContain("on");
    expect(await row.$(".ckbox").isEnabled()).toBe(false);

    // 还原回看板,免得给后面的 spec 留一条在回收站里的任务。
    await invoke("restore_task", { id: taskId });
  });
});
