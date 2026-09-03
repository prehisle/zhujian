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
      const p = [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((x) =>
        x.textContent.includes(l),
      );
      if (!p) throw new Error("pill not found: " + l);
      p.click();
    }, label);
  }

  // 超时时把现场压成一行接在断言消息后(同 439 给 zz-verify-163 那例做的取证面)。
  // ⚠ **由头**:这支在 Linux CI 上红过一趟(gate/win-desk/88fa43c),两例都只报
  // `waitUntil condition timed out after 8000ms` —— 光这一句**看不出它在等什么**,
  // 于是那笔账只能记成「疑似 flaky」躺着(backlog 测试与工装 66)。
  // ⭐ 这五格是照「能分开哪几种局面」选的,不是随手抄 DOM:
  //   ①`ideas`(库) vs ②`cards`(屏)分得开「压根没落库」与「落了库屏上没有」;
  //   ③`filter`/④`pills` 说清是不是被筛选滤掉的;⑤`compose` 说清输入框里当时还有没有字
  //   (compose bar 每次 refresh 都重建 ⇒ 值可能丢在游离的旧节点上,而那是这两例最可疑的一形)。
  async function scene() {
    const dom = await browser.execute(() => ({
      filter: document.querySelector("#idea-filter")?.value ?? "(没有过滤框)",
      pills: [...document.querySelectorAll("#idea-topic-filter .tf-pill.active")].map((p) =>
        p.textContent.trim(),
      ),
      cards: [...document.querySelectorAll(".note")].map((n) => n.textContent.trim().slice(0, 20)),
      center: document.querySelector(".v-inbox .center .big")?.textContent ?? "(没有空态)",
      compose: document.querySelector(".v-inbox .compose-input")?.value ?? "(没有输入框)",
    }));
    // 库那半单独问一次:list_ideas = 灵感视图那份(inbox + filed 合并),与屏上那份同源不同路。
    const ideas = (await invoke("list_ideas")).map((i) => String(i.content ?? "").slice(0, 20));
    return JSON.stringify({ ...dom, ideas });
  }

  // waitUntil 的包装:超时时先抄现场再抛。⛔ 别改用 wdio 的 `timeoutMsg` —— 那是**调用前**
  // 就求好值的字符串,抄不到"超时那一刻"的现场。
  async function waitScene(cond, what, timeout = 8000) {
    try {
      await browser.waitUntil(cond, { timeout });
    } catch (e) {
      throw new Error(`${what} —— 超时那一刻的现场:${await scene()}(原始:${e.message})`);
    }
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
    // 桌面单选惯例下,单击 T1 就把选集替换成只 T1;但上一例可能残留别的选态,先归
    // 「所有」再单击 T1,保证这里只筛 T1(不依赖前例的残留选态)。
    await pickPill("所有");
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
      const p = [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((x) =>
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

    await waitScene(
      async () => (await exists(NEW)) && (await exists(A)),
      "记完新灵感后没能同时看见新卡与那条被过滤词滤掉的(= 过滤词没自动清空,或新卡压根没落库)",
    );
    expect(await browser.execute(() => document.querySelector("#idea-filter").value)).toBe("");
  });

  it("筛着标签删掉其最后一条灵感 → 离场后重渲出「筛空」空态,不留白", async () => {
    // ⛔ 别省这一句:上一例若红在「过滤词自动清空」那格,词就还留在框里,而空态三档里
    // **文本过滤优先**(src/inbox.ts:1276)⇒ 屏上是「没有匹配「…」的随记」,本例末尾那句
    // 便**永远等不到**、跟着一起超时。CI 上那趟(gate/win-desk/88fa43c)两例一起红正是
    // 这个连带,不是两处各自在抖 —— 清一次让本例只对自己负责(backlog 测试与工装 66)。
    await setFilter("");
    await pickPill(T2); // 只剩 B
    await browser.waitUntil(async () => (await exists(B)) && !(await exists(A)), {
      timeout: 8000,
    });

    await inboxAction(B, "删除"); // 软删进回收站;离场动画完成后 refresh 重渲
    await waitScene(
      async () => (await $(".v-inbox .center .big").getText()).includes("下没有随记"),
      "删掉筛选下最后一条之后没重渲出「筛空」空态",
    );
  });
});
