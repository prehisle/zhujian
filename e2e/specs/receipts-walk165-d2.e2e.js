// W5 修复 · D2 组(桌面回执与一致性,backlog 用户面 165)的回归锚。守的是「做完一件事屏上说不说、说的是什么、
// 撤不撤得回」那一片,外加几处叫法 / 写法:
//   ① Q6:撤成之后一律说「已撤销」(两端同句);Q5:列首 / 列尾、截止、优先级也给「已… 撤销」,撤销 = 再写一次旧值;
//   ② Q7:⋯ 菜单「完成」/ X = 移到已完成、回执「已完成」;已完成卡上 X = 打回第一列;
//   ③ A11:截止框里有字没成日期 —— 回车不收、框旁说怎么填;点别处收起并说没设上;库里一个字不动;
//   ④ A16 / A20:随记摘标签有回执与撤销;选择器打名字回车建成说一声、框清空;同名已挂不写库照实说;
//   ⑤ A45 没改过按 H / V 说一句;A44 归档卡带标签;Q14 时间写到「今天 HH:MM」;A42「本周记了」只数随记;
//   ⑥ A43 跳转落点约 3 秒后自己淡;Q15 彻底删除写出是哪条、清空确认写明只清这一只、看板空了说归档在哪;
//   ⑦ Q1 / Q15 长文:离开说存成一篇 / 一版、新篇左上叫「← 回到正文」、顶行、列表首行不误加粗、改于、页头回收站;
//   ⑧ A21 库里有标签时摘掉唯一那枚,记一笔框不跳。
// 用真键(browser.keys)的地方:单键与焦点、日期框逐段输入 —— 合成事件给不了那几样默认动作。
import { browser, $, expect } from "@wdio/globals";
import { clearInbox, goNotebook, inboxShow, invoke, typeText } from "./support.js";

const P = "W5D2-";

/** 等底部那条回执(大黑条 / 小条)里出现这句;超时把屏上此刻的回执抄出来。 */
async function waitToast(text, msg) {
  const read = () =>
    browser.execute(() => [...document.querySelectorAll(".undo-toast .undo-text, .copy-toast")].map((n) => n.textContent));
  await browser.waitUntil(async () => (await read()).some((x) => x.includes(text)), { timeout: 6000 }).catch(async (e) => {
    throw new Error(`${msg}\n  屏上回执:${JSON.stringify(await read())}\n  ${e.message}`);
  });
}
/** 点在场那条回执上的【撤销】。 */
const clickUndo = () =>
  browser.execute(() => {
    const b = document.querySelector(".undo-toast .undo-btn:not(.undo-go)");
    if (!b) throw new Error("没有带【撤销】的回执");
    b.click();
  });
/** 把焦点放到那张卡的 ⋯ 上 = 选中它(W5 D1 起选中 = 焦点)。 */
const focusDots = (sel, text) =>
  browser.execute(
    (s, t) => {
      const c = [...document.querySelectorAll(s)].find((n) => n.textContent.includes(t));
      if (!c) throw new Error("卡不在:" + t);
      c.scrollIntoView({ block: "center" });
      c.querySelector(".hk-btn").focus();
    },
    sel,
    text,
  );
const task = async (title) => (await invoke("list_tasks")).find((t) => t.title === title);
const colOrder = (col) =>
  browser.execute((c) => [...document.querySelectorAll(`.col[data-col="${c}"] .tcard .ttitle`)].map((n) => n.textContent), col);
const until = (fn, msg, timeout = 6000) => browser.waitUntil(fn, { timeout, timeoutMsg: msg });
/** 等那张卡出现(选择器里带后代 / 多类名时 `sel*=字` 那种写法驱动不认,走页内查)。 */
const waitCard = (sel, text) =>
  until(async () => browser.execute((s, t) => [...document.querySelectorAll(s)].some((n) => n.textContent.includes(t)), sel, text), `${sel} 里一直没有「${text}」`, 8000);

async function cleanupBoard() {
  for (const t of await invoke("list_tasks")) if (t.title.startsWith(P)) await invoke("archive_task", { id: t.id });
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(P)) await invoke("purge_task", { id: t.id });
}

describe("W5 D2 · 桌面回执与一致性", () => {
  before(async () => {
    await cleanupBoard();
  });

  it("看板:X = 完成、回执「已完成」;Ctrl+Z 回原列原位并说「已撤销」;已完成卡 X = 打回待办;⋯ 菜单有「完成」(Q7 / Q6)", async () => {
    for (const s of ["丙", "乙", "甲"]) await invoke("create_task", { title: `${P}${s}` }); // 新建落列首 ⇒ 甲 乙 丙
    await goNotebook("board");
    await $(`.tcard*=${P}甲`).waitForExist({ timeout: 8000 });
    const before = (await colOrder("todo")).filter((x) => x.startsWith(P));
    expect(before).toEqual([`${P}甲`, `${P}乙`, `${P}丙`]);
    await focusDots(".tcard", `${P}乙`);
    await browser.keys("x");
    await waitToast("已完成", "X 之后没有「已完成」回执");
    await until(async () => (await task(`${P}乙`))?.status === "done", "X 没把卡挪进已完成");
    await browser.keys(["Control", "z"]);
    await waitToast("已撤销", "Ctrl+Z 撤成了却没说「已撤销」");
    await until(async () => (await task(`${P}乙`))?.status === "todo", "撤销没把卡挪回待办");
    await until(
      async () => JSON.stringify((await colOrder("todo")).filter((x) => x.startsWith(P))) === JSON.stringify(before),
      "撤销后没回到原位",
    );
    // 已完成卡:菜单里没有「完成」,X = 打回第一列(右边印着 X)
    await invoke("update_task_status", { id: (await task(`${P}丙`)).id, to: "done" });
    await goNotebook("board");
    await waitCard(`.col[data-col="done"] .tcard`, `${P}丙`);
    const menu = await browser.execute((t) => {
      const c = [...document.querySelectorAll(".tcard")].find((n) => n.textContent.includes(t));
      c.querySelector(".hk-btn").click();
      const rows = [...document.querySelectorAll(".hk-menu .hk-item")].map((i) => [i.querySelector(".hk-label").textContent, i.querySelector(".hk-key")?.textContent ?? ""]);
      document.body.click();
      return rows;
    }, `${P}丙`);
    expect(menu.some(([l]) => l === "完成")).toBe(false);
    expect(menu.find(([l]) => l.startsWith("打回"))?.[1]).toBe("X");
    await focusDots(".tcard", `${P}丙`);
    await browser.keys("x");
    await until(async () => (await task(`${P}丙`))?.status === "todo", "已完成卡上 X 没打回待办");
    await waitToast("已移到", "打回待办没说去了哪");
    const todoMenu = await browser.execute((t) => {
      const c = [...document.querySelectorAll(".tcard")].find((n) => n.textContent.includes(t));
      c.querySelector(".hk-btn").click();
      const rows = [...document.querySelectorAll(".hk-menu .hk-item")].map((i) => [i.querySelector(".hk-label").textContent, i.querySelector(".hk-key")?.textContent ?? ""]);
      document.body.click();
      return rows;
    }, `${P}甲`);
    expect(todoMenu.find(([l]) => l === "完成")?.[1]).toBe("X");
  });

  it("看板:F 移到列尾有回执、撤销回原位;截止 / 优先级写成有回执,撤销写回旧值(Q5)", async () => {
    await goNotebook("board");
    await $(`.tcard*=${P}甲`).waitForExist({ timeout: 8000 });
    const mine = async () => (await colOrder("todo")).filter((x) => x.startsWith(P));
    const before = await mine();
    await focusDots(".tcard", before[0]);
    await browser.keys("f");
    await waitToast("已移到列尾", "F 之后没有「已移到列尾」回执");
    await until(async () => (await mine()).at(-1) === before[0], "F 没把卡挪到列尾");
    await clickUndo();
    await waitToast("已撤销", "列尾撤成了没说「已撤销」");
    await until(async () => JSON.stringify(await mine()) === JSON.stringify(before), "列尾撤销没回原位");

    // 截止:框里写进合法日期回车 = 存,回执写那一天;撤销 = 清回去(原来没设)
    const t = before[0];
    await focusDots(".tcard", t);
    await browser.keys("s");
    await $(".due-input").waitForExist({ timeout: 5000 });
    await browser.execute(() => {
      const i = document.querySelector(".due-input");
      i.value = "2026-12-20";
    });
    await browser.keys("Enter");
    await waitToast("已设截止 12月20日", "设了截止没说设成哪天");
    await until(async () => (await task(t))?.due_on === "2026-12-20", "截止没存进去");
    await clickUndo();
    await waitToast("已撤销", "截止撤成了没说「已撤销」");
    await until(async () => (await task(t))?.due_on === null, "截止撤销没写回旧值(没设)");

    // 优先级:选中 P2 回车;再撤销
    await focusDots(".tcard", t);
    await browser.keys("p");
    await until(async () => browser.execute(() => document.activeElement?.classList.contains("choice")), "P 的选项没拿到焦点");
    await browser.execute(() => [...document.querySelectorAll(".pri-slot .choice")].find((b) => b.textContent === "P2").focus());
    await browser.keys("Enter");
    await waitToast("已设优先级 P2", "设了优先级没说");
    await until(async () => (await task(t))?.priority === 1, "优先级没存进去");
    await clickUndo();
    await waitToast("已撤销", "优先级撤成了没说「已撤销」");
    await until(async () => (await task(t))?.priority === null, "优先级撤销没写回旧值");
  });

  it("看板:截止框里有字没成日期 —— 回车不收、框旁说怎么填;点别处收起说没设上;库里不动(A11)", async () => {
    const t = `${P}甲`;
    await goNotebook("board");
    await $(`.tcard*=${t}`).waitForExist({ timeout: 8000 });
    await focusDots(".tcard", t);
    await browser.keys("s");
    await $(".due-input").waitForExist({ timeout: 5000 });
    await browser.keys(["2", "0", "2", "6", "1", "1", "0", "8"]); // 照常理连着打:年那一格全吃进去
    const typed = await browser.execute(() => ({ v: document.querySelector(".due-input").value, bad: document.querySelector(".due-input").validity.badInput }));
    expect(typed.v).toBe("");
    await browser.keys("Enter");
    await $(".due-err").waitForExist({ timeout: 3000 });
    expect(await browser.execute(() => !!document.querySelector(".due-input") && document.activeElement === document.querySelector(".due-input"))).toBe(true);
    expect(await browser.execute(() => document.querySelector(".due-err").getAttribute("role"))).toBe("alert");
    // 点别处 = 收起,底部说一句没设上
    await browser.execute(() => document.querySelector(".v-board header h1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await browser.execute(() => document.querySelector(".v-board header h1").click());
    await waitToast("截止没设上", "点别处收起了却没说没设上");
    expect((await task(t)).due_on).toBe(null);
  });

  it("随记:摘标签 ✕ 有回执与撤销;选择器打名字回车 = 建成并说、框清空;同名已挂不写库、说已打上(A16 / A20 / Q6)", async () => {
    await clearInbox();
    const id = await invoke("capture_note", { content: `${P}随记甲` });
    await invoke("file_note_to_topic", { id, topicId: null, newTitle: `${P}标` });
    await inboxShow("ideas");
    await $(`.note*=${P}随记甲`).waitForExist({ timeout: 8000 });
    await browser.execute((t) => {
      const n = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes(t));
      n.querySelector(".tag-x").click();
    }, `${P}随记甲`);
    await waitToast(`已去掉标签「${P}标」`, "随记摘标签没有回执");
    await until(async () => (await invoke("list_ideas")).find((i) => i.id === id)?.topics.length === 0, "✕ 没摘掉");
    await clickUndo();
    await waitToast("已撤销", "摘标签撤成了没说「已撤销」");
    await until(async () => (await invoke("list_ideas")).find((i) => i.id === id)?.topics.some((x) => x.title === `${P}标`), "撤销没把标签挂回去");

    await $(`.note*=${P}随记甲`).waitForExist({ timeout: 8000 });
    await focusDots(".note", `${P}随记甲`);
    await browser.keys("l");
    await $(".topic-search").waitForExist({ timeout: 5000 });
    await typeText(`${P}新`);
    await browser.keys("Enter");
    await waitToast(`已建标签「${P}新」并打上`, "打名字回车建成了没说");
    expect(await browser.execute(() => document.querySelector(".topic-search").value)).toBe("");
    // 同名(大小写不同)已挂:不写库,照实说「已打上」
    await typeText(`${P}标`);
    await browser.keys("Enter");
    await waitToast(`已打上标签「${P}标」`, "同名已挂回车没说已打上");
    expect(await browser.execute(() => [...document.querySelectorAll(".form-err")].filter((n) => !n.hidden).map((n) => n.textContent))).toEqual([]);
    await browser.keys("Escape");
    const tags = (await invoke("list_ideas")).find((i) => i.id === id).topics.map((x) => x.title).sort();
    expect(tags).toEqual([`${P}新`, `${P}标`].sort());
  });

  it("没改过的卡按 H(随记)/ V(看板)说一句;菜单里照旧不列「历史」(A45)", async () => {
    await inboxShow("ideas");
    await $(`.note*=${P}随记甲`).waitForExist({ timeout: 8000 });
    await focusDots(".note", `${P}随记甲`);
    await browser.keys("h");
    await waitToast("这张还没改过", "没改过的随记按 H 一声不吭");
    await goNotebook("board");
    await $(`.tcard*=${P}甲`).waitForExist({ timeout: 8000 });
    await focusDots(".tcard", `${P}甲`);
    await browser.keys("v");
    await waitToast("这张还没改过", "没改过的任务按 V 一声不吭");
  });

  it("归档卡带标签、完成时刻写到「今天 HH:MM」;看板空了、归档有 → 空态说归档在哪(A44 / Q14 / Q15)", async () => {
    const tp = await invoke("create_topic", { title: `${P}归档标` });
    const id = await invoke("create_task", { title: `${P}要归档`, topicId: tp });
    await invoke("update_task_status", { id, to: "done" });
    await invoke("seal_task", { id });
    await goNotebook("board");
    await browser.execute(() => document.querySelector("#seal-toggle").click());
    await waitCard(".tcard.sealed", `${P}要归档`);
    const card = await browser.execute((t) => {
      const c = [...document.querySelectorAll(".tcard.sealed")].find((n) => n.textContent.includes(t));
      return { chips: [...c.querySelectorAll(".chip.topic")].map((n) => n.textContent), x: c.querySelectorAll(".chip-x").length, at: c.querySelector(".done-at").textContent };
    }, `${P}要归档`);
    expect(card.chips).toEqual([`${P}归档标`]);
    expect(card.x).toBe(0); // 只读:不带 ✕
    expect(card.at).toMatch(/^完成于 今天 \d{2}:\d{2}/);

    // 看板此刻没有任何活着的任务(先把活着的全挪进回收站,验完还原)
    const live = await invoke("list_tasks");
    for (const t of live) await invoke("archive_task", { id: t.id });
    try {
      await goNotebook("board");
      await $(".v-board .col-empty").waitForExist({ timeout: 8000 });
      const said = await browser.execute(() => document.querySelector(".col-empty-sealed")?.textContent ?? null);
      expect(said).toMatch(/^归档了 \d+ 张,在页头「归档」里/);
    } finally {
      for (const t of live) await invoke("restore_task", { id: t.id });
    }
  });

  it("随记:「本周记了 N 条」只数随记本身 —— 新建一篇长文不加数(A42)", async () => {
    await inboxShow("ideas");
    const read = async () => {
      const s = await browser.execute(() => document.querySelector("#idea-stats").textContent);
      return Number(/本周记了 (\d+) 条/.exec(s)?.[1]);
    };
    await until(async () => Number.isFinite(await read()), "页头没有「本周记了 N 条」");
    const n0 = await read();
    const doc = await invoke("capture_doc", { content: `# ${P}统计用长文` });
    await goNotebook("docs");
    await inboxShow("ideas");
    await until(async () => Number.isFinite(await read()), "回随记页后页头没有数");
    expect(await read()).toBe(n0);
    await invoke("archive_note", { id: doc });
  });

  it("跳转落点亮约 3 秒后自己淡出,不用等点 / 滚(A43)", async () => {
    await goNotebook("search");
    await browser.execute((q) => {
      const i = document.querySelector("#q");
      i.value = q;
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }, `${P}随记甲`);
    await $(".v-search .hit").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector(".v-search .hit").click());
    await $(".v-inbox .note.just-located").waitForExist({ timeout: 8000 });
    await browser.pause(1500);
    expect(await browser.execute(() => !!document.querySelector(".v-inbox .note.just-located"))).toBe(true); // 还亮着
    await until(async () => browser.execute(() => !document.querySelector(".v-inbox .note.just-located")), "落点 5 秒还没淡", 5000);
  });

  it("回收站:彻底删除写出删的是哪条;清空确认写明只清这一只(Q15 / Q14)", async () => {
    const id = await invoke("capture_note", { content: `# ${P}要彻底删的那条,名字长一点看截断\n第二行` });
    await invoke("archive_note", { id });
    await inboxShow("archived");
    await waitCard(".note.archived", `${P}要彻底删`);
    await browser.execute(() => document.querySelector(".purge-open").click());
    expect(await browser.execute(() => document.querySelector(".purge-q").textContent)).toContain("只清这只(随记与长文);看板的回收站不动。");
    await browser.keys("Escape");
    await focusDots(".note.archived", `${P}要彻底删`);
    await browser.keys("d");
    await browser.execute((t) => {
      const n = [...document.querySelectorAll(".note.archived")].find((x) => x.textContent.includes(t));
      n.querySelector(".confirm .do").click();
    }, `${P}要彻底删`);
    await waitToast(`已彻底删除「${P}要彻底删的那条,名字长一点看截…」`, "彻底删除没写出是哪条(或截法不对:取第一行、去 #、20 字封顶加「…」)");
  });

  it("长文:新篇左上叫「← 回到正文」、顶行说离开就存;离开说已存成一篇 / 一版;列表首行没 # 不加粗、改于;页头回收站开随记那只(Q1 / Q15)", async () => {
    await goNotebook("docs");
    await browser.keys("n");
    await $(".v-docs .doc-area").waitForExist({ timeout: 8000 });
    expect(await browser.execute(() => document.querySelector(".v-docs .doc-bar .hbtn").textContent)).toBe("← 回到正文");
    await typeText(`${P}新篇`);
    await until(async () => browser.execute(() => document.querySelector(".doc-status").textContent === "草稿已存在本机 · 离开就存成一版"), "顶上那行没说离开就存");
    await browser.keys("Escape");
    await waitToast("已存成一篇,在「长文」页", "新篇离开没说存成一篇");
    await $(".v-docs .doc-page").waitForExist({ timeout: 8000 });
    await browser.keys("e");
    await $(".v-docs .doc-area").waitForExist({ timeout: 8000 });
    // 停在篇首点「编辑」= 光标落在全文末尾(Q15)
    expect(await browser.execute(() => { const a = document.querySelector(".doc-area"); return a.selectionStart === a.value.length; })).toBe(true);
    await typeText("x");
    await browser.keys("Escape");
    await waitToast("已存成一版", "改了离开没说存成一版");
    await $(".v-docs .doc-page .doc-edited").waitForExist({ timeout: 8000 });
    expect(await browser.execute(() => document.querySelector(".v-docs .doc-meta .doc-edited").textContent)).toMatch(/^改于 今天 \d{2}:\d{2}$/);
    await browser.keys("Escape"); // 回列表
    await $(".v-docs .doc-card").waitForExist({ timeout: 8000 });
    const c = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.textContent.includes(t));
      return { cls: card.querySelector(".doc-card-title").className, edited: card.querySelector(".doc-edited")?.textContent ?? null };
    }, `${P}新篇`);
    expect(c.cls).toBe("doc-card-title plain");
    expect(c.edited).toMatch(/^改于 今天/);
    await browser.execute(() => [...document.querySelectorAll(".v-docs header .hbtn")].find((b) => b.textContent === "回收站").click());
    await $(".v-inbox.in-trash").waitForExist({ timeout: 8000 });
    const d = (await invoke("list_docs")).find((x) => x.content.startsWith(`${P}新篇`));
    await invoke("archive_note", { id: d.id });
  });

  it("筛选行:库里有标签时摘掉唯一挂着的那一枚,记一笔框不上下跳(A21)", async () => {
    await clearInbox();
    await invoke("capture_note", { content: `${P}无标签那条` });
    const id = await invoke("capture_note", { content: `${P}挂着标签那条` });
    await invoke("file_note_to_topic", { id, topicId: null, newTitle: `${P}唯一` });
    await inboxShow("ideas");
    await $(`.note*=${P}挂着标签那条`).waitForExist({ timeout: 8000 });
    const top = () => browser.execute(() => Math.round(document.querySelector(".v-inbox .compose-input").getBoundingClientRect().top));
    const t0 = await top();
    await browser.execute((t) => {
      const n = [...document.querySelectorAll(".note")].find((x) => x.textContent.includes(t));
      n.querySelector(".tag-x").click();
    }, `${P}挂着标签那条`);
    await until(async () => (await invoke("list_ideas")).find((i) => i.id === id)?.topics.length === 0, "✕ 没摘掉");
    await until(async () => browser.execute(() => !document.querySelector(".v-inbox .tag-x")), "卡上的标签还在");
    expect(await top()).toBe(t0);
  });

  after(async () => {
    await cleanupBoard();
  });
});
