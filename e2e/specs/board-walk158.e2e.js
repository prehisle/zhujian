import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction, clearInbox } from "./support.js";

// 158 G1 + G2 桌面那一半(W2「做事」走查,用户全取推荐):看板这一侧能自动化的那几条。
//  A1 卡内编辑改过按 Esc 先提醒、再按才丢;A2 截止框逐段输入不存、离开才一次性存;
//  A3 拖着跨列挪也有「已移到 · 撤销」,撤销回原位;A6 全部归档 / 取消归档的回执与撤销,
//  归档页「本周完成 / 累计」不随归档进出变;A7 撤回为随记确认句说清会清截止优先级、回执带「撤销」「去看看」;
//  A12 管理列面板是对话框、焦点进面板、Tab 圈在里面、有关闭钮、删不了的原因写在面板里;
//  A14 复制看板保住多行正文(清单不压成一行、空行留着);A16 空提交说一声、钮叫「记下」;
//  A17 标签 ✕ 有撤销、`/` C 有回执、清单中间空项回车不留空行;A18 删除确认焦点在执行钮上、删列确认顺序。
// ⚠ 引擎面那几格(真键盘逐段敲日期、真拖、1260 宽几何)e2e 证不了,走 desktop-verify(progress-log 同号)。

const taskByTitle = async (title) => (await invoke("list_tasks")).find((t) => t.title === title) ?? null;
const toastText = () => browser.execute(() => document.querySelector(".undo-toast .undo-text")?.textContent ?? null);
const toastButtons = () =>
  browser.execute(() => [...document.querySelectorAll(".undo-toast button")].map((b) => b.textContent));
const clickToast = (label) =>
  browser.execute((l) => [...document.querySelectorAll(".undo-toast button")].find((b) => b.textContent === l).click(), label);
const cardEl = (title) => `[...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(${JSON.stringify(title)}))`;

async function waitToast(want) {
  let seen = null;
  await browser.waitUntil(async () => (seen = await toastText()) === want, {
    timeout: 6000,
    timeoutMsg: `没等到回执「${want}」,实得 ${JSON.stringify(seen)}`,
  });
}

async function cleanupTitles(prefix) {
  for (const t of await invoke("list_tasks")) if (t.title.startsWith(prefix)) await invoke("archive_task", { id: t.id });
  for (const t of await invoke("list_sealed_tasks")) {
    if (t.title.startsWith(prefix)) {
      await invoke("unseal_task", { id: t.id });
      await invoke("archive_task", { id: t.id });
    }
  }
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(prefix)) await invoke("purge_task", { id: t.id });
}

describe("158 · 看板 W2 走查修的那批(桌面)", () => {
  const P = "E2E158-";

  before(async () => {
    await cleanupTitles(P);
    await browser.execute(() => localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed"));
    await goNotebook("board");
  });

  after(async () => {
    await browser.execute(() => document.querySelector(".undo-toast")?.remove());
    await cleanupTitles(P);
  });

  it("A1:卡内改过按 Esc 先提醒不丢,再按一次才丢;没改过一次就退", async () => {
    const T = `${P}A1-原标题`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    await browser.execute(() => {
      const ta = document.querySelector(".tcard .edit-input");
      ta.value += "改了";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.keys(["Escape"]);
    const mid = await browser.execute(() => ({
      editing: !!document.querySelector(".tcard .edit-input"),
      hint: (() => {
        const h = document.querySelector(".tcard .discard-hint");
        return h && !h.hidden ? h.textContent : null;
      })(),
    }));
    expect(mid.editing).toBe(true);
    expect(mid.hint).toContain("再按一次 Esc");
    await browser.keys(["Escape"]);
    await $(".tcard .edit-input").waitForExist({ timeout: 5000, reverse: true });
    expect(await taskByTitle(T)).not.toBe(null); // 原标题还在 = 第二下才真丢
    expect(await taskByTitle(`${T}改了`)).toBe(null);

    // 没改过:一下就退(别把「提醒」做成每次都要按两下)
    await boardAction(T, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    await browser.keys(["Escape"]);
    await $(".tcard .edit-input").waitForExist({ timeout: 5000, reverse: true });
  });

  it("A2:截止框逐段输入(按键那一拍里的 change)不存,回车才一次性存", async () => {
    const T = `${P}A2-截止`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "截止");
    await $(`.tcard*=${T}`).$(".due-input").waitForExist({ timeout: 5000 });
    // 键盘改段:keydown 之后同一拍里浏览器发 change(值已凑成一个合法日期)—— 这一下不许存。
    await browser.execute((sel) => {
      const input = eval(sel).querySelector(".due-input");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      input.value = "2026-01-01";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, cardEl(T));
    await browser.pause(400);
    expect((await taskByTitle(T)).due_on).toBe(null);
    expect(await browser.execute((sel) => !!eval(sel).querySelector(".due-input"), cardEl(T))).toBe(true); // 框还开着
    await browser.execute((sel) => {
      const input = eval(sel).querySelector(".due-input");
      input.value = "2026-10-12";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, cardEl(T));
    await browser.waitUntil(async () => (await taskByTitle(T)).due_on === "2026-10-12", {
      timeout: 6000,
      timeoutMsg: "回车没把框里的日期存下",
    });
    // Esc = 不存
    await $(`.tcard*=${T}`).$(".chip.due").waitForExist({ timeout: 5000 });
    await browser.execute((sel) => eval(sel).querySelector(".chip.due").click(), cardEl(T)); // A17:章点得开
    await $(`.tcard*=${T}`).$(".due-input").waitForExist({ timeout: 5000 });
    await browser.execute((sel) => {
      eval(sel).querySelector(".due-input").value = "2027-03-03";
    }, cardEl(T));
    await browser.keys(["Escape"]);
    await $(`.tcard*=${T}`).$(".due-input").waitForExist({ timeout: 5000, reverse: true });
    expect((await taskByTitle(T)).due_on).toBe("2026-10-12");
  });

  it("A3:拖着跨列挪 → 「已移到「进行中」」+ 撤销;撤销回原列原位", async () => {
    const A = `${P}A3-甲`;
    const B = `${P}A3-乙`;
    const C = `${P}A3-丙`;
    for (const t of [C, B, A]) await invoke("create_task", { title: t }); // 列首起:甲 乙 丙
    await goNotebook("board");
    await $(`.tcard*=${A}`).waitForExist({ timeout: 8000 });
    await browser.execute((sel) => {
      const card = eval(sel);
      const target = document.querySelector('.col[data-col="doing"]');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    }, cardEl(B));
    await browser.waitUntil(async () => (await taskByTitle(B)).status === "doing", { timeout: 6000 });
    await waitToast("已移到「进行中」");
    expect(await toastButtons()).toEqual(["撤销"]);
    await clickToast("撤销");
    await browser.waitUntil(async () => (await taskByTitle(B)).status === "todo", { timeout: 6000, timeoutMsg: "撤销没把卡挪回待办" });
    const order = (await invoke("list_tasks")).filter((t) => t.status === "todo" && t.title.startsWith(`${P}A3-`)).map((t) => t.title);
    expect(order).toEqual([A, B, C]); // 回原位,不是列尾
  });

  it("A6:全部归档 / 取消归档都有回执与撤销;归档页「本周完成 · 累计」不随进出变", async () => {
    const D1 = `${P}A6-完成一`;
    const D2 = `${P}A6-完成二`;
    for (const t of [D1, D2]) {
      const id = await invoke("create_task", { title: t });
      await invoke("update_task_status", { id, to: "done" });
    }
    const doneAll = (await invoke("list_tasks")).filter((t) => t.status === "done").length;
    await goNotebook("board");
    await $(".col.done").$(`.tcard*=${D1}`).waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector('.col[data-col="done"] .seal-all-slot .act').click());
    const q = await browser.execute(() => document.querySelector('.col[data-col="done"] .seal-all-slot .confirm-q')?.textContent);
    expect(q).toBe(`归档 ${doneAll} 条?`);
    // A18 → W5 Q3 ★①(D1 改):确认一出现,焦点停「取消」(此前停执行钮,回车即全部归档)
    expect(await browser.execute(() => document.activeElement?.textContent)).toBe("取消");
    await browser.execute(() => document.querySelector('.col[data-col="done"] .seal-all-slot .act.primary').click());
    await waitToast(`已归档 ${doneAll} 条`);
    await clickToast("撤销");
    await browser.waitUntil(async () => (await taskByTitle(D1))?.status === "done" && (await taskByTitle(D2))?.status === "done", {
      timeout: 8000,
      timeoutMsg: "撤销全部归档没把卡放回「已完成」",
    });

    // 取消归档:先把两张都归档(册里得留一张,统计那行才在),进归档页读数,取消归档 D1 后读数不变 + 回执
    await invoke("seal_task", { id: (await taskByTitle(D1)).id });
    await invoke("seal_task", { id: (await taskByTitle(D2)).id });
    await goNotebook("board");
    await $("#seal-toggle").click();
    await $(".sealed-view").$(`.tcard*=${D1}`).waitForExist({ timeout: 8000 });
    // 只钉那两个数:W3 159 / A21 起后面另挂半句「(含看板「已完成」列里还没归档的 N 张)」,取消归档让 N 加一是对的
    const stats = () =>
      browser.execute(() => document.querySelector(".sealed-view .trash-bar .grow")?.textContent.match(/^本周完成 \d+ · 累计 \d+/)?.[0] ?? null);
    const before = await stats();
    expect(before).toMatch(/^本周完成 \d+ · 累计 \d+$/); // 读不到就别拿 null === null 判过
    await boardAction(D1, "取消归档");
    await waitToast("已取消归档,回到「已完成」");
    expect(await toastButtons()).toEqual(["撤销", "去看看"]); // 158 G3 / Q3 起带「去看看」
    await browser.waitUntil(async () => (await taskByTitle(D1))?.status === "done", { timeout: 6000 });
    await browser.waitUntil(async () => (await stats()) === before, {
      timeout: 6000,
      timeoutMsg: `取消归档后「本周完成 · 累计」变了:${before} → ${await stats()}`,
    });
    await $("#seal-toggle").click();
  });

  it("A7:有截止 / 优先级时确认句说会清掉;撤回后回执带「撤销」「去看看」、点「去看看」到随记页", async () => {
    await clearInbox();
    const T = `${P}A7-撤回`;
    const id = await invoke("create_task", { title: T });
    await invoke("set_task_due", { id, dueOn: "2026-12-01" });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "撤回为随记");
    const q = await browser.execute((sel) => eval(sel).querySelector(".confirm-q")?.textContent, cardEl(T));
    expect(q).toBe("撤回为随记?将清除截止和优先级");
    expect(await browser.execute(() => document.activeElement?.textContent)).toBe("取消"); // A18 焦点 → W5 Q3:停「取消」
    await browser.execute((sel) => eval(sel).querySelector(".act.primary").click(), cardEl(T));
    await waitToast("已撤回为随记");
    // 158 G3 / A7 对齐手机:配「撤销」(转回待办并设回截止 / 优先级,撤销那半在 board-walk158-g3)+「去看看」
    expect(await toastButtons()).toEqual(["撤销", "去看看"]);
    await clickToast("去看看");
    await $(`.note*=${T}`).waitForExist({ timeout: 8000 });
    await clearInbox();
  });

  it("A12:管理列面板是对话框,打开焦点在面板里、Tab 圈在里面、✕ 关得掉", async () => {
    await goNotebook("board");
    await $("#manage-cols").waitForDisplayed({ timeout: 8000 });
    await $("#manage-cols").click();
    await $(".bcm-panel .bcm-col").waitForExist({ timeout: 8000 });
    const s = await browser.execute(() => {
      const p = document.querySelector(".bcm-panel");
      return { role: p.getAttribute("role"), modal: p.getAttribute("aria-modal"), focusIn: p.contains(document.activeElement) };
    });
    expect(s).toEqual({ role: "dialog", modal: "true", focusIn: true });
    for (let i = 0; i < 25; i++) await browser.keys(["Tab"]);
    expect(await browser.execute(() => document.querySelector(".bcm-panel").contains(document.activeElement))).toBe(true);
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  // W5 Q3 ★①(D1 改):确认一出来焦点停「取消」(此前 158 A18 定的是停「删除」、回车即删)—— 要删 Tab 一下到红钮。
  it("A12 / A18:有卡的自定义列点「删除」→ 面板里写明原因;空列删除确认「取消」在前、红「删除」在后,焦点停「取消」", async () => {
    const COL = "E2E158列";
    await goNotebook("board");
    await $("#manage-cols").waitForDisplayed({ timeout: 8000 });
    await $("#manage-cols").click();
    await $(".bcm-panel .bcm-new .bcm-col-input").waitForExist({ timeout: 8000 });
    await browser.execute((n) => {
      const i = document.querySelector(".bcm-panel .bcm-new .bcm-col-input");
      i.value = n;
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, COL);
    const rowSel = (n) =>
      `[...document.querySelectorAll(".bcm-panel .bcm-col")].find((r) => r.querySelector(".bcm-col-name").textContent === ${JSON.stringify(n)})`;
    await browser.waitUntil(() => browser.execute((s) => !!eval(s), rowSel(COL)), { timeout: 8000, timeoutMsg: "新列没出现" });
    // WD-14:回车建完焦点回到新建框(此前掉到 body)
    expect(await browser.execute(() => document.activeElement === document.querySelector(".bcm-panel .bcm-new .bcm-col-input"))).toBe(true);
    const colId = await browser.execute((s) => eval(s).dataset.col, rowSel(COL));

    // 往这一列塞一张卡 → 删除钮淡着,点它在面板里写原因
    const T = `${P}A12-占列`;
    const tid = await invoke("create_task", { title: T });
    await invoke("update_task_status", { id: tid, to: colId });
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $("#manage-cols").click();
    await browser.waitUntil(() => browser.execute((s) => !!eval(s)?.querySelector(".bcm-btn.blocked"), rowSel(COL)), { timeout: 8000 });
    await browser.execute((s) => eval(s).querySelector(".bcm-btn.blocked").click(), rowSel(COL));
    expect(await browser.execute((s) => eval(s).querySelector(".bcm-col-note")?.textContent, rowSel(COL))).toBe("先把这一列的 1 个条目移走");
    expect(await browser.execute((s) => !!eval(s).querySelector(".bcm-col-q"), rowSel(COL))).toBe(false); // 没进确认

    // 卡挪走 → 删除确认的顺序与焦点
    await invoke("update_task_status", { id: tid, to: "todo" });
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $("#manage-cols").click();
    await browser.waitUntil(() => browser.execute((s) => !!eval(s)?.querySelector(".bcm-btn.danger:not(.blocked)"), rowSel(COL)), {
      timeout: 8000,
    });
    await browser.execute((s) => eval(s).querySelector(".bcm-btn.danger").click(), rowSel(COL));
    const c = await browser.execute((s) => {
      const acts = eval(s).querySelector(".bcm-col-acts");
      return {
        order: [...acts.querySelectorAll("button")].map((b) => b.textContent),
        focused: document.activeElement?.textContent,
        solid: acts.querySelector(".bcm-btn.danger")?.classList.contains("solid"),
      };
    }, rowSel(COL));
    expect(c).toEqual({ order: ["取消", "删除"], focused: "取消", solid: true });
    await browser.keys(["Tab"]); // 到红钮
    expect(await browser.execute(() => document.activeElement?.textContent)).toBe("删除");
    await browser.pause(350); // 执行钮落在原「删除」位上 ⇒ 出现后 300ms 内不接(§3.2 防连击)
    await browser.keys(["Enter"]);
    await browser.waitUntil(() => browser.execute((s) => !eval(s), rowSel(COL)), { timeout: 8000, timeoutMsg: "回车没删掉那一列" });
    await browser.keys(["Escape"]);
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("A14:复制看板 —— 多行正文挂在那一项下面,清单不压成一行、空行留着", async () => {
    const T = `${P}A14-搬家打包\n- [x] 书\n- [ ] 衣服\n\n厨房另说`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${P}A14-搬家打包`).waitForExist({ timeout: 8000 });
    // 拦写入侧(同 inbox-copy.e2e.js 的形,⛔ 别碰真剪贴板)
    await browser.execute(() => {
      window.__lastClip = null;
      navigator.clipboard.writeText = (t) => {
        window.__lastClip = t;
        return Promise.resolve();
      };
      document.querySelector("#copy-slot .hbtn").click();
    });
    await browser.waitUntil(async () => (await browser.execute(() => window.__lastClip)) !== null, { timeout: 5000 });
    const md = await browser.execute(() => window.__lastClip);
    const i = md.indexOf(`- [ ] ${P}A14-搬家打包`);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(md.slice(i).split("\n").slice(0, 5)).toEqual([`- [ ] ${P}A14-搬家打包`, "  - [x] 书", "  - [ ] 衣服", "", "  厨房另说"]);
  });

  it("A16:空着提交说一声;提交钮叫「记下」", async () => {
    await goNotebook("board");
    await $("#add-task").click();
    await $("#compose-input").waitForDisplayed({ timeout: 5000 });
    expect(await $("#compose-add").getText()).toBe("记下");
    await browser.execute(() => {
      document.querySelector("#compose-input").value = "   ";
      document.querySelector("#compose-add").click();
    });
    await browser.waitUntil(async () => (await $("#compose-err").getText()) === "先写个卡片标题", {
      timeout: 5000,
      timeoutMsg: "空提交没说话",
    });
    await browser.execute(() => {
      document.querySelector("#compose-input").value = "";
      document.querySelector("#compose-close").click();
    });
  });

  it("A17:标签 ✕ 摘了有回执 + 撤销,撤销挂回同一枚", async () => {
    const T = `${P}A17-标签`;
    const TAG = "E2E158标签";
    const id = await invoke("create_task", { title: T });
    const topics = await invoke("list_topics");
    const tagId = topics.find((x) => x.title === TAG)?.id ?? (await invoke("create_topic", { title: TAG }));
    await invoke("add_task_topic", { id, topicId: tagId });
    await goNotebook("board");
    await $(`.tcard*=${T}`).$(".chip-x").waitForExist({ timeout: 8000 });
    await browser.execute((sel) => eval(sel).querySelector(".chip-x").click(), cardEl(T));
    await waitToast(`已去掉标签「${TAG}」`);
    expect((await taskByTitle(T)).topics.length).toBe(0);
    await clickToast("撤销");
    await browser.waitUntil(async () => (await taskByTitle(T)).topics.some((x) => x.id === tagId), {
      timeout: 6000,
      timeoutMsg: "撤销没把标签挂回去",
    });
    await invoke("delete_topic", { id: tagId });
  });

  it("A17:悬停按 C(菜单没开)复制了也有回执", async () => {
    const T = `${P}A17-复制`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await browser.execute((sel) => {
      navigator.clipboard.writeText = () => Promise.resolve();
      document.querySelectorAll(".copy-toast").forEach((n) => n.remove());
      eval(sel).dispatchEvent(new MouseEvent("mouseenter"));
    }, cardEl(T));
    await browser.keys(["c"]);
    await browser.waitUntil(
      () => browser.execute(() => [...document.querySelectorAll(".copy-toast")].some((n) => n.textContent === "已复制")),
      { timeout: 4000, timeoutMsg: "按 C 复制后屏上没有回执" },
    );
  });

  it("A17:清单中间的空项上回车 → 撤掉那一项,不留空行", async () => {
    const T = `${P}A17-清单\n- [ ] 书\n- [ ] 衣服\n- [ ] 厨房`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${P}A17-清单`).waitForExist({ timeout: 8000 });
    await boardAction(`${P}A17-清单`, "编辑");
    await $(".tcard .edit-input").waitForDisplayed({ timeout: 5000 });
    // 光标放到「衣服」行末,回车续一项,再回车(空项)
    await browser.execute(() => {
      const ta = document.querySelector(".tcard .edit-input");
      const at = ta.value.indexOf("衣服") + 2;
      ta.focus();
      ta.setSelectionRange(at, at);
    });
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector(".tcard .edit-input").value.includes("衣服\n- [ ] \n")),
      { timeout: 4000, timeoutMsg: "回车没续出新的一项" },
    );
    await browser.keys(["Enter"]);
    const v = await browser.execute(() => {
      const ta = document.querySelector(".tcard .edit-input");
      return { value: ta.value, caretAfter: ta.value.slice(0, ta.selectionStart).split("\n").pop() };
    });
    expect(v.value).toBe(`${P}A17-清单\n- [ ] 书\n- [ ] 衣服\n- [ ] 厨房`);
    expect(v.caretAfter).toBe("- [ ] 衣服");
    await browser.keys(["Escape"]);
    await browser.keys(["Escape"]);
  });

  // W5 Q3 ★①(D1 改):全应用的确认一个规矩 —— 焦点停「取消」(此前停「删除」,再按一下回车就删)。
  it("A18 → W5 Q3:卡的删除确认出现时焦点在「取消」上", async () => {
    const T = `${P}A18-删`;
    await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
    await boardAction(T, "删除");
    expect(await browser.execute(() => document.activeElement?.textContent)).toBe("取消");
    expect(await browser.execute(() => document.activeElement?.closest(".tcard")?.textContent.includes("E2E158-A18-删"))).toBe(true);
    await browser.keys(["Escape"]);
  });
});
