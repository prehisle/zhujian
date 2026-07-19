import { $, expect } from "@wdio/globals";
import { browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "./support.js";

// 灵感 · 标签筛选 + 文本过滤(共享件 filter-bar.ts,与看板同源同款——board.e2e.js
// 覆盖看板侧,这里覆盖灵感侧的接线与灵感特有路径:自动挂标签、离场后重渲筛空空态)。

const T1 = "E2EF-绿茶";
const T2 = "E2EF-器物";
const A = "E2EF-买绿茶叶";
const B = "E2EF-修紫砂壶";
const C = "E2EF-随手一记";

describe("灵感 · 标签筛选与文本过滤", () => {
  let t1Id;
  let t2Id;
  let bId;

  // `*=` 文本匹配不能跟在后代组合子后面(support.js cornerMenuAction 注释的既有坑),
  // 裸 `.note*=` 即可——.note 只在灵感视图用(看板卡是 .tcard),无歧义。
  const exists = (text) => $(`.note*=${text}`).isExisting();

  // Type into the filter box like a user: set value + fire input (filters on every
  // keystroke through refresh(); the box lives OUTSIDE renderFilterPills' rebuild).
  async function setFilter(text) {
    await browser.execute((v) => {
      const box = document.querySelector("#idea-filter");
      box.value = v;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
  }

  // Click the pill whose label contains `label` (textContent also carries the count).
  async function pickPill(label) {
    await browser.execute((l) => {
      const p = [...document.querySelectorAll(".v-inbox .tf-pill")].find((x) =>
        x.textContent.includes(l),
      );
      if (!p) throw new Error("pill not found: " + l);
      p.click();
    }, label);
  }

  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    t1Id = await invoke("create_topic", { title: T1 });
    t2Id = await invoke("create_topic", { title: T2 });
    const aId = await invoke("capture_note", { content: A });
    await invoke("file_note_to_topic", { id: aId, topicId: t1Id, newTitle: null });
    bId = await invoke("capture_note", { content: B });
    await invoke("file_note_to_topic", { id: bId, topicId: t2Id, newTitle: null });
    await invoke("capture_note", { content: C });
    await goNotebook("inbox");
    await browser.waitUntil(async () => await exists(C), { timeout: 8000 });
  });

  // 筛选态(topic/text)是模块态、跨视图切换存活,所有 spec 共享一个 app 进程——
  // 离开时归还「所有」+清词,再清光本 spec 造的一切:clearInbox 清活跃想法(A/C 与
  // 两条 NEW),B 已被最后一例软删进回收站、clearInbox 不管回收站,得单独 purge;
  // 标签最后删(先条目后标签)。别把筛选/条目/标签泄漏给后续 spec。
  after(async () => {
    await setFilter("");
    await pickPill("所有");
    await clearInbox();
    // B 只有在最后一例真跑到软删时才在回收站;中途失败时它还活跃、已被 clearInbox
    // 清掉——按实际归宿清,teardown 对非全绿路径也稳。
    const archived = await invoke("list_archived");
    if (archived.some((n) => n.id === bId)) await invoke("purge_note", { id: bId });
    await invoke("delete_topic", { id: t1Id });
    await invoke("delete_topic", { id: t2Id });
  });

  it("点标签 pill → 只显该标签的灵感;无标签 → 只显未打标签的;所有 → 全部回来", async () => {
    await pickPill(T1);
    await browser.waitUntil(
      async () => (await exists(A)) && !(await exists(B)) && !(await exists(C)),
      { timeout: 8000 },
    );

    await pickPill("无标签");
    await browser.waitUntil(
      async () => (await exists(C)) && !(await exists(A)) && !(await exists(B)),
      { timeout: 8000 },
    );

    await pickPill("所有");
    await browser.waitUntil(
      async () => (await exists(A)) && (await exists(B)) && (await exists(C)),
      { timeout: 8000 },
    );
  });

  it("输入过滤词 → 只显匹配正文的灵感;清空 → 全部回来", async () => {
    await setFilter("紫砂");
    await browser.waitUntil(
      async () => (await exists(B)) && !(await exists(A)) && !(await exists(C)),
      { timeout: 8000 },
    );

    await setFilter("");
    await browser.waitUntil(
      async () => (await exists(A)) && (await exists(B)) && (await exists(C)),
      { timeout: 8000 },
    );
  });

  it("筛空 → 显示「没有匹配」空态(compose 常驻),不冒充没有灵感", async () => {
    await setFilter("绝无此词xyzq");
    await browser.waitUntil(
      async () => (await $(".v-inbox .center .big").getText()).includes("没有匹配"),
      { timeout: 8000 },
    );
    // 记灵感的输入框还在——筛空只清列表,不收走录入入口。
    await expect($(".v-inbox .compose-input")).toExist();
    await setFilter("");
    await browser.waitUntil(async () => await exists(A), { timeout: 8000 });
  });

  it("筛着标签记灵感 → 新灵感自动挂该标签、留在视野里", async () => {
    const NEW = "E2EF-新茶到了";
    await pickPill(T1);
    await browser.waitUntil(async () => !(await exists(C)), { timeout: 8000 });

    await browser.execute((v) => {
      const input = document.querySelector(".v-inbox .compose-input");
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, NEW);
    await $(".v-inbox .compose-add").click();

    // 新卡在 T1 筛选下可见(=已挂上 T1,否则会被当场滤掉)。
    await browser.waitUntil(async () => await exists(NEW), { timeout: 8000 });
    const ideas = await invoke("list_ideas");
    const born = ideas.find((i) => i.content === NEW);
    expect(born.topics.map((t) => t.title)).toContain(T1);
  });

  it("标签+文本叠加过滤(交集);pills 计数保持全量、不随文本收缩", async () => {
    // 上一例后 T1 下有两条:A 与「E2EF-新茶到了」。再播一条无标签、但同样含
    // 「买」的 D——若实现忽略标签维度只做文本过滤,D 会漏出来,交集断言才真钉得住。
    const NEW = "E2EF-新茶到了";
    const D = "E2EF-无标买粮";
    await invoke("capture_note", { content: D });
    await pickPill(T1);
    await browser.waitUntil(async () => (await exists(A)) && (await exists(NEW)), {
      timeout: 8000,
    });

    await setFilter("买");
    // 交集:A(T1 且含「买」)在;NEW 被文本维度排除;D 被标签维度排除。
    await browser.waitUntil(
      async () => (await exists(A)) && !(await exists(NEW)) && !(await exists(D)),
      { timeout: 8000 },
    );

    // 两维正交:文本只收窄列表,不改「T1 下有多少」——pill 计数仍是全量 2。
    const n = await browser.execute((l) => {
      const p = [...document.querySelectorAll(".v-inbox .tf-pill")].find((x) =>
        x.textContent.includes(l),
      );
      return p.querySelector(".tf-n").textContent;
    }, T1);
    expect(n).toBe("2");
    await setFilter("");
  });

  it("文本过滤着记灵感 → 过滤词自动清空,新卡可见", async () => {
    const NEW = "E2EF-又一记";
    await pickPill("所有");
    await setFilter("紫砂");
    await browser.waitUntil(async () => !(await exists(A)), { timeout: 8000 });

    await browser.execute((v) => {
      const input = document.querySelector(".v-inbox .compose-input");
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, NEW);
    await $(".v-inbox .compose-add").click();

    await browser.waitUntil(async () => (await exists(NEW)) && (await exists(A)), {
      timeout: 8000,
    });
    expect(await browser.execute(() => document.querySelector("#idea-filter").value)).toBe("");
  });

  it("筛着标签删掉其最后一条灵感 → 离场后重渲出「筛空」空态,不留白", async () => {
    await pickPill(T2); // 只剩 B
    await browser.waitUntil(async () => (await exists(B)) && !(await exists(A)), {
      timeout: 8000,
    });

    await inboxAction(B, "删除"); // 软删进回收站;离场动画完成后 refresh 重渲
    await browser.waitUntil(
      async () => (await $(".v-inbox .center .big").getText()).includes("下没有灵感"),
      { timeout: 8000 },
    );
  });
});
