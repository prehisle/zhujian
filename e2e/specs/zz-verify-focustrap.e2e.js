// 常驻回归锚(a11y 焦点陷阱,mountLightbox):焦点陷阱静默失效(用户无感知)→ 值一个锚。验证:
//   ① 开图把焦点移进遮罩、Tab/Shift+Tab 困在遮罩内不溜到背后被盖住的看板按钮;
//   ② 关闭把焦点还回打开前的元素(prevFocus 还焦)。
// 双向阴性对照实跑过:摘掉开图移焦+trapTab → 例① 红;单摘还焦(保留开图移焦)→ 例② 红。
// 用合成 MouseEvent("click") 触发开图(img 上的 click 监听照收),避开 WebDriver 真点对焦点的副作用,
// 让「还焦」测试的 prevFocus 确定为那颗侧栏按钮。
// zz 前缀:openLightbox(已保存图)可能在暗遮罩下撑主窗,窗口几何敏感,放字典序末尾跑。
import { browser, $, expect } from "@wdio/globals";
import { goNotebook, invoke } from "./support.js";

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

describe("a11y · lightbox 焦点陷阱", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("开图移焦进遮罩;Tab/Shift+Tab 困在遮罩内不溜到背后", async () => {
    const T = "焦点陷阱-Tab";
    await seedTaskWithImage(T);
    await goNotebook("board");
    await $(".tcard*=" + T).$(".img-thumb-img").waitForExist({ timeout: 5000 });
    await openThumb(T);
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
      expect(await inOverlay()).toBe(true); // 旧代码:焦点会溜到背后看板按钮 → 此处红
    }
    await browser.keys("Escape");
    await $(".img-lightbox").waitForExist({ reverse: true, timeout: 5000 });
    await browser.pause(400); // 让还原窗口在遮罩下跑完
  });

  it("关闭把焦点还回打开前的元素", async () => {
    const T = "焦点陷阱-还焦";
    await seedTaskWithImage(T);
    await goNotebook("board");
    await $(".tcard*=" + T).$(".img-thumb-img").waitForExist({ timeout: 5000 });
    const marked = await browser.execute(() => {
      const btn = document.querySelector('.sidebar nav button[data-view="board"]');
      btn.focus();
      return document.activeElement === btn;
    });
    expect(marked).toBe(true);
    await openThumb(T); // 合成 click 不改焦点 → prevFocus 恒为那颗按钮
    await $(".img-lightbox").waitForExist({ timeout: 5000 });
    await browser.keys("Escape");
    await $(".img-lightbox").waitForExist({ reverse: true, timeout: 5000 });
    await browser.pause(400);
    const restored = await browser.execute(
      () => document.activeElement === document.querySelector('.sidebar nav button[data-view="board"]'),
    );
    expect(restored).toBe(true);
  });
});
