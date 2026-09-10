import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// 0031 kind + 按类型筛选(路线 A 钻取器)扩到灵感 tab:与看板同源(board-kind-filter
// 覆盖看板侧)。灵感筛选条顶部多一行类型 pill——选中一个类型先圈定「挂了该类型任一
// 标签的想法」,同时把下方标签 pill 收到该类型内(可再钻到具体某人)。无 kind 的库不显
// 类型行。
describe("灵感 · 按标签类型筛选", () => {
  const P1 = "E2EIK-张三";
  const P2 = "E2EIK-李四";
  const PROJ = "E2EIK-项目甲"; // 无 kind
  // 652:一枚**没有任何想法挂着**的标签 + 它自己的类型 —— 类型 pill 的计数由 items 算,
  // 而 pill 本身由 allTopics 派生 ⇒ 计数 0 的类型照样出现在轴上、点得着(用户就是这么撞上的)。
  const THING = "E2EIK-器物甲";
  const KIND_EMPTY = "E2EIK-器物";
  const IDEA_A = "E2EIK-想到张三";
  const IDEA_B = "E2EIK-想到李四";
  const IDEA_C = "E2EIK-想到项目";
  let idP1, idP2, idProj, idThing, idA, idB, idC;

  const kindPills = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#idea-kind-filter .kind-pill")].map((p) => p.textContent),
    );
  const topicPillLabels = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#idea-topic-filter .tf-pill")].map((p) =>
        p.querySelector(".tf-n") ? p.textContent.replace(p.querySelector(".tf-n").textContent, "") : p.textContent,
      ),
    );
  const clickKind = (label) =>
    browser.execute((l) => {
      [...document.querySelectorAll("#idea-kind-filter .kind-pill")].find((p) => p.textContent.includes(l)).click();
    }, label);
  const clickTopic = (label) =>
    browser.execute((l) => {
      [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((p) => p.textContent.includes(l)).click();
    }, label);
  const shows = (name) => $(`.note*=${name}`).isExisting();

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    idP1 = await invoke("create_topic", { title: P1 });
    idP2 = await invoke("create_topic", { title: P2 });
    idProj = await invoke("create_topic", { title: PROJ });
    // 两个人名标签打上 kind「人名」,项目标签不打(无类型)。
    await invoke("set_topic_kind", { id: idP1, kind: "人名" });
    await invoke("set_topic_kind", { id: idP2, kind: "人名" });
    // 器物类:标签建了、类型标了,但一条想法都不挂 ⇒ 该类型 pill 显 0(最后一例点它)。
    idThing = await invoke("create_topic", { title: THING });
    await invoke("set_topic_kind", { id: idThing, kind: KIND_EMPTY });
    idA = await invoke("capture_note", { content: IDEA_A });
    await invoke("file_note_to_topic", { id: idA, topicId: idP1, newTitle: null });
    idB = await invoke("capture_note", { content: IDEA_B });
    await invoke("file_note_to_topic", { id: idB, topicId: idP2, newTitle: null });
    idC = await invoke("capture_note", { content: IDEA_C });
    await invoke("file_note_to_topic", { id: idC, topicId: idProj, newTitle: null });
    await goNotebook("inbox");
    await $(`.note*=${IDEA_A}`).waitForExist({ timeout: 10000 });
  });

  // 筛选态是模块态、跨视图存活:归还「全部类型/所有」再清光造的一切,别泄漏给后续 spec。
  after(async () => {
    await clickKind("全部类型");
    await clickTopic("所有");
    await clearInbox();
    await invoke("delete_topic", { id: idP1 });
    await invoke("delete_topic", { id: idP2 });
    await invoke("delete_topic", { id: idProj });
    await invoke("delete_topic", { id: idThing });
  });

  it("库里有标了 kind 的标签 → 类型 pill 行出现(全部类型 + 人名 2)", async () => {
    const kinds = await kindPills();
    expect(kinds.some((k) => k.includes("全部类型"))).toBe(true);
    const renPill = kinds.find((k) => k.includes("人名"));
    expect(renPill).toBeDefined();
    expect(renPill).toContain("2"); // 挂人名标签的想法数=IDEA_A/IDEA_B=2
  });

  it("选「人名」→ 想法缩到挂人名标签的、标签 pill 收到人名类内(项目/无标签消失)", async () => {
    await clickKind("人名");
    await browser.waitUntil(async () => (await shows(IDEA_A)) && !(await shows(IDEA_C)), {
      timeout: 8000,
      timeoutMsg: "选人名后列表未缩到人名想法",
    });
    expect(await shows(IDEA_B)).toBe(true);
    const labels = await topicPillLabels();
    expect(labels.some((l) => l.includes("所有"))).toBe(true);
    expect(labels.some((l) => l.includes(P1))).toBe(true);
    expect(labels.some((l) => l.includes(P2))).toBe(true);
    expect(labels.some((l) => l.includes("无标签"))).toBe(false);
    expect(labels.some((l) => l.includes(PROJ))).toBe(false);
  });

  it("类型内再钻到具体某人 → 只剩该人的想法", async () => {
    await clickTopic(P1); // 张三
    await browser.waitUntil(async () => (await shows(IDEA_A)) && !(await shows(IDEA_B)), {
      timeout: 8000,
      timeoutMsg: "钻到张三后未只剩张三的想法",
    });
    expect(await shows(IDEA_C)).toBe(false);
  });

  it("回「全部类型」→ 恢复全量(项目想法与无标签 pill 回来)", async () => {
    await clickKind("全部类型");
    await browser.waitUntil(async () => await shows(IDEA_C), {
      timeout: 8000,
      timeoutMsg: "回全部类型后项目想法未恢复",
    });
    expect(await shows(IDEA_A)).toBe(true);
    const labels = await topicPillLabels();
    expect(labels.some((l) => l.includes("无标签"))).toBe(true);
    expect(labels.some((l) => l.includes(PROJ))).toBe(true);
  });

  // 652(用户报的):**只筛类型、没钻到具体标签**时,空态此前落在「按标签」那句上,而
  // `selectedTopicLabels` 只认标签维、这一维给的是空数组 ⇒ 屏上是「「」下没有随记」。
  // ⚠ 判据两格缺一不可:①新那句真的在(正面);②书名号里**不是空的**(反面)——只断 ①
  // 的话,一个把两句都印出来的坏实现照样绿。
  it("选一个一条随记都没有的类型 → 空态说「「…」类型下没有随记」,不是空书名号", async () => {
    await clickKind(KIND_EMPTY);
    const big = $(".v-inbox .center .big");
    await big.waitForExist({ timeout: 8000 });
    await browser.waitUntil(async () => (await big.getText()).includes("类型下没有随记"), {
      timeout: 8000,
      timeoutMsg: `选空类型后未出现类型空态,屏上是:${await big.getText().catch(() => "(取不到)")}`,
    });
    const text = await big.getText();
    expect(text).toContain(`「${KIND_EMPTY}」类型下没有随记`);
    expect(text).not.toContain("「」");
  });
});
