// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)
// —— 理由与 `win-clipboard.e2e.js` 同:它**真的会改写本机剪贴板**,且是 Windows 专属。
//
// 补的是 backlog「测试与工装」3② —— **看大图时 Ctrl+C 复制整张图,两端零回归网**:
// 223 加的这条路今天只有人眼验过,而 394 在 Linux 上撞出「WebKitGTK 的异步剪贴板只认文本、
// 写图恒 NotAllowedError」,于是 `copyImageToClipboard` 成了**两条真机制**(web 那支 →
// 失败退到壳的 arboard `writeImage`)。⇒ 要量的不只是「有没有报错」,而是:
//   ①系统剪贴板上**真的**多了一张图,且尺寸就是那一张(不是上一次残留);
//   ②这台走的是**哪一支**(判别式,与 395/401 那支「prevented」同一手法)——
//     Windows 期望恒走 web 支,shell 支一次都不该被叫到。
//
// 怎么跑(先照文档退出生产朱简;fast 形要另起 `npm run dev`):
//   YS_E2E_FAST=1 npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/win-copy-image.e2e.js
import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke, goNotebook, clearInbox } from "../specs/support.js";

const here = dirname(fileURLToPath(import.meta.url));

function ps(script, args = []) {
  return execFileSync(
    "powershell",
    ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(here, script), ...args],
    { encoding: "utf8" },
  ).trim();
}

const setClipboard = (mode) => ps("set-clipboard.ps1", ["-Mode", mode]);
const clipboardImage = () => ps("get-clipboard-image.ps1");

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

// 尺寸刻意选一对**不像默认值**的数(37×21):剪贴板上若是别处残留的图,尺寸对不上当场露馅。
const W = 37;
const H = 21;

describe("223/394 · 看大图 Ctrl+C 复制整张图(Windows 真剪贴板)", () => {
  it("Ctrl+C 后系统剪贴板真的拿到那张图(尺寸对得上),且走的是 web 那支", async () => {
    // 前置对照:先把剪贴板清空并**断言真的空了** —— 否则「复制成功」可能只是上一次的残留
    // (测试参数就是判据的一部分,memory `test-parameters-are-part-of-the-predicate`)。
    console.log("clipboard:", setClipboard("empty"));
    expect(clipboardImage()).toBe("none");

    await goNotebook("inbox");
    await clearInbox();
    const id = await invoke("capture_note", { content: "E2E-复制整张图" });
    await invoke("add_item_image", {
      itemId: id,
      mime: "image/png",
      dataB64: await mkPng(W, H),
    });

    await goNotebook("inbox");
    const card = await $(".note*=E2E-复制整张图");
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
      { timeout: 10000, timeoutMsg: "大图没加载出那张 37×21" },
    );

    // 判别式:把 web 那支的**结果**记下来(不改它的行为,原样转发)。走到 shell 支 =
    // web 支抛过 —— Windows 上一次都不该发生(生产端行为口径,394 记的)。
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

    // 剪贴板是异步写的:轮询到位再断言(直接 pause 是在赌时序)。
    let seen = "none";
    await browser.waitUntil(
      async () => {
        seen = clipboardImage();
        return seen !== "none";
      },
      { timeout: 10000, timeoutMsg: "Ctrl+C 之后剪贴板上一直没有图" },
    );
    console.log("clipboard after Ctrl+C:", seen);
    expect(seen).toBe(`image ${W}x${H}`);

    const probe = await browser.execute(() => window.__copyProbe);
    console.log("PROBE:", JSON.stringify(probe));
    expect(probe.web).toBe("ok"); // ← Windows 恒走 web 支;是 "throw:…" 就说明退到了壳那条

    // 收摊:关遮罩、清库、把剪贴板还成空(别把这张探针图留在用户的剪贴板上)。
    await browser.keys(["Escape"]);
    await clearInbox();
    console.log("clipboard:", setClipboard("empty"));
  });
});
