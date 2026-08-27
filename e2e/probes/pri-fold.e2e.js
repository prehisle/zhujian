import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "../specs/support.js";

// 按需探针(默认套件扫不到,要 --spec 点名):量看板 `.task-meta` 那两个行内编辑器在窄列里的折行。
// 判据不是「高度像不像两行」,而是**这段文字被排成了几行** —— 拿 Range 数 client rects,
// 一行文字恰好一个矩形,折了就 ≥2。窗宽从宽扫到窄,同时记卡片有没有被撑出横向溢出。
const WIDTHS = [1100, 1000, 950, 900, 860, 820, 780, 740, 700];

function readSlot(title, slotSel) {
  const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
  if (!card) return null;
  const slot = card.querySelector(slotSel);
  if (!slot || !slot.firstElementChild) return null;
  const lineCount = (elm) => {
    const r = document.createRange();
    r.selectNodeContents(elm);
    return r.getClientRects().length;
  };
  const body = card.closest(".col-body") ?? card.parentElement;
  const n1 = (v) => Math.round(v * 10) / 10;
  return {
    cardW: card.clientWidth,
    cardOverflow: card.scrollWidth - card.clientWidth,
    bodyOverflow: body.scrollWidth - body.clientWidth,
    slotH: n1(slot.getBoundingClientRect().height),
    kids: [...slot.children].map((b) => `${(b.textContent || b.tagName).trim()}:${n1(b.getBoundingClientRect().width)}w/${n1(b.getBoundingClientRect().height)}h/${b.textContent ? lineCount(b) : "-"}L`),
  };
}

async function sweep(title, slotSel, tag) {
  const rows = [];
  for (const w of WIDTHS) {
    await browser.setWindowSize(w, 700);
    await browser.pause(250);
    const r = await browser.execute(readSlot, title, slotSel);
    rows.push({ win: w, ...(r ?? { GONE: true }) });
  }
  console.log(`${tag} ` + JSON.stringify(rows, null, 1));
  const folded = rows.filter((r) => r.kids && r.kids.some((b) => b.endsWith("/2L") || b.endsWith("/3L")));
  const burst = rows.filter((r) => r.cardOverflow > 0 || r.bodyOverflow > 0);
  console.log(`${tag}-FOLDED-AT ` + JSON.stringify(folded.map((r) => r.win)));
  console.log(`${tag}-BURST-AT ` + JSON.stringify(burst.map((r) => `${r.win}(card+${r.cardOverflow}/body+${r.bodyOverflow})`)));
  await browser.setWindowSize(1100, 700);
  return rows;
}

describe("探针 · task-meta 行内编辑器折行", () => {
  const T = "折行探针-缴水电费";

  before(async () => {
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
  });

  it("优先级选择器:扫窗宽", async () => {
    await boardAction(T, "优先级");
    await $(`.tcard*=${T}`).$(".pri-slot .choice").waitForExist({ timeout: 5000 });
    const rows = await sweep(T, ".pri-slot", "PRI");
    await browser.saveScreenshot("e2e/probes/out-pri-1100-AFTER.png");
    expect(rows.length).toBe(WIDTHS.length);
  });

  it("截止编辑器:扫窗宽", async () => {
    const task = (await invoke("list_tasks")).find((t) => t.title === T);
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    await invoke("set_task_due", { id: task.id, dueOn: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "截止");
    await $(`.tcard*=${T}`).$(".due-slot .due-input").waitForExist({ timeout: 5000 });
    const rows = await sweep(T, ".due-slot", "DUE");
    expect(rows.length).toBe(WIDTHS.length);
  });

  it("窄窗截一张图当字据", async () => {
    await browser.setWindowSize(950, 700);
    await browser.pause(300);
    await boardAction(T, "优先级");
    await $(`.tcard*=${T}`).$(".pri-slot .choice").waitForExist({ timeout: 5000 });
    await browser.pause(200);
    await browser.saveScreenshot("e2e/probes/out-pri-950-AFTER.png");
    await browser.setWindowSize(1100, 700);
  });
});
