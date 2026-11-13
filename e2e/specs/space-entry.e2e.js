import { $, expect, browser } from "@wdio/globals";
import { goNotebook, invoke } from "./support.js";

// 411/D2「首用入口分层·桌面半」(408 走查):单空间时侧栏那枚「个人空间 ▾」徽章整个藏起
// ——落点无歧义,菜单里那几项(切换/新建/加入/改名/重置)第一天全用不到。
//
// ⛔ 本 spec 真正守的不是「藏起来了」,是**藏了还有路**:新建 / 加入空间的唯一入口就在
// 那枚徽章的菜单里,只藏不补 = 单空间用户再也建不了、加不了空间(408 点名要核的那一格)。
// 故两例是一对:①徽章不在;②同步面里的兜底能把同一个菜单开出来,且「新建/加入」都在。
//
// e2e 恒单空间(YS_DB_PATH 模式禁扫/禁建空间,support.js 头注),故「≥2 空间时徽章现身、
// 兜底行收起」那一半在这里造不出来 —— 那是本 spec 的诚实边界,判据在 notebook.ts /
// sync.ts 两处读同一个数(空间数),不是各判各的。

/** 面板/菜单里按可见文字点一枚钮(真实 DOM 结构随渲染变,按文字找最稳)。 */
function clickByText(sel, text) {
  return browser.execute(
    (s, t) => {
      for (const b of document.querySelectorAll(s)) {
        if (b.textContent.trim() === t) return b.click();
      }
      throw new Error(`没找到文字为「${t}」的元素:${s}`);
    },
    sel,
    text,
  );
}

describe("411/D2 空间入口分层(单空间藏徽章,同步面兜底)", () => {
  it("单空间时侧栏空间徽章不出现", async () => {
    await goNotebook("inbox");
    // 属性直读:元素常驻 DOM、只是 hidden,isDisplayed 那条路两端驱动读法有差(396)。
    const hidden = await browser.execute(() => document.getElementById("space-entry").hidden);
    expect(hidden).toBe(true);
  });

  it("同步面「空间…」兜底开出空间菜单,新建/加入空间都还在,且钳在视口内", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    await (await $(".sync-panel")).waitForExist({ timeout: 3000 });
    await clickByText(".sync-panel button", "空间…");
    // 面板是模态浮层,兜底行点完先关面板再开菜单(两者不同屏)。
    await browser.waitUntil(async () => !(await $(".sync-overlay").isExisting()), {
      timeout: 3000,
      timeoutMsg: "点「空间…」应先关掉同步面板",
    });
    const menu = await $(".space-menu");
    await menu.waitForExist({ timeout: 3000 });
    // 两项的真文案带前缀/后缀(「＋ 新建空间」「加入空间(输入配对码)…」),故按包含判。
    const labels = await browser.execute(() =>
      [...document.querySelectorAll(".space-menu button")].map((b) => b.textContent.trim()).join("|"),
    );
    expect(labels).toContain("新建空间");
    expect(labels).toContain("加入空间");
    // 钳位:锚点(同步入口)贴在侧栏底部,不钳就整个掉出视口下沿 = 真实的「点不到」。
    const fits = await browser.execute(() => {
      const r = document.querySelector(".space-menu").getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    expect(fits.top).toBeGreaterThanOrEqual(0);
    expect(fits.bottom).toBeLessThanOrEqual(fits.vh);
    // 收摊:Esc 关菜单,别留给下一个 spec。
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await browser.waitUntil(async () => !(await $(".space-menu").isExisting()), {
      timeout: 3000,
      timeoutMsg: "Esc 应关闭空间菜单",
    });
  });

  it("「加入空间」表单头上一句讲清「另开一个空间 vs 并进当前空间」(用户面 121)", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    await (await $(".sync-panel")).waitForExist({ timeout: 3000 });
    await clickByText(".sync-panel button", "空间…");
    const menu = await $(".space-menu");
    await menu.waitForExist({ timeout: 3000 });
    await clickByText(".space-menu button", "加入空间(输入配对码)…");
    const hint = await $(".space-menu .space-form .space-hint");
    await hint.waitForExist({ timeout: 3000 });
    const text = await hint.getText();
    // 两半都要有:这条路加的是**新空间**;并进主空间走的是同步面板那条「用配对码加入」。
    expect(text).toContain("作为一个新空间加到这台电脑");
    expect(text).toContain("用配对码加入");
    // 收摊:表单里的「取消」在没有在途加入时就是关菜单。
    await clickByText(".space-menu .space-form button", "取消");
    await browser.waitUntil(async () => !(await $(".space-menu").isExisting()), {
      timeout: 3000,
      timeoutMsg: "「取消」应关闭空间菜单",
    });
  });

  // 904 H1(Esc 只退一层):菜单里点开的小表单(新建 / 加入 / 重置的确认)按 Esc 先收表单、那一行换回来且拿到焦点,
  // 再按才关菜单。用真键。阴性对照:把 notebook.ts::escapeSpaceMenu 里收表单那一支拔掉(一律 closeSpaceMenu)→ 红在
  // 「Esc 把整个菜单关了」。
  it("空间菜单里的小表单:Esc 先收表单回到菜单(焦点在那一行),再按才关菜单", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    await (await $(".sync-panel")).waitForExist({ timeout: 3000 });
    await clickByText(".sync-panel button", "空间…");
    await (await $(".space-menu")).waitForExist({ timeout: 3000 });
    const here = () =>
      browser.execute(() => ({
        menu: !!document.querySelector(".space-menu"),
        forms: document.querySelectorAll(".space-menu .space-form").length,
        focusForm: !!document.activeElement?.closest?.(".space-form"),
        focusText: document.activeElement?.classList?.contains("space-row") ? document.activeElement.textContent.trim() : null,
      }));
    const waitHere = (pred, msg) =>
      browser.waitUntil(async () => pred(await here()), { timeout: 5000, timeoutMsg: msg }).catch(async (e) => {
        throw new Error(`${msg}\n  现场:${JSON.stringify(await here())}\n  ${e.message}`);
      });
    const spacesBefore = (await invoke("list_spaces")).length;
    for (const label of ["＋ 新建空间", "加入空间(输入配对码)…", "重置当前空间…"]) {
      await clickByText(".space-menu button", label);
      await waitHere((h) => h.forms === 1 && h.focusForm, `点「${label}」后小表单没出来 / 焦点没进表单`);
      if (label === "＋ 新建空间") {
        // 框里有字也一样只收表单(此前有字没字都整个关,不另问)
        await browser.keys(["x", "y"]);
        expect(await browser.execute(() => document.activeElement.value)).toBe("xy");
      }
      await browser.keys("Escape");
      await waitHere((h) => h.menu && h.forms === 0 && h.focusText === label, `Esc 把整个菜单关了,或焦点没回「${label}」那一行`);
    }
    // 收回去的那一行还是活的:再点照样开出表单(框是空的,刚才那两个字没留着)
    await clickByText(".space-menu button", "＋ 新建空间");
    await waitHere((h) => h.forms === 1 && h.focusForm, "收回去的那一行再点没开出表单");
    expect(await browser.execute(() => document.activeElement.value)).toBe("");
    await browser.keys("Escape");
    await waitHere((h) => h.menu && h.forms === 0, "第二次收表单没收住");
    await browser.keys("Escape");
    await waitHere((h) => !h.menu, "菜单上再按 Esc 应关菜单");
    expect((await invoke("list_spaces")).length).toBe(spacesBefore); // 一本都没建出来、没删掉
  });
});
