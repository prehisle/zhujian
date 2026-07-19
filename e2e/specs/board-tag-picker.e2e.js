import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

// 按 L(⋯ 菜单「标签」)打开的标签选择器(board.ts openPicker)本轮升级:
//   · 去掉「取消」按钮 —— Esc / 点别处 收起(和 ⋯ 菜单、编辑态同一套手势);
//   · 输入即筛选 + 无匹配时内联新建标签(先复用已有是默认路径,精确同名不给「创建」防重复)。
// board-multitag.e2e.js 已覆盖「从候选里选已有标签」;这里覆盖上面两项新能力。
describe("任务看板 · 标签选择器(Esc 收起 + 内联新建)", () => {
  const TASK = "E2E-选择器任务";
  const EXIST = "E2E-已存在标签";
  const NEW = "E2E-内联新建标签";
  let taskId;

  before(async () => {
    await invoke("create_topic", { title: EXIST });
    taskId = await invoke("create_task", { title: TASK, topicId: null }); // 生而无标签
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
  });

  // 后端真相:TASK 当前挂的标签名。
  const tagTitles = async () => {
    const tasks = await invoke("list_tasks");
    const t = tasks.find((x) => x.id === taskId);
    return (t?.topics ?? []).map((tp) => tp.title);
  };

  it("Esc 收起选择器 → 不加任何标签,且没有「取消」按钮", async () => {
    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // 旧的「取消」按钮已删除(Esc/点别处代之)。
    expect(await card.$("button*=取消").isExisting()).toBe(false);

    // Esc(armDismiss 文档级捕获监听)→ 选择器收起,标签数不变。
    await browser.execute(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    await browser.waitUntil(async () => !(await $(`.tcard*=${TASK}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "Esc 后选择器未收起",
    });
    expect(await tagTitles()).toEqual([]);
  });

  it("点选择器以外处 → 收起,不加标签", async () => {
    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // mousedown 落在卡片(选择器)以外 → armDismiss 文档级捕获监听收起(和 ⋯ 菜单一致)。
    await browser.execute(() =>
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    await browser.waitUntil(async () => !(await $(`.tcard*=${TASK}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "点别处后选择器未收起",
    });
    expect(await tagTitles()).toEqual([]);
  });

  it("输入库里没有的新名 → 冒出「创建」→ 落库新标签并挂到任务", async () => {
    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // 往搜索框输入一个不存在的名字(dispatch input,免真实逐字键入)。
    await browser.execute(
      (title, name) => {
        const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
        const inp = c.querySelector(".topic-search");
        inp.value = name;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      },
      TASK,
      NEW,
    );
    // 无匹配 → 「创建「NEW」」按钮出现。
    await card.$(".choice.create").waitForExist({ timeout: 5000 });
    await browser.execute((title) => {
      const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
      c.querySelector(".choice.create").click();
    }, TASK);

    // 新标签既进了 topics 表,也挂到了任务上。
    await browser.waitUntil(async () => (await tagTitles()).includes(NEW), {
      timeout: 8000,
      timeoutMsg: "内联新建的标签未挂到任务",
    });
    const topics = await invoke("list_topics");
    expect(topics.some((t) => t.title === NEW)).toBe(true);
  });

  it("输入已存在标签的精确名 → 只给复用、不给「创建」(防近似重复)", async () => {
    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    await browser.execute(
      (title, name) => {
        const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
        const inp = c.querySelector(".topic-search");
        inp.value = name;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      },
      TASK,
      EXIST,
    );
    // EXIST 已存在 → 候选里有它可直接选,但精确同名不再给「创建」按钮。
    await card.$(`.choice=${EXIST}`).waitForExist({ timeout: 5000 });
    expect(await card.$(".choice.create").isExisting()).toBe(false);
  });
});
