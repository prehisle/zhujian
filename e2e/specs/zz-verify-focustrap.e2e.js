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
