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
    // The card reloaded; it now wears the due-today accent class.
    const hasAccent = await browser.execute((title) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) =>
        c.textContent.includes(title),
      );
      return card?.classList.contains("due-today") ?? false;
    }, T);
    expect(hasAccent).toBe(true);
  });

  it("⋯ 菜单优先级 → 选「高」→ 落库 priority=3", async () => {
    // ㊺: open the priority picker from the ⋯ menu's 优先级, then pick 高 (.choice.p3).
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

  /** 库里此刻有多少张「今天到期 / 已逾期」(与前端 dueState 同口径:纯日历日字符串比)。 */
  async function dueCounts() {
    const today = ymd(0);
    const all = await invoke("list_tasks");
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

  it("点一下 → 只剩到期与逾期的卡;再点 → 全部回来", async () => {
    await browser.execute(() => document.querySelector("#due-soon").click());
    await browser.waitUntil(async () => !(await cardTitles()).includes(FREE), {
      timeout: 8000,
      timeoutMsg: "点「到期」后没截止的卡还在",
    });
    const titles = await cardTitles();
    expect(titles).toContain(NOW);
    expect(titles).toContain(LATE);
    expect((await chip()).active).toBe(true);

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
});
