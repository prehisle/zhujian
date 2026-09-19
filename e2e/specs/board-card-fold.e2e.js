import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// 看板长卡折叠(704):正文超过 8 行的卡默认折起、下面长一枚「展开」;短卡一个像素不动。
//
// ⛔ **别拿「`.clamped` 这个类在不在」单独当判据** —— 类挂上了而 CSS 没落下去(选择器写错、
// 特异性输了)照样绿,691 正是这么栽过一次(`.v-board .edit-zoom` 那两条声明根本没生效,
// 实测 padding 仍是旧值)。⇒ 每一例的正面字据都是**量出来的几何**:clientHeight / scrollHeight
// 与**计算后**的 max-height。
//
// ⚠ 折叠态是 **mount 级**、刻意不落库不落 localStorage ⇒ `goNotebook()` 会把它整个清掉
// (那次是真的 `browser.url()` 重载)。本支每例都自己开局,例与例之间不传状态。

const LONG_HEAD = "折叠甲-长正文第1行";
const LONG_TAIL = "折叠甲莓-最后一行只露在褶子下面"; // 搜索用:这个词必落在折起来的那一截里
const LONG = [
  ...Array.from({ length: 19 }, (_, i) => `折叠甲-长正文第${i + 1}行`),
  LONG_TAIL,
].join("\n");
const SHORT_HEAD = "折叠乙-短卡两行";
const SHORT = `${SHORT_HEAD}\n第二行`;
const CK_HEAD = "折叠丙-带清单的长卡";
const CK = [CK_HEAD, ...Array.from({ length: 16 }, (_, i) => `清单卡第${i + 1}行`), "- [ ] 还没勾的一项"].join("\n");
// 丁 = 丙的对照:同样有还没勾的框,但框全在**前 8 行**里 ⇒ 折起来照样点得到 ⇒ 该照折。
const CK_TOP_HEAD = "折叠丁-框在开头的长卡";
const CK_TOP = [
  CK_TOP_HEAD,
  "- [x] 已经勾掉的一项",
  "- [ ] 还没勾的一项",
  ...Array.from({ length: 16 }, (_, i) => `后面还拖着第${i + 1}行`),
].join("\n");

/** 一张卡的折叠读数(量几何,不信类名)。卡不在 DOM 上回 null,断言那头会当场说清。 */
async function boxOf(title) {
  return browser.execute((t) => {
    const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
    if (!card) return null;
    const p = card.querySelector(".ttitle");
    const cs = getComputedStyle(p);
    const b = card.querySelector(".fold-toggle");
    return {
      clamped: p.classList.contains("clamped"),
      clientH: p.clientHeight,
      scrollH: p.scrollHeight,
      maxH: cs.maxHeight,
      lineH: parseFloat(cs.lineHeight),
      overflowY: cs.overflowY,
      btn: b === null ? null : b.textContent,
      ariaExpanded: b === null ? null : b.getAttribute("aria-expanded"),
    };
  }, title);
}

/** 「一行都没被藏起来」的判法。⛔ **别写 `clientH === scrollH`** —— 两者一个向下取整、
 *  一个向上取整,18 行 × 22.5px 实测就是 405 / 406(本支第一版真红在这儿,而那 1px 是亚像素
 *  舍入、不是被裁掉的字)。判据取**半行**:差不到半行 = 一行都没藏。 */
const HIDDEN_NONE = (m) => m.scrollH - m.clientH;

async function clickFold(title) {
  await browser.execute((t) => {
    const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
    card.querySelector(".fold-toggle").click();
  }, title);
}

/** 排序钮走一圈(手动 → 最新在前 → 最早在前 → 手动)= **三次真的全量重画**,而 mount 没换
 *  (它每次都清 lastSig,见 board.ts 那句「排序不改数据,指纹不会变」)。
 *  ⭐ 等的是**正面字据**:重画走 `replaceChildren`,卡片是全新节点 ⇒ 点之前打在旧 DOM 上的
 *  记号消失,就是「这一发重画真落地了」。⛔ 别改成 `browser.pause(N)` —— 那是拿墙钟赌。 */
async function repaintInPlace() {
  for (let i = 0; i < 3; i++) {
    await browser.execute(() => {
      document.querySelectorAll(".tcard").forEach((c) => c.setAttribute("data-e2e-stale", "1"));
      document.getElementById("board-sort").click();
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll(".tcard[data-e2e-stale]").length)) === 0,
      { timeout: 8000, timeoutMsg: "点了排序钮之后整版一直没重画(旧 DOM 上的记号没被换掉)" },
    );
  }
}

async function seed(title) {
  const all = await invoke("list_tasks");
  if (!all.some((t) => t.title === title)) await invoke("create_task", { title });
}

describe("任务看板 · 长卡默认折叠", () => {
  before(async () => {
    await seed(LONG);
    await seed(SHORT);
    await seed(CK);
    await seed(CK_TOP);
  });

  beforeEach(async () => {
    await goNotebook("board");
    await (await $(`.tcard*=${LONG_HEAD}`)).waitForExist({ timeout: 8000 });
  });

  it("长卡默认折起:夹在 8 行、褶子下面真有东西、长出「展开」", async () => {
    const m = await boxOf(LONG_HEAD);
    expect(m.clamped).toBe(true);
    expect(m.overflowY).toBe("hidden");
    // CSS 真落下去了:max-height 不是 none,且换算成行数恰好 8(12em ÷ line-height 1.5)。
    expect(m.maxH).not.toBe("none");
    expect(Math.round(m.clientH / m.lineH)).toBe(8);
    // 前置自证 + 正面字据:20 行的正文被夹掉了一多半,褶子下面真有东西。
    expect(m.scrollH).toBeGreaterThan(m.clientH);
    // ⚠ 量的是**渲染行**不是物理行:列宽有 200px 下限,长行在窄列里会自己折
    // (本支最后一行就折成两行,第一版写死 20 当场红)⇒ 只断言「至少 20 行」。
    expect(Math.round(m.scrollH / m.lineH)).toBeGreaterThanOrEqual(20);
    expect(m.btn).toContain("展开");
    expect(m.ariaExpanded).toBe("false");
  });

  it("短卡一个像素不动:夹子当场摘掉(max-height: none)、也不长钮", async () => {
    const m = await boxOf(SHORT_HEAD);
    expect(m.clamped).toBe(false);
    expect(m.maxH).toBe("none"); // ⭐ 判的是「夹子真摘了」,不是「类名没挂」
    expect(HIDDEN_NONE(m)).toBeLessThan(m.lineH / 2);
    expect(m.btn).toBe(null);
  });

  it("点「展开」→ 全文可见;再点一下 → 收回去", async () => {
    await clickFold(LONG_HEAD);
    const open = await boxOf(LONG_HEAD);
    expect(open.clamped).toBe(false);
    expect(open.maxH).toBe("none");
    expect(HIDDEN_NONE(open)).toBeLessThan(open.lineH / 2); // 全文可见
    expect(open.btn).toContain("收起");
    expect(open.ariaExpanded).toBe("true");

    await clickFold(LONG_HEAD);
    const shut = await boxOf(LONG_HEAD);
    expect(shut.clamped).toBe(true);
    expect(Math.round(shut.clientH / shut.lineH)).toBe(8);
    expect(shut.scrollH).toBeGreaterThan(shut.clientH);
    expect(shut.btn).toContain("展开");
  });

  it("展开之后整版重画三趟(排序钮走一圈)→ 不许自己合上", async () => {
    await clickFold(LONG_HEAD);
    expect((await boxOf(LONG_HEAD)).clamped).toBe(false); // 前置自证:确实先摊开了
    await repaintInPlace();
    const m = await boxOf(LONG_HEAD);
    expect(m.clamped).toBe(false);
    expect(HIDDEN_NONE(m)).toBeLessThan(m.lineH / 2);
    expect(m.btn).toContain("收起"); // 钮还在,还收得回去
  });

  it("切走再回来 → 收回(刻意的 mount 级边界,不是漏了持久化)", async () => {
    await clickFold(LONG_HEAD);
    expect((await boxOf(LONG_HEAD)).clamped).toBe(false);
    await goNotebook("inbox");
    await goNotebook("board");
    await (await $(`.tcard*=${LONG_HEAD}`)).waitForExist({ timeout: 8000 });
    const m = await boxOf(LONG_HEAD);
    expect(m.clamped).toBe(true);
    expect(m.btn).toContain("展开");
  });

  it("没勾的方框被夹在褶子下面 → 不自动折(勾得到),但「收起」照给", async () => {
    const m = await boxOf(CK_HEAD);
    expect(m.clamped).toBe(false);
    expect(HIDDEN_NONE(m)).toBeLessThan(m.lineH / 2); // 全文可见 = 方框没被埋进褶子
    expect(m.btn).toContain("收起"); // 它本来够长 ⇒ 钮照给,要折是用户自己的事
    // 正面字据:那枚方框真画出来了、点得到(⛔ 不点它——本支不验勾选那条路)。
    const boxes = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      return card.querySelectorAll(".ckbox").length;
    }, CK_HEAD);
    expect(boxes).toBe(1);
  });

  // 丙的对照:豁免的**唯一**理由是「褶子下面的框点不到」⇒ 框全在夹线以上的卡该照折。
  // ⛔ 这一例不是洁癖:第一版按「正文里有没有框」豁免,一张清单在开头、后面拖着长记录的卡
  // 会把整列占满(704 的截图逮到的),而那恰恰是最该折的一种。
  it("方框全在夹线以上 → 照折,而那枚没勾的框照样点得到", async () => {
    const m = await boxOf(CK_TOP_HEAD);
    expect(m.clamped).toBe(true);
    expect(Math.round(m.clientH / m.lineH)).toBe(8);
    expect(m.btn).toContain("展开");
    // 正面字据两格:①那枚**没勾**的框整个在夹线以上(量几何);②它真的点得到 ——
    // 取框中心做命中测试,`elementFromPoint` 回来的必须就是它自己(合成 click 绕过命中
    // 测试,证不了「没被夹子/别的东西盖住」)。
    const hit = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      card.scrollIntoView({ block: "center" }); // 命中测试用的是视口坐标,先让它在屏上
      const body = card.querySelector(".ttitle");
      const box = card.querySelector(".ckline:not(.on) .ckbox");
      if (box === null) return { found: false };
      const r = box.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        found: true,
        aboveFold: r.bottom <= body.getBoundingClientRect().bottom,
        hitIsBox: top === box,
      };
    }, CK_TOP_HEAD);
    expect(hit.found).toBe(true);
    expect(hit.aboveFold).toBe(true);
    expect(hit.hitIsBox).toBe(true);
  });

  it("搜索命中褶子下面那个词 → 跳过去那张卡是摊开的(跳了看不见等于没跳)", async () => {
    await goNotebook("search");
    await browser.execute((val) => {
      const input = document.getElementById("q");
      input.value = val;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, "折叠甲莓");
    await $(".hit").waitForExist({ timeout: 10000 });
    await browser.execute(() => document.querySelector(".hit").click());
    await $(".v-board").waitForExist({ timeout: 8000 });
    await (await $(`.tcard*=${LONG_HEAD}`)).waitForExist({ timeout: 8000 });

    const m = await boxOf(LONG_HEAD);
    expect(m.clamped).toBe(false);
    expect(HIDDEN_NONE(m)).toBeLessThan(m.lineH / 2); // 命中的词在最后一行,摊开了才看得见
    expect(m.btn).toContain("收起");
  });
});
