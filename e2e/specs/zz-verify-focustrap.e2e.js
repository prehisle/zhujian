// 常驻回归锚(a11y 焦点,mountLightbox + lightbox.ts::dismiss):焦点的事静默失效(用户只觉得
// 「怎么还要多点一下」)→ 值一个锚。验证:
//   ① 开图把焦点移进遮罩、Tab/Shift+Tab 困在遮罩内(`trapTab`);
//   ② 关图把**操作焦点还给开图那个窗**(遮罩窗 hide + 给 opener setFocus)。
//
// ⭐ **606 起这两格问的都不再是同一件事了,别照旧读**:遮罩搬进了自己那只窗(`lightbox.html`)。
//   ·例① 从前的价值在于「Tab 别溜到**背后被盖住的看板按钮**上」——那种误触现在结构上就不可能
//     (那些按钮压根不在这个文档里)。它今天守的是**剩下的那一半**:`trapTab` 还在不在、焦点
//     进没进遮罩。⛔ 别因此把它删了:`trapTab` 仍是活代码,且遮罩窗里日后一旦加了可聚焦控件
//     (翻页箭头就是),环绕逻辑立刻又开始承重。
//   ·例② 从前量的是遮罩所在文档里的 `prevFocus` 还焦;那个今天只在遮罩窗内部有意义(没人看得见)。
//     换成量两件**这套架构真会坏、且这里量得到**的事:关图之后 (a) 遮罩窗**真的藏起来了**
//     ——它是置顶窗,不藏就一直盖着整块屏幕,而 DOM 上一点痕迹都没有;(b) 笔记本窗自己的
//     `activeElement` **一个字没动**——遮罩在另一个文档里,本就不该碰到这边的焦点。
//     ⛔ **别拿 `document.hasFocus()` 当判据**(606 第一版就是这么写的,当场红):e2e 跑在
//     `run-on-desktop.ps1` 开的**后台桌面**上,那儿没有「活动窗口」,`hasFocus()` **恒 false**
//     ——连开图前那句前置自证都过不了。⚠ 「关图之后 OS 焦点回到笔记本窗」这件事**这里测不了**,
//     它由 CDP 在真桌面上验(606 实读:关图后笔记本页 `document.hasFocus() === true`),如实记账。
// 阴性对照(606 实跑):摘掉 `isTabKey(e) → trapTab(e)` → 例① 红;摘掉 `dismiss()` 里的
// `selfWin.hide()` → 例② 红。
// 用合成 MouseEvent("click") 触发开图(img 上的 click 监听照收),避开 WebDriver 真点击对焦点的副作用。
// zz 前缀:这支要在两个窗之间来回切,放字典序末尾跑最省心。
import { browser, $, expect } from "@wdio/globals";
import { goNotebook, invoke, toLightbox } from "./support.js";

async function seedTaskWithImage(title) {
  const id = await invoke("create_task", { title });
  await browser.execute(async (itemId) => {
    const cv = document.createElement("canvas");
    cv.width = 200;
    cv.height = 150;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#369";
    ctx.fillRect(0, 0, 200, 150);
    const dataB64 = cv.toDataURL("image/png").split(",")[1];
    await window.__TAURI__.core.invoke("add_item_image", {
      itemId,
      mime: "image/png",
      dataB64,
      spaceId: "main",
    });
  }, id);
}

const inOverlay = () =>
  browser.execute(() => {
    const a = document.activeElement;
    return !!a && (a.classList.contains("img-lightbox") || !!a.closest(".img-lightbox"));
  });

const openThumb = (title) =>
  browser.execute((t) => {
    const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
    card.querySelector(".img-thumb-img").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, title);

describe("a11y · lightbox 焦点", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("开图移焦进遮罩;Tab/Shift+Tab 困在遮罩内", async () => {
    const T = "焦点陷阱-Tab";
    await seedTaskWithImage(T);
    await goNotebook("board");
    await $(".tcard*=" + T).$(".img-thumb-img").waitForExist({ timeout: 5000 });
    await openThumb(T);

    const back = await toLightbox();
    await $(".img-lightbox").waitForExist({ timeout: 5000 });
    expect(await inOverlay()).toBe(true); // 开图即把焦点移进遮罩
    // ⭐ 603 起 Shift+Tab 这一步**两端都跑**(396 立、602 推翻、603 修完打开):
    // 396 写的是「WebKitWebDriver 在 GTK 层把 Shift+Tab 处理掉了,页面一条 keydown 都收不到
    // (那一步 `seen: []`)⇒ 拦不了一个收不到的事件 = 驱动差异,不是产品缺陷」。**那句不成立**
    // ——602 两支探针(WebDriver 一支、xdotool/XTEST 真键盘一支,同形)量出页面**收得到**那一记,
    // 只是 WebKitGTK 把 `e.key` 报成 `Unidentified`(`code=Tab` / `keyCode=9` / `shiftKey` 全在);
    // 396 那份读数里焦点跑到背后的 `BUTTON.hk-btn`,是 `trapTab` 判得太窄漏掉的**真 a11y 缺陷**。
    // 判据现在住 `src/keys.ts` 的 `isTabKey`(认 `key` 或 `code`)⇒ 这一步不再分平台。
    // ⛔ 别再把它改回「只在 Windows 上跑」:那样这一端的漏就又没人看着了。
    for (const key of ["Tab", "Tab", ["Shift", "Tab"], "Tab"]) {
      await browser.keys(key);
      expect(await inOverlay()).toBe(true); // 摘掉 trapTab → 焦点落到 body → 此处红
    }
    await browser.keys("Escape");
    await $(".img-lightbox").waitForExist({ reverse: true, timeout: 5000 });
    await back();
  });

  it("关图:遮罩窗真的藏起来,笔记本窗自己的焦点一个字没动", async () => {
    const T = "关图收窗";
    await seedTaskWithImage(T);
    await goNotebook("board");
    await $(".tcard*=" + T).$(".img-thumb-img").waitForExist({ timeout: 5000 });
    // 前置自证:开图之前,焦点确实钉在这颗按钮上 —— 否则「关图之后还在那儿」什么都没证明。
    const parked = await browser.execute(() => {
      const btn = document.querySelector('.sidebar nav button[data-view="board"]');
      btn.focus();
      return document.activeElement === btn;
    });
    expect(parked).toBe(true);

    await openThumb(T); // 合成 click 不改焦点
    const back = await toLightbox();
    await $(".img-lightbox").waitForExist({ timeout: 5000 });
    // 前置自证 2:开着的时候遮罩窗**是显形的** —— 不然下面那句「藏起来了」恒真。
    expect(await browser.execute(() => window.__TAURI__.window.getCurrentWindow().isVisible())).toBe(true);

    await browser.keys("Escape");
    await $(".img-lightbox").waitForExist({ reverse: true, timeout: 5000 });
    // (a) 遮罩窗真的藏了 —— 摘掉 dismiss() 里的 hide() 就红在这句(它是置顶窗,
    //     不藏就一直盖着整块屏幕,而 DOM 上一点痕迹都没有)。
    await browser.waitUntil(
      async () => browser.execute(() => window.__TAURI__.window.getCurrentWindow().isVisible().then((v) => !v)),
      { timeout: 5000, timeoutMsg: "关掉大图之后遮罩窗还显形着(dismiss 里的 hide 没生效)" },
    );
    await back();

    // (b) 笔记本窗自己的焦点一个字没动(遮罩在另一个文档里,本就不该碰这边)。
    const still = await browser.execute(
      () => document.activeElement === document.querySelector('.sidebar nav button[data-view="board"]'),
    );
    expect(still).toBe(true);
  });
});
