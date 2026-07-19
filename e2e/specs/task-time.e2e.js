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
