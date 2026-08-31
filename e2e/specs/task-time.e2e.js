import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

// A local calendar day `YYYY-MM-DD`, offset by N days from today — built from
// local date parts to match the frontend's localToday() (no UTC shift).
function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const taskByTitle = async (title) =>
  (await invoke("list_tasks")).find((t) => t.title === title) ?? null;

describe("任务时间维度 · 看板设置截止/优先级", () => {
  const T = "时间甲-缴水电费";

  before(async () => {
    // Create the task first, then mount the board so it renders on load().
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
  });

  it("⋯ 菜单截止 → 选日期 → 落库 due_on,卡片高亮今天", async () => {
    const today = ymd(0);
    // ㊺: the on-card chip is pure display now; open the date editor from the ⋯ menu's 截止.
    await boardAction(T, "截止");
    await $(`.tcard*=${T}`).$(".due-input").waitForExist({ timeout: 5000 });
    await browser.execute(
      (title, val) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) =>
          c.textContent.includes(title),
        );
        const input = card.querySelector(".due-input");
        input.value = val;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      T,
      today,
    );

    await browser.waitUntil(async () => (await taskByTitle(T))?.due_on === today, {
      timeout: 8000,
      timeoutMsg: "due_on 未写入库",
    });
    // 上一句等的是**库**,这一句看的是 **DOM** —— 中间必须有一次等重渲,不能靠"应该已经好了"。
    // 旧形是一次性 `browser.execute` + 一句 `expect`,而应用侧落账之后还要再走一趟 `list_tasks`
    // 才重渲整卡(`src/tasktime.ts::call` → `refresh`)⇒ 库满足的那一刻卡片往往还是**改之前**
    // 那张。旧注释「The card reloaded」是**假设**不是等待,529 那趟公开仓 CI(run 33225838969)
    // 上它真红过一次。⛔ 修法不是加 sleep(那是把判据错误当成时间不够治)。
    //
    // ⭐ 读数刻意做成**三态**:旧形那个 `?? false` 把「卡片还不在 DOM 上」和「卡片在、但没有
    // 那个类」压成同一个 false —— 前者是抖动、后者才是真缺陷,红了却分不出是哪一种。
    const readAccent = () =>
      browser.execute((title) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) =>
          c.textContent.includes(title),
        );
        if (!card) return "absent";
        return card.classList.contains("due-today") ? "accent" : "no-accent";
      }, T);
    let seen = "never-read";
    await browser
      .waitUntil(async () => (seen = await readAccent()) === "accent", {
        timeout: 8000,
        timeoutMsg: "卡片没等到 due-today",
      })
      // `timeoutMsg` 是**调用那一刻**就定死的字符串,带不进最后一眼的读数 ⇒ 在这儿分岔。
      .catch((e) => {
        // ⛔ **别把「一次都没读成」也改写成「没等到那个类」** —— `readAccent` 自己抛(会话断了 /
        // execute 失败)时 `seen` 还是初值,照下面那两支写出来的话,消息会**指着一个没出问题的
        // 地方**,而那正是这条账本身在治的病。原样抛。⭐ 这条有刀:摘掉它之后,一次
        // `javascript error` 被改写成「卡片一直在 DOM 上⋯这是真缺陷」(读数在 progress-log 533)。
        if (seen === "never-read") throw e;
        throw new Error(
          seen === "absent"
            ? "8s 内卡片一直不在 DOM 上 —— 这是重渲/驱动那一侧的事,不是 due-today 没上"
            : seen === "accent"
              ? "恰在超时边界上才读到 due-today(条件已满足但 waitUntil 已判超时)"
              : `8s 内卡片一直在 DOM 上、却始终没有 due-today(最后一眼:${seen})—— 这是真缺陷`,
        );
      });
  });

  it("⋯ 菜单优先级 → 选「P0」→ 落库 priority=3", async () => {
    // ㊺: open the priority picker from the ⋯ menu's 优先级, then pick P0 (.choice.p3;
    // 506 起最高档屏上读作 P0,库里仍是 3 —— 选择器与断言走类名,不受改名影响)。
    await boardAction(T, "优先级");
    await $(`.tcard*=${T}`).$(".choice.p3").waitForExist({ timeout: 5000 });
    await browser.execute((title) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) =>
        c.textContent.includes(title),
      );
      card.querySelector(".choice.p3").click();
    }, T);

    await browser.waitUntil(async () => (await taskByTitle(T))?.priority === 3, {
      timeout: 8000,
      timeoutMsg: "priority 未写入库",
    });
    // Chained $(...).$(...) is fine; only combined `descendant *=text` is not.
    await expect($(`.tcard*=${T}`).$(".chip.pri.set.p3")).toExist();
  });
});

// 502:到期汇总(顶栏「逾期 M · 今天 N」+ 点开只看到期)。这是「截止时间提醒」的最小
// 可用形——不加通知插件、不动数据模型,只把已经在库里的 due_on 汇总到一处。
//
// ⚠ 计数按**整块看板**算,而看板上还有别的 describe / 别的 spec 留下的卡 ⇒ 断言一律走
// **基线 + 增量**,不写死绝对数(首版写死「今天 1」,同文件上一个 describe 那张「今天」
// 截止的卡当场把它打成「今天 2」)。
describe("任务时间维度 · 到期汇总", () => {
  const NOW = "到期甲-今天交的";
  const LATE = "到期乙-早该做的";
  const FREE = "到期丙-没截止";
  const ids = [];
  let base = { now: 0, late: 0 };

  /** 库里此刻有多少张「今天到期 / 已逾期」(与前端 dueAttentionState 同口径:纯日历日
   *  字符串比 + 完成的任务不算——做完的不该继续占逾期计数,即使截止日已经过去)。 */
  async function dueCounts() {
    const today = ymd(0);
    const all = (await invoke("list_tasks")).filter((t) => t.status !== "done");
    return {
      now: all.filter((t) => t.due_on === today).length,
      late: all.filter((t) => t.due_on && t.due_on < today).length,
    };
  }
  const chip = () =>
    browser.execute(() => {
      const b = document.querySelector("#due-soon");
      return {
        shown: !b.hidden,
        text: b.querySelector(".lbl").textContent,
        late: b.classList.contains("late"),
        active: b.classList.contains("active"),
      };
    });
  /** 汇总钮此刻该说什么(一条都没有 = 整枚藏起)。 */
  async function expectChip(now, late) {
    const c = await chip();
    if (now + late === 0) {
      expect(c.shown).toBe(false);
      return;
    }
    expect(c.shown).toBe(true);
    expect(c.text).toBe(late > 0 ? `逾期 ${late} · 今天 ${now}` : `今天到期 ${now}`);
    expect(c.late).toBe(late > 0);
  }
  const cardTitles = () =>
    browser.execute(() => [...document.querySelectorAll(".tcard .ttitle")].map((p) => p.textContent));

  before(async () => {
    base = await dueCounts(); // 先取基线,再种自己的三张
    for (const [title, due] of [[NOW, ymd(0)], [LATE, ymd(-3)], [FREE, null]]) {
      const id = await invoke("create_task", { title });
      ids.push(id);
      if (due) await invoke("set_task_due", { id, dueOn: due });
    }
    await goNotebook("board");
    await $(`.tcard*=${FREE}`).waitForExist({ timeout: 8000 });
  });

  after(async () => {
    await browser.execute(() => {
      const b = document.querySelector("#due-soon");
      if (b && b.classList.contains("active")) b.click(); // ⛔ 别把「只看到期」泄漏给后面
    });
    for (const id of ids) {
      await invoke("archive_task", { id });
      await invoke("purge_task", { id });
    }
  });

  it("有逾期 → 顶栏报出逾期与今天各几条,并描成朱砂", async () => {
    await expectChip(base.now + 1, base.late + 1);
    expect((await chip()).active).toBe(false);
  });

  it("点一下 → 只剩到期与逾期的卡、按最近到期在前排;再点 → 全部回来", async () => {
    await browser.execute(() => document.querySelector("#due-soon").click());
    await browser.waitUntil(async () => !(await cardTitles()).includes(FREE), {
      timeout: 8000,
      timeoutMsg: "点「到期」后没截止的卡还在",
    });
    const titles = await cardTitles();
    expect(titles).toContain(NOW);
    expect(titles).toContain(LATE);
    expect((await chip()).active).toBe(true);

    // B:列内序变成按截止日 —— LATE(逾期 3 天)该排在 NOW(今天到期)前面,尽管创建顺序
    // 是 NOW 先建、LATE 后建(手动/创建时间序都会把 NOW 排前面,能把两种排序分辨出来)。
    // 两个都在默认落点 todo 列,故直接在该列内比相对顺序,不受别的 spec 遗留卡干扰。
    const todoOrder = await browser.execute(() =>
      [...document.querySelectorAll(".col.todo .tcard .ttitle")].map((p) => p.textContent),
    );
    expect(todoOrder.indexOf(LATE)).toBeLessThan(todoOrder.indexOf(NOW));

    await browser.execute(() => document.querySelector("#due-soon").click());
    await browser.waitUntil(async () => (await cardTitles()).includes(FREE), {
      timeout: 8000,
      timeoutMsg: "再点一次没回到全部",
    });
  });

  it("一条到期都没有时整枚藏起(不摆一个恒亮的 0)", async () => {
    // 这一格要的是「真的一条都没有」,故连基线那几张也临时摘掉截止 —— 记下原值,
    // finally 里逐条还回去(⛔ 别留下改过的别人的数据)。
    const today = ymd(0);
    const others = (await invoke("list_tasks")).filter(
      (t) => t.due_on && t.due_on <= today && !ids.includes(t.id),
    );
    try {
      for (const t of others) await invoke("set_task_due", { id: t.id, dueOn: null });
      for (const id of ids) await invoke("set_task_due", { id, dueOn: null });
      await goNotebook("board");
      await $(`.tcard*=${FREE}`).waitForExist({ timeout: 8000 });
      await browser.waitUntil(async () => (await chip()).shown === false, {
        timeout: 8000,
        timeoutMsg: "一条到期都没有了,汇总钮还挂着",
      });
    } finally {
      for (const t of others) await invoke("set_task_due", { id: t.id, dueOn: t.due_on });
    }
  });

  it("完成的任务不再计入逾期/今天,卡片也不再带朱砂强调(G)", async () => {
    const DONE_LATE = "到期戊-已完成但曾逾期";
    const before = await dueCounts(); // dueCounts() 已排除 done,这是「加一张 done 卡不该变」的基线
    const id = await invoke("create_task", { title: DONE_LATE });
    try {
      await invoke("set_task_due", { id, dueOn: ymd(-5) });
      await invoke("update_task_status", { id, to: "done" });
      await goNotebook("board");
      await $(".col.done").$(`.tcard*=${DONE_LATE}`).waitForExist({ timeout: 8000 });
      // 顶栏汇总:done 卡不该把逾期数顶上去(数字不变,或本就该藏起的仍然藏着)。
      await expectChip(before.now, before.late);
      // 卡片本身:done 列里那张不该再带 due-overdue 朱砂强调。
      const accent = await browser.execute((title) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
        return card ? card.classList.contains("due-overdue") : "absent";
      }, DONE_LATE);
      expect(accent).toBe(false);
    } finally {
      await invoke("archive_task", { id });
      await invoke("purge_task", { id });
    }
  });
});

// 510:窄列里 `.task-meta` 的两个行内编辑器,文字不许排成两行、卡片不许被撑破。
//
// ⚠ **判据走「这段文字排了几行」,不看高度** —— 拿 Range 量 client rects,数**不同的 y** 有几个。
// 高度会随字号档 / 行高 / padding 漂,而「排了几行」是那件事本身。
// ⛔ **别退回「数 rect 个数」**(510 那版就是这么写的,522 在 WebView2 138 上实测证伪):
// 同一行上可以有多个 rect(实测同 `y` 同高、宽 288 与 96 的两个)⇒ 那把尺答的是「这段文字被
// 切成了几段」,不是「排了几行」。它在这两例上今天恰好还绿,是因为 P0/P1/P2/清除 都是固定短词
// 不触发分段 —— 那是运气不是判据,失效方向是**假红**。字据与复现见 e2e/probes/tagpick-long.e2e.js 头注。
// ⚠ 新尺仍假定「同一行上各段 rect 的顶边相同」:哪天这几枚钮里混进**不同字号的段**(加图标那种),
// 同一行也可能落进两个 y ⇒ 假红会以更窄的形回来。⛔ 这是推理不是字据(没造过混合字号的输入)。
// ⚠ **窗宽 950 是量出来的,别改成 1100**:1100 那档卡宽 198,改前改后都不折
// ⇒ 在那儿断言等于什么都没断言(改前的实测:折行只在 1000 及以下出现)。
// ⚠ 四条断言**缺一不可**,它们盯的是两个不同的患:`lines` 盯钮在自己内部折(屏上读作
// 「清 / 除」),两条 `overflow` 盯「只加 nowrap 不让整枚换行」那个替代患 —— 钮缩到
// min-content 就顶住不动,整行撑破卡片、列体长出横滚条。
describe("任务时间维度 · 窄列里行内编辑器不折行也不撑破卡片", () => {
  const T = "窄列甲-缴水电费";
  let id;

  before(async () => {
    id = await invoke("create_task", { title: T });
    await invoke("set_task_due", { id, dueOn: ymd(0) });
    await goNotebook("board"); // 它自己会把窗摆回 1100,故窄窗必须在它之后设
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await browser.setWindowSize(950, 700);
    await browser.pause(250);
  });

  after(async () => {
    await browser.setWindowSize(1100, 700); // ⛔ 别把窄窗泄漏给后面的 spec
    await invoke("archive_task", { id });
    await invoke("purge_task", { id });
  });

  /** slot 里每个**有文字**的孩子各排了几行(`.due-input` 是 input,没有文字节点,自然落选)
      + 卡片与列体的横向溢出。 */
  const measure = (title, slotSel) =>
    browser.execute(
      (t, sel) => {
        const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
        const slot = card.querySelector(sel);
        const body = card.closest(".col-body") ?? card.parentElement;
        const lines = (elm) => {
          const r = document.createRange();
          r.selectNodeContents(elm);
          return new Set([...r.getClientRects()].map((rc) => Math.round(rc.y))).size;
        };
        return {
          cardW: card.clientWidth,
          cardOverflow: card.scrollWidth - card.clientWidth,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          lines: [...slot.children].filter((b) => b.textContent.trim()).map(lines),
        };
      },
      title,
      slotSel,
    );

  it("优先级选择器:四枚钮各排一行,卡片与列体都不横向溢出", async () => {
    await boardAction(T, "优先级");
    await $(`.tcard*=${T}`).$(".pri-slot .choice").waitForExist({ timeout: 5000 });
    const m = await measure(T, ".pri-slot");
    // 前置断言:确认真的在窄列里量。⛔ 少了它,窗宽哪天被别处改宽,上面三条会安静地恒绿。
    expect(m.cardW).toBeLessThan(180);
    expect(m.lines).toEqual([1, 1, 1, 1]);
    expect(m.cardOverflow).toBe(0);
    expect(m.bodyOverflow).toBe(0);
  });

  it("截止编辑器:「清除」链接排一行,卡片与列体都不横向溢出", async () => {
    await boardAction(T, "截止");
    await $(`.tcard*=${T}`).$(".due-slot .due-input").waitForExist({ timeout: 5000 });
    const m = await measure(T, ".due-slot");
    expect(m.cardW).toBeLessThan(180);
    expect(m.lines).toEqual([1]);
    expect(m.cardOverflow).toBe(0);
    expect(m.bodyOverflow).toBe(0);
  });
});

// 524:更窄的一档 —— 原生 `<input type=date>` 有自己的最小内在宽度(实测恒 128px),
// 510 的 `flex-wrap` 治不了它(换行只在「两个以上的东西挤不下」时有用,这里是**一个东西
// 自己就太宽**)。修法 = 与 topic-slot/chip 同一套的**两层 `min-width: 0`**。
//
// ⚠ **窗宽 820 是量出来的,别改宽**:上面那只用的 950 → 卡宽 161,而这个患的门槛在**卡宽 138**
// ⇒ 在 950 那档断言等于什么都没断言(改前改后都是 0)。820 → 卡宽 **128**,改前 `card+13`
// / 列体横滚条 `body+8`,余量够大。
// ⚠ **只断言不溢出,不断言「日期读得全」**:原生 date 的内容在 UA shadow DOM 里,页内量不到;
// 逐档可读性是**截图**判的(探针 `pri-fold` 的 `out-due-*.png`),读数在 progress-log 524 ——
// ⭐ 卡宽 ≥128 日期完整,118 起裁成 `2026/08/`。**那是知情的取舍,不是这只测该管的事。**
describe("任务时间维度 · 更窄的列里截止编辑器也不撑破卡片", () => {
  const T = "窄列乙-缴水电费";
  let id;

  before(async () => {
    id = await invoke("create_task", { title: T });
    await invoke("set_task_due", { id, dueOn: ymd(0) });
    await goNotebook("board"); // 它自己会把窗摆回 1100,故窄窗必须在它之后设
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await browser.setWindowSize(820, 700);
    await browser.pause(250);
  });

  after(async () => {
    await browser.setWindowSize(1100, 700); // ⛔ 别把窄窗泄漏给后面的 spec
    await invoke("archive_task", { id });
    await invoke("purge_task", { id });
  });

  it("卡宽 ~128 时:截止编辑器缩得下去,卡片与列体都不横向溢出", async () => {
    await boardAction(T, "截止");
    await $(`.tcard*=${T}`).$(".due-slot .due-input").waitForExist({ timeout: 5000 });
    const m = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      const body = card.closest(".col-body") ?? card.parentElement;
      const input = card.querySelector(".due-slot .due-input");
      return {
        cardW: card.clientWidth,
        inputW: Math.round(input.getBoundingClientRect().width),
        cardOverflow: card.scrollWidth - card.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
      };
    }, T);
    // 前置断言:确认真的在那一档量。⛔ 少了它,窗宽哪天被别处改宽,下面三条会安静地恒绿。
    expect(m.cardW).toBeLessThan(140);
    // ⭐ 承重的那一格:输入框**真的缩了**(改前它在任何窗宽下恒 128)。
    // ⛔ 只断言「不溢出」不够 —— 哪天有人把整个编辑器藏起来,那两格也会是 0。
    expect(m.inputW).toBeLessThan(120);
    expect(m.cardOverflow).toBe(0);
    expect(m.bodyOverflow).toBe(0);
  });
});
