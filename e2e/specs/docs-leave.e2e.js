import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, typeText } from "./support.js";

// 154 G6–G8(桌面长文编辑器离开那一刻与两件小事):
//   G6 正文空着、只挂着图 ⇒ 离开前问留不留,「删掉这篇」进回收站(撤得回);
//   G7 Esc / 返回钮离开也落一版,标了删的图先问「删不删这 N 张」(点【保存】不问);问句开着时 Esc = 接着写;
//   G8 列表项回车续一项 / 空项回车退出;空的新篇离开时说一声。
// 续行的判据本身在 `scripts/test-markdown.mjs`(continueListOnNewline,有阴性刀);这里只管接线真通(真按键)。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function clearDocs() {
  for (const d of await invoke("list_docs")) {
    await invoke("archive_note", { id: d.id });
    await invoke("purge_note", { id: d.id });
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k);
  });
}
const areaValue = () => browser.execute(() => document.querySelector(".v-docs .doc-area").value);
const askText = () =>
  browser.execute(() => {
    const a = document.querySelector(".v-docs .doc-ask");
    return a === null ? null : a.querySelector("span").textContent;
  });
const clickAsk = (label) =>
  browser.execute((l) => {
    const b = [...document.querySelectorAll(".v-docs .doc-ask button")].find((x) => x.textContent === l);
    if (!b) throw new Error(`问句里没有「${l}」:${document.querySelector(".v-docs .doc-ask")?.textContent}`);
    b.click();
  }, label);
const inEditor = () => browser.execute(() => document.querySelector(".v-docs .doc-area") !== null);

async function newDoc() {
  await goNotebook("docs");
  await browser.execute(() => document.querySelector(".v-docs header .hbtn").click());
  await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
  await browser.execute(() => document.querySelector(".v-docs .doc-area").focus());
}
/** 「＋加图」的文件框塞一张 1×1 PNG(同 docs-images.e2e.js 的 feed("pick"))。 */
function pickPng() {
  return browser.execute((b64) => {
    const png = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], "a.png", { type: "image/png" }));
    const input = document.querySelector('.v-docs .doc-bar input[type="file"]');
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, PNG);
}

describe("长文编辑器离开前问的两句 + 续列表(154 G6–G8)", () => {
  beforeEach(async () => {
    await clearDocs();
  });

  it("续列表:回车续「- 」与方框,空项回车退出;空的新篇保存 ⇒ 不建并说一声", async () => {
    await newDoc();
    await typeText("- 甲");
    await browser.keys("Enter");
    await typeText("乙");
    await browser.keys("Enter");
    await browser.keys("Enter"); // 空项 ⇒ 退出列表:抹掉记号,光标留在那一行
    expect(await areaValue()).toBe("- 甲\n- 乙\n");
    await typeText("- [x] 丙");
    await browser.keys("Enter");
    expect(await areaValue()).toBe("- 甲\n- 乙\n- [x] 丙\n- [ ] ");

    // 清空 ⇒ 点保存:不建,回执说一声
    await browser.execute(() => {
      const a = document.querySelector(".v-docs .doc-area");
      a.select();
      document.execCommand("delete");
    });
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll(".copy-toast")].some((n) => n.textContent.includes("没有建"))), {
      timeout: 5000,
      timeoutMsg: "空的新篇保存之后一直没说一声",
    });
    expect(await inEditor()).toBe(false);
    expect((await invoke("list_docs")).length).toBe(0);
  });

  it("只剩图的空篇:Esc 先问留不留;Esc 收起问句;「删掉这篇」进回收站、撤销拿回来", async () => {
    await newDoc();
    await pickPng();
    await browser.waitUntil(async () => (await areaValue()) === "图1\n\n", { timeout: 8000, timeoutMsg: "加图之后写字框里一直没有「图1」" });
    const [doc] = await invoke("list_docs");
    expect(doc).toBeTruthy();
    // 撤掉那行字(图不跟着撤)
    await browser.keys(["Control", "z"]);
    await browser.waitUntil(async () => (await areaValue()).trim() === "", { timeout: 3000, timeoutMsg: "Ctrl+Z 没撤掉「图1」那行" });

    await browser.keys("Escape");
    await browser.waitUntil(async () => (await askText()) !== null, { timeout: 5000, timeoutMsg: "只剩图的空篇离开时一直没问" });
    expect(await askText()).toContain("只挂着 1 张图");
    await browser.keys("Escape"); // 问句开着:Esc = 接着写
    expect(await askText()).toBe(null);
    expect(await inEditor()).toBe(true);

    await browser.keys("Escape");
    await browser.waitUntil(async () => (await askText()) !== null, { timeout: 5000, timeoutMsg: "第二次 Esc 一直没问" });
    await clickAsk("删掉这篇(进回收站)");
    await browser.waitUntil(async () => (await invoke("list_docs")).length === 0, { timeout: 8000, timeoutMsg: "删掉这篇之后它一直还在长文里" });
    expect(await inEditor()).toBe(false);
    await $(".undo-toast .undo-btn").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".undo-toast .undo-btn").click());
    await browser.waitUntil(async () => (await invoke("list_docs")).some((d) => d.id === doc.id), { timeout: 8000, timeoutMsg: "撤销之后这篇一直没回来" });
    expect((await invoke("list_item_images", { itemId: doc.id })).length).toBe(1);
  });

  it("标了删的图:Esc 先问,「不删」留着图落正文;再标、Esc「删掉这 1 张」才删;点保存不问", async () => {
    const id = await invoke("capture_doc", { content: "# 删图问E2E\n\n见图1。" });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    const openEd = async (n) => {
      await goNotebook("docs");
      await browser.waitUntil(() => browser.execute(() => document.querySelector(".v-docs .doc-card") !== null), { timeout: 8000, timeoutMsg: "列表里一直没有那篇" });
      await browser.execute(() => document.querySelector(".v-docs .doc-card").click());
      await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
      await browser.execute(() => document.querySelectorAll(".v-docs .doc-bar .hbtn")[1].click());
      await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
      await browser.waitUntil(() => browser.execute((n) => document.querySelectorAll(".v-docs .img-editor .img-thumb").length === n, n), {
        timeout: 5000,
        timeoutMsg: `编辑器的条一直没画齐 ${n} 张`,
      });
    };
    const mark = (seq) => browser.execute((s) => document.querySelector(`.v-docs .img-editor .img-thumb[data-seq="${s}"] .img-del`).click(), seq);
    const imgCount = async () => (await invoke("list_item_images", { itemId: id })).length;

    // ① 标图1、改一个字,Esc ⇒ 问;「不删」⇒ 字落库、图还在
    await openEd(2);
    await mark(1);
    await browser.execute(() => {
      const a = document.querySelector(".v-docs .doc-area");
      a.focus();
      a.setSelectionRange(a.value.length, a.value.length);
    });
    await typeText("改");
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await askText()) !== null, { timeout: 5000, timeoutMsg: "标了删图 Esc 离开一直没问" });
    expect(await askText()).toContain("标了删的 1 张图");
    await clickAsk("不删");
    await browser.waitUntil(async () => (await invoke("list_docs")).find((d) => d.id === id)?.content === "# 删图问E2E\n\n见图1。改", {
      timeout: 8000,
      timeoutMsg: "「不删」之后正文一直没落库",
    });
    expect(await inEditor()).toBe(false);
    expect(await imgCount()).toBe(2);

    // ② 再标、Esc ⇒「删掉这 1 张」⇒ 删了
    await openEd(2);
    await mark(2);
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await askText()) !== null, { timeout: 5000, timeoutMsg: "第二趟 Esc 一直没问" });
    await clickAsk("删掉这 1 张");
    await browser.waitUntil(async () => (await imgCount()) === 1, { timeout: 8000, timeoutMsg: "「删掉这 1 张」之后图一直没删" });

    // ③ 标了删再点【保存】⇒ 不问,直接删
    await openEd(1);
    await mark(1);
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(async () => (await imgCount()) === 0, { timeout: 8000, timeoutMsg: "点保存之后图一直没删" });
    expect(await askText()).toBe(null);
  });
});
