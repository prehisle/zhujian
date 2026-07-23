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
  const IDEA_A = "E2EIK-想到张三";
  const IDEA_B = "E2EIK-想到李四";
  const IDEA_C = "E2EIK-想到项目";
  let idP1, idP2, idProj, idA, idB, idC;

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
});
