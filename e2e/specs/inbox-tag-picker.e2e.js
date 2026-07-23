import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// 灵感「打标签」选择器(inbox.ts openTopic)与看板 openPicker 现共用 src/tag-picker.ts。
// 这支是 board-tag-picker.e2e.js 的对称面:同覆盖「Esc / 点别处 收起(无取消钮)」与「输入即
// 筛选 + 无匹配内联新建 / 精确同名不给创建」——两视图同源后,两边都要有正式回归,免得日后
// 单改一边悄悄漂移(174 可优化项①点名「抽时一并加对称 inbox-tag-picker.e2e.js」)。
// 灵感一步落库(file_note_to_topic),故「是否加上标签」的断言查 list_ideas 的 topics。
describe("灵感 · 标签选择器(Esc 收起 + 内联新建)", () => {
  const IDEA = "E2E-灵感选择器想法";
  const EXIST = "E2E-灵感已存在标签";
  const NEW = "E2E-灵感内联新建标签";
  let noteId;

  before(async () => {
    // 幂等 seed(specFileRetries 重跑时库里可能已有 EXIST、残留上轮新建的 NEW):按名先
    // 清理再建,免得 create_topic 撞「已存在」、或残留 NEW 让「内联新建」用例落空。
    const topics = await invoke("list_topics");
    if (!topics.some((t) => t.title === EXIST)) await invoke("create_topic", { title: EXIST });
    const staleNew = topics.find((t) => t.title === NEW);
    if (staleNew) await invoke("delete_topic", { id: staleNew.id });
    // 清空想法列表,播一条未归类、无标签的 IDEA,再导航到灵感 —— 先建后导航:直接 IPC 建
    // 条目不会推动已挂载视图刷新,须靠 goNotebook 的 re-nav 让新条目进入首渲(同 openCard)。
    await clearInbox();
    noteId = await invoke("capture_note", { content: IDEA });
    await goNotebook("inbox");
    await $(`.note*=${IDEA}`).waitForExist({ timeout: 10000 });
  });

  // 后端真相:IDEA 当前挂的标签名(灵感的标签走 list_ideas 的 topics)。
  const ideaTags = async () => {
    const ideas = await invoke("list_ideas");
    const n = ideas.find((x) => x.id === noteId);
    return (n?.topics ?? []).map((t) => t.title);
  };

  it("Esc 收起选择器 → 不加任何标签,且没有「取消」按钮", async () => {
    await inboxAction(IDEA, "标签");
    const card = await $(`.note*=${IDEA}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // 旧的「取消」按钮已删除(Esc/点别处代之)——与看板同款。
    expect(await card.$("button*=取消").isExisting()).toBe(false);

    // Esc(armDismiss 文档级捕获监听)→ 选择器收起,标签数不变。
    await browser.execute(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    await browser.waitUntil(async () => !(await $(`.note*=${IDEA}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "Esc 后选择器未收起",
    });
    expect(await ideaTags()).toEqual([]);
  });

  it("点选择器以外处 → 收起,不加标签", async () => {
    await inboxAction(IDEA, "标签");
    const card = await $(`.note*=${IDEA}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // mousedown 落在选择器以外 → armDismiss 文档级捕获监听收起(和 ⋯ 菜单一致)。
    await browser.execute(() =>
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    await browser.waitUntil(async () => !(await $(`.note*=${IDEA}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "点别处后选择器未收起",
    });
    expect(await ideaTags()).toEqual([]);
  });

  it("输入库里没有的新名 → 冒出「创建」→ 落库新标签并挂到灵感", async () => {
    await inboxAction(IDEA, "标签");
    const card = await $(`.note*=${IDEA}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    // 往搜索框输入一个不存在的名字(dispatch input,免真实逐字键入)。
    await browser.execute(
      (text, name) => {
        const c = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes(text));
        const inp = c.querySelector(".topic-search");
        inp.value = name;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      },
      IDEA,
      NEW,
    );
    // 无匹配 → 「创建「NEW」」按钮出现。
    await card.$(".choice.create").waitForExist({ timeout: 5000 });
    await browser.execute((text) => {
      const c = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes(text));
      c.querySelector(".choice.create").click();
    }, IDEA);

    // 新标签既进了 topics 表,也挂到了灵感上。
    await browser.waitUntil(async () => (await ideaTags()).includes(NEW), {
      timeout: 8000,
      timeoutMsg: "内联新建的标签未挂到灵感",
    });
    const topics = await invoke("list_topics");
    expect(topics.some((t) => t.title === NEW)).toBe(true);
  });

  it("输入已存在标签的精确名 → 只给复用、不给「创建」(防近似重复)", async () => {
    await inboxAction(IDEA, "标签");
    const card = await $(`.note*=${IDEA}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });
    await browser.execute(
      (text, name) => {
        const c = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes(text));
        const inp = c.querySelector(".topic-search");
        inp.value = name;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      },
      IDEA,
      EXIST,
    );
    // EXIST 已存在 → 候选里有它可直接选,但精确同名不再给「创建」按钮。
    await card.$(`.choice=${EXIST}`).waitForExist({ timeout: 5000 });
    expect(await card.$(".choice.create").isExisting()).toBe(false);
  });
});
