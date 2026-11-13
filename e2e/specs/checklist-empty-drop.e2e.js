import { $, expect, browser } from "@wdio/globals";
import { invoke, tryInvoke, goNotebook, goShow, clearInbox, inboxShow, inboxAction, boardAction, openCompose } from "./support.js";

// 空的待办项,提交那一刻摘掉(用户拍板;`src/checklist-input.ts::dropEmptyChecklistLines`)。
//
// 这支钉的是**接线**:五个正文入口(随记记一笔 / 捕获浮窗 / 随记编辑 / 看板新建 / 卡片编辑)提交给后端的
// 是不是摘过的那份,以及三条**不许碰**的边界 ——
//   ① 旧条目本来就带空项:只是打开、没改就收场 ⇒ 一个字节都不写、历史不长;
//   ② 点方框打勾(0039 不留历史那条路)不经过摘除:旁边的空项原样在、历史仍是零版;
//   ③ 长文里的 `- [ ]` 是 Markdown 源,原样保存。
// 「哪一行算空项」的判据是 `shared/checklist.ts` 的 `parseChecklistLine`,纯逻辑由它自己的对拍管,这里不重复。
//
// ⚠ 种子一律走 `invoke` 直发后端:后端不摘(本条只在前端提交前做),所以造得出「带空项的旧条目」。
// ⚠ 编辑态收场发的是 **Ctrl+Enter**:光标停在待办行上时裸回车归「续下一项」(157 G4 / P6),不是提交。

const P = "E2EKD"; // 本支所有条目的前缀,清场按它认

const ideaBy = async (head) => (await invoke("list_ideas")).find((i) => i.content.startsWith(head));
const taskBy = async (head) => (await invoke("list_tasks")).find((x) => x.title.startsWith(head));
const revCount = async (id) => (await invoke("list_revisions", { id, before: null })).total;

async function clearTasks() {
  for (const x of await invoke("list_tasks")) {
    if (!x.title.startsWith(P)) continue;
    await tryInvoke("archive_task", { id: x.id });
    await tryInvoke("purge_task", { id: x.id });
  }
}
async function clearDocs() {
  for (const d of await invoke("list_docs")) {
    if (!d.content.includes(P)) continue;
    await invoke("archive_note", { id: d.id });
    await invoke("purge_note", { id: d.id });
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k);
  });
}

/** 随记「记一笔」:灌值与点钮收在同一个同步回合里(那条 bar 每次 refresh 都重建,分两趟会点在游离节点上)。
 *  ⛔ 不走 `inboxCompose()` —— 它拿「库里有一条正文 === 灌进去的字」当落账判据,而这里存下的正是另一份。 */
async function inboxSubmit(text) {
  await browser.execute((v) => {
    const bar = document.querySelector(".v-inbox .compose");
    const input = bar.querySelector(".compose-input");
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bar.querySelector(".compose-add").click();
  }, text);
}

/** 编辑框里换一份正文(`null` = 不动)再 Ctrl+Enter 收场。 */
async function commitEdit(sel, value) {
  await browser.execute(
    (s, v) => {
      const ta = document.querySelector(s);
      if (v !== null) {
        ta.value = v;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    },
    sel,
    value,
  );
}

describe("空的待办项 · 提交时摘掉", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    await clearTasks();
    await clearDocs();
  });
  after(async () => {
    await clearInbox();
    await clearTasks();
    await clearDocs();
  });

  it("随记记一笔:字 + 空项 → 存下的正文里没有空项(缩进的、大写 X 的、带尾随空白的都算);有字的项与裸 `-` 不动", async () => {
    await inboxShow("ideas");
    await $(".v-inbox .compose-input").waitForExist({ timeout: 10000 });
    await inboxSubmit(`${P}-记一笔\n- [ ] 有字\n- [ ] \n  - [X]\n- [x]   \n- 裸的`);
    await browser.waitUntil(async () => (await ideaBy(`${P}-记一笔`)) !== undefined, {
      timeout: 8000,
      timeoutMsg: "记一笔之后库里一直没有这一条",
    });
    expect((await ideaBy(`${P}-记一笔`)).content).toBe(`${P}-记一笔\n- [ ] 有字\n- 裸的`);
  });

  it("随记记一笔:只有一个空项 → 走空内容那条路(不存),框里的字留着", async () => {
    await inboxShow("ideas");
    await $(".v-inbox .compose-input").waitForExist({ timeout: 10000 });
    const before = (await invoke("list_ideas")).length;
    await inboxSubmit("- [ ] ");
    await browser.pause(800);
    expect((await invoke("list_ideas")).length).toBe(before);
    expect(await browser.execute(() => document.querySelector(".v-inbox .compose-input").value)).toBe("- [ ] ");
    // 收场:别把这段草稿留给后面的 spec
    await browser.execute(() => {
      const input = document.querySelector(".v-inbox .compose-input");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  it("捕获浮窗:夹在中间的空项被摘掉再存", async () => {
    await goShow("/index.html");
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    // ⛔ 别用 `setValue` 灌多行:它把 `\n` 当成一记回车发出去,第一行当场就被提交了。
    await browser.execute((v) => {
      const el = document.querySelector("#capture");
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.setSelectionRange(v.length, v.length); // 光标在末行(普通行)⇒ 裸回车 = 提交
    }, `${P}-纸条\n- [ ] \n尾巴`);
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await ideaBy(`${P}-纸条`)) !== undefined, {
      timeout: 8000,
      timeoutMsg: "浮窗回车之后库里一直没有这一条",
    });
    expect((await ideaBy(`${P}-纸条`)).content).toBe(`${P}-纸条\n尾巴`);
  });

  it("看板新建卡片:空项摘掉;只有空项 → 照旧提示「先写个卡片标题」、不建卡", async () => {
    await goNotebook("board");
    await openCompose();
    await browser.execute((v) => {
      document.querySelector("#compose-input").value = v;
    }, `${P}-新卡\n- [ ] \n- [x] 留着`);
    await $("#compose-add").click();
    await browser.waitUntil(async () => (await taskBy(`${P}-新卡`)) !== undefined, {
      timeout: 8000,
      timeoutMsg: "新建卡片之后库里一直没有这张卡",
    });
    expect((await taskBy(`${P}-新卡`)).title).toBe(`${P}-新卡\n- [x] 留着`);

    const n = (await invoke("list_tasks")).length;
    await openCompose();
    await browser.execute(() => {
      document.querySelector("#compose-input").value = "- [ ] \n  - [x]";
    });
    await $("#compose-add").click();
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector("#compose-err").textContent)) === "先写个卡片标题", {
      timeout: 5000,
      timeoutMsg: "只有空项的提交没有走到「先写个卡片标题」那句",
    });
    expect((await invoke("list_tasks")).length).toBe(n);
    await browser.execute(() => {
      const input = document.querySelector("#compose-input");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  it("随记编辑旧条目:打开没改就收场 → 一个字节不写;改了再存 → 空项被摘、留一版历史(上一版是带空项的原文)", async () => {
    const OLD = `${P}-旧条目\n- [ ] \n- [ ] 子项`;
    const id = await invoke("capture_note", { content: OLD });
    await inboxShow("ideas");
    await $(`.note*=${P}-旧条目`).waitForExist({ timeout: 10000 });

    // ① 没改就收场
    await inboxAction(`${P}-旧条目`, "编辑");
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
    await commitEdit(".v-inbox .edit-area", null);
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000, reverse: true });
    await browser.pause(400); // 给一次本不该有的写留出落库的时间
    expect((await ideaBy(`${P}-旧条目`)).content).toBe(OLD);
    expect(await revCount(id)).toBe(0);

    // ② 改了再存
    await inboxAction(`${P}-旧条目`, "编辑");
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
    await commitEdit(".v-inbox .edit-area", `${OLD}\n添一行`);
    await browser.waitUntil(async () => (await ideaBy(`${P}-旧条目`)).content !== OLD, {
      timeout: 8000,
      timeoutMsg: "编辑保存之后库里正文一直没变",
    });
    expect((await ideaBy(`${P}-旧条目`)).content).toBe(`${P}-旧条目\n- [ ] 子项\n添一行`);
    const cat = await invoke("list_revisions", { id, before: null });
    expect(cat.entries).toHaveLength(1);
    const pair = await invoke("revision_texts", { id, a: { rev: cat.entries[0].revision_id }, b: "current" });
    expect(pair.a.content).toBe(OLD);
  });

  it("卡片编辑旧条目:同上两半(rename_task 那条路)", async () => {
    const OLD = `${P}-旧卡\n- [ ] \n- [ ] 子项`;
    const id = await invoke("create_task", { title: OLD });
    await goNotebook("board");
    await $(`.tcard*=${P}-旧卡`).waitForExist({ timeout: 10000 });

    await boardAction(`${P}-旧卡`, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    await commitEdit(".tcard .edit-input", null);
    await $(".edit-input").waitForExist({ timeout: 5000, reverse: true });
    await browser.pause(400);
    expect((await taskBy(`${P}-旧卡`)).title).toBe(OLD);
    expect(await revCount(id)).toBe(0);

    await $(`.tcard*=${P}-旧卡`).waitForExist({ timeout: 10000 });
    await boardAction(`${P}-旧卡`, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    await commitEdit(".tcard .edit-input", `${OLD}\n添一行`);
    await browser.waitUntil(async () => (await taskBy(`${P}-旧卡`)).title !== OLD, {
      timeout: 8000,
      timeoutMsg: "卡片编辑保存之后库里正文一直没变",
    });
    expect((await taskBy(`${P}-旧卡`)).title).toBe(`${P}-旧卡\n- [ ] 子项\n添一行`);
    expect(await revCount(id)).toBe(1);
  });

  it("点方框打勾不经过摘除:旁边的空项原样在,历史仍是零版", async () => {
    const BODY = `${P}-打勾\n- [ ] \n- [ ] 子项`;
    const id = await invoke("capture_note", { content: BODY });
    await inboxShow("ideas");
    const card = await $(`.note*=${P}-打勾`);
    await card.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await card.$$(".ckbox")).length === 2, {
      timeout: 8000,
      timeoutMsg: "卡上没画出恰两枚方框(空项那枚也该画)",
    });
    await (await card.$$(".ckline"))[1].$(".ckbox").click();
    await browser.waitUntil(async () => (await ideaBy(`${P}-打勾`)).content.includes("- [x] 子项"), {
      timeout: 8000,
      timeoutMsg: "勾了第二项,库里正文没变",
    });
    expect((await ideaBy(`${P}-打勾`)).content).toBe(`${P}-打勾\n- [ ] \n- [x] 子项`);
    expect(await revCount(id)).toBe(0);
  });

  it("长文不摘:Markdown 源里的空项原样保存", async () => {
    const id = await invoke("capture_doc", { content: `# ${P}长文\n\n原文。` });
    await goNotebook("docs");
    await browser.waitUntil(
      () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), `${P}长文`),
      { timeout: 8000, timeoutMsg: "长文列表里一直没有这一篇" },
    );
    await browser.execute((t) => {
      [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent.includes(t)).click();
    }, `${P}长文`);
    await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelectorAll(".v-docs .doc-bar .hbtn")[1].click()); // 编辑
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    const v2 = `# ${P}长文\n\n- [ ] \n- [x]\n- [ ] 有字`;
    await browser.execute((t) => {
      const a = document.querySelector(".v-docs .doc-area");
      a.value = t;
      a.dispatchEvent(new Event("input", { bubbles: true }));
    }, v2);
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click()); // 保存
    await browser.waitUntil(async () => (await invoke("list_docs")).find((d) => d.id === id).content !== `# ${P}长文\n\n原文。`, {
      timeout: 8000,
      timeoutMsg: "长文点了保存,库里正文一直没变",
    });
    expect((await invoke("list_docs")).find((d) => d.id === id).content).toBe(v2);
  });
});
