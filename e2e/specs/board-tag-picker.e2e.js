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
  // 24 个汉字 ≈ 288px(--fs-12)—— 比窄列里的卡片内容宽(≈134)宽一倍有余。
  const LONG = "E2E特别长的标签名字用来看它会不会把卡片撑破哦";
  let taskId;

  before(async () => {
    await invoke("create_topic", { title: EXIST });
    await invoke("create_topic", { title: LONG }).catch(() => {}); // 只当候选,不挂到任务上
    taskId = await invoke("create_task", { title: TASK, topicId: null }); // 生而无标签
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
  });

  // ⛔ 别把窄窗泄漏给后面的 spec(同 task-time.e2e.js 那条纪律)——最后一例会把窗设窄。
  after(async () => {
    await browser.setWindowSize(1100, 700);
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

  it("keepOpen:选一个不收起 → 可连续再加,已加的即时从候选消失", async () => {
    const NEW2 = "E2E-连加第二个标签";
    const setSearch = (name) =>
      browser.execute(
        (title, n) => {
          const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
          const inp = c.querySelector(".topic-search");
          inp.value = n;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        },
        TASK,
        name,
      );

    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-search").waitForExist({ timeout: 5000 });

    // 选既有 EXIST:选完选择器**不收起**(keepOpen),标签即刻挂上。
    await setSearch(EXIST);
    await card.$(`.choice=${EXIST}`).waitForExist({ timeout: 5000 });
    await browser.execute(
      (title, name) => {
        const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
        [...c.querySelectorAll(".choice")].find((b) => b.textContent === name).click();
      },
      TASK,
      EXIST,
    );
    await browser.waitUntil(async () => (await tagTitles()).includes(EXIST), {
      timeout: 8000,
      timeoutMsg: "EXIST 未挂上",
    });
    // 选完选择器仍在(没收起),且 EXIST 已从候选隐藏(避免重复挂)。
    expect(await card.$(".topic-search").isExisting()).toBe(true);
    await setSearch(EXIST);
    await browser.waitUntil(async () => !(await $(`.tcard*=${TASK}`).$(`.choice=${EXIST}`).isExisting()), {
      timeout: 5000,
      timeoutMsg: "已加的标签仍留在候选里",
    });

    // 同一次选择器会话里再内联新建第二个,也一并挂上 —— 无需重开 ⋯ 菜单。
    await setSearch(NEW2);
    await card.$(".choice.create").waitForExist({ timeout: 5000 });
    await browser.execute((title) => {
      const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(title));
      c.querySelector(".choice.create").click();
    }, TASK);
    await browser.waitUntil(
      async () => {
        const t = await tagTitles();
        return t.includes(EXIST) && t.includes(NEW2);
      },
      { timeout: 8000, timeoutMsg: "连加的两个标签未同时挂到任务上" },
    );

    // Esc 收起,连加结束。
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await browser.waitUntil(async () => !(await $(`.tcard*=${TASK}`).$(".topic-search").isExisting()), {
      timeout: 5000,
      timeoutMsg: "Esc 后选择器未收起",
    });
  });

  // 长标签名的候选 pill:名字曾在 pill **内部**折行(窗 950 / 卡宽 161 / 24 个汉字 ⇒ 3 行、
  // 高 46),灵感那侧早有整套省略号、看板这侧一条都没有 = 同端内的漂移。
  // ⛔ **两半判据缺一不可**:只断言「收成一行」,单搬 `white-space: nowrap` 就能骗过它,
  //    而那正是 510 试过并撤回的形(长名字当场撑破卡片);只断言「不撑破」,今天不改也是绿的
  //    (它本来就折在卡片里面)。⇒ 一行 **且** 不溢出,两条一起才钉得住。
  it("长标签名的候选 pill:窄卡上省略号收成一行,卡片与列体都不横向溢出", async () => {
    await browser.setWindowSize(950, 700);
    await browser.pause(250);
    await boardAction(TASK, "标签");
    const card = await $(`.tcard*=${TASK}`);
    await card.$(".topic-choices").waitForExist({ timeout: 5000 });
    await card.$(`.choice=${LONG}`).waitForExist({ timeout: 5000 });

    const m = await browser.execute(
      (task, long) => {
        const c = [...document.querySelectorAll(".tcard")].find((x) => x.textContent.includes(task));
        const pill = [...c.querySelectorAll(".topic-choices .choice")].find((b) => b.textContent === long);
        const body = c.closest(".col-body") ?? c.parentElement;
        // ⛔ 行数**别数 rect 个数**:同一行上会有多个 rect(修好之后这枚实测 2 个 rect 同 y、
        //    同高)。数**不同的 y** 才是行数。字据与复现见 e2e/probes/tagpick-long.e2e.js 头注。
        const rg = document.createRange();
        rg.selectNodeContents(pill);
        const ys = new Set([...rg.getClientRects()].map((r) => Math.round(r.y)));
        return {
          cardW: c.clientWidth,
          cardOverflow: c.scrollWidth - c.clientWidth,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          pillLines: ys.size,
          clipped: pill.scrollWidth > pill.clientWidth,
        };
      },
      TASK,
      LONG,
    );

    // 前置断言:确认真的在窄列里量。⛔ 少了它,窗宽哪天被别处改宽,下面四条会安静地恒绿。
    expect(m.cardW).toBeLessThan(180);
    expect(m.pillLines).toBe(1); // 收成一行
    expect(m.clipped).toBe(true); // 且那一行真的被裁了(省略号在干活,不是名字碰巧够短)
    expect(m.cardOverflow).toBe(0); // ⛔ 没拿「撑破卡片」换「收成一行」
    expect(m.bodyOverflow).toBe(0);
  });
});
