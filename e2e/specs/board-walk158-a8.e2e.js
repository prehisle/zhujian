import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction, boardMenuHas, shownText } from "./support.js";

// 158 G4-A8(W2 两端对比 X-05):桌面看板卡的「改过」标记 + 历史。手机任务卡早就有(它走
// list_timeline 的 revised),桌面看板读 list_tasks / list_sealed_tasks —— core TaskRow 此前不带
// revised。这里验:
//  ① 改过的卡标「改过」、⋯ 菜单有「历史」;没改过的、只勾过方框的(0039 不留版)两样都没有;
//  ② 「历史」开读框:点开一版是「这一版 → 现在」的比对;Esc 关;读框开着时卡片单键被截住
//     (按 D 不会删掉身后那张卡);
//  ③ 单键 V 直达;④ 界面上第一次改完,不用别的刷新「改过」就出来;⑤ 归档里的卡同样有。

const P = "E2E158A8-";
const taskByTitle = async (title) => (await invoke("list_tasks")).find((t) => t.title === title) ?? null;
const cardSel = (title) => `[...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(${JSON.stringify(title)}))`;
const hasMark = (title) => browser.execute((sel) => !!eval(sel)?.querySelector(".edited-mark"), cardSel(title));

async function cleanupTitles() {
  for (const t of await invoke("list_tasks")) if (t.title.startsWith(P)) await invoke("archive_task", { id: t.id });
  for (const t of await invoke("list_sealed_tasks")) {
    if (t.title.startsWith(P)) {
      await invoke("unseal_task", { id: t.id });
      await invoke("archive_task", { id: t.id });
    }
  }
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(P)) await invoke("purge_task", { id: t.id });
}

async function closeDialog() {
  await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await browser.waitUntil(() => browser.execute(() => !document.querySelector(".hd-panel")), {
    timeout: 3000,
    timeoutMsg: "Esc 没关掉历史读框",
  });
}

describe("158 G4-A8 · 看板卡「改过」+ 历史(桌面)", () => {
  before(async () => {
    await cleanupTitles();
    await browser.execute(() => localStorage.setItem("zhujian.board-sort", "manual"));
  });

  after(async () => {
    await browser.execute(() => document.querySelector(".hd-overlay")?.remove());
    await cleanupTitles();
  });

  it("①② 改过的标「改过」、菜单有「历史」,读框里是比对、Esc 关、开着时单键被截住;没改过 / 只勾过的都没有", async () => {
    const id = await invoke("create_task", { title: `${P}改前` });
    await invoke("rename_task", { id, title: `${P}改后` });
    await invoke("create_task", { title: `${P}没改` });
    const tick = await invoke("create_task", { title: `${P}勾\n- [ ] 甲` });
    await invoke("rename_task", { id: tick, title: `${P}勾\n- [x] 甲` });
    await goNotebook("board");
    await $(`.tcard*=${P}改后`).waitForExist({ timeout: 8000 });

    expect(await hasMark(`${P}改后`)).toBe(true);
    expect(await hasMark(`${P}没改`)).toBe(false);
    expect(await hasMark(`${P}勾`)).toBe(false);
    // 「改过」挂在 meta 行:那一行别的格都空(没截止 / 优先级 / 标签),也得看得见(board.css 收起白名单)。
    expect(
      await browser.execute((sel) => {
        const m = eval(sel).querySelector(".edited-mark");
        return m.offsetParent !== null && m.getBoundingClientRect().height > 0;
      }, cardSel(`${P}改后`)),
    ).toBe(true);
    expect(await boardMenuHas(`${P}改后`, "历史")).toBe(true);
    expect(await boardMenuHas(`${P}没改`, "历史")).toBe(false);
    expect(await boardMenuHas(`${P}勾`, "历史")).toBe(false);

    await boardAction(`${P}改后`, "历史");
    const entry = await $(".hd-panel .hist-entry");
    await entry.waitForExist({ timeout: 5000 });
    // ⚠ 走 shownText 不走 getText():WebKitWebDriver 上 getText 对这只框恒回 ""(Linux CI 至少 11-04 起夜跑连红,858 修)
    expect(await shownText($(".hd-panel .hd-host"))).toContain(`${P}改后`);
    await entry.click();
    await $(".hd-panel .diff").waitForExist({ timeout: 5000 });
    expect(
      await browser.execute(() => !!document.querySelector(".hd-panel .diff .diff-del") && !!document.querySelector(".hd-panel .diff .diff-ins")),
    ).toBe(true);

    // 读框开着、焦点在框里:D(删除)不许落到身后那张卡上。遮罩盖着卡,真鼠标悬停不上去 ⇒
    // 直接给卡派 mouseenter(hotkey-menu 选中单键目标走的就是它),并**断言它真成了目标**(codex A8 L2:
    // 不断言的话这一格可能根本没走到)。删除第一次只出行内确认 ⇒ 两样都看:卡还在库里 + 卡上没冒确认。
    const armed = await browser.execute((sel) => {
      const c = eval(sel);
      c.dispatchEvent(new MouseEvent("mouseenter"));
      return c.classList.contains("is-active");
    }, cardSel(`${P}改后`));
    expect(armed).toBe(true);
    await browser.execute(() => {
      document.querySelector(".hd-panel .hd-close").focus();
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });
    await browser.pause(400);
    expect(await browser.execute((sel) => !!eval(sel)?.querySelector(".confirm-q"), cardSel(`${P}改后`))).toBe(false);
    expect(await taskByTitle(`${P}改后`)).not.toBe(null);
    expect(await browser.execute(() => !!document.querySelector(".hd-panel"))).toBe(true);
    await closeDialog();
    // 关框焦点回这张卡的 ⋯(codex A8 L1)
    expect(await browser.execute((sel) => document.activeElement === eval(sel)?.querySelector(".hk-btn"), cardSel(`${P}改后`))).toBe(true);
  });

  it("③ 单键 V 直达历史(改过的卡)", async () => {
    await goNotebook("board");
    const c = await $(`.tcard*=${P}改后`);
    await c.waitForExist({ timeout: 8000 });
    await c.moveTo();
    await browser.waitUntil(() => browser.execute((sel) => eval(sel)?.classList.contains("is-active"), cardSel(`${P}改后`)), {
      timeout: 3000,
      timeoutMsg: "悬停没选中那张卡",
    });
    await browser.keys("v");
    await $(".hd-panel .hist-entry").waitForExist({ timeout: 5000 });
    await closeDialog();
  });

  it("④ 界面上第一次改完,「改过」与菜单里的「历史」当场就有", async () => {
    await goNotebook("board");
    await $(`.tcard*=${P}没改`).waitForExist({ timeout: 8000 });
    await boardAction(`${P}没改`, "编辑");
    await $(".v-board .edit-input").waitForExist({ timeout: 5000 });
    await browser.execute((v) => {
      const a = document.querySelector(".v-board .edit-input");
      a.value = v;
      a.dispatchEvent(new Event("input", { bubbles: true }));
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, `${P}现在改了`);
    await browser.waitUntil(async () => await hasMark(`${P}现在改了`), {
      timeout: 8000,
      timeoutMsg: "界面上改完卡上没标「改过」",
    });
    expect(await boardMenuHas(`${P}现在改了`, "历史")).toBe(true);
  });

  it("⑤ 归档里的卡:改过的标「改过」、菜单有「历史」能打开;没改过的没有", async () => {
    const t = await taskByTitle(`${P}改后`);
    const plain = await invoke("create_task", { title: `${P}归档没改` });
    for (const id of [t.id, plain]) {
      await invoke("update_task_status", { id, to: "done" });
      await invoke("seal_task", { id });
    }
    await goNotebook("board");
    await $("#seal-toggle").click();
    await $(".sealed-view").$(`.tcard*=${P}改后`).waitForExist({ timeout: 8000 });
    expect(await hasMark(`${P}改后`)).toBe(true);
    expect(await hasMark(`${P}归档没改`)).toBe(false);
    expect(await boardMenuHas(`${P}归档没改`, "历史")).toBe(false);
    await boardAction(`${P}改后`, "历史");
    await $(".hd-panel .hist-entry").waitForExist({ timeout: 5000 });
    await closeDialog();
    // 回看板,别把归档视图留给下一支
    await $("#seal-toggle").click();
  });
});
