import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxShow, inboxAction, shownText, docAction } from "./support.js";

// 长文视图(longform-plan 第 3 格)的主路:随记「展开成长文」→ 长文列表 → 阅读页按 Markdown 画 →
// 编辑(停笔存本机草稿)→ 保存落一版 → 历史比对;外加草稿的「接着改 / 丢掉」、搜索命中跳到
// 阅读页、「收回随记」回到随记。Markdown 解析与比对算法本身的正确性 / 安全 / 预算由
// `scripts/test-markdown.mjs` / `test-diff.mjs` 管,这里只管接线是不是真通。

// e2e 恒打主库,空间 id = "main" ⇒ 草稿键就是这一格
const draftKey = (id) => `zhujian.doc-draft:main:${id}`;
const readDraft = (id) => browser.execute((k) => localStorage.getItem(k), draftKey(id));

async function clearDocs() {
  for (const d of await invoke("list_docs")) {
    await invoke("archive_note", { id: d.id });
    await invoke("purge_note", { id: d.id });
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k);
  });
}

/** 列表里点开题目含 `title` 的那篇,等阅读页画出正文。 */
async function openDoc(title) {
  await goNotebook("docs");
  await browser.waitUntil(
    () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), title),
    { timeout: 8000, timeoutMsg: `长文列表里一直没有「${title}」` },
  );
  await browser.execute((t) => {
    const card = [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent.includes(t));
    card.click();
  }, title);
  await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
}

/** 阅读页工具条的三枚钮:← 长文 / 编辑 / 历史。 */
const barBtn = (i) => browser.execute((n) => document.querySelectorAll(".v-docs .doc-bar .hbtn")[n].click(), i);

describe("长文(展开 → 编辑 → 保存 → 比对)", () => {
  beforeEach(async () => {
    await clearInbox();
    await clearDocs();
  });

  it("随记展开成长文,按 Markdown 显示;编辑停笔存草稿,保存落一版并清掉草稿;历史里比得出差异", async () => {
    const v1 = "# 长文E2E标题\n\n第一段原文。\n\n- 甲\n- 乙";
    const id = await invoke("capture_note", { content: v1 });

    // ① 随记卡 ⋯「展开成长文」:卡片离开随记,库里成了长文
    await inboxShow("ideas");
    await inboxAction("长文E2E标题", "展开成长文");
    await browser.waitUntil(async () => (await invoke("list_docs")).some((d) => d.id === id), {
      timeout: 8000,
      timeoutMsg: "展开之后 list_docs 里一直没有这一篇",
    });
    expect((await invoke("list_ideas")).some((i) => i.id === id)).toBe(false);
    await browser.waitUntil(
      () => browser.execute(() => ![...document.querySelectorAll(".v-inbox .note")].some((n) => n.textContent.includes("长文E2E标题"))),
      { timeout: 8000, timeoutMsg: "展开之后随记列表上那张卡没走" },
    );

    // ② 阅读页:# 成了标题、- 成了列表(共用渲染器画的,不是原文)
    await openDoc("长文E2E标题");
    expect(await shownText($(".v-docs .doc-page .md h1"))).toBe("长文E2E标题");
    expect(await browser.execute(() => document.querySelectorAll(".v-docs .doc-page .md ul > li").length)).toBe(2);

    // ③ 编辑:改一段,停笔 1 秒后本机有草稿(正文还没落库)
    await barBtn(1);
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    const v2 = "# 长文E2E标题\n\n第一段改过的文字。\n\n- 甲\n- 乙\n- 丙";
    await browser.execute((t) => {
      const a = document.querySelector(".v-docs .doc-area");
      a.value = t;
      a.dispatchEvent(new Event("input", { bubbles: true }));
    }, v2);
    await browser.waitUntil(async () => (await readDraft(id)) !== null, { timeout: 5000, timeoutMsg: "停笔之后本机一直没有草稿" });
    expect(JSON.parse(await readDraft(id)).text).toBe(v2);
    expect((await invoke("list_docs")).find((d) => d.id === id).content).toBe(v1);

    // ④ 保存:落一版、回到阅读页、草稿清掉、历史多一版(上一版就是 v1)
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(async () => (await invoke("list_docs")).find((d) => d.id === id).content === v2, {
      timeout: 8000,
      timeoutMsg: "点了保存,库里正文一直没变成新版",
    });
    await $(".v-docs .doc-page .md").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelectorAll(".v-docs .doc-page .md ul > li").length)).toBe(3);
    expect(await readDraft(id)).toBe(null);
    const cat = await invoke("list_revisions", { id, before: null });
    expect(cat.total).toBe(1);

    // ⑤ 历史:默认「上一版 → 当前」,删的与加的各有一行,行内高亮到字
    await barBtn(2);
    await $(".v-docs .hv-out .diff").waitForExist({ timeout: 8000 });
    const diff = await browser.execute(() => ({
      del: [...document.querySelectorAll(".v-docs .diff-del")].map((n) => n.textContent).join("|"),
      ins: [...document.querySelectorAll(".v-docs .diff-ins")].map((n) => n.textContent).join("|"),
      hl: document.querySelectorAll(".v-docs .diff-hl").length,
      md: document.querySelectorAll(".v-docs .hv .md").length,
    }));
    expect(diff.del).toContain("第一段原文。");
    expect(diff.ins).toContain("第一段改过的文字。");
    expect(diff.ins).toContain("- 丙");
    expect(diff.hl).toBeGreaterThan(0);
    expect(diff.md).toBe(0); // 比对面显示原文,⛔ 不渲染 Markdown
  });

  it("草稿与正文不同:阅读页明说,「接着改」带着草稿进编辑器,「丢掉」清掉", async () => {
    const id = await invoke("capture_doc", { content: "# 草稿E2E\n\n正文。" });
    await browser.execute(
      (k) => localStorage.setItem(k, JSON.stringify({ text: "# 草稿E2E\n\n没存的字。", gen: 1, at: new Date().toISOString() })),
      draftKey(id),
    );
    await openDoc("草稿E2E");
    await $(".v-docs .doc-draft").waitForExist({ timeout: 5000 });
    // 「接着改」:编辑器里是草稿,⛔ 不是正文
    await browser.execute(() => [...document.querySelectorAll(".v-docs .doc-draft button")][0].click());
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".v-docs .doc-area").value)).toBe("# 草稿E2E\n\n没存的字。");
    // 离开编辑器 = 落一版(§2):Esc
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await invoke("list_docs")).find((d) => d.id === id).content === "# 草稿E2E\n\n没存的字。", {
      timeout: 8000,
      timeoutMsg: "Esc 离开编辑器之后正文一直没落库",
    });
    expect(await readDraft(id)).toBe(null);

    // 「丢掉」:再种一份,点丢掉,横条没了、键也没了,正文不变
    await browser.execute(
      (k) => localStorage.setItem(k, JSON.stringify({ text: "另一份草稿", gen: 2, at: new Date().toISOString() })),
      draftKey(id),
    );
    await openDoc("草稿E2E");
    await $(".v-docs .doc-draft").waitForExist({ timeout: 5000 });
    await browser.execute(() => [...document.querySelectorAll(".v-docs .doc-draft button")][1].click());
    await $(".v-docs .doc-draft").waitForExist({ reverse: true, timeout: 5000 });
    expect(await readDraft(id)).toBe(null);
  });

  it("新建长文:第一次保存才建条目;搜索命中标「长文」并跳到阅读页;收回随记回到随记", async () => {
    await goNotebook("docs");
    await browser.execute(() => document.querySelector(".v-docs header .hbtn").click());
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    expect((await invoke("list_docs")).length).toBe(0); // 还没存 = 还没建
    await browser.execute(() => {
      const a = document.querySelector(".v-docs .doc-area");
      a.value = "# 新建E2E篇\n\nzjdocneedle 在这里。";
      a.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(async () => (await invoke("list_docs")).length === 1, { timeout: 8000, timeoutMsg: "新建那篇一直没落库" });
    const id = (await invoke("list_docs"))[0].id;
    await $(".v-docs .doc-page .md h1").waitForExist({ timeout: 5000 });
    expect(await readDraft("new")).toBe(null);

    // 搜索:命中徽记是「长文」(0042 之前会被前端当回收站),点它落到阅读页
    await goNotebook("search");
    await browser.execute(() => {
      const q = document.getElementById("q");
      q.value = "zjdocneedle";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await $(".v-search .hit").waitForExist({ timeout: 8000 });
    expect(await shownText($(".v-search .hit .badge"))).toBe("长文");
    await browser.execute(() => document.querySelector(".v-search .hit").click());
    await $(".v-docs .doc-page .md h1").waitForExist({ timeout: 8000 });
    expect(await shownText($(".v-docs .doc-page .md h1"))).toBe("新建E2E篇");

    // 收回随记(⋯ 菜单):离开长文、回到随记
    await docAction("新建E2E篇", "收回随记");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.id === id), {
      timeout: 8000,
      timeoutMsg: "收回之后随记里一直没有这一篇",
    });
    expect((await invoke("list_docs")).length).toBe(0);
    await $(".v-docs .doc-page").waitForExist({ reverse: true, timeout: 5000 });
  });
});
