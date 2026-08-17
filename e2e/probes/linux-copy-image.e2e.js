// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)
// —— 理由与 `win-copy-image.e2e.js` 同:它**真的会改写本机剪贴板**;这支是 Linux 专属(xclip)。
//
// 补的是 backlog「测试与工装」3② 里**最该补的那半**:394 在 Linux 上撞出「WebKitGTK 的异步
// 剪贴板只认文本、写图恒 `NotAllowedError`」,于是 `copyImageToClipboard` 长出**第二条真机制**
// —— 退到壳的 arboard(`writeImage`)。411 已给 Windows 那半织了网,并量出 **Windows 恒走 web
// 那支**(`{"web":"ok"}`,arboard 那条**一次都没被叫到**)⇒ **这条退路今天全世界零回归网,
// 而唯一走它的就是这一端**。
//
// ⭐ 判别式与 411 同手法、**期望值恰好相反**:那边断 `probe.web === "ok"`,这边断它
// **抛过**(`throw:…`),真正要证的是「退到 arboard 之后,系统剪贴板上确实多了那张图」。
// ⇒ 断言分两格:①机制走的是哪条(web 抛了);②效果真达成(剪贴板上尺寸恰是那一张)。
// 只断①是「验了个报错」,只断②则分不清是哪条路送上去的。
//
// 怎么跑(先照文档退出生产朱简;fast 形要另起 `npm run dev`):
//   YS_E2E_FAST=1 npx wdio run e2e/wdio.conf.js --specFileRetries=0 --spec e2e/probes/linux-copy-image.e2e.js
import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "../specs/support.js";
import { clipboardImage, clipboardTargets, clearClipboard } from "./xclip.js";

/** 在页面里现造一张 w×h 的 PNG,返回不带 data: 前缀的 base64(add_item_image 要这个形状)。 */
const mkPng = (w, h) =>
  browser.execute(
    (ww, hh) => {
      const c = document.createElement("canvas");
      c.width = ww;
      c.height = hh;
      const x = c.getContext("2d");
      x.fillStyle = "#c0392b";
      x.fillRect(0, 0, ww, hh);
      return c.toDataURL("image/png").split(",")[1];
    },
    w,
    h,
  );

// 尺寸与 Windows 那支**刻意取同一对**(37×21):两端读数才能直接对照,且它不像默认值 ——
// 剪贴板上若是别处残留的图,尺寸对不上当场露馅。
const W = 37;
const H = 21;

describe("223/394 · 看大图 Ctrl+C 复制整张图(Linux 真剪贴板 / arboard 那条退路)", () => {
  it("Ctrl+C 后系统剪贴板真的拿到那张图,且走的是**壳的 arboard**(web 那支抛过)", async () => {
    // 前置对照:先真清空并断言真的空了 —— 否则「复制成功」可能只是上一次的残留
    // (测试参数就是判据的一部分,memory `test-parameters-are-part-of-the-predicate`)。
    console.log("clipboard:", clearClipboard());
    expect(clipboardImage()).toBe("none");

    await goNotebook("inbox");
    await clearInbox();
    const id = await invoke("capture_note", { content: "E2E-复制整张图-Linux" });
    await invoke("add_item_image", {
      itemId: id,
      mime: "image/png",
      dataB64: await mkPng(W, H),
    });

    await goNotebook("inbox");
    const card = await $(".note*=E2E-复制整张图-Linux");
    await card.waitForExist({ timeout: 10000 });
    const thumb = await card.$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await thumb.click(); // → openLightbox
    const box = await $(".img-lightbox");
    await box.waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const i = document.querySelector("img.img-lightbox-img");
          return i ? i.naturalWidth : 0;
        })) === W,
      { timeout: 10000, timeoutMsg: `大图没加载出那张 ${W}×${H}` },
    );

    // 判别式:把 web 那支的**结果**记下来(不改它的行为,原样转发)。
    // Linux 期望 `throw:…`(WebKitGTK 写图恒 NotAllowedError);真要是 "ok",说明这台的
    // WebKitGTK 行为变了 —— 那不是这支的失败,是 394 那条根因过期了,该重判而不是改断言。
    await browser.execute(() => {
      window.__copyProbe = { web: null };
      const orig = navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = async (...a) => {
        try {
          const r = await orig(...a);
          window.__copyProbe.web = "ok";
          return r;
        } catch (e) {
          window.__copyProbe.web = "throw:" + String(e);
          throw e;
        }
      };
    });

    await browser.keys(["Control", "c"]);

    // 剪贴板是异步写的(而且这一端还要多绕一趟 IPC):轮询到位再断言,别赌时序。
    let seen = "none";
    await browser.waitUntil(
      async () => {
        seen = clipboardImage();
        return seen !== "none";
      },
      { timeout: 15000, timeoutMsg: "Ctrl+C 之后剪贴板上一直没有图 —— arboard 那条退路断了" },
    );
    console.log("clipboard after Ctrl+C:", seen, "| TARGETS:", JSON.stringify(clipboardTargets()));
    expect(seen).toBe(`image ${W}x${H}`);

    const probe = await browser.execute(() => window.__copyProbe);
    console.log("PROBE:", JSON.stringify(probe));
    // ← Linux 恒走壳那条:web 支必须抛过。是 "ok" 的话见上面注释,该重判 394 那条根因。
    expect(String(probe.web)).toContain("throw:");

    // 收摊:关遮罩、清库、把剪贴板还成空(别把这张探针图留在用户的剪贴板上)。
    await browser.keys(["Escape"]);
    await clearInbox();
    console.log("clipboard:", clearClipboard());
  });
});
