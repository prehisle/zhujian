// W5 修复 · D1 组(桌面键盘与焦点,backlog 用户面 165)的回归锚。守的是「只用键盘的人」那几条路:
//   ① 选中 = 焦点(A2 / A6 / A7):Tab 到一张卡的 ⋯ 就是选中它;↑ ↓ 挪选中时焦点跟着走;
//   ② 单键做完选中落到原位后一张、整列重画后接回同一张(A3 / A12);Ctrl+Z = 回执上的【撤销】(A1);
//   ③ 层与菜单一个规矩(Q2):打开焦点进去、Esc 关、关完焦点回打开它的那枚(A2 / A4 / A8 / A14 / A15 / A39);
//   ④ 确认一出来焦点停【取消】(Q3);看板 ← → 换列(Q10);搜索落点 Esc 回搜索且落点是选中(Q11);
//   ⑤ Tab 走开 = 离开就保存(A17,⛔ 没改不多落一版);⤢ 上回车 = 放大、不是保存(A10);E 不全选(Q15)。
// 用真键(browser.keys):焦点移动、钮上回车 = 点击这些默认动作合成事件给不了。
// 阴性对照(本轮手工三刀,读数在回报):摘掉 hotkey-menu.ts 的 onFocusIn 里 setActiveRow → ① 红;
// leave() 里不落到后一张 → ② 红;revealConfirm 改回 .act.primary → ④ 红(④ 今天由随记回收站「彻底删除」那例守;看板删卡不再有确认,F 组 F4)。
import { browser, $, expect } from "@wdio/globals";
import { clearInbox, goNotebook, inboxShow, invoke, typeText } from "./support.js";

const P = "W5D1-";

/** 读现场:选中的卡、焦点所在的卡、焦点那枚、菜单开没开。卡认正文前 24 个字。 */
const state = () =>
  browser.execute(() => {
    const txt = (n) =>
      n ? (n.querySelector(".note-text, .ttitle, .doc-card-title")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24) : null;
    const a = document.activeElement;
    return {
      selected: [...document.querySelectorAll(".hk-host.is-active")].map(txt),
      focusCard: txt(a?.closest?.(".hk-host") ?? null),
      onBtn: !!a?.classList?.contains("hk-btn"),
      cls: a ? String(a.className) : "",
      inMenu: !!a?.closest?.(".hk-menu"),
      menu: !!document.querySelector(".hk-menu"),
    };
  });

/** 把焦点放到那张卡的 ⋯ 上(起点;之后全用真键)。 */
const focusDots = (sel, text) =>
  browser.execute(
    (s, t) => {
      const c = [...document.querySelectorAll(s)].find((n) => n.textContent.includes(t));
      if (!c) throw new Error("卡不在:" + t);
      c.querySelector(".hk-btn").focus();
    },
    sel,
    text,
  );

const waitState = (pred, msg) =>
  browser.waitUntil(async () => pred(await state()), {
    timeout: 6000,
    timeoutMsg: msg,
  }).catch(async (e) => {
    throw new Error(`${msg}\n  现场:${JSON.stringify(await state())}\n  ${e.message}`);
  });

describe("W5 D1 · 桌面键盘与焦点", () => {
  it("随记:⋯ 上的焦点就是选中;↓ 挪选中时焦点跟着走;E 作用于焦点那张、光标在末尾(A7 / Q15)", async () => {
    await clearInbox();
    for (const s of ["甲", "乙", "丙"]) await invoke("capture_note", { content: `${P}${s}` });
    await inboxShow("ideas");
    await $(`.note*=${P}甲`).waitForExist({ timeout: 8000 });
    await focusDots(".note", `${P}丙`); // 时间轴最上面那张(后记的在上)
    await waitState((s) => s.selected[0] === `${P}丙`, "焦点进了卡的 ⋯,这张却没成为选中");
    await browser.keys("ArrowDown");
    await waitState((s) => s.selected.length === 1 && s.selected[0] === `${P}乙` && s.focusCard === `${P}乙` && s.onBtn, "↓ 之后焦点没跟着选中走到下一张的 ⋯");
    await browser.keys("e");
    await $(".note .edit-area").waitForExist({ timeout: 5000 });
    const ed = await browser.execute(() => {
      const a = document.activeElement;
      return { cls: a.className, start: a.selectionStart, end: a.selectionEnd, len: a.value.length, val: a.value };
    });
    expect(ed).toEqual({ cls: "edit-area", start: ed.len, end: ed.len, len: `${P}乙`.length, val: `${P}乙` });
    await browser.keys("Escape"); // 没改:一下就收
    await waitState((s) => s.focusCard === `${P}乙` && s.onBtn, "收起编辑后焦点没回这张卡的 ⋯(A4)");
  });

  it("随记:D 删掉后选中落到原位后一张、焦点跟着;Ctrl+Z = 回执上的【撤销】,撤回来的那张重新是选中(A3 / A1)", async () => {
    await focusDots(".note", `${P}乙`);
    expect(await $(".undo-toast").isExisting()).toBe(false);
    await browser.keys("d");
    await $(".undo-toast").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".undo-toast .undo-btn:not(.undo-go)")?.dataset.k)).toMatch(/\+Z$/);
    await waitState((s) => s.selected.length === 1 && s.selected[0] === `${P}甲` && s.focusCard === `${P}甲`, "删掉后选中 / 焦点没落到原位后一张");
    await browser.keys(["Control", "z"]);
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.content === `${P}乙`), {
      timeout: 6000,
      timeoutMsg: "Ctrl+Z 没把卡撤回来",
    });
    await waitState((s) => s.selected[0] === `${P}乙` && s.focusCard === `${P}乙`, "撤回来的那张没重新成为选中 / 拿到焦点");
    // 删掉那一下的离场动画收尾(260ms 后)还会补一发整列重画;等它落定,免得它在下一例里把开着的菜单 / 编辑收掉
    await browser.pause(800);
    await waitState((s) => s.selected[0] === `${P}乙` && s.focusCard === `${P}乙`, "离场收尾那一发重画后选中 / 焦点丢了");
  });

  it("⋯ 菜单:回车打开焦点就进第一项,↓ 走项,Esc 关了焦点回 ⋯ 且选中留着;菜单里按字母 = 做那一项(A2 / Q2)", async () => {
    await focusDots(".note", `${P}乙`);
    await browser.keys("Enter");
    await waitState((s) => s.menu && s.inMenu, "回车开了菜单,焦点却没进菜单");
    const first = await browser.execute(() => document.activeElement.textContent);
    await browser.keys("ArrowDown");
    const second = await browser.execute(() => document.activeElement.textContent);
    expect(second).not.toBe(first);
    await browser.keys("Escape");
    await waitState((s) => !s.menu && s.focusCard === `${P}乙` && s.onBtn && s.selected[0] === `${P}乙`, "Esc 关菜单后焦点没回 ⋯ / 选中丢了");
    await browser.keys("Enter");
    await waitState((s) => s.inMenu, "第二次没开出菜单");
    await browser.keys("e");
    await browser
      .waitUntil(async () => browser.execute(() => !!document.querySelector(".note .edit-area")), { timeout: 5000 })
      .catch(async () => {
        throw new Error(`菜单里按 E 没开编辑。现场:${JSON.stringify(await state())}`);
      });
    await browser.keys("Escape");
  });

  it("编辑框:改了按 Tab 走开 = 存下并收起(一版);没改 Tab 走开只收起、不多落一版(A17)", async () => {
    await focusDots(".note", `${P}甲`);
    await browser.keys("e");
    await $(".note .edit-area").waitForExist({ timeout: 5000 });
    await typeText("x");
    // 卡里还有「＋加图」那一站;Tab 到焦点出了这张卡为止
    for (let i = 0; i < 4; i++) {
      await browser.keys("Tab");
      const out = await browser.execute(() => !document.activeElement?.closest?.(".note.editing"));
      if (out) break;
    }
    await browser
      .waitUntil(async () => (await invoke("list_ideas")).some((i) => i.content === `${P}甲x`), { timeout: 6000 })
      .catch(async () => {
        const here = await browser.execute(() => ({
          ae: `${document.activeElement?.tagName}.${document.activeElement?.className}`,
          editing: [...document.querySelectorAll(".note.editing .edit-area")].map((a) => a.value),
        }));
        const lib = (await invoke("list_ideas")).filter((i) => i.content.startsWith(P)).map((i) => i.content);
        throw new Error(`Tab 走开没把改动存下。现场:${JSON.stringify(here)};库里:${JSON.stringify(lib)}`);
      });
    await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector(".note.editing"))), {
      timeout: 6000,
      timeoutMsg: "Tab 走开后编辑框还开着",
    });
    const id = (await invoke("list_ideas")).find((i) => i.content === `${P}甲x`).id;
    expect((await invoke("list_revisions", { id, before: null })).total).toBe(1);
    // 没改:Tab 走开只收起
    await focusDots(".note", `${P}甲x`);
    await browser.keys("e");
    await $(".note .edit-area").waitForExist({ timeout: 5000 });
    for (let i = 0; i < 4; i++) {
      await browser.keys("Tab");
      const out = await browser.execute(() => !document.activeElement?.closest?.(".note.editing"));
      if (out) break;
    }
    await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector(".note.editing"))), {
      timeout: 6000,
      timeoutMsg: "没改、Tab 走开后编辑框还开着",
    });
    await browser.pause(400);
    expect((await invoke("list_revisions", { id, before: null })).total).toBe(1); // ⛔ 没多落一版
  });

  it("随记的历史:H 打开焦点进第一版,Esc 收走、焦点回 ⋯(A15)", async () => {
    await focusDots(".note", `${P}甲x`);
    await browser.keys("h");
    await waitState((s) => s.cls.includes("hist-entry"), "H 打开历史后焦点没进去");
    await browser.keys("Escape");
    await waitState((s) => s.focusCard === `${P}甲x` && s.onBtn, "Esc 后焦点没回 ⋯");
    expect(await browser.execute(() => [...document.querySelectorAll(".hist-host")].some((h) => h.childElementCount > 0))).toBe(false);
  });

  it("随记回收站:R 还原后 ↑ ↓ 照样选得中;彻底删除的确认焦点停【取消】、回车 = 取消(A12 / Q3)", async () => {
    for (const s of ["丁", "戊"]) {
      const id = await invoke("capture_note", { content: `${P}${s}` });
      await invoke("archive_note", { id });
    }
    await inboxShow("archived");
    await $(`.note*=${P}戊`).waitForExist({ timeout: 8000 });
    await focusDots(".note", `${P}戊`);
    await browser.keys("r");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.content === `${P}戊`), { timeout: 6000, timeoutMsg: "R 没还原" });
    await browser.pause(400);
    await browser.keys("ArrowDown");
    await browser.keys("ArrowUp");
    await waitState((s) => s.selected.length === 1 && s.focusCard !== null, "还原一条后 ↑ ↓ 选不中了(A12)");
    await focusDots(".note", `${P}丁`);
    await browser.keys("d");
    await waitState((s) => s.cls === "no" && s.focusCard === `${P}丁`, "彻底删除的确认出来,焦点没停在【取消】上(Q3)");
    await browser.keys("Enter");
    await waitState((s) => s.onBtn && s.focusCard === `${P}丁`, "回车取消后焦点没回 ⋯");
    expect((await invoke("list_archived")).some((i) => i.content === `${P}丁`)).toBe(true);
  });

  it("看板:← → 换列(选中跳到隔壁列最上面那张);] 挪完选中留在原位后一张(Q10 / A3)", async () => {
    const a = await invoke("create_task", { title: `${P}左` });
    const b = await invoke("create_task", { title: `${P}右` });
    await invoke("update_task_status", { id: b, to: "doing" });
    await goNotebook("board");
    await $(`.tcard*=${P}右`).waitForExist({ timeout: 8000 });
    await focusDots(".tcard", `${P}左`);
    await browser.keys("ArrowRight");
    const firstDoing = await browser.execute(() =>
      (document.querySelector('.col[data-col="doing"] .tcard .ttitle')?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
    );
    await waitState((s) => s.selected[0] === firstDoing && s.focusCard === firstDoing && s.onBtn, "→ 没跳到「进行中」最上面那张");
    await browser.keys("ArrowLeft");
    const firstTodo = await browser.execute(() =>
      (document.querySelector('.col[data-col="todo"] .tcard .ttitle')?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
    );
    await waitState((s) => s.selected[0] === firstTodo, "← 没跳回「待办」最上面那张");
    await focusDots(".tcard", `${P}左`);
    // 原位后一张 = 文档序里紧跟它的那张(同列下一张;它是列尾就是右边一列的第一张)
    const after = await browser.execute((t) => {
      const all = [...document.querySelectorAll(".tcard")];
      const i = all.findIndex((c) => c.textContent.includes(t));
      return (all[i + 1]?.querySelector(".ttitle")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    }, `${P}左`);
    await browser.keys("]");
    await browser.waitUntil(async () => (await invoke("list_tasks")).find((t) => t.id === a)?.status === "doing", {
      timeout: 6000,
      timeoutMsg: "] 没挪列",
    });
    await browser.pause(500); // 挪完那一发重画落定
    await waitState((s) => s.selected.length === 1 && s.selected[0] === after && s.focusCard === after, "挪完列选中 / 焦点没留在原位后一张");
  });

  it("看板:D 直接删(不再先问)、选中落原位后一张;Ctrl+Z 撤回来重新是选中;E 不全选;⤢ 上回车 = 放大、不存(F4 / A3 / A1 / Q15 / A10)", async () => {
    await focusDots(".tcard", `${P}左`);
    // 原位后一张 = 文档序里紧跟它的那张;它是最后一张就往前一张(hotkey-menu 的 leave 同一条规矩)
    const next = await browser.execute((t) => {
      const all = [...document.querySelectorAll(".tcard")];
      const i = all.findIndex((c) => c.textContent.includes(t));
      return ((all[i + 1] ?? all[i - 1])?.querySelector(".ttitle")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    }, `${P}左`);
    expect(next).not.toBe(""); // 前置:屏上不止它一张(否则下面那句是空断言)
    await browser.execute(() => document.querySelector(".undo-toast")?.remove());
    await browser.keys("d");
    // 不问:没有确认条,卡直接进回收站,回执带【撤销】
    await browser.waitUntil(async () => !(await invoke("list_tasks")).some((t) => t.title === `${P}左`), { timeout: 6000, timeoutMsg: "D 没直接删(还在等确认?)" });
    expect(await browser.execute(() => !!document.querySelector(".tcard .confirm-q"))).toBe(false);
    await $(".undo-toast").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".undo-toast .undo-text").textContent)).toBe("已移入回收站");
    await waitState((s) => s.selected.length === 1 && s.selected[0] === next && s.focusCard === next, "删掉后选中 / 焦点没落到原位后一张");
    await browser.keys(["Control", "z"]);
    await browser.waitUntil(async () => (await invoke("list_tasks")).some((t) => t.title === `${P}左`), { timeout: 6000, timeoutMsg: "Ctrl+Z 没把卡撤回来" });
    await waitState((s) => s.selected[0] === `${P}左` && s.focusCard === `${P}左` && s.onBtn, "撤回来的那张没重新成为选中 / 拿到焦点");
    await browser.keys("e");
    await $(".tcard .edit-input").waitForExist({ timeout: 5000 });
    const ed = await browser.execute(() => {
      const a = document.activeElement;
      return [a.selectionStart, a.selectionEnd, a.value.length];
    });
    expect(ed).toEqual([`${P}左`.length, `${P}左`.length, `${P}左`.length]);
    await typeText("q");
    await browser.keys(["Shift", "Tab"]); // ⤢ 在框上面那一行
    expect(await browser.execute(() => document.activeElement.classList.contains("edit-zoom"))).toBe(true);
    await browser.keys("Enter");
    await $(".ze-overlay").waitForExist({ timeout: 5000 });
    expect((await invoke("list_tasks")).some((t) => t.title === `${P}左`)).toBe(true); // 没被存成「…q」
    await browser.keys("Escape"); // 改过:先提醒
    await browser.keys("Escape"); // 再按 = 丢
    await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector(".ze-overlay"))), {
      timeout: 5000,
      timeoutMsg: "放大框没收",
    });
    await waitState((s) => s.onBtn && s.focusCard === `${P}左`, "放大编辑丢掉后焦点没回这张卡的 ⋯");
  });

  it("看板:按 E 紧跟着打的字进编辑框,不被当成那张卡的单键(D 删 / T 置顶)(168)", async () => {
    await focusDots(".tcard", `${P}左`);
    // 一发连按:E 之后那几下落在「重画中、编辑框还没出来」的窗口里(各不相同,免 WebKitWebDriver 吞相邻重复字)
    await browser.keys(["e", "d", "t", "x"]);
    await $(".tcard .edit-input").waitForExist({ timeout: 5000 });
    const here = () =>
      browser.execute(() => ({
        val: document.activeElement?.value ?? null,
        cls: String(document.activeElement?.className ?? ""),
        confirm: !!document.querySelector(".tcard .confirm-q"),
      }));
    await browser
      .waitUntil(async () => (await here()).val === `${P}左dtx`, { timeout: 3000 })
      .catch(async () => {
        throw new Error(`E 后紧跟的字没进编辑框。现场:${JSON.stringify(await here())}`);
      });
    expect((await here()).confirm).toBe(false); // D 没被派发成删除确认
    await browser.keys("Escape"); // 改过:先提醒
    await browser.keys("Escape"); // 再按 = 丢
    await waitState((s) => s.onBtn && s.focusCard === `${P}左`, "丢掉编辑后焦点没回这张卡的 ⋯");
    expect((await invoke("list_tasks")).some((t) => t.title === `${P}左`)).toBe(true); // 没删、没存成「…dtx」
  });

  it("看板:P 的选项焦点进去,Esc 收起焦点回 ⋯(A39)", async () => {
    await focusDots(".tcard", `${P}左`);
    await browser.keys("p");
    await waitState((s) => s.cls.includes("choice"), "P 展开的选项没拿到焦点");
    await browser.keys("Escape");
    await waitState((s) => s.onBtn && s.focusCard === `${P}左`, "Esc 收起后焦点没回 ⋯");
  });

  // 904 H1(Esc 只退一层):「移到 ▸」子层里按 Esc 先回上一层菜单、焦点落回「移到」那一行,再按才关。
  // 阴性对照:把 hotkey-menu.ts::onMenuKey 里退层那一支拔掉(一律 closeMenu)→ 这一例红在「子层里按 Esc 把菜单整个关了」。
  it("看板:⋯ 菜单的「移到 ▸」子层里 Esc 先回上一层(焦点回「移到」那行),再按才关、焦点回 ⋯", async () => {
    await focusDots(".tcard", `${P}左`);
    await browser.keys("Enter");
    await waitState((s) => s.menu && s.inMenu, "回车开了菜单,焦点却没进菜单");
    const menuNow = () =>
      browser.execute(() => ({
        open: !!document.querySelector(".hk-menu"),
        sub: !!document.querySelector(".hk-menu .hk-back"),
        focusLabel: document.activeElement?.querySelector?.(".hk-label")?.textContent ?? null,
        focusHasSub: !!document.activeElement?.classList?.contains("hk-has-sub"),
      }));
    const waitMenu = (pred, msg) =>
      browser.waitUntil(async () => pred(await menuNow()), { timeout: 5000, timeoutMsg: msg }).catch(async (e) => {
        throw new Error(`${msg}\n  现场:${JSON.stringify(await menuNow())}\n  ${e.message}`);
      });
    await browser.execute(() => {
      const row = [...document.querySelectorAll(".hk-menu .hk-has-sub")].find((b) => b.querySelector(".hk-label").textContent === "移到");
      if (!row) throw new Error("菜单里没有「移到 ▸」");
      row.focus();
    });
    await browser.keys("ArrowRight");
    await waitMenu((m) => m.open && m.sub && !m.focusHasSub && m.focusLabel !== null, "→ 没进「移到 ▸」子层");
    await browser.keys("Escape");
    await waitMenu((m) => m.open && !m.sub && m.focusHasSub && m.focusLabel === "移到", "子层里按 Esc 把菜单整个关了 / 焦点没回「移到」那一行");
    await browser.keys("Escape");
    await waitState((s) => !s.menu && s.onBtn && s.focusCard === `${P}左`, "回到主菜单后再按 Esc 没关菜单 / 焦点没回 ⋯");
  });

  it("搜索:回车跳过去,落点那张是选中、焦点在它的 ⋯;Esc 回搜索,词在、焦点回那条结果(Q11)", async () => {
    await goNotebook("search");
    await browser.execute((q) => {
      const i = document.querySelector("#q");
      i.value = q;
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }, `${P}右`);
    const hit = await $(".v-search .hit");
    await hit.waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector(".v-search .hit").focus());
    await browser.keys("Enter");
    await $(".v-board").waitForExist({ timeout: 8000 });
    await waitState((s) => s.selected[0] === `${P}右` && s.focusCard === `${P}右` && s.onBtn, "落点那张不是选中 / 焦点不在它的 ⋯");
    await browser.keys("Escape");
    await $(".v-search").waitForExist({ timeout: 8000 });
    expect(await browser.execute(() => document.querySelector("#q").value)).toBe(`${P}右`);
    await browser.waitUntil(async () => browser.execute(() => document.activeElement?.classList.contains("hit")), {
      timeout: 6000,
      timeoutMsg: "Esc 回搜索后焦点没落回那条结果",
    });
    // 168:再跳一次,在落点页里自己换到回收站 = 走开了 ⇒ Esc 不再回搜索
    await browser.keys("Enter");
    await $(".v-board").waitForExist({ timeout: 8000 });
    await waitState((s) => s.selected[0] === `${P}右`, "第二次跳过去落点不对");
    await browser.execute(() => document.querySelector(".v-board #trash-toggle").click());
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector(".v-board #trash-toggle.active")), {
      timeout: 6000,
      timeoutMsg: "回收站没打开",
    });
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys("Escape");
    await browser.pause(400);
    expect(await browser.execute(() => !!document.querySelector(".v-search"))).toBe(false);
    await browser.execute(() => document.querySelector(".v-board #trash-toggle").click()); // 回看板
  });

  it("标签合并:M 进来焦点在第一枚方框,空格勾选,Esc 退出、焦点回「合并」钮(A8)", async () => {
    await invoke("create_topic", { title: `${P}标甲` });
    await invoke("create_topic", { title: `${P}标乙` });
    await goNotebook("topics");
    await $(".v-topics .topic").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector("#merge-toggle").focus());
    await browser.keys("m");
    await browser.waitUntil(async () => browser.execute(() => document.activeElement?.classList.contains("check")), {
      timeout: 5000,
      timeoutMsg: "进合并态焦点没进第一枚方框",
    });
    await browser.keys(" ");
    expect(await browser.execute(() => document.querySelectorAll(".v-topics .topic.selected").length)).toBe(1);
    expect(await browser.execute(() => document.activeElement.getAttribute("aria-checked"))).toBe("true");
    await browser.keys("Escape");
    expect(await browser.execute(() => document.querySelector(".v-topics").classList.contains("merging"))).toBe(false);
    expect(await browser.execute(() => document.activeElement?.id)).toBe("merge-toggle");
  });

  it("Ctrl+, 开设置;左栏 ↓ 换页;别名框没改时 Esc 就关设置(Q15 / A14)", async () => {
    await goNotebook("inbox");
    await browser.keys(["Control", ","]);
    await $(".settings-overlay").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="general"]').focus());
    await browser.keys("ArrowDown");
    expect(await browser.execute(() => document.querySelector(".settings-cat.on")?.dataset.cat)).toBe("hotkeys");
    await browser.keys("ArrowUp");
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector(".alias-input")?.disabled), {
      timeout: 5000,
      timeoutMsg: "别名框一直是灰的",
    });
    await browser.execute(() => document.querySelector(".alias-input").focus());
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector(".settings-overlay"))), {
      timeout: 5000,
      timeoutMsg: "别名框没改,Esc 却关不掉设置",
    });
  });

  it("长文阅读页:页头印着的 H 照着按就进历史(A13)", async () => {
    const id = await invoke("capture_doc", { content: `# ${P}长文\n\n一段。` });
    await goNotebook("docs");
    await browser.waitUntil(
      async () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), `${P}长文`),
      { timeout: 8000, timeoutMsg: "长文列表里没出现那一篇" },
    );
    await browser.execute((t) => {
      const c = [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.textContent.includes(t));
      c.click();
    }, `${P}长文`);
    await $(".v-docs .doc-page").waitForExist({ timeout: 8000 });
    await browser.keys("h");
    await $(".v-docs .hv").waitForExist({ timeout: 5000 });
    await browser.keys("Escape");
    await $(".v-docs .doc-page").waitForExist({ timeout: 5000 });
    await invoke("archive_note", { id });
  });
});
