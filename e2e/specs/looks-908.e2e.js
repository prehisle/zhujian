// 908 桌面观感巡检修的那几条里「能锁的行为」(brief 的验收节):
//   D4 / D5 五页顶栏同一个高度、标题同一条基线,带键帽 / 不带键帽的顶栏钮一样高;
//   D7 标签药丸一种尺寸(随记卡 / 长文卡 / 看板卡 / 搜索命中行的标签与类别徽标);
//   D8 卡片挑标签的候选:没挂上的是中性样(透明底)、挂上的点亮,有色标签带色点;
//   D10 长文阅读页的「‹ 长文」在页面左上、与页头标题左缘对齐,Esc 回列表照旧;看板回收站里 R 照旧是开关;
//   D12 随记 / 看板 / 长文三页的回收站钮同写「回收站 N」,键帽只在看板(那一页按得动 R)。
// 判据一律量**几何 / 计算样式**,不判 class(memory `gates-green-is-not-looks-right`)。
// D11(标签行计数)在 topics.e2e.js,D10 随记回收站 / 归档册在 inbox-trash / board-walk158-g3。
import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction } from "./support.js";

const P = "L908-";
const NOTE = `${P}带标签的随记`;
const TASK = `${P}带标签的卡`;
const DOC = `# ${P}长文\n\n正文一句。`;
const TAG_ON = `${P}挂上的`;
const TAG_OFF = `${P}没挂的`;

/** 一个视图的顶栏读数:内容高(不含底边线)、标题顶边、可见顶栏钮各自的高。 */
const readHead = () =>
  browser.execute(() => {
    const h = document.querySelector("#view > .view > header");
    const h1 = h.querySelector("h1").getBoundingClientRect();
    const btns = [...h.querySelectorAll(".hbtn")]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ id: b.id || b.textContent.trim(), h: b.getBoundingClientRect().height, k: !!b.querySelector(".k") && getComputedStyle(b.querySelector(".k")).display !== "none" }));
    return { clientH: h.clientHeight, h1Top: h1.top, h1H: h1.height, btns };
  });

async function setQuery(q) {
  await browser.execute((v) => {
    const el = document.querySelector("#q");
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, q);
}

describe("908 桌面观感:顶栏 / 药丸 / 候选 / 返回 / 回收站计数", () => {
  before(async () => {
    const on = await invoke("create_topic", { title: TAG_ON });
    await invoke("set_topic_color", { id: on, color: "#3f7a8c" });
    const off = await invoke("create_topic", { title: TAG_OFF });
    await invoke("set_topic_color", { id: off, color: "#a8577e" });
    const nid = await invoke("capture_note", { content: NOTE });
    await invoke("file_note_to_topic", { id: nid, topicId: on, newTitle: null });
    await invoke("create_task", { title: TASK, topicId: on });
    const did = await invoke("capture_doc", { content: DOC });
    await invoke("file_note_to_topic", { id: did, topicId: on, newTitle: null });
  });

  it("D4 / D5:五页顶栏同高、标题同一条线;同一排顶栏钮带不带键帽都一样高", async () => {
    const reads = {};
    for (const v of ["inbox", "board", "docs", "topics", "search"]) {
      await goNotebook(v);
      await $(`.v-${v}`).waitForExist({ timeout: 8000 });
      if (v === "board") await $(".v-board .tcard").waitForExist({ timeout: 8000 });
      reads[v] = await readHead();
    }
    const base = reads.inbox;
    for (const [v, r] of Object.entries(reads)) {
      expect({ v, clientH: r.clientH, h1Top: r.h1Top }).toEqual({ v, clientH: base.clientH, h1Top: base.h1Top });
      for (const b of r.btns) expect({ v, id: b.id, h: Math.round(b.h * 10) / 10 }).toEqual({ v, id: b.id, h: Math.round(r.btns[0].h * 10) / 10 });
    }
    // 前置:看板那一排真有带键帽的钮,也真有不带的 —— 否则上面「一样高」恒真(没量到想量的那一对)。
    // 键帽在 1260 窗下按顶栏宽挑档,可能整排摘掉;那时退回比「新建卡片」与「⋯」两枚(一枚带 + 号字 / 一枚只有一个字形)。
    const withK = reads.board.btns.filter((b) => b.k).length;
    const withoutK = reads.board.btns.filter((b) => !b.k).length;
    expect(withoutK).toBeGreaterThan(0);
    if (withK === 0) console.log("(D4:这一趟看板顶栏在摘键帽那一档,带键帽那半没量到 —— 长文页「+ 新建长文 N」那枚兜着)");
    const docsK = reads.docs.btns.filter((b) => b.k).length;
    expect(docsK + withK).toBeGreaterThan(0);
  });

  it("D7:随记卡 / 长文卡 / 看板卡 / 搜索命中行上的标签章与类别徽标同一个高", async () => {
    const hOf = (sel, text) =>
      browser.execute(
        (s, t) => {
          const e = [...document.querySelectorAll(s)].find((n) => n.offsetParent !== null && n.textContent.includes(t));
          return e ? e.getBoundingClientRect().height : -1;
        },
        sel,
        text,
      );
    await inboxShow("ideas");
    await $(`.note*=${NOTE}`).waitForExist({ timeout: 8000 });
    const inbox = await hOf(".v-inbox .note .tag", TAG_ON);
    await goNotebook("docs");
    await $(".v-docs .doc-card").waitForExist({ timeout: 8000 });
    const docs = await hOf(".v-docs .doc-card .tag", TAG_ON);
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 8000 });
    const board = await hOf(".v-board .task-meta .chip.topic", TAG_ON);
    await goNotebook("search");
    await $("#q").waitForExist({ timeout: 8000 });
    await setQuery(NOTE);
    await $(".v-search .hit").waitForExist({ timeout: 8000 });
    const searchChip = await hOf(".v-search .hit .chip", TAG_ON);
    const searchBadge = await hOf(".v-search .hit .badge", "");
    const all = { inbox, docs, board, searchChip, searchBadge };
    for (const v of Object.values(all)) expect(v).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(all)) expect({ k, h: Math.round(v * 10) / 10 }).toEqual({ k, h: Math.round(board * 10) / 10 });
  });

  it("D8:挑标签的候选 —— 没挂上的透明底、挂上的点亮;有色的带色点;与卡上标签章同族(候选到热区底线 24)", async () => {
    await inboxShow("ideas");
    await $(`.note*=${NOTE}`).waitForExist({ timeout: 8000 });
    await inboxAction(NOTE, "标签");
    await $(".topic-choices .choice").waitForExist({ timeout: 5000 });
    const r = await browser.execute((on, off) => {
      const pick = (t) => [...document.querySelectorAll(".topic-choices .choice")].find((c) => c.textContent === t);
      const read = (c) => {
        const cs = getComputedStyle(c);
        const alpha = (col) => {
          const m = col.match(/rgba?\(([^)]+)\)/);
          if (!m) return 1;
          const p = m[1].split(",").map((x) => parseFloat(x));
          return p.length === 4 ? p[3] : 1;
        };
        return { bgAlpha: alpha(cs.backgroundColor), weight: cs.fontWeight, dot: getComputedStyle(c, "::before").content, h: c.getBoundingClientRect().height };
      };
      const tagH = [...document.querySelectorAll(".v-inbox .note .tag")].find((n) => n.offsetParent !== null)?.getBoundingClientRect().height ?? -1;
      return { on: read(pick(on)), off: read(pick(off)), tagH };
    }, TAG_ON, TAG_OFF);
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(r.off.bgAlpha).toBe(0); // 中性:透明底(此前淡朱底 = 「已挂上」那枚章的样子)
    expect(r.on.bgAlpha).toBeGreaterThan(0); // 挂上的点亮
    expect(Number(r.on.weight)).toBeGreaterThan(Number(r.off.weight));
    expect(r.off.dot).toBe('"●"');
    expect(r.on.dot).toBe('"●"');
    // 与卡上标签章同族:章 22、候选多 2px 到 §2.3 热区底线 24(候选要点、章只显示)
    expect(r.off.h).toBeGreaterThanOrEqual(24);
    expect(r.off.h - r.tagH).toBeLessThanOrEqual(2);
  });

  it("D12:随记 / 看板 / 长文三页的回收站钮都写「回收站 N」,长文与随记同一个数;键帽只在看板", async () => {
    const read = (sel) =>
      browser.execute((s) => {
        const b = [...document.querySelectorAll(`#view > .view > header ${s}`)].find((n) => n.offsetParent !== null);
        return { text: (b.querySelector(".lbl").textContent + " " + b.querySelector(".tn").textContent).replace(/\s+/g, " ").trim(), k: b.querySelector(".k")?.textContent ?? null };
      }, sel);
    await inboxShow("ideas");
    const inbox = await read("#inbox-trash-toggle");
    await goNotebook("board");
    await $(".v-board .tcard").waitForExist({ timeout: 8000 });
    const board = await read("#trash-toggle");
    await goNotebook("docs");
    await $(".v-docs .doc-card").waitForExist({ timeout: 8000 });
    await browser.waitUntil(async () => (await read("#docs-trash")).text.match(/\d/) !== null, { timeout: 5000, timeoutMsg: "长文页回收站钮一直没有数" });
    const docs = await read("#docs-trash");
    expect(inbox.text).toMatch(/^回收站 \d+$/);
    expect(board.text).toMatch(/^回收站 \d+$/);
    expect(docs.text).toBe(inbox.text); // 长文删了进的就是随记那只回收站
    expect(inbox.k).toBe(null); // 随记页 R 是卡上的「还原」,没有打开回收站的单键
    expect(docs.k).toBe(null);
    expect(board.k).toBe("R");
  });

  it("D10:长文阅读页「‹ 长文」在页面左上、与页头标题左缘对齐;Esc 回列表照旧", async () => {
    await goNotebook("docs");
    const card = await $(`.doc-card*=${P}长文`);
    await card.waitForExist({ timeout: 8000 });
    await browser.execute((c) => c.click(), card);
    await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
    const r = await browser.execute(() => {
      const back = document.querySelector(".v-docs .page-back");
      const b = back.getBoundingClientRect();
      const h1 = document.querySelector(".v-docs header h1").getBoundingClientRect();
      const others = [...document.querySelectorAll(".v-docs .doc-bar .hbtn")].filter((x) => x !== back).map((x) => x.getBoundingClientRect().left);
      return { text: back.textContent, dx: Math.abs(b.left - h1.left), leftmost: others.every((l) => l > b.left), belowHeader: b.top >= document.querySelector(".v-docs header").getBoundingClientRect().bottom };
    });
    expect(r).toEqual({ text: "‹ 长文", dx: r.dx, leftmost: true, belowHeader: true });
    expect(r.dx).toBeLessThanOrEqual(1);
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys("Escape");
    await $(".v-docs .doc-list").waitForExist({ timeout: 5000 });
  });

  it("D9:设置面板的钮是圆头药丸;同一行里输入框、钮、分段选择器同高", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.querySelector("#settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="general"]').click());
    const r = await browser.execute(() => {
      const pane = document.querySelector('.settings-pane[data-cat="general"]');
      const btns = [...pane.querySelectorAll(".hkset-change, .zoom-btn")].filter((b) => b.offsetParent !== null);
      const rowOf = (sel) => pane.querySelector(sel)?.closest(".hkset-row");
      const hs = (row) => [...row.querySelectorAll(".alias-input, .remind-time, .hkset-change, .seg")].filter((e) => e.offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
      return {
        n: btns.length,
        pill: btns.every((b) => getComputedStyle(b).borderTopLeftRadius === "999px"),
        alias: hs(rowOf(".alias-input")),
        remind: hs(rowOf(".remind-time")),
      };
    });
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(r.n).toBeGreaterThan(3);
    expect(r.pill).toBe(true);
    // 前置:两行都真量到了三 / 两件(否则「全相等」对一件也成立)
    expect(r.alias.length).toBe(2);
    expect(r.remind.length).toBe(3);
    // 红了要带出读数(Linux CI 曾在这里红,只报「2 ≠ 1」)
    expect(r.alias).toEqual([r.alias[0], r.alias[0]]);
    expect(r.remind).toEqual([r.remind[0], r.remind[0], r.remind[0]]);
  });

  it("D10:看板回收站里 R 照旧是开关(进 / 出),左上「‹ 看板」随之显 / 藏", async () => {
    await goNotebook("board");
    await $(".v-board .tcard").waitForExist({ timeout: 8000 });
    const rowHidden = () => browser.execute(() => document.querySelector("#board-back-row").hidden);
    expect(await rowHidden()).toBe(true);
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys("r");
    await browser.waitUntil(async () => (await rowHidden()) === false, { timeout: 5000, timeoutMsg: "按 R 没进回收站(左上那枚没显)" });
    expect(await $(".v-board header h1").getText()).toBe("回收站");
    await browser.keys("r");
    await browser.waitUntil(async () => (await rowHidden()) === true, { timeout: 5000, timeoutMsg: "再按 R 没回看板" });
  });
});
