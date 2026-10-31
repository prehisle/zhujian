import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxShow, inboxAction } from "./support.js";

// 154 G3–G5(桌面长文的图):
//   G3 展开成长文 ⇒ 正文里没提到的图在文末各补一段「图N」;加图插在光标所在段的段尾另起一段(句中不拆),连加往下排;
//   G4 标删时提示正文里提到几处;删掉之后阅读页那几处「图N」灰的带删除线、正文一个字不改;
//   G5 拖图片文件进写字框 = 加图(非图片明说没收);「＋加图」钮走同一条路。
// 插在哪的判据本身在 `scripts/test-markdown.mjs`(refInsertion / withMissingRefs,有阴性刀);这里只管两端接线真通。

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
const docContent = async (id) => (await invoke("list_docs")).find((d) => d.id === id)?.content;
const areaValue = () => browser.execute(() => document.querySelector(".v-docs .doc-area").value);

async function openDoc(title) {
  await goNotebook("docs");
  await browser.waitUntil(
    () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), title),
    { timeout: 8000, timeoutMsg: `长文列表里一直没有「${title}」` },
  );
  await browser.execute((t) => {
    [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent.includes(t)).click();
  }, title);
  await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
}

/** 页内造一批文件(`names` 以 .png 结尾的是 1×1 PNG,其余是纯文本),交给 `how`:"drop" = 拖进写字框,"pick" = 塞给「＋加图」的文件框。 */
function feed(how, names) {
  return browser.execute(
    (how, names, b64) => {
      const png = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      for (const n of names) dt.items.add(n.endsWith(".png") ? new File([png], n, { type: "image/png" }) : new File(["x"], n, { type: "text/plain" }));
      if (how === "drop") {
        const box = document.querySelector(".v-docs .doc-ed");
        const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(over);
        const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(drop);
        return { overTaken: over.defaultPrevented, dropTaken: drop.defaultPrevented };
      }
      const input = document.querySelector('.v-docs .doc-bar input[type="file"]');
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { overTaken: true, dropTaken: true };
    },
    how,
    names,
    PNG,
  );
}

describe("长文的图(154 G3–G5)", () => {
  beforeEach(async () => {
    await clearInbox();
    await clearDocs();
  });

  it("展开成长文补图N;加图插在段尾(拖文件 / ＋加图);标删提示几处;删后阅读页灰的带删除线", async () => {
    // ① 带两张图的随记,正文只提到图2 ⇒ 展开后文末补「图1」(按编号),落一版
    const id = await invoke("capture_note", { content: "# 图E2E\n\n见图2。" });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    await inboxShow("ideas");
    await inboxAction("图E2E", "展开成长文");
    await browser.waitUntil(async () => (await docContent(id)) === "# 图E2E\n\n见图2。\n\n图1", {
      timeout: 8000,
      timeoutMsg: "展开之后正文一直没补上「图1」",
    });
    expect((await invoke("list_revisions", { id, before: null })).total).toBe(1);

    // ② 编辑器:光标放进「见图2。」句中,拖一张 PNG + 一个文本文件进写字框
    await openDoc("图E2E");
    await browser.execute(() => document.querySelectorAll(".v-docs .doc-bar .hbtn")[1].click());
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    await browser.execute(() => {
      const a = document.querySelector(".v-docs .doc-area");
      const k = a.value.indexOf("图2。");
      a.focus();
      a.setSelectionRange(k, k);
    });
    const taken = await feed("drop", ["a.png", "notes.txt"]);
    expect(taken).toEqual({ overTaken: true, dropTaken: true });
    await browser.waitUntil(async () => (await invoke("list_item_images", { itemId: id })).length === 3, {
      timeout: 8000,
      timeoutMsg: "拖进来的图一直没挂上",
    });
    await browser.waitUntil(async () => (await areaValue()).includes("图3"), { timeout: 5000, timeoutMsg: "写字框里一直没插「图3」" });
    // 句子没被拆开:图3 在「见图2。」那段后面另起一段
    expect(await areaValue()).toBe("# 图E2E\n\n见图2。\n\n图3\n\n图1");
    const err = await browser.execute(() => {
      const e = document.querySelector(".v-docs .img-editor .form-err");
      return e && !e.hidden ? e.textContent : null;
    });
    expect(err).toContain("1 个文件不是图片");

    // ③ 「＋加图」钮:接着排在图3 后面
    expect(await browser.execute(() => [...document.querySelectorAll(".v-docs .doc-bar .hbtn .lbl")].some((n) => n.textContent === "＋加图"))).toBe(true);
    await feed("pick", ["b.png"]);
    await browser.waitUntil(async () => (await areaValue()).includes("图4"), { timeout: 8000, timeoutMsg: "＋加图之后写字框里一直没插「图4」" });
    expect(await areaValue()).toBe("# 图E2E\n\n见图2。\n\n图3\n\n图4\n\n图1");

    // ④ 条里标删图2(正文提到 1 处)⇒ 提示;撤回 ⇒ 收起;再标
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll(".v-docs .img-editor .img-thumb").length === 4), {
      timeout: 5000,
      timeoutMsg: "编辑器的条一直没画齐 4 张",
    });
    const del2 = () => browser.execute(() => document.querySelector('.v-docs .img-editor .img-thumb[data-seq="2"] .img-del').click());
    const note = () =>
      browser.execute(() => {
        const n = document.querySelector(".v-docs .doc-del-note");
        return n.hidden ? null : n.textContent;
      });
    await del2();
    expect(await note()).toContain("图2 正文里提到 1 处");
    await del2();
    expect(await note()).toBe(null);
    await del2();

    // ⑤ 保存:图2 删了、正文一个字不改;阅读页那处「图2」灰的带删除线
    const before = await areaValue();
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(async () => (await invoke("list_item_images", { itemId: id })).length === 3, {
      timeout: 8000,
      timeoutMsg: "保存之后图2 一直没删",
    });
    expect(await docContent(id)).toBe(before);
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll(".v-docs .doc-page .md .img-gone").length === 1), {
      timeout: 8000,
      timeoutMsg: "阅读页里删掉的图2 一直没变灰",
    });
    const gone = await browser.execute(() => {
      const e = document.querySelector(".v-docs .doc-page .md .img-gone");
      return { t: e.textContent, deco: getComputedStyle(e).textDecorationLine, title: e.title };
    });
    expect(gone.t).toBe("图2");
    expect(gone.deco).toContain("line-through");
    expect(gone.title).toContain("图2");
  });
});
