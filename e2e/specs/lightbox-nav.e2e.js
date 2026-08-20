import { $, browser, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// 224 同条目多图:大图遮罩内 ←/→ 键与左右箭头按钮在组内循环翻页。
// 三张图刻意给不同的自然边长(4/8/12px),这样「翻到了另一张」不是只看角标文字,
// 而是由 img.naturalWidth 这个只有真换了字节才会变的量作证。
// 单图那一例是配套的反面对照:导航件必须不出现(不给只有一张图的人多余控件)。

/** 在页面里现造一张 n×n 的 PNG,返回不带 data: 前缀的 base64(add_item_image 要这个形状)。 */
const mkPng = (n) =>
  browser.execute((size) => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const x = c.getContext("2d");
    x.fillStyle = "#c0392b";
    x.fillRect(0, 0, size, size);
    return c.toDataURL("image/png").split(",")[1];
  }, n);

const addPng = async (itemId, n) =>
  invoke("add_item_image", { itemId, mime: "image/png", dataB64: await mkPng(n) });

/** 当前大图的实况:自然宽(=哪张图)、alt、角标读数。 */
const shown = () =>
  browser.execute(() => {
    const i = document.querySelector("img.img-lightbox-img");
    const c = document.querySelector(".img-lightbox-count");
    return { w: i ? i.naturalWidth : 0, alt: i ? i.alt : "", vis: i ? i.style.visibility : "?", count: c ? c.textContent : null };
  });

/** 等到大图换成自然宽为 w 的那张、且已亮相(visibility 复位)。
 *  ⭐ 红了自带现场(455,同 439 的形):这句原来只说「大图没换到自然宽 N」,而它**盖住了
 *  两个不同的病** —— ①图根本没换(`w` 还是上一张 / 是 0 = 压根没 `<img>`)⇒ 换图那条路断了;
 *  ②图换了但**没亮相**(`vis === "hidden"`)⇒ 是「布局未定不显示」那条取舍还没放行,
 *  与 zz-verify-163 例② 同族(几何/撑窗敏感)。两种在屏幕上一模一样,而这支是**已记档的
 *  老抖动支**(progress-log 8547「基线已记档的抖动支」;455 在 Windows 全量第一趟又见一次,
 *  三格分诊全绿)⇒ 下次再红,现场直接把 w/vis/alt/角标 摆出来,一眼分档。 */
const waitShown = async (w) => {
  let last = null;
  try {
    await browser.waitUntil(async () => {
      last = await shown();
      return last.w === w && last.vis === "";
    }, { timeout: 10000, timeoutMsg: `大图没换到自然宽 ${w}` });
  } catch (e) {
    throw new Error(
      `大图没换到自然宽 ${w} —— 实读 ${last === null ? "(一次都没读到)" : JSON.stringify(last)}` +
        `(w 不对=没换图;vis="hidden"=换了没亮相,那是「布局未定不显示」那条取舍)` +
        `(原始报错:${String(e).split("\n")[0]})`,
    );
  }
};

describe("配图 · 大图遮罩内翻同条目的多图(224)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("←/→ 与左右箭头在三张图间循环,角标随之走", async () => {
    const id = await invoke("capture_note", { content: "E2E-多图翻页" });
    await addPng(id, 4); // 图1
    await addPng(id, 8); // 图2
    await addPng(id, 12); // 图3

    await goNotebook("inbox");
    const card = await $(".note*=E2E-多图翻页");
    await card.waitForExist({ timeout: 10000 });
    const thumb = await card.$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await thumb.click(); // 点第一张缩略图 → openLightbox(整组, 0)

    const box = await $(".img-lightbox");
    await box.waitForExist({ timeout: 10000 });
    await waitShown(4);
    expect((await shown()).count).toBe("图1 · 1/3");
    await expect(await $(".img-lightbox-nav.prev")).toExist();
    await expect(await $(".img-lightbox-nav.next")).toExist();

    // → 键:图1 → 图2
    await browser.keys(["ArrowRight"]);
    await waitShown(8);
    expect((await shown()).count).toBe("图2 · 2/3");
    expect((await shown()).alt).toBe("图2");

    // 点「›」按钮:图2 → 图3(顺带验按钮的 click 没冒泡到遮罩的「点背景关闭」)
    await (await $(".img-lightbox-nav.next")).click();
    await waitShown(12);
    expect((await shown()).count).toBe("图3 · 3/3");
    await expect(await $(".img-lightbox")).toExist(); // 仍开着

    // 末张再往后:绕回第一张
    await (await $(".img-lightbox-nav.next")).click();
    await waitShown(4);
    expect((await shown()).count).toBe("图1 · 1/3");

    // ← 键从首张往前:绕到末张
    await browser.keys(["ArrowLeft"]);
    await waitShown(12);
    expect((await shown()).count).toBe("图3 · 3/3");

    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await $(".img-lightbox").isExisting()), {
      timeout: 10000,
      timeoutMsg: "Esc 没关掉大图",
    });
  });

  it("只有一张图时不出导航件(不给单图的人多余控件)", async () => {
    await clearInbox();
    const id = await invoke("capture_note", { content: "E2E-单图无导航" });
    await addPng(id, 6);

    await goNotebook("inbox");
    const card = await $(".note*=E2E-单图无导航");
    await card.waitForExist({ timeout: 10000 });
    const thumb = await card.$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await thumb.click();

    await (await $(".img-lightbox")).waitForExist({ timeout: 10000 });
    await waitShown(6);
    await expect(await $(".img-lightbox-nav.prev")).not.toExist();
    await expect(await $(".img-lightbox-nav.next")).not.toExist();
    await expect(await $(".img-lightbox-count")).not.toExist();

    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await $(".img-lightbox").isExisting()), {
      timeout: 10000,
      timeoutMsg: "Esc 没关掉大图",
    });
  });
});
