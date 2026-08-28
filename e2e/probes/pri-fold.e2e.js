import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "../specs/support.js";

// 按需探针(默认套件扫不到,要 --spec 点名):量看板 `.task-meta` 那两个行内编辑器在窄列里的折行。
// 判据不是「高度像不像两行」,而是**这段文字被排成了几行** —— 拿 Range 量 client rects,
// 数**不同的 y** 有几个,折了就 ≥2。窗宽从宽扫到窄,同时记卡片有没有被撑出横向溢出。
// ⛔ **别退回「数 rect 个数」**(510 那版就是这么写的,522 实测证伪:同一行上可以有多个 rect,
// 同 `y` 同高)—— 那把尺答的是「被切成了几段」。字据见 e2e/probes/tagpick-long.e2e.js 头注。
const WIDTHS = [1100, 1000, 950, 900, 860, 820, 780, 740, 700];

function readSlot(title, slotSel) {
  const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
  if (!card) return null;
  const slot = card.querySelector(slotSel);
  if (!slot || !slot.firstElementChild) return null;
  const lineCount = (elm) => {
    const r = document.createRange();
    r.selectNodeContents(elm);
    return new Set([...r.getClientRects()].map((rc) => Math.round(rc.y))).size;
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

async function sweep(title, slotSel, tag, shoot = false) {
  const rows = [];
  for (const w of WIDTHS) {
    await browser.setWindowSize(w, 700);
    await browser.pause(250);
    const r = await browser.execute(readSlot, title, slotSel);
    rows.push({ win: w, ...(r ?? { GONE: true }) });
    // 524:日期框那半的取舍是「不撑破」换「可能看不全」,而**能不能读**只有渲出来才知道
    // (memory `gates-green-is-not-looks-right`)⇒ 逐档截图,别拿 scrollWidth 猜
    // (原生 date 的内容在 UA shadow DOM 里,那个读数答不了这一问)。
    if (shoot) await browser.saveScreenshot(`e2e/probes/out-${tag.toLowerCase()}-${w}.png`);
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
    const rows = await sweep(T, ".due-slot", "DUE", true);
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
