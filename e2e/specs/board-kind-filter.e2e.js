import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// 0031 kind + 按类型筛选(路线 A 钻取器):标签有「类型」(自由文本,如「人名」)。看板筛选
// 条顶部多一行类型 pill——选中一个类型先圈定「挂了该类型任一标签的任务」,同时把下方标签
// pill 收到该类型内(可再钻到具体某人)。只看板接线;无 kind 的库不显类型行。
describe("任务看板 · 按标签类型筛选", () => {
  const P1 = "E2E-类-张三";
  const P2 = "E2E-类-李四";
  const PROJ = "E2E-类-项目甲"; // 无 kind
  const TASK_A = "E2E-类任务-找张三";
  const TASK_B = "E2E-类任务-找李四";
  const TASK_C = "E2E-类任务-做项目";
  let idP1, idP2, idProj;

  const kindPills = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#kind-filter .kind-pill")].map((p) => p.textContent),
    );
  const topicPillLabels = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#topic-filter .tf-pill")].map((p) =>
        // 去掉尾部计数,只留标签文字
        p.querySelector(".tf-n") ? p.textContent.replace(p.querySelector(".tf-n").textContent, "") : p.textContent,
      ),
    );
  const clickKind = (label) =>
    browser.execute((l) => {
      [...document.querySelectorAll("#kind-filter .kind-pill")].find((p) => p.textContent.includes(l)).click();
    }, label);
  const clickTopic = (label) =>
    browser.execute((l) => {
      [...document.querySelectorAll("#topic-filter .tf-pill")].find((p) => p.textContent.includes(l)).click();
    }, label);
  const shows = (name) => $(`.tcard*=${name}`).isExisting();

  before(async () => {
    idP1 = await invoke("create_topic", { title: P1 });
    idP2 = await invoke("create_topic", { title: P2 });
    idProj = await invoke("create_topic", { title: PROJ });
    // 两个人名标签打上 kind「人名」,项目标签不打(无类型)。
    await invoke("set_topic_kind", { id: idP1, kind: "人名" });
    await invoke("set_topic_kind", { id: idP2, kind: "人名" });
    await invoke("create_task", { title: TASK_A, topicId: idP1 });
    await invoke("create_task", { title: TASK_B, topicId: idP2 });
    await invoke("create_task", { title: TASK_C, topicId: idProj });
    await goNotebook("board");
    await $(`.tcard*=${TASK_A}`).waitForExist({ timeout: 10000 });
  });

  it("库里有标了 kind 的标签 → 类型 pill 行出现(全部类型 + 人名 2)", async () => {
    const kinds = await kindPills();
    // 全部类型 + 人名(计数=挂人名标签的任务数=TASK_A/TASK_B=2)
    expect(kinds.some((k) => k.includes("全部类型"))).toBe(true);
    const renPill = kinds.find((k) => k.includes("人名"));
    expect(renPill).toBeDefined();
    expect(renPill).toContain("2");
  });

  it("选「人名」→ 任务缩到挂人名标签的、标签 pill 收到人名类内(丙/无标签消失)", async () => {
    await clickKind("人名");
    // 列表:两个人名任务在、项目任务不在
    await browser.waitUntil(async () => (await shows(TASK_A)) && !(await shows(TASK_C)), {
      timeout: 8000,
      timeoutMsg: "选人名后列表未缩到人名任务",
    });
    expect(await shows(TASK_B)).toBe(true);
    // 标签 pill 收到人名类:所有 + 张三 + 李四;无「无标签」、无项目标签
    const labels = await topicPillLabels();
    expect(labels.some((l) => l.includes("所有"))).toBe(true);
    expect(labels.some((l) => l.includes(P1))).toBe(true);
    expect(labels.some((l) => l.includes(P2))).toBe(true);
    expect(labels.some((l) => l.includes("无标签"))).toBe(false);
    expect(labels.some((l) => l.includes(PROJ))).toBe(false);
  });

  it("类型内再钻到具体某人 → 只剩该人的任务", async () => {
    await clickTopic(P1); // 张三
    await browser.waitUntil(async () => (await shows(TASK_A)) && !(await shows(TASK_B)), {
      timeout: 8000,
      timeoutMsg: "钻到张三后未只剩张三的任务",
    });
    expect(await shows(TASK_C)).toBe(false);
  });

  it("回「全部类型」→ 恢复全量(项目任务与无标签 pill 回来)", async () => {
    await clickKind("全部类型");
    await browser.waitUntil(async () => await shows(TASK_C), {
      timeout: 8000,
      timeoutMsg: "回全部类型后项目任务未恢复",
    });
    expect(await shows(TASK_A)).toBe(true);
    const labels = await topicPillLabels();
    expect(labels.some((l) => l.includes("无标签"))).toBe(true);
    expect(labels.some((l) => l.includes(PROJ))).toBe(true);
  });
});
