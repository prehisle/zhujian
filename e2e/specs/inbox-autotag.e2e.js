import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxPickTopicPill, inboxCompose } from "./support.js";

// 灵感 · 「筛着标签记灵感 → 那几枚标签自动挂上」(用户 2026-08-31 拍板:相关的标签
// 都打上)。inbox-filter.e2e.js 覆盖的是**单选一枚**那档(它顺带钉着筛选/过滤的其余
// 语义,故顺序耦合紧);这里单开一支覆盖此前没有的两格,自造自清、不与那支共享状态:
//   ① 多选(Ctrl+单击)下**每一枚**都挂上——此前刻意不挂、改清标签筛选;
//   ② 只筛了**类型**没钻到具体标签时,新灵感生而无标签会被类型维当场滤掉 ⇒ 收尾要让
//      类型筛选让位(此前只清了文本/标签/时间三维,漏了这一格,新卡「记了却没出现」)。
describe("灵感 · 筛着标签记灵感自动挂标签", () => {
  const T1 = "E2EAT-读书";
  const T2 = "E2EAT-手账";
  const K1 = "E2EAT-张三"; // 打上 kind「人名」
  const SEED_1 = "E2EAT-旧的读书条";
  const SEED_K = "E2EAT-旧的张三条";
  let t1Id, t2Id, k1Id;

  const exists = (text) => $(`.note*=${text}`).isExisting();
  // Ctrl+单击 = 桌面的多选手势(平点是「只筛这一个」的替换)。⛔ 限定在标签轴那一行:
  // `.tf-pill` 在类型轴/时间轴上也发,裸选会点错行(support.js pickTopicPill 的判例)。
  const ctrlPill = (id) =>
    browser.execute((i) => {
      const p = document.querySelector(`#idea-topic-filter .tf-pill[data-topic-id="${i}"]`);
      if (!p) throw new Error("标签轴上没有这枚 pill:" + i);
      p.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    }, id);
  const clickKind = (label) =>
    browser.execute((l) => {
      const p = [...document.querySelectorAll("#idea-kind-filter .kind-pill")].find((x) =>
        x.textContent.includes(l),
      );
      if (!p) throw new Error("类型轴上没有这枚 pill:" + l);
      p.click();
    }, label);
  const kindActive = (label) =>
    browser.execute((l) => {
      const p = [...document.querySelectorAll("#idea-kind-filter .kind-pill")].find((x) =>
        x.textContent.includes(l),
      );
      return p ? p.classList.contains("active") : false;
    }, label);
  // 记一条灵感(compose 常驻,不必先开)。灌值+点钮+自证走共享件(测试与工装 66):
  // 灵感这条 bar 每次 refresh 都重建,两步之间撞上一次重渲就点在游离节点上。
  const captureIdea = (text) => inboxCompose(text);
  const topicsOf = async (content) => {
    const ideas = await invoke("list_ideas");
    const born = ideas.find((i) => i.content === content);
    expect(born).toBeDefined();
    return born.topics.map((t) => t.title).sort();
  };

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    t1Id = await invoke("create_topic", { title: T1 });
    t2Id = await invoke("create_topic", { title: T2 });
    k1Id = await invoke("create_topic", { title: K1 });
    await invoke("set_topic_kind", { id: k1Id, kind: "人名" });
    // 每枚标签下先各垫一条:0 条的标签 pill 会被藏起(renderFilterPills 的既有口径),
    // 藏了就点不着,这几条纯粹是为了让 pill 在场。
    const s1 = await invoke("capture_note", { content: SEED_1 });
    await invoke("file_note_to_topic", { id: s1, topicId: t1Id, newTitle: null });
    const s2 = await invoke("capture_note", { content: "E2EAT-旧的手账条" });
    await invoke("file_note_to_topic", { id: s2, topicId: t2Id, newTitle: null });
    const sk = await invoke("capture_note", { content: SEED_K });
    await invoke("file_note_to_topic", { id: sk, topicId: k1Id, newTitle: null });
    await goNotebook("inbox");
    await $(`.note*=${SEED_1}`).waitForExist({ timeout: 10000 });
  });

  // 筛选态(类型/标签/文本)是模块态、跨视图存活:两根轴都归还,再清光造的一切。
  after(async () => {
    await clickKind("全部类型");
    await inboxPickTopicPill("所有");
    await clearInbox();
    await invoke("delete_topic", { id: t1Id });
    await invoke("delete_topic", { id: t2Id });
    await invoke("delete_topic", { id: k1Id });
  });

  it("筛着两枚标签(Ctrl 多选)记灵感 → 两枚都挂上、留在视野里", async () => {
    const NEW = "E2EAT-两枚都要";
    await inboxPickTopicPill(T1); // 平点 = 只筛 T1
    await ctrlPill(t2Id); // Ctrl+单击 = 把 T2 加进并集
    await browser.waitUntil(async () => (await exists(SEED_1)) && (await exists("E2EAT-旧的手账条")), {
      timeout: 8000,
      timeoutMsg: "两枚标签的并集筛选没生效",
    });

    await captureIdea(NEW);

    // 新卡留在视野 = 它至少挂上了并集里的一枚(否则当场被滤掉)。
    await browser.waitUntil(async () => await exists(NEW), {
      timeout: 8000,
      timeoutMsg: "多标签筛选下记的灵感没留在视野里",
    });
    // 库里逐枚核:两枚都要在(承重的那格——此前这里只会挂 0 枚)。
    expect(await topicsOf(NEW)).toEqual([T1, T2].sort());
    // 筛选原样留着(挂上了就不必清),两枚 pill 仍高亮。
    const stillTwo = await browser.execute(
      () =>
        [...document.querySelectorAll("#idea-topic-filter .tf-pill.active")].filter((p) =>
          p.dataset.topicId,
        ).length,
    );
    expect(stillTwo).toBe(2);
  });

  it("只筛了类型(没钻到具体标签)记灵感 → 类型筛选让位,新灵感可见", async () => {
    const NEW = "E2EAT-只筛类型时记的";
    await inboxPickTopicPill("所有"); // 先归还标签轴
    await clickKind("人名"); // 只筛类型,不钻到具体某人
    await browser.waitUntil(async () => (await exists(SEED_K)) && !(await exists(SEED_1)), {
      timeout: 8000,
      timeoutMsg: "类型筛选没生效",
    });

    await captureIdea(NEW);

    // 新灵感生而无标签 = 不挂「人名」类任一标签 ⇒ 类型维不让位它就当场隐身。
    await browser.waitUntil(async () => await exists(NEW), {
      timeout: 8000,
      timeoutMsg: "只筛类型时记的灵感没出现(类型筛选没让位)",
    });
    expect(await kindActive("全部类型")).toBe(true);
    expect(await topicsOf(NEW)).toEqual([]); // 类型不是标签,没什么可挂
  });
});
